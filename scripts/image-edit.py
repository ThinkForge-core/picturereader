# -*- coding: utf-8 -*-
"""
image-edit.py — local image editing / processing backend (called by the DSH
image_edit tool).

Pure-CPU lightweight implementation: the core uses Pillow (PIL) and the P1/P2
parts use OpenCV (cv2, optional); rembg / rawpy / realesrgan-ncnn-vulkan are
optional dependencies too — when one is missing the matching action returns a
clear "install the dependency" hint instead of crashing. The dependencies are
installed with `python3 scripts/install.py`.

Usage (argv):
  python image-edit.py <request.json path>

  <request.json path>  path to a JSON file holding the request object (the Node
                       side has already materialized the input image onto a real
                       local path, so the from field is an absolute path).

Common request fields:
  action           required, string. See the ACTIONS list below.
  from             required, absolute path of the main input image.
  from_extra       optional, array of absolute paths of extra input images
                   (used by composite/stitch and similar).
  out              required, absolute output image path (including the
                   extension, which determines the format).
  ...action-specific parameters (see the handle_* functions). Every value must
  be a JSON number/string.

Output:
  stdout prints a single JSON line:
    {"ok": true, "out_path": "...", "width": W, "height": H, "bytes": N,
     "format": "PNG", "summary": "...", "extra": {...}}
  or
    {"error": "clear English message", "action": "..."}
  Any uncaught exception is returned as a JSON error plus exit code 1.

Supported actions:
  P0: resize, rotate, flip, convert, adjust, blur, sharpen, composite, watermark
  P1: remove_background, edges, equalize_hist, denoise, perspective, stitch, thumbnail
  P2: exif_read, exif_write, raw_convert, upscale, colorspace, morphology
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback


# ---- Image open/save primitives (every operation funnels through Pillow so
# ---- that format compatibility stays guaranteed) -----------------------------

def open_image(path):
    """Open any supported format -> a PIL Image in RGBA or RGB mode."""
    from PIL import Image
    im = Image.open(path)
    im.load()
    if "A" in im.getbands():
        return im.convert("RGBA")
    return im.convert("RGB")


def save_image(im, out, action):
    """Save according to the out extension, normalizing to RGB/RGBA.
    Returns (width, height, bytes, format)."""
    from PIL import Image
    ext = os.path.splitext(out)[1].lower()
    # Lossless/transparency-capable formats keep RGBA, the rest use RGB
    # (JPEG has no alpha channel).
    alpha_formats = {".png", ".webp", ".bmp", ".tiff", ".tif", ".gif"}
    if ext in alpha_formats and "A" in im.getbands():
        save_im = im
    else:
        save_im = im.convert("RGB")
    # JPEG/TIFF need mode handling; webp is written without animation.
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    save_im.save(out)
    fmt = Image.open(out).format or "UNKNOWN"
    return im.width, im.height, os.path.getsize(out), fmt


# ---- P0: basic transforms (pure Pillow) -------------------------------------

def handle_resize(req, im):
    width = int(req.get("width", 0))
    height = int(req.get("height", 0))
    if width <= 0 or height <= 0:
        raise ValueError("resize requires width and height (>0 integers)")
    mode = req.get("mode", "stretch")  # stretch | fit | fill
    keep_ratio = bool(req.get("keep_ratio", False))
    img = im
    if mode == "stretch":
        w, h = width, height
    elif mode == "fit":  # keep the ratio, fit inside width x height (smaller scale wins)
        ratio = min(width / im.width, height / im.height)
        w, h = max(1, round(im.width * ratio)), max(1, round(im.height * ratio))
    elif mode == "fill":  # keep the ratio, crop-fill to width x height
        ratio = max(width / im.width, height / im.height)
        w, h = round(im.width * ratio), round(im.height * ratio)
        img = im.resize((w, h), Image_LANCZOS())
        # center crop
        left = (w - width) // 2
        top = (h - height) // 2
        img = img.crop((left, top, left + width, top + height))
        w, h = width, height
    else:
        raise ValueError("resize mode must be stretch/fit/fill")
    if img is im:
        if keep_ratio and mode == "stretch":
            ratio = min(width / im.width, height / im.height)
            w, h = max(1, round(im.width * ratio)), max(1, round(im.height * ratio))
        img = im.resize((w, h), Image_LANCZOS())
    return img


def Image_LANCZOS():
    from PIL import Image
    return Image.LANCZOS


def handle_rotate(req, im):
    angle = float(req.get("angle", 0))
    expand = bool(req.get("expand", True))
    fill = req.get("fill")  # accepts "#rrggbb" or "255,255,255" or "transparent"
    from PIL import Image
    if not expand:
        return im.rotate(angle, expand=False)
    # With expand=True an image carrying alpha rotates directly; an RGB image
    # first gets a canvas fill color.
    if "A" in im.getbands():
        return im.rotate(angle, expand=True)
    color = parse_fill(fill) or (0, 0, 0)
    rgba = im.convert("RGBA")
    out = rgba.rotate(angle, expand=True, fillcolor=(*color, 255))
    return out


def parse_fill(fill):
    if not fill:
        return None
    s = str(fill).strip()
    if s.startswith("#") and len(s) == 7:
        try:
            return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))
        except ValueError:
            return None
    parts = [int(x) for x in s.replace(" ", "").split(",") if x != ""]
    if len(parts) == 3:
        return tuple(parts)
    return None


def handle_flip(req, im):
    from PIL import Image
    axis = req.get("axis", "horizontal")
    if axis == "horizontal":
        return im.transpose(Image.FLIP_LEFT_RIGHT)
    if axis == "vertical":
        return im.transpose(Image.FLIP_TOP_BOTTOM)
    if axis == "both":
        return im.transpose(Image.FLIP_LEFT_RIGHT).transpose(Image.FLIP_TOP_BOTTOM)
    raise ValueError("flip axis must be horizontal/vertical/both")


def handle_convert(req, im):
    # The format comes from the out extension (Pillow supports png/jpg/jpeg/webp/bmp/tiff/gif)
    return im


def handle_adjust(req, im):
    from PIL import ImageEnhance
    brightness = float(req.get("brightness", 1.0))
    contrast = float(req.get("contrast", 1.0))
    saturation = float(req.get("saturation", 1.0))
    work = im
    if "A" in im.getbands():
        work = im.convert("RGB")
    if brightness != 1.0:
        work = ImageEnhance.Brightness(work).enhance(brightness)
    if contrast != 1.0:
        work = ImageEnhance.Contrast(work).enhance(contrast)
    if saturation != 1.0:
        work = ImageEnhance.Color(work).enhance(saturation)
    # restore alpha
    if "A" in im.getbands():
        alpha = im.getchannel("A")
        work = work.convert("RGBA")
        work.putalpha(alpha)
    return work


def handle_blur(req, im):
    from PIL import ImageFilter
    blur_type = req.get("type", "gaussian")
    radius = float(req.get("radius", 2.0))
    if blur_type == "box":
        return im.filter(ImageFilter.BoxBlur(max(0.1, radius)))
    if blur_type == "motion":
        return im.filter(ImageFilter.GaussianBlur(max(0.1, radius * 2)))
    return im.filter(ImageFilter.GaussianBlur(max(0.1, radius)))


def handle_sharpen(req, im):
    from PIL import ImageFilter
    radius = float(req.get("radius", 2.0))
    percent = int(req.get("percent", 150))
    threshold = int(req.get("threshold", 3))
    return im.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=threshold))


def handle_composite(req, im):
    # Composite the foreground image (from_extra[0]) onto the main image im.
    from PIL import Image
    extra = req.get("from_extra") or []
    if not extra:
        raise ValueError("composite requires from_extra[0] (the foreground/overlay image path) plus from (the background)")
    fg = open_image(extra[0])
    pos = req.get("position", "center")  # pixel "x,y" or a keyword
    alpha = float(req.get("alpha", 1.0))
    bg = im.convert("RGBA")
    x, y = resolve_position(bg, fg, pos)
    if alpha < 1.0:
        fg = fg.copy()
        if "A" in fg.getbands():
            a = fg.getchannel("A").point(lambda v: round(v * alpha))
            fg.putalpha(a)
        else:
            fg = fg.convert("RGBA")
            fg.putalpha(Image.new("L", fg.size, int(alpha * 255)))
    bg.alpha_composite(fg, (x, y))
    return bg


def resolve_position(bg, fg, pos):
    s = str(pos).strip().lower()
    if "," in s:
        parts = [int(x.strip()) for x in s.split(",") if x.strip() != ""]
        if len(parts) == 2:
            return parts[0], parts[1]
    if s == "center":
        return (bg.width - fg.width) // 2, (bg.height - fg.height) // 2
    if s == "top_left":
        return 0, 0
    if s == "top_right":
        return bg.width - fg.width, 0
    if s == "bottom_left":
        return 0, bg.height - fg.height
    if s == "bottom_right":
        return bg.width - fg.width, bg.height - fg.height
    if s == "top_center":
        return (bg.width - fg.width) // 2, 0
    if s == "bottom_center":
        return (bg.width - fg.width) // 2, bg.height - fg.height
    raise ValueError("unknown composite position: " + pos)


def handle_watermark(req, im):
    # Supports an image watermark (from_extra[0]) or a text watermark (text).
    from PIL import Image, ImageDraw, ImageFont
    wtype = req.get("type", "text")
    pos = req.get("position", "bottom_right")
    alpha = float(req.get("alpha", 0.6))
    bg = im.convert("RGBA")
    overlay = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    if wtype == "image":
        extra = req.get("from_extra") or []
        if not extra:
            raise ValueError("watermark(image) requires from_extra[0] pointing at the watermark image")
        wm = open_image(extra[0])
        x, y = resolve_position(bg, wm, pos)
        if alpha < 1.0:
            if "A" in wm.getbands():
                wm.putalpha(wm.getchannel("A").point(lambda v: round(v * alpha)))
            else:
                wm = wm.convert("RGBA")
                wm.putalpha(Image.new("L", wm.size, int(alpha * 255)))
        overlay.alpha_composite(wm, (x, y))
    else:
        text = str(req.get("text", ""))
        if not text:
            raise ValueError("watermark(text) requires text")
        size = int(req.get("font_size", 36))
        font = load_font(size)
        # rough text size measurement
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if pos == "center":
            x, y = (bg.width - tw) // 2, (bg.height - th) // 2
        elif pos == "top_left":
            x, y = 10, 10
        elif pos == "top_right":
            x, y = bg.width - tw - 10, 10
        elif pos == "bottom_left":
            x, y = 10, bg.height - th - 10
        else:
            x, y = bg.width - tw - 10, bg.height - th - 10
        color = parse_fill(req.get("color", "#ffffff")) or (255, 255, 255)
        draw.text((x, y), text, font=font, fill=(*color, int(alpha * 255)))
    bg.alpha_composite(overlay)
    return bg


def load_font(size):
    from PIL import ImageFont
    # Common Linux font locations, CJK-capable ones first so that non-Latin
    # watermark text still renders.
    candidates = [
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                continue
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size)
    except Exception:
        return ImageFont.load_default()


def handle_thumbnail(req, im):
    from PIL import Image
    max_w = int(req.get("width", 256))
    max_h = int(req.get("height", 256))
    copy = im.copy()
    copy.thumbnail((max_w, max_h), Image.LANCZOS)
    return copy


# ---- P1: advanced (OpenCV / rembg) ------------------------------------------

def get_cv2():
    try:
        import cv2  # noqa
        return cv2
    except Exception as e:
        raise RuntimeError(
            "This action requires OpenCV. Install opencv-python-headless with: "
            "run: python3 scripts/install.py (missing: %s)" % e
        )


def handle_edges(req, im):
    cv2 = get_cv2()
    import numpy as np
    low = int(req.get("low", 100))
    high = int(req.get("high", 200))
    gray_pil = im.convert("L")
    arr = np.array(gray_pil)
    edges = cv2.Canny(arr, low, high)
    from PIL import Image
    return Image.fromarray(edges).convert("RGB")


def handle_equalize_hist(req, im):
    cv2 = get_cv2()
    import numpy as np
    from PIL import Image
    mode = req.get("mode", "auto")  # auto | clahe
    # Convert to gray or color. For color, apply CLAHE to the luminance channel
    # and merge back, which preserves the colors.
    if "A" in im.getbands():
        rgba = im.convert("RGBA")
        rgb = rgba.convert("RGB")
        alpha = rgba.getchannel("A")
    else:
        rgb = im.convert("RGB")
        alpha = None
    arr = np.array(rgb)
    if mode == "clahe":
        lab = cv2.cvtColor(arr, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        l = clahe.apply(l)
        lab = cv2.merge((l, a, b))
        out = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    else:
        hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
        h, s, v = cv2.split(hsv)
        v = cv2.equalizeHist(v)
        hsv = cv2.merge((h, s, v))
        out = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)
    out_pil = Image.fromarray(out).convert("RGB")
    if alpha is not None:
        out_pil = out_pil.convert("RGBA")
        out_pil.putalpha(alpha)
    return out_pil


def handle_denoise(req, im):
    cv2 = get_cv2()
    import numpy as np
    from PIL import Image
    strength = float(req.get("strength", 10.0))
    rgba = im.convert("RGBA")
    rgb = rgba.convert("RGB")
    alpha = rgba.getchannel("A")
    bgr = cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)
    denoised = cv2.fastNlMeansDenoisingColored(bgr, None, strength, strength, 7, 21)
    out = cv2.cvtColor(denoised, cv2.COLOR_BGR2RGB)
    out_pil = Image.fromarray(out).convert("RGBA")
    out_pil.putalpha(alpha)
    return out_pil


def handle_perspective(req, im):
    cv2 = get_cv2()
    import numpy as np
    from PIL import Image
    pts = req.get("points")  # 4 points: from the top-left, counter-clockwise [x1,y1,x2,y2,...]
    if not pts or len(pts) != 8:
        raise ValueError("perspective requires points (8 numbers: 4 corners starting at the top-left, clockwise or counter-clockwise)")
    src = np.float32([[pts[0], pts[1]], [pts[2], pts[3]], [pts[4], pts[5]], [pts[6], pts[7]]])
    w = int(req.get("width", im.width))
    h = int(req.get("height", im.height))
    dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    arr = np.array(im.convert("RGB"))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    M = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(bgr, M, (w, h))
    out = cv2.cvtColor(warped, cv2.COLOR_BGR2RGB)
    return Image.fromarray(out)


def handle_stitch(req, im):
    from PIL import Image
    extras = (req.get("from_extra") or [])
    if not extras:
        raise ValueError("stitch needs at least from plus from_extra[0] (two images)")
    direction = req.get("direction", "horizontal")
    imgs = [im] + [open_image(e).convert("RGBA") for e in extras]
    if req.get("mode", "resize") == "same_height" and direction == "horizontal":
        h = max(x.height for x in imgs)
        imgs = [x.resize((max(1, round(x.width * h / x.height)), h), Image_LANCZOS()) for x in imgs]
        total_w = sum(x.width for x in imgs)
        canvas = Image.new("RGBA", (total_w, h), (0, 0, 0, 0))
        cx = 0
        for x in imgs:
            canvas.alpha_composite(x, (cx, 0))
            cx += x.width
        return canvas
    if direction == "horizontal":
        w = max(x.width for x in imgs)
        h = sum(x.height for x in imgs)
        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        cy = 0
        for x in imgs:
            canvas.alpha_composite(x, (0, cy))
            cy += x.height
        return canvas
    else:
        w = sum(x.width for x in imgs)
        h = max(x.height for x in imgs)
        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        cx = 0
        for x in imgs:
            canvas.alpha_composite(x, (cx, 0))
            cx += x.width
        return canvas


def handle_remove_background(req, im):
    try:
        from rembg import remove
    except Exception as e:
        raise RuntimeError(
            "Background removal requires rembg (U²-Net based, about 35 MB, runs on CPU). "
            "Install rembg with: run: python3 scripts/install.py (missing: %s)" % e
        )
    rgba = im.convert("RGBA")
    out = remove(rgba, post_process_mask=bool(req.get("post_process", False)))
    return out.convert("RGBA")


# ---- P2: optional extras ----------------------------------------------------

def handle_exif_read(req, im):
    exif = im.getexif()
    fields = {}
    for tag_id, value in exif.items():
        name = EXIF_TAGS.get(tag_id, str(tag_id))
        # Keep only a summary for compressed byte values, so the JSON stays bounded.
        if isinstance(value, bytes) and len(value) > 200:
            value = "<%d bytes>" % len(value)
        fields[name] = str(value)
    # Nesting of the Photo tags
    try:
        if hasattr(exif, "get_ifd"):
            for ifd in (0x8825, 0x927C):  # GPS, MakerNote
                sub = exif.get_ifd(ifd)
                for tag_id, value in sub.items():
                    fields["%s:%s" % (ifd, tag_id)] = str(value)
    except Exception:
        pass
    return im, {"exif": fields}


def handle_exif_write(req, im):
    # Basic EXIF: write the user-supplied key/value pairs (overriding the printed
    # fields). Uses Pillow's native getexif rewrite.
    im_with_exif = im.copy()
    exif = im_with_exif.getexif()
    kv = req.get("fields")
    for k, v in (kv or {}).items():
        try:
            tag = int(k) if str(k).isdigit() else EXIF_TAGS_REV.get(k)
            if tag is not None:
                exif[tag] = v
        except Exception:
            continue
    return im_with_exif


def handle_raw_convert(req, im):
    try:
        import rawpy
    except Exception as e:
        raise RuntimeError("RAW processing requires rawpy (based on libraw). Install rawpy with: run: python3 scripts/install.py (missing: %s)" % e)
    src = req["from"]
    raw = rawpy.imread(src)
    try:
        rgb = raw.postprocess(use_camera_wb=bool(req.get("camera_wb", True)))
    finally:
        raw.close()
    from PIL import Image
    return Image.fromarray(rgb)


def handle_upscale(req, im):
    # Lightweight upscaling: prefers the realesrgan-ncnn-vulkan CLI (an external
    # executable, not a Python package).
    exe = os.environ.get("DSH_REALESRGAN_EXE", "realesrgan-ncnn-vulkan")
    if shutil.which(exe) is None and not os.path.exists(exe):
        raise RuntimeError(
            "Upscaling requires the external realesrgan-ncnn-vulkan CLI (Vulkan inference, no PyTorch). "
            "Download it and point the DSH_REALESRGAN_EXE environment variable at the executable."
        )
    scale = int(req.get("scale", 2))
    src = req["from"]
    tmp = tempfile.mkdtemp(prefix="realesrgan_")
    try:
        # realesrgan-ncnn-vulkan only writes png, so render into the temp directory
        out_png = os.path.join(tmp, "sr.png")
        env = dict(os.environ)
        cmd = [exe, "-i", src, "-o", out_png, "-s", str(scale)]
        if req.get("model"):
            cmd += ["-m", str(req["model"])]
        if req.get("n"):
            cmd += ["-n", str(req["n"])]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=env)
        if proc.returncode != 0 or not os.path.exists(out_png):
            raise RuntimeError("realesrgan failed: " + (proc.stderr or proc.stdout or "")[-400:])
        return open_image(out_png)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def handle_colorspace(req, im):
    cv2 = get_cv2()
    import numpy as np
    from PIL import Image
    target = req.get("target", "rgb").lower()
    rgb_arr = np.array(im.convert("RGB"))
    if target in ("hsv", "hsl"):
        out = cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2HSV)
        # scale to 0-255 so it can be stored
        h, s, v = out[:, :, 0] / 2, out[:, :, 1], out[:, :, 2]
        out = np.stack([h, s, v], axis=-1).astype(np.uint8)
    elif target == "lab":
        out = cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2LAB)
    elif target == "gray":
        out = cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2GRAY)
        return Image.fromarray(out).convert("L")
    elif target == "cmyk":
        cmyk = im.convert("RGB").convert("CMYK")
        return cmyk
    else:
        raise ValueError("colorspace target must be rgb/hsv/lab/gray/cmyk")
    return Image.fromarray(out)


def handle_morphology(req, im):
    cv2 = get_cv2()
    import numpy as np
    from PIL import Image
    op = req.get("op", "erode").lower()
    size = int(req.get("size", 3))
    ops = {
        "erode": cv2.MORPH_ERODE,
        "dilate": cv2.MORPH_DILATE,
        "open": cv2.MORPH_OPEN,
        "close": cv2.MORPH_CLOSE,
        "gradient": cv2.MORPH_GRADIENT,
    }
    if op not in ops:
        raise ValueError("morphology op must be erode/dilate/open/close/gradient")
    gray = np.array(im.convert("L"))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (size, size))
    out = cv2.morphologyEx(gray, ops[op], kernel)
    return Image.fromarray(out).convert("RGB")


# ---- EXIF tag map (common tags) ---------------------------------------------

EXIF_TAGS = {
    0x010F: "Make", 0x0110: "Model", 0x0112: "Orientation", 0x0132: "DateTime",
    0x013B: "Artist", 0x01EA: "Photographer", 0x0827: "Comments",
    0x829A: "ExposureTime", 0x829D: "FNumber", 0x8827: "ISOSpeedRatings",
    0x9201: "ShutterSpeed", 0x9202: "Aperture", 0x9209: "Flash",
    0x920A: "FocalLength", 0x9003: "DateTimeOriginal", 0x9004: "DateTimeDigitized",
}
EXIF_TAGS_REV = {v: k for k, v in EXIF_TAGS.items()}


# ---- dispatch ---------------------------------------------------------------

P0 = {
    "resize": handle_resize, "rotate": handle_rotate, "flip": handle_flip,
    "convert": handle_convert, "adjust": handle_adjust, "blur": handle_blur,
    "sharpen": handle_sharpen, "composite": handle_composite,
    "watermark": handle_watermark, "thumbnail": handle_thumbnail,
}
P1 = {
    "edges": handle_edges, "equalize_hist": handle_equalize_hist,
    "denoise": handle_denoise, "perspective": handle_perspective,
    "stitch": handle_stitch, "remove_background": handle_remove_background,
}
P2 = {
    "exif_read": handle_exif_read, "exif_write": handle_exif_write,
    "raw_convert": handle_raw_convert, "upscale": handle_upscale,
    "colorspace": handle_colorspace, "morphology": handle_morphology,
}
ACTIONS = {**P0, **P1, **P2}
ACTIVITY = {
    "resize": "P0 basic transform", "rotate": "P0 basic transform", "flip": "P0 basic transform",
    "convert": "P0 basic transform", "adjust": "P0 basic transform", "blur": "P0 basic transform",
    "sharpen": "P0 basic transform", "composite": "P0 basic transform", "watermark": "P0 basic transform",
    "thumbnail": "P0 basic transform", "edges": "P1 advanced", "equalize_hist": "P1 advanced",
    "denoise": "P1 advanced", "perspective": "P1 advanced", "stitch": "P1 advanced",
    "remove_background": "P1 advanced", "exif_read": "P2 extras", "exif_write": "P2 extras",
    "raw_convert": "P2 extras", "upscale": "P2 extras", "colorspace": "P2 extras",
    "morphology": "P2 extras",
}


def main(argv):
    if len(argv) < 1:
        print(json.dumps({"error": "usage: image-edit.py <request.json path>"}))
        return 2
    req_path = argv[0]
    if not os.path.exists(req_path):
        print(json.dumps({"error": "request file not found: %s" % req_path}))
        return 1
    with open(req_path, "r", encoding="utf-8") as f:
        req = json.load(f)

    action = req.get("action")
    if not action or action not in ACTIONS:
        print(json.dumps({"error": "unknown action '%s' (supported: %s)" % (action, ", ".join(sorted(ACTIONS)))}))
        return 1

    src = req.get("from")
    out = req.get("out")
    if not src or not os.path.exists(src):
        print(json.dumps({"error": "input file does not exist: %s" % src, "action": action}))
        return 1
    if not out:
        print(json.dumps({"error": "out (output path) is required", "action": action}))
        return 1

    try:
        if action == "raw_convert":
            im = None
            result = handle_raw_convert(req, None)
            width, height, bytes_n, fmt = save_image(result, out, action)
        elif action == "exif_read":
            im = open_image(src)
            result, extra = handle_exif_read(req, im)
            width, height = result.width, result.height
            bytes_n = os.path.getsize(out) if os.path.exists(out) else None
            fmt = None
            # exif_read does not modify the file, it just reports the exif data
            print(json.dumps({
                "ok": True, "out_path": None, "width": result.width, "height": result.height,
                "bytes": 0, "format": None, "summary": "read %d EXIF fields" % len(extra.get("exif", {})),
                "action": action, "extra": extra,
            }))
            return 0
        elif action == "exif_write":
            im = open_image(src)
            result = handle_exif_write(req, im)
            width, height, bytes_n, fmt = save_image(result, out, action)
        else:
            im = open_image(src)
            result = ACTIONS[action](req, im)
            width, height, bytes_n, fmt = save_image(result, out, action)

        print(json.dumps({
            "ok": True, "out_path": out, "width": width, "height": height,
            "bytes": bytes_n, "format": fmt, "action": action,
            "summary": "%s completed (%s): %dx%d -> %s (%d bytes)" % (
                ACTIVITY.get(action, action), action, width, height, os.path.basename(out), bytes_n),
        }))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e), "action": action}))
        return 1


if __name__ == "__main__":
    try:
        code = main(sys.argv[1:])
    except Exception as e:  # top-level safety net
        print(json.dumps({"error": "unexpected: %s" % e}))
        code = 1
    sys.exit(code)
