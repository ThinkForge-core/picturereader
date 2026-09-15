#!/usr/bin/env python3
"""Local OCR for picturereader: RapidOCR (ONNX Runtime) with tiling.

Why this exists next to the PaddleOCR path
------------------------------------------
PaddleOCR cannot be installed on aarch64: ``paddlepaddle`` publishes no
``manylinux*aarch64`` wheel from 3.3.0 onwards, and its ``paddlex`` dependency
tree has no ARM wheels at all. RapidOCR runs the *same* PP-OCR detection and
recognition models through ONNX Runtime, which ships a wheel for every
architecture this plugin targets (x86_64 and aarch64) and needs no compiler.
So this is the default engine; ``paddle`` stays available as a fallback for
installations that already have it.

Two problems this script solves that the PaddleOCR path did not
----------------------------------------------------------------
1. **Long screenshots.** Every OCR engine in this family resizes the input so
   that its longest side fits a limit (PaddleOCR 960 px, RapidOCR 2000 px).
   A 1080x20000 stitched screenshot is therefore downscaled ~12x and the text
   collapses into an unreadable smear -- silently, with no error. This script
   slices the image into tiles that need no downscaling, runs OCR on each tile
   and merges the results back into whole-image coordinates.

2. **Mixed scripts.** A single recognition model cannot read Cyrillic and CJK
   at once: the Chinese model returns confident nonsense for Cyrillic input,
   reporting a Russian phrase as a run of bare digits at a plausible score.
   Detection is script-agnostic, so we detect once per tile and recognize the
   *same* crops with two models (Chinese/English + East Slavic), keeping the
   higher-scoring reading of each line. Russian, English and Chinese then work
   in one pass without the caller having to declare a language.

Wire contract (unchanged from the PaddleOCR script, so the JS side is shared):
stdout carries one base64-encoded JSON object; diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import sys
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------
# logging: RapidOCR is chatty on INFO. It must never reach stdout, because
# stdout carries the base64 payload.
# --------------------------------------------------------------------------
logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format="%(message)s")
for _name in ("RapidOCR", "rapidocr", "onnxruntime"):
    logging.getLogger(_name).setLevel(logging.ERROR)


def fail(message: str, code: int = 3) -> "None":
    """Print an actionable error on stderr and exit."""
    sys.stderr.write("ocr.py: %s\n" % message)
    raise SystemExit(code)


# --------------------------------------------------------------------------
# language handling
# --------------------------------------------------------------------------

#: BCP-47 primary subtag -> RapidOCR (rec) language key.
#:
#: ``ch`` covers Simplified Chinese *and* English/digits, ``eslav`` covers the
#: East Slavic languages (ru/uk/be), ``cyrillic`` the remaining Cyrillic ones.
LANG_BY_SUBTAG: Dict[str, str] = {
    "zh": "ch", "cn": "ch", "chinese": "ch",
    "en": "en", "english": "en",
    "ru": "eslav", "uk": "eslav", "be": "eslav",
    "ja": "japan", "japanese": "japan",
    "ko": "korean", "korean": "korean",
    "th": "th", "el": "el", "ka": "ka",
    "ar": "arabic", "fa": "arabic", "ur": "arabic",
    "hi": "devanagari", "ne": "devanagari", "mr": "devanagari",
    "ta": "ta", "te": "te",
}
for _tag in ("bg", "sr", "mk", "kk", "ky", "mn", "tg", "tt", "ba", "uk"):
    LANG_BY_SUBTAG.setdefault(_tag, "cyrillic")
# Latin-script languages share the latin model; `ch`/`en` also read them, but
# a dedicated latin model is better for diacritics.
for _tag in ("de", "fr", "es", "it", "pt", "nl", "sv", "da", "no", "fi", "pl",
             "cs", "sk", "hu", "ro", "tr", "vi", "id", "ms", "hr", "sl", "et",
             "lv", "lt", "ca", "gl", "eu", "cy", "ga", "is", "sq", "az", "uz"):
    LANG_BY_SUBTAG.setdefault(_tag, "latin")

#: RapidOCR ships some recognition models only for PP-OCRv5, others only for
#: PP-OCRv4. DET is script-agnostic and always uses the v5 mobile detector.
REC_VERSION: Dict[str, str] = {
    "ch": "PP-OCRv5", "en": "PP-OCRv5", "eslav": "PP-OCRv5",
    "cyrillic": "PP-OCRv5", "latin": "PP-OCRv5", "korean": "PP-OCRv5",
    "th": "PP-OCRv5", "el": "PP-OCRv5", "arabic": "PP-OCRv5",
    "devanagari": "PP-OCRv5", "ta": "PP-OCRv5", "te": "PP-OCRv5",
    # not published for v5 -- fall back to the v4 model set
    "japan": "PP-OCRv4", "chinese_cht": "PP-OCRv4", "ka": "PP-OCRv4",
}

DET_VERSION = "PP-OCRv5"

#: Printed on stdout right before the payload. Anything a wrapper (proot-distro
#: prints a login banner, for instance) writes before it is ignored, so the
#: base64 payload can never be corrupted by stray stdout output.
PAYLOAD_MARKER = "@@PICTUREREADER-OCR@@"

#: ``auto`` = read every line with both a CJK and a Slavic/European model.
AUTO_LANGS: Tuple[str, ...] = ("ch", "eslav")

#: Model order for ``auto``, by reader preference. Every line is read by both
#: models and the higher score wins, so the first model wins a *tie* — the order
#: therefore decides whose script survives a disagreement. The CJK model
#: mangles Cyrillic into bare digits at a plausible score, so a Russian reader
#: wants ``cyrillic``; a Chinese reader wants the CJK model first. ``auto`` and
#: ``zh`` name the same order, so a Chinese deployment can state it explicitly.
AUTO_LANGS_BY_PRIORITY: Dict[str, Tuple[str, ...]] = {
    "auto": AUTO_LANGS,
    "zh": AUTO_LANGS,
    "cyrillic": ("eslav", "ch"),
}


def normalize_priority(value: Optional[str]) -> str:
    """Coerce a priority setting to a known key, falling back to ``auto``.

    A typo in the settings card must not break every OCR call, so an unknown
    value degrades to the default instead of raising.
    """
    raw = (value or "auto").strip().lower()
    return raw if raw in AUTO_LANGS_BY_PRIORITY else "auto"


def language_list(spec: Optional[str], priority: Optional[str] = "auto") -> List[str]:
    """Resolve a ``--language`` argument into an ordered list of model keys.

    ``priority`` is consulted only for ``auto``: it picks which of the two
    models runs first, and the first model wins a tie. An explicit language or
    model key already names its models, so it ignores the priority.
    """
    raw = (spec or "auto").strip().lower()
    if raw in ("", "auto", "*"):
        return list(AUTO_LANGS_BY_PRIORITY[normalize_priority(priority)])
    if raw in REC_VERSION:
        return [raw]
    # Traditional Chinese needs the whole tag, not just the primary subtag.
    if raw.startswith("zh") and any(t in raw for t in ("hant", "tw", "hk", "mo")):
        return ["chinese_cht"]
    if raw.startswith("zh") and any(t in raw for t in ("hans", "cn", "sg")):
        return ["ch"]
    primary = raw.replace("_", "-").split("-")[0]
    if primary.startswith("zh"):
        return ["ch"]
    if primary in LANG_BY_SUBTAG:
        return [LANG_BY_SUBTAG[primary]]
    return list(AUTO_LANGS)


# --------------------------------------------------------------------------
# tiling
# --------------------------------------------------------------------------

def _band_starts(total: int, band: int) -> List[int]:
    """Start offsets of the ownership bands along one axis (contiguous)."""
    if total <= band:
        return [0]
    out = [0]
    while out[-1] + band < total:
        out.append(out[-1] + band)
    return out


def _axis(width_or_height: int, limit: int, overlap: int) -> Tuple[List[int], int, int]:
    """(band starts, band size, overlap) for one axis, keeping tiles <= limit.

    The tile is the band grown by ``overlap`` on both sides, so the band must
    be ``limit - 2 * overlap`` wide for the tile to still fit within ``limit``.
    Getting this wrong is subtle and expensive: a tile even slightly over the
    engine limit is downscaled, which is exactly what tiling exists to avoid.
    """
    if width_or_height <= limit:
        # Already within the engine limit: one band, and no tile may be grown
        # beyond the image or it would stop being the whole image.
        return [0], max(1, width_or_height), 0
    size = limit
    ov = max(1, min(overlap, (size - 1) // 2))
    band = max(1, size - 2 * ov)
    return _band_starts(width_or_height, band), band, ov


def plan_tiles(
    width: int, height: int, max_side: int, overlap: int
) -> List[Tuple[int, int, int, int, int, int, int, int]]:
    """Split an image into tiles that need no downscaling.

    Returns ``(x0, y0, x1, y1, bx0, by0, bx1, by1)`` per tile, where the first
    rect is the *tile* (a bit larger than the ownership band, so a text line
    sitting on a band boundary is still fully visible in some tile) and the
    second is the *band* whose centre decides which tile owns a line. Bands
    tile the image exactly, so a line is never dropped and never duplicated.
    """
    xs, band_w, ov_x = _axis(width, max_side, overlap)
    ys, band_h, ov_y = _axis(height, max_side, overlap)
    tiles = []
    for by0 in ys:
        by1 = min(by0 + band_h, height)
        y0 = max(0, by0 - ov_y)
        y1 = min(height, by1 + ov_y)
        for bx0 in xs:
            bx1 = min(bx0 + band_w, width)
            x0 = max(0, bx0 - ov_x)
            x1 = min(width, bx1 + ov_x)
            tiles.append((x0, y0, x1, y1, bx0, by0, bx1, by1))
    return tiles


# --------------------------------------------------------------------------
# the engine
# --------------------------------------------------------------------------

class OcrEngine:
    """Detect once per tile, recognize the same crops with several models."""

    def __init__(self, langs: Sequence[str], max_side: int, threads: int = 0):
        try:
            from rapidocr import LangDet, LangRec, ModelType, OCRVersion, RapidOCR
            from rapidocr.ch_ppocr_rec import TextRecInput
        except Exception as exc:  # pragma: no cover - depends on the environment
            fail(
                "the RapidOCR environment is missing (%s). Install it with "
                "scripts/install.py (or scripts/termux/setup.sh under Termux)." % exc
            )
        self._RapidOCR = RapidOCR
        self._TextRecInput = TextRecInput
        self._OCRVersion = OCRVersion
        self._LangDet = LangDet
        self._ModelType = ModelType
        self.max_side = max_side

        common: Dict[str, Any] = {
            "Global.max_side_len": max_side,
            "Global.min_side_len": 30,
            # Screenshots and PDF pages are upright; orientation classification
            # would only cost time. We bypass it anyway by calling the detector
            # and recognizer directly.
            "Global.use_cls": False,
            "Global.use_vertical_padding": False,
            "Global.log_level": "error",
        }
        if threads > 0:
            common["EngineConfig.onnxruntime.intra_op_num_threads"] = threads

        # Primary engine: detector + first recognition model.
        self.primary_lang = langs[0]
        self.primary = self._make(langs[0], common, with_det=True)

        # Extra recognizers: same crops, different script. Building them with
        # use_det=False means the detector is loaded only once.
        extra_cfg = dict(common)
        extra_cfg["Global.use_det"] = False
        extra_cfg["Global.use_rec"] = True
        self.extra: List[Tuple[str, Any]] = [
            (lang, self._make(lang, extra_cfg, with_det=False)) for lang in langs[1:]
        ]

    def _lang_enum(self, lang: str) -> Any:
        """``'ch'``/``'chinese_cht'`` -> ``LangRec.CH``/``LangRec.CHINESE_CHT``."""
        from rapidocr import LangRec
        try:
            return getattr(LangRec, lang.upper())
        except AttributeError:  # pragma: no cover - newer/older model sets
            return lang

    def _version_enum(self, version: str) -> Any:
        try:
            return getattr(self._OCRVersion, version.replace("-", "").upper())
        except AttributeError:  # pragma: no cover
            return version

    def _make(self, lang: str, common: Dict[str, Any], with_det: bool) -> Any:
        params = dict(common)
        if with_det:
            params["Det.ocr_version"] = self._version_enum(DET_VERSION)
            params["Det.lang_type"] = self._LangDet.CH
            params["Det.model_type"] = self._ModelType.MOBILE
        else:
            params["Global.use_det"] = False
        params["Rec.lang_type"] = self._lang_enum(lang)
        params["Rec.ocr_version"] = self._version_enum(REC_VERSION.get(lang, "PP-OCRv5"))
        params["Rec.model_type"] = self._ModelType.MOBILE
        try:
            return self._RapidOCR(params=params)
        except Exception as exc:
            fail("cannot create the '%s' recognition engine: %s" % (lang, exc))

    @property
    def langs(self) -> List[str]:
        return [self.primary_lang] + [lang for lang, _ in self.extra]

    def run_tile(self, rgb: Any) -> List[Dict[str, Any]]:
        """OCR one tile given as a HxWx3 numpy array; boxes are tile-local."""
        try:
            from rapidocr.utils.process_img import map_boxes_to_original
        except ImportError:  # pragma: no cover - older/newer layout
            try:
                from rapidocr.utils import map_boxes_to_original  # type: ignore
            except ImportError:
                map_boxes_to_original = None

        ori_h, ori_w = rgb.shape[:2]
        img, op_record = self.primary.preprocess_img(rgb)
        crops, det = self.primary.detect_and_crop(img, op_record)
        if det.boxes is None or len(crops) == 0:
            return []
        if map_boxes_to_original is not None:
            boxes = map_boxes_to_original(det.boxes, op_record, ori_h, ori_w)
        else:  # pragma: no cover - preprocess was a no-op resize
            boxes = det.boxes

        readings: List[Tuple[Tuple[str, ...], List[float]]] = []
        for engine in [self.primary] + [e for _, e in self.extra]:
            try:
                rec = engine.text_rec(self._TextRecInput(img=crops))
            except Exception as exc:  # a broken extra model must not kill the run
                sys.stderr.write("ocr.py: recognition with %s failed: %s\n" % (engine, exc))
                continue
            readings.append((tuple(rec.txts or ()), list(rec.scores or [])))

        if not readings:
            return []

        lines: List[Dict[str, Any]] = []
        for index, box in enumerate(boxes):
            best_text = ""
            best_score = 0.0
            for texts, scores in readings:
                if index >= len(texts):
                    continue
                text = texts[index]
                score = float(scores[index]) if index < len(scores) else 0.0
                if score > best_score:
                    best_text, best_score = text, score
            if not best_text.strip():
                continue
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            lines.append(
                {
                    "text": best_text,
                    "score": round(best_score, 3),
                    "x": int(min(xs)),
                    "y": int(min(ys)),
                    "width": int(max(xs) - min(xs)),
                    "height": int(max(ys) - min(ys)),
                }
            )
        return lines


def _probe_size(path: str) -> Tuple[int, int]:
    """Width/height without decoding the pixels (Pillow only reads the header)."""
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 250_000_000
    try:
        with Image.open(path) as image:
            return image.size
    except Exception as exc:
        fail("cannot read %s: %s" % (path, exc))


def focus_to_region(focus: Sequence[float], width: int, height: int) -> Sequence[float]:
    """Mirror of the JS ``resolveFocus``: the grid is 32 cells wide, and as many
    rows as keep the cells square (``round(32 * height / width)``)."""
    row0, col0, row1, col1 = (int(v) for v in focus)
    grid_w = 32
    grid_h = max(1, round(32 * (height / width)))
    if row1 < row0 + 1 or col1 < col0 + 1:
        fail("--focus must span at least 2 rows and 2 columns")
    if row1 >= grid_h or col1 >= grid_w:
        fail("--focus %d,%d,%d,%d is out of range for a %dx%d grid"
             % (row0, col0, row1, col1, grid_w, grid_h))
    return [col0 / grid_w, row0 / grid_h, (col1 + 1) / grid_w, (row1 + 1) / grid_h]


def _load_image(path: str, region: Optional[Sequence[float]]):
    try:
        from PIL import Image
    except Exception as exc:  # pragma: no cover
        fail("Pillow is required to read images (%s)" % exc)

    # A long screenshot is legitimately huge; Pillow's decompression-bomb guard
    # would reject it. Raise the ceiling to something that still fails loudly
    # before an Android process gets killed for memory.
    Image.MAX_IMAGE_PIXELS = 250_000_000
    try:
        image = Image.open(path)
        image.load()
    except Exception as exc:
        fail("cannot read %s: %s" % (path, exc))
    image = image.convert("RGB")
    width, height = image.size
    if region is not None:
        rx0, ry0, rx1, ry1 = (max(0.0, min(1.0, float(v))) for v in region)
        box = (
            int(rx0 * width),
            int(ry0 * height),
            max(int(rx0 * width) + 1, int(rx1 * width)),
            max(int(ry0 * height) + 1, int(ry1 * height)),
        )
        image = image.crop(box)
        width, height = image.size
    return image, width, height


def collect_lines(
    engine: OcrEngine, image: Any, width: int, height: int, tiled: bool, overlap: int
) -> Tuple[List[Dict[str, Any]], int, List[str]]:
    """Run the engine over the image (tiled or not) and merge the lines."""
    import numpy as np

    notes: List[str] = []
    if not tiled:
        tiles = [(0, 0, width, height, 0, 0, width, height)]
    else:
        tiles = plan_tiles(width, height, engine.max_side, overlap)
    if len(tiles) == 1 and (width <= engine.max_side and height <= engine.max_side):
        pass
    elif tiled and len(tiles) > 1:
        notes.append(
            "tiled into %d pieces (%dx%d each, no downscaling) so long "
            "screenshots keep full resolution" % (len(tiles), min(width, engine.max_side), min(height, engine.max_side))
        )

    merged: List[Dict[str, Any]] = []
    for (x0, y0, x1, y1, bx0, by0, bx1, by1) in tiles:
        tile = image.crop((x0, y0, x1, y1))
        rgb = np.asarray(tile)
        if rgb.ndim == 2:
            rgb = np.stack([rgb] * 3, axis=-1)
        for line in engine.run_tile(rgb):
            gx = line["x"] + x0
            gy = line["y"] + y0
            cx = gx + line["width"] / 2.0
            cy = gy + line["height"] / 2.0
            # Ownership by band centre: exactly one tile owns each line, and
            # since the tile is `overlap` px larger than its band, a line that
            # straddles a band boundary is still read in full somewhere.
            if not (bx0 <= cx < bx1 and by0 <= cy < by1):
                continue
            merged.append({**line, "x": gx, "y": gy})

    merged.sort(key=lambda item: (item["y"], item["x"]))
    return merged, len(tiles), notes


def describe_environment() -> Dict[str, Any]:
    info: Dict[str, Any] = {"python": sys.version.split()[0]}
    for name in ("rapidocr", "onnxruntime", "numpy", "PIL", "cv2"):
        try:
            module = __import__(name)
            info[name] = getattr(module, "__version__", "?")
        except Exception as exc:
            info[name] = "missing (%s)" % exc
    return info


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="picturereader OCR (RapidOCR + tiling)")
    parser.add_argument("--input", help="path to the image to read")
    parser.add_argument("--language", default="auto",
                        help="BCP-47 tag, a RapidOCR language key, or 'auto' (default)")
    parser.add_argument("--priority", default="auto",
                        help="model order under 'auto': 'auto'/'zh' reads CJK first, "
                             "'cyrillic' reads Cyrillic first; the first model wins a tie")
    parser.add_argument("--region", default=None,
                        help="optional x0,y0,x1,y1 fractions of the image")
    parser.add_argument("--focus", default=None,
                        help="optional row0,col0,row1,col1 grid cell (same grid as image_scan)")
    parser.add_argument("--tile", choices=["auto", "on", "off"], default="auto",
                        help="tiling mode: auto tiles only when the image is larger than --max-side")
    parser.add_argument("--max-side", type=int, default=1600,
                        help="longest side of a tile; keep <= the engine limit (default 1600)")
    parser.add_argument("--overlap", type=int, default=120,
                        help="tile overlap in pixels (default 120)")
    parser.add_argument("--threads", type=int, default=0,
                        help="ONNX Runtime intra-op threads (0 = let it choose)")
    parser.add_argument("--probe", action="store_true",
                        help="load the models, print environment info and exit")
    parser.add_argument("--raw", action="store_true",
                        help="print plain JSON instead of base64 (debugging)")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)

    if args.probe:
        env = describe_environment()
        langs = language_list(args.language, args.priority)
        engine = OcrEngine(langs, args.max_side, args.threads)
        env["langs"] = engine.langs
        env["priority"] = normalize_priority(args.priority)
        env["max_side"] = args.max_side
        sys.stdout.write("\n" + PAYLOAD_MARKER + "\n")
        sys.stdout.write(json.dumps(env, ensure_ascii=False) + "\n")
        return 0

    if not args.input:
        fail("--input is required")

    region = None
    if args.region:
        try:
            region = [float(v) for v in str(args.region).split(",")]
        except ValueError:
            fail("--region must be four comma-separated numbers")
        if len(region) != 4:
            fail("--region must be four comma-separated numbers")

    if args.region and args.focus:
        fail("--region and --focus are mutually exclusive")

    langs = language_list(args.language, args.priority)
    engine = OcrEngine(langs, args.max_side, args.threads)
    if args.focus:
        try:
            focus = [int(v) for v in str(args.focus).split(",")]
        except ValueError:
            fail("--focus must be four comma-separated integers")
        if len(focus) != 4:
            fail("--focus must be four comma-separated integers")
        probe_w, probe_h = _probe_size(args.input)
        region = focus_to_region(focus, probe_w, probe_h)

    image, width, height = _load_image(args.input, region)

    tiled = args.tile in ("on", "auto") and (
        args.tile == "on" or width > args.max_side or height > args.max_side
    )
    lines, tile_count, notes = collect_lines(engine, image, width, height, tiled, args.overlap)

    payload = {
        "engine": "rapid",
        "langs": engine.langs,
        "lang": args.language,
        "priority": normalize_priority(args.priority),
        "width": int(width),
        "height": int(height),
        "tiles": int(tile_count),
        "lines": lines,
        "notes": notes,
    }
    text = json.dumps(payload, ensure_ascii=False)
    sys.stdout.write("\n" + PAYLOAD_MARKER + "\n")
    if args.raw:
        sys.stdout.write(text + "\n")
    else:
        sys.stdout.write(base64.b64encode(text.encode("utf-8")).decode("ascii") + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
