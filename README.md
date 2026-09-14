# picturereader

> **v3.3.2 · Linux-only** — full "see images / read documents / edit photos" capability for text-only LLMs such as DeepSeek.
> It combines a **visual twin adapter** (wraps any text-only model in place so DSH treats it as image-capable → native thumbnails plus automatic image analysis), **three-mode routing** (privacy / smart / strict), a **local pixel-level toolchain** (scan / RapidOCR / crop / palette / compare / batch), **document to image** (pdf / word / excel / ppt), a **local image editor `image_edit`** (Pillow + OpenCV, pure CPU: resize / rotate / filters / composite / watermark / background removal / upscale and more) and an **optional external VLM bridge**. One plugin, the whole chain.

[![dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) [![dsh.so security](https://www.dsh.so/badge/picturereader.svg)](https://www.dsh.so/artifact/picturereader) [![dsh.so install](https://www.dsh.so/badge/install/picturereader.svg)](https://www.dsh.so/artifact/picturereader)

---

## Why this exists

Text-only models such as DeepSeek have no vision encoder, so they cannot look at an image directly; and DSH only renders its native thumbnail when the model is declared as image-capable. picturereader closes that gap in three ways:

1. **It translates "look at this image / read this document" into structured textual evidence** a text-only model can reason about: pixel-level hue / structure / material analysis, real OCR text, and (optionally) a VLM semantic description — distilled into a reusable image-reading skill.
2. **It gives text-only models a native thumbnail experience inside DSH through the visual twin adapter**: check a model and a "(vision)" variant is generated, images paste in as native thumbnails and enter the conversation as image blocks, then get analyzed automatically into a text path plus local evidence before the model ever sees them. Even when the upstream entry point degrades an image to an `attachment sha256` text reference, the image bridge recovers the file from the local attachment object store — header-validated — and injects the local tool path. The model always receives plain text, so `UNSUPPORTED_CONTENT` is never triggered.
3. **It edits and batch-processes images locally**: `image_edit` offers resize, rotate, filters, compositing, watermarking, background removal, stitching, perspective correction and more — pure CPU, and image bytes never leave the machine.

> ⭐ **External vision APIs are supported** (OpenAI-compatible endpoints, LM Studio, cloud VLMs) and are called by the LLM on demand: once an endpoint is configured, the model decides for itself in smart / strict mode whether an image is worth an external call, using `vision_analyze` for semantic understanding, while simple content is handled by local pixel analysis and OCR. **The external API is a plug-in enhancement, never a hard dependency.**

> **Version compatibility**: this release targets **dsh 0.1.3-alpha.1 / dsheac 5.4.0** and remains compatible with **dsh 0.1.1-rc.2**, **dsheac 5.1.0**, DeepSeek Harness EAC 4.2.0 and `@deepseek-ai/dsh-client-ui-workspace` rc.7. `peerDependencies` uses the joint range `^0.1.0-rc.6 || ^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.3-alpha.1`, covering all three 0.1.x release lines.
>
> ⚠️ **dsh 0.1.3 removed the `settingsNamespace()` export** from `@deepseek-ai/dsh-settings` (namespace validation moved inside `register()`). Importing a symbol that no longer exists fails at ESM link time, which takes down the whole plugin tree and trips EAC's guard mode. This release passes the bare `NS` straight to `sctx.settings.register(NS, Config, { base: config })` instead; the returned scope still offers `get / watch / update / replace`.

> 🚀 **Planned as a built-in vision plugin for DeepSeek Harness EAC**: picturereader is intended to replace the bundled `dsh-tool-vision` and ship with the DSH EAC desktop build out of the box. It is published as a standalone package so that non-EAC and older-version users can get the same image / document reading capability through the plugin installer.

## Feature overview

### 1. Visual twin adapter (native thumbnails + automatic analysis)

- **In-place proxy wrapping**: for the provider that owns the checked models, `Proxy` wraps its adapter into a "twin" and replaces it in place (`registerTwinAdapters`; uninstall is restored through `ctx.effect`), with no duplicate registration.
- **`listModels` / `resolveModel`**: checked models are declared with `inputModalities: ['text','image']` and a "(vision)" name suffix → DSH believes they accept images → **native thumbnail rendering, image blocks in the conversation and paste admission** are all unlocked.
- **`stream` interception**: `image` blocks in the request are captured → exported to `~/.dsh/picturereader-vision/images/` → replaced by a text path plus local toolchain guidance → forwarded to the original adapter. **pi-ai receives plain text and never raises `UNSUPPORTED_CONTENT`**; providers built on `@earendil-works/pi-ai`, such as `opencode-go`, gain native thumbnails through the same twin.
- In privacy mode analysis stays local: nothing is ever sent out.

### 2. Routing (privacy / smart / strict)

**This is the brain of picturereader**: `routing.js` plus `runtime.js` decide "when to call the external VLM, when to stay local, and whether to cross-validate", and every tool, the image bridge, the visual twin `stream` hook and `vision_analyze` share that single policy, so the whole image chain obeys one set of rules.

#### How a routing decision is made

Every time an image arrives, the underlying question is the same: "what is this image worth spending, and which route reads it best?" picturereader pre-defines three strategies; the model decides within them and the host enforces hard limits on top:

```
image arrives → twin stream interception / tool call
              → read the current "mode" → get that mode's routing policy
              → model / tool picks a route:
                   local pixel analysis (image_scan / image_sample)
                   local text recognition (image_ocr → RapidOCR)
                   external semantic understanding (vision_analyze include_vlm=true → VLM)
                   cross-validation (compare evidence from several routes)
```

The core decision function `visionAnalyzeDefaults(mode)` defines each mode's default evidence combination:

| Mode | default include_scan | default include_ocr | default include_vlm | allow_low_info |
|---|---|---|---|---|
| **privacy** | ✅ | ✅ | ❌ (hard-disabled) | ❌ |
| **smart** | ✅ | ❌ (on demand) | ✅ (only when worth it) | ❌ |
| **strict** | ✅ | ✅ | ✅ | ❌ |

#### What each mode asks the model to do

**🕶 Privacy — zero outbound calls, enforced on the host**
- **Never calls** any external vision endpoint, even if an API key is configured in the settings card.
- The constraint is enforced host-side: `runtime.js` makes `isVlmConfigured()` permanently `false`, `vision_analyze` forces `include_vlm=false`, and the visual twin's degraded `stream` text states explicitly that only local tools may be used.
- The model can only use local tools: `image_scan` / `image_ocr` / `image_sample` / `image_crop` / `image_palette` / `image_compare` / `image_edit`. Image bytes never leave the machine.
- Suited to sensitive images (ID documents, contracts, private screenshots), offline work and zero-external-traffic audits.

**⚡ Smart — fewer turns, less time (default)**
- Goal: **push the cost as low as possible and only go external for genuinely complex content**.
- Flow: `image_scan` first for an overview → then decide:
  1. mostly text → `image_ocr` is enough, **no VLM needed**;
  2. an ordinary chart / UI / simple content → `image_scan` + `image_sample` answer it, **no VLM needed**;
  3. only when the content is complex and needs semantic understanding (photos, abstract scenes) **and** an endpoint is configured, call `vision_analyze(include_vlm=true)` to reach the external VLM.
- The visual twin always exports the image to a local path first, so the model can dig deeper locally whenever it wants and is never trapped into "I must call out".

**🎯 Strict — cross-validation, close inspection**
- Goal: **reliability first**, cost is secondary.
- Flow: `image_scan` for the overview → `image_ocr` for text and `image_sample` for fine detail when needed → **cross-validate** key conclusions by comparing pixel evidence, OCR evidence and (optionally) the VLM description instead of trusting a single source.
- External VLM use is allowed (when configured), but heavier and fully traceable.
- Suited to work that needs high accuracy and reproducible conclusions (image review, proofreading, data analysis).

> **The privacy hard gate applies to every entry point**: whichever tool or bridge is used, the mode snapshot from `runtime.js` is re-checked at the call site, and `routePolicyText(mode)` additionally injects the current policy into the guidance handed to the model — belt and braces.

#### Interaction with the visual twin adapter

The three modes constrain not only `vision_analyze` but also the `stream` interception installed by `registerTwinAdapters`: image blocks are **always** replaced by text (path plus local-evidence guidance — that is the precondition for a text-only model to understand anything), but **whether and when to go further and call the VLM** is decided by the current mode. Privacy mode never passes an image through and never makes an external call; smart and strict call out only when it is needed and configured. "Native thumbnails" and "privacy with zero outbound calls" therefore hold at the same time without conflict.

### 3. Local analysis toolchain (fully local reading)

| Tool | Purpose |
|---|---|
| `image_scan` | Whole-image or regional scan: color grid + region blobs + shade diversity + texture + structure + hue families; supports `focus` / `region` / `px_per_cell` for targeted zoom. |
| `image_ocr` | Text recognition through **RapidOCR** (ONNX Runtime), with an optional `language` BCP-47 tag or model key selecting the recognition model. By default every line is read with **both** bundled models — Chinese/English and East Slavic/Cyrillic — and the higher-scoring reading wins (see the OCR languages table below). |
| `image_sample` | N×N exact pixel sampling to judge material and texture. |
| `image_crop` | Crop by `region` and write out a PNG. |
| `image_palette` | Color extraction: dominant color list (hex + palette name + share) plus hue families. |
| `image_compare` | Pixel comparison of two images or two regions: `mean_diff` / `diff_ratio` / `diff_box` / `verdict`, with an optional difference preview PNG. |
| `image_batch` | Batch scale and context validation: batch scan + type classification + automatic full OCR + a recommendation on which images are worth deepening. |
| `vision_analyze` | Unified entry point: low-information guard plus optional pixel scan / OCR / VLM, routed by mode, returning evidence from several routes. |
| `document_to_image` | Render documents (pdf / word / excel / ppt) page by page to PNG for per-page OCR and scan analysis. |
| `image_edit` | Local image editing and batch processing with 22 CPU-only actions. |

> **OCR note**: `image_ocr` runs on **RapidOCR** (ONNX Runtime). That is the engine the installer creates (`--engine ocr`, the default) and the only one that installs on every platform, aarch64/Termux included. Its Python environment is therefore required for `image_ocr` (`--skip-ocr` during installation leaves it out). A missing environment yields a clear "run the installer" hint instead of a raw error. The **legacy PaddleOCR** environment (`--engine paddle`) still works and is still detected at runtime, so an older installation keeps working — but it is not what a fresh install produces, and it has no aarch64 wheel.

> **OCR languages matter.** The recognition model is chosen by language, and a wrong model returns confident nonsense rather than an error. By default `image_ocr` reads every line with **two** models at once — Chinese/English (`ch`) and East Slavic/Cyrillic (`eslav`) — and keeps the higher-scoring reading, so Russian, English and Chinese can be mixed in one image without declaring anything. Forcing a single model is faster and is the right thing when the script is known. Set it once in the settings card (**OCR default language**, advanced) or per call with the `language` argument; both a BCP-47 tag and a model key are accepted:

| Text you need to read | `language` / `ocr_language` |
|---|---|
| Mixed scripts, or unknown | *(leave empty — both bundled models, the default)* |
| Chinese (Simplified) + English + digits | `ch` (or `zh`, `zh-Hans`) |
| Russian, Ukrainian, Belarusian | `eslav` (or `ru`, `uk`, `be`) |
| Other Cyrillic (Bulgarian, Serbian, Kazakh, …) | `cyrillic` (or `bg`, `sr`, `kk`, …) |
| Latin-script European (German, French, Spanish, Polish, Turkish, Vietnamese, …) | `latin` (or `de`, `fr`, `es`, `pl`, `tr`, `vi`, …) |
| Japanese | `japan` (`ja`) |
| Traditional Chinese | `chinese_cht` |
| Korean, Thai, Greek, Georgian | `korean` (`ko`), `th`, `el`, `ka` |
| Arabic, Persian, Urdu | `arabic` (`ar`, `fa`, `ur`) |
| Hindi, Marathi, Nepali | `devanagari` (`hi`, `mr`, `ne`) |
| Tamil, Telugu | `ta`, `te` |

`ch` and `eslav` ship with the environment — the installer warms them up, so they work offline immediately. Every other model is downloaded on first use into the environment's own model cache. The `language` argument of a call always overrides the setting.

### 4. Document to image — `document_to_image`

Converts **pdf / docx / doc / xlsx / xls / pptx / ppt** page by page into PNG (LibreOffice headless → PDF → PyMuPDF) so the model can OCR or scan-analyze each page. Fully local, zero network; supports `dpi` / `max_pages` / `out_dir` and batch `file_paths`. PDFs are rendered directly by PyMuPDF; Office formats are first converted to PDF by headless LibreOffice, which is auto-detected (`DSH_SOFFICE`, then the state file, then `PATH`, then the usual Linux locations such as `/usr/bin/soffice`).

### 5. External VLM bridge (supported, called by the LLM itself)

**External vision APIs are supported, and the timing of the call is entirely up to the LLM**: once an OpenAI-compatible endpoint is configured (LM Studio, llama-server, a cloud gateway, the free GLM-4V-Flash model, …), the model in **smart / strict mode** decides whether an image deserves an external call — simple content is covered by local pixels and OCR, while complex content (photos, abstract scenes, anything needing semantic understanding) goes through `vision_analyze(include_vlm=true)`, which sends the image as a data URI to the external VLM via `sendVisionRequest` and brings back a description. **The base URL gets `/v1/chat/completions` appended automatically**, so there is no need to type the full path.

- The LLM calling on its own means you never switch models or attach images by hand: the model follows the mode policy and calls the external API exactly when the policy says it should.
- Privacy mode remains a hard gate: even with an external API configured, it is never called and no image bytes are ever sent.

### 6. Settings card "Image reading"

The Web settings page registers an "Image reading" card in the settings-panel design language (grouped cards, pill buttons, collapsible advanced section) with the usage mode, the external vision API, the vision-bridge model multi-select and the advanced settings (see [Settings card fields](#settings-card-fields)). Changes are written to `~/.dsh/settings.yaml` and take effect immediately.

### 7. Paste an image and go

With the visual twin enabled and a "(vision)" model variant selected: paste or drag in an image → native thumbnail → image block enters the conversation → intercepted by the twin `stream` hook → exported as a text path plus local evidence → the text-only model gets the result and can keep digging with `image_scan` / `image_ocr`.

### 8. Local image editor — `image_edit`

A single tool dispatching many actions, backed by the installer-managed `media` Python environment (Pillow + OpenCV-headless, plus the optional rembg / rawpy / realesrgan CLI), **pure CPU, no GPU and no large models**. Image bytes never leave the machine.

> Dependencies are installed with `python3 scripts/install.py`; add `--with-optional` for `rembg` (background removal) and `rawpy` (RAW input). See [image_edit](#image_edit) below.

## Tools

| Tool | Summary |
|---|---|
| `image_scan` | Coarse pixel grid (luminance and/or color), connected color regions, shade diversity, texture density, structural hints (stripes, symmetry, gradients), true color shares and hue families. Zoom with `focus` (grid coordinates from a previous scan), `region` (0..1 fractions) or `px_per_cell` (source pixels per cell). |
| `image_ocr` | RapidOCR text recognition over the whole image or a `region` / `focus`, returning each line with its pixel bounding box and confidence. Optional `language` BCP-47 tag or model key (`ru`, `en-US`, `zh-Hans`, `eslav`, `de`, …) selecting the recognition model; it falls back to the configured `ocr_language`, then to the two-model default. |
| `image_sample` | Exact N×N pixels of a small region plus a local-contrast statistic, for material and texture judgement. |
| `image_crop` | Crop to a fraction region and write a lossless PNG, ready for a follow-up `image_scan` / `image_ocr`. |
| `image_palette` | Dominant colors plus a hue-family breakdown for an overall tone read. |
| `image_compare` | Pixel-by-pixel comparison of two images or two regions, optionally restricted to the same fraction region, with a diff preview PNG. |
| `image_batch` | Triage a batch of images: type guess, text density, OCR excerpt and a deepening recommendation for each, in one compact manifest. |
| `vision_analyze` | One call that runs the low-information guard and returns `scan` / `ocr` / `vlm` evidence blocks; `ocr_language` selects the RapidOCR recognition model for the OCR block. |
| `document_to_image` | Page-by-page document rendering to PNG (see above). |
| `image_edit` | 22 local editing actions (see below). |

## image_edit

Local single-image or batch editing. Example prompts:

```text
Use image_edit to scale <path> to width 800: action=resize, file_path=<path>, width=800, height=600
Add a bottom-left text watermark to <path>: action=watermark, file_path=<path>, type=text, text="©2026", position=bottom_left, font_size=40
Composite <foreground> onto <background>: action=composite, file_path=<background>, file_paths=[<foreground>], position=bottom_right, alpha=0.8
Stitch <IMG1> and <IMG2> horizontally: action=stitch, file_path=<IMG1>, file_paths=[<IMG2>], direction=horizontal
```

Everything runs in the shared `media` environment created by `scripts/install.py` — the same environment `document_to_image` uses — plus two external pieces described under [Dependencies](#dependencies-and-graceful-degradation).

### Supported actions (P0 / P1 / P2)

| Tier | Action | Description | Dependency |
|---|---|---|---|
| **P0** | `resize` | Scale: `width,height` plus `mode` (stretch/fit/fill). | Pillow |
| **P0** | `rotate` | Rotate: `angle` in degrees, `expand`, `fill`. | Pillow |
| **P0** | `flip` | Flip: `axis` (horizontal/vertical/both). | Pillow |
| **P0** | `convert` | Format conversion: png/jpg/webp/bmp/tiff/gif, decided by the output extension. | Pillow |
| **P0** | `adjust` | Brightness / contrast / saturation: `brightness,contrast,saturation` (1.0 = unchanged). | Pillow |
| **P0** | `blur` | Blur: `type` (gaussian/box/motion) plus `radius`. | Pillow |
| **P0** | `sharpen` | Sharpen: `radius,percent,threshold` (UnsharpMask). | Pillow |
| **P0** | `composite` | Overlay `file_paths[0]` onto the main image at `position` with `alpha`. | Pillow |
| **P0** | `watermark` | Watermark: `type=text` (`text,color,font_size`) or `type=image` (`file_paths[0]`). | Pillow |
| **P0** | `thumbnail` | Thumbnail: `width,height` (aspect ratio preserved). | Pillow |
| **P1** | `edges` | Edge detection / outlining: `low,high` (Canny). | OpenCV |
| **P1** | `equalize_hist` | Histogram equalization (contrast boost): `mode` (auto/clahe). | OpenCV |
| **P1** | `denoise` | Denoise: `strength` (fastNlMeansDenoisingColored, pure CPU). | OpenCV |
| **P1** | `perspective` | Perspective correction (straighten skewed documents or buildings): `points` (8 ints) plus `width,height`. | OpenCV |
| **P1** | `stitch` | Multi-image stitching: `direction` (horizontal/vertical) plus `file_paths`. | Pillow |
| **P1** | `remove_background` | Background removal with U²-Net (needs `rembg` from `--with-optional`; roughly 35 MB, tens of seconds on CPU). | rembg |
| **P2** | `exif_read` | Read EXIF (Make/Model/exposure …). | Pillow |
| **P2** | `exif_write` | Write EXIF: `fields` (tag name → value). | Pillow |
| **P2** | `raw_convert` | RAW conversion via `rawpy` (libraw based, installed with `--with-optional`). | rawpy |
| **P2** | `upscale` | 2–4× super-resolution through the standalone `realesrgan-ncnn-vulkan` CLI (Vulkan, no PyTorch). | external CLI |
| **P2** | `colorspace` | Color space conversion: `target` (rgb/hsv/lab/gray/cmyk). | OpenCV |
| **P2** | `morphology` | Morphology: `op` (erode/dilate/open/close/gradient) plus `size`. | OpenCV |

### Dependencies and graceful degradation

- **All P0 actions** need only Pillow; **P1 apart from `remove_background`** needs only OpenCV-headless. Both live in the shared `media` environment.
- `remove_background` needs `rembg` and `raw_convert` needs `rawpy`, both installed with `python3 scripts/install.py --with-optional`.
- `upscale` needs the external `realesrgan-ncnn-vulkan` CLI, which is available in the AUR on Arch Linux; point `DSH_REALESRGAN_EXE` at the binary.
- When an optional dependency is missing, the tool does **not** crash: it returns a clear message telling you which dependency is absent and how to install it (or to set `DSH_REALESRGAN_EXE`).
- The environment is never located by guesswork: `mediaPython()` resolves `DSH_MEDIA_PYTHON`, then the installer state file, then `~/.dsh/picturereader/venvs/media/bin/python`. When nothing is found, the tool returns the "run the installer" hint.
- Every action has a default timeout of 120 s; `remove_background` gets 300 s, and `upscale` / `denoise` get longer budgets so nothing blocks in the background.

## document_to_image

Runs in the same shared `media` environment as `image_edit` (PyMuPDF, Pillow, OpenCV-headless, piexif) and additionally requires LibreOffice headless for Office formats. Parameters: `file_path` or `file_paths` (batch), `out_dir` (defaults to a temporary directory), `dpi` (72–300, default 150) and `max_pages` (1–500, default 50). If either the Python environment or LibreOffice is missing, the tool returns an explicit hint rather than failing obscurely.

## Installation

### Requirements

- **Linux** (this release targets Linux only).
- **Termux / Android**: *not* installed with the script below, under any flag. A device needs a `proot-distro` Debian rootfs — Termux is Bionic libc, so PyPI's manylinux wheels do not apply there and the environments would have to be compiled from source. The device therefore runs a separate [`termux` branch](https://github.com/ThinkForge-core/picturereader/tree/termux) with its own bootstrap; **start from that branch's README, not this one.** The branch model itself is described under [Development](#development).
- **Node.js** `^22.19` or `>=24` for DSH itself (per `engines` in `package.json`).
- **Python 3** to run the installer scripts. The default RapidOCR environment needs nothing beyond that; only the **legacy** PaddleOCR environment (`--engine paddle`) additionally needs an interpreter of **version 3.13 or older**, because `paddlepaddle` publishes no cp314 wheels.
- **LibreOffice** (headless `soffice`) only if you want `document_to_image` to handle Office formats; it is auto-detected on `PATH` and in the usual Linux install locations.

### Install

```sh
cd /path/to/picturereader
python3 scripts/install.py
```

That single command manages the **whole project**: it installs the plugin into a DSH profile, creates the Python environments, warms up OCR, and writes the state file.

```sh
# Install into a specific profile, everything unattended
python3 scripts/install.py --profiles web --yes

# Preview the entire plan without changing anything, then verify an existing install
python3 scripts/install.py --dry-run
python3 scripts/install.py --verify

# Install from a local checkout, an npm spec or a tarball
python3 scripts/install.py --from /path/to/picturereader
python3 scripts/install.py --spec npm
python3 scripts/install.py --spec tgz

# Skip the OCR environment (smaller, faster; image_ocr stays unavailable)
python3 scripts/install.py --skip-ocr

# Add the optional image-editing dependencies (rembg for background removal, rawpy for RAW)
python3 scripts/install.py --with-optional

# Put the environments somewhere else and use a private package index
python3 scripts/install.py --venv-prefix /opt/picturereader/venvs --index-url https://pypi.example.org/simple

# Also install the bundled image-reading skill into ~/.dsh/skills
python3 scripts/install.py --install-skill

# Machine-readable output for automation
python3 scripts/install.py --json
```

### `install.py` flags

| Flag | Effect |
|---|---|
| `--from <path>` | Install the plugin from a local directory (default: this checkout). |
| `--profiles web` | Comma-separated DSH profile(s) to install into. |
| `--dsh <path>` | Path to the `dsh` executable when it is not on `PATH`. |
| `--skip-ocr` | Do not create the OCR environment (and do not warm it up). |
| `--engine <ocr\|paddle>` | Which OCR environment to install. `ocr` (default) is RapidOCR on ONNX Runtime and is the only one that installs on aarch64; `paddle` is the legacy PaddleOCR environment and needs Python 3.13 or older. |
| `--with-optional` | Also install the optional extras: `rembg` (`remove_background`) and `rawpy` (`raw_convert`). |
| `--venv-prefix <dir>` | Directory for the Python environments (default `~/.dsh/picturereader/venvs`). |
| `--index-url <url>` | Python package index to use for pip. |
| `--locked` | Install strictly from the hashed `*.lock.txt` files next to the pinned ones. |
| `--install-skill` | Copy the bundled image-reading skill into `~/.dsh/skills`. |
| `--yes` | Answer yes to every prompt (unattended install). |
| `--dry-run` | Print the full plan and change nothing. |
| `--verify` | Check an existing installation and report what is present, missing or broken. |
| `--force` | Redo steps even when they already look complete. |
| `--json` | Emit machine-readable JSON instead of human text. |
| `--quiet` | Reduce output to warnings and errors. |
| `--verbose` | Extra diagnostic output. |
| `--color <auto\|always\|never>` | Colour control; `auto` disables colour when the output is not a terminal or `NO_COLOR` is set. |
| `--selftest` | Run the installer's own self-test and exit. |

### What the installer creates

| Component | Default location | Contents |
|---|---|---|
| Plugin registration | the selected DSH profile | The plugin row installed into the profile. |
| `media` environment | `~/.dsh/picturereader/venvs/media` | PyMuPDF + Pillow + OpenCV-headless + piexif. Used by **both** `document_to_image` and `image_edit`. |
| `ocr` environment | `~/.dsh/picturereader/venvs/ocr` | RapidOCR + ONNX Runtime. Used by `image_ocr`; tiled, so long screenshots keep full resolution. |
| `paddle` environment | `~/.dsh/picturereader/venvs/paddle` | `paddlepaddle` + `paddleocr`, only with `--engine paddle`. Legacy: still detected at runtime so an older installation keeps working, but it has no aarch64 wheel. Needs Python 3.13 or older. |
| State file | `~/.dsh/picturereader/env.json` | Where the plugin reads the interpreter paths, cache locations and helper binaries the installer discovered. |
| Recognition models | inside the `ocr` environment | Downloaded and warmed up during installation, so the first `image_ocr` call is instant. |

The state file is what makes the installation reproducible: DSH does not need any environment plumbing to find the environments the installer created. Environment variables, when set, override the state file.

### A live log, never a silent progress bar

Both scripts narrate every step as it happens: the exact command being run, what is being downloaded together with its expected size, the streamed output of `pip` and `pnpm`, and the timing of each step. You can always tell what the installer is doing and how long each stage took.

## Termux / Android

Termux is Android, so it uses Bionic libc and PyPI's manylinux wheels do not
apply: `opencv-python-headless`, `pyclipper` and `shapely` have no Termux build
and would have to be compiled from source. `paddlepaddle` is worse — it
publishes **no** `manylinux*aarch64` wheel from 3.3.0 onwards at all.

The plugin therefore keeps its Python environments inside a `proot-distro`
Debian rootfs, where the glibc is manylinux-compatible and every dependency
resolves to a prebuilt aarch64 wheel. Nothing is ever compiled.

This is the **Termux branch**. On a device you run **one** script, and it is not
`scripts/install.py`:

| | Linux / desktop | Termux / Android |
|---|---|---|
| Branch | `linux` (the default branch) | `termux` |
| Installer | `python3 scripts/install.py` | `bash scripts/termux/setup.sh` |
| Python environments | `~/.dsh/picturereader/venvs/` | inside a `proot-distro` Debian rootfs |
| Why | glibc, so manylinux wheels resolve | Bionic, so those wheels do not exist |

`scripts/install.py` cannot install on a device: it creates the environments with
`pip` **inside Termux**, where `opencv-python-headless` and friends have no wheel,
so it fails partway and rewrites the state file on the way. `setup.sh` does the
same job the proot way, so it **replaces** the installer rather than following it.
The one `install.py` mode that is correct on a device is the read-only check, and
that is the last step below.

The two builds differ by exactly this section and `scripts/termux/setup.sh`: no
JavaScript and no test differs between them.

### Steps

1. **Get Termux** from F-Droid or the Termux GitHub releases. The Play Store
   build is stale and its packaging behaves differently.

2. **Clone and bootstrap.** `setup.sh` installs `proot-distro` and Termux's own
   `python3`, creates a Debian rootfs, and builds both environments inside it:

   ```sh
   pkg install -y git
   git clone -b termux https://github.com/ThinkForge-core/picturereader.git
   cd picturereader
   bash scripts/termux/setup.sh
   ```

   Budget 10–20 minutes and roughly 1.5 GB: the rootfs, then
   PyMuPDF/Pillow/OpenCV, then RapidOCR + ONNX Runtime, then the OCR models. The
   script is idempotent — re-running it repairs the environments in place.
   `bash scripts/termux/setup.sh --help` lists the flags (`--verify`,
   `--profile <name>`, `--skip-plugin`).

3. **Export the interpreters** (recommended on a device). Add to `~/.bashrc`:

   ```sh
   cat >> ~/.bashrc <<'EOF'
   export DSH_MEDIA_PYTHON="$PREFIX/bin/picturereader-media-python"
   export DSH_OCR_PYTHON="$PREFIX/bin/picturereader-ocr-python"
   export DSH_OCR_THREADS=2
   EOF
   source ~/.bashrc
   ```

   They always win over the state file, and `DSH_OCR_THREADS=2` stops ONNX
   Runtime from keeping every core busy for a whole OCR run — on a phone that is
   the difference between a warm device and a hot, flat one.

4. **Check** (read-only, safe any time):

   ```sh
   python3 scripts/install.py --verify
   ```

5. **Restart DSH** if it was already running. The bootstrap registers the plugin
   in the `web` profile; a running host picks up tool changes only after a
   restart.

### What the bootstrap does

The script installs `proot-distro`, creates a Debian rootfs, and builds two
environments inside it:

| Environment | Location (inside the rootfs) | Contents |
|---|---|---|
| `media` | `/opt/picturereader/media` | PyMuPDF + Pillow + OpenCV-headless + piexif. |
| `ocr` | `/opt/picturereader/ocr` | RapidOCR + ONNX Runtime, plus the recognition models. |

Each gets a small wrapper in `$PREFIX/bin` (`picturereader-media-python`,
`picturereader-ocr-python`) that enters the rootfs and runs the interpreter.
`proot-distro` binds the Termux home, `$PREFIX` and `/sdcard` at their original
paths, so script and image paths mean the same thing on both sides and no path
translation is needed.

It then writes both interpreters into the state file, and adds the plugin to the
`web` profile with `dsh plugin --profile web add <checkout>` — the same
registration step `install.py` performs on Linux, repeated here because on a
device it is the only part of `install.py` that could work. If `dsh` is not on
`PATH`, or the profile does not exist yet, that step prints the exact command to
run later instead of failing.

Prefer the environment variables over the state file on a device: re-running
`scripts/install.py` rewrites the state file and would drop those entries.

Deliberately **not** installed:

* **LibreOffice** (~1.5 GB). It only converts Office documents to PDF; PDFs are
  rendered by PyMuPDF directly, so `document_to_image` works on PDFs out of the
  box. Install it inside the rootfs if you actually receive `.docx`/`.xlsx`:
  `proot-distro login debian -- apt-get install -y libreoffice-core`
* **`rembg` / `rawpy`** (the optional extras). Under Termux `image_edit` hides
  the `remove_background`, `raw_convert` and `upscale` actions instead of
  advertising them and failing at runtime; installing the extras inside the
  rootfs brings them back.

Long screenshots are the case this setup is built around. Every OCR engine of
this family downscales an image whose longest side exceeds its limit
(PaddleOCR 960 px, RapidOCR 2000 px), which silently turns a stitched
screenshot into unreadable noise. `scripts/ocr.py` tiles the image instead, so
no downscaling ever happens, and reads each tile with two recognition models
(Chinese/English and East Slavic), keeping the more confident reading per line
— Russian, English and Chinese work in one pass without declaring a language.

On a 1080×11040 screenshot mixing the three scripts, that is the difference
between **98/100 lines correct** (tiled, ~6 s) and **0/100** (single pass).

## Uninstallation

```sh
cd /path/to/picturereader
python3 scripts/uninstall.py
```

The uninstaller lists **every component it manages together with its real on-disk size**, asks about each one interactively, and removes only what the installer created — nothing else is touched.

```sh
# See the full inventory without removing anything
python3 scripts/uninstall.py --dry-run

# Unattended removal, keeping the Python environments
python3 scripts/uninstall.py --yes --keep-venvs

# Remove everything except the plugin registration
python3 scripts/uninstall.py --skip-plugin

# Additionally purge a state directory created outside the defaults
python3 scripts/uninstall.py --purge-external /opt/picturereader/venvs

# Machine-readable inventory and result
python3 scripts/uninstall.py --json
```

| Flag | Effect |
|---|---|
| `--dry-run` | Show the component inventory and sizes, remove nothing. |
| `--yes` | Answer yes to every prompt (unattended removal). |
| `--keep-venvs` | Keep the Python environments (and their models) in place. |
| `--skip-plugin` | Leave the plugin registration in the DSH profile untouched. |
| `--purge-external <path>` | Also remove an environment or state directory that lives outside the default prefix. |
| `--json` | Emit machine-readable JSON. |
| `--quiet` | Reduce output to warnings and errors. |
| `--verbose` | Extra diagnostic output. |
| `--selftest` | Run the uninstaller's own self-test and exit. |

> There are no longer any per-environment setup helper scripts: `scripts/install.py` and `scripts/uninstall.py` are the only entry points for installation and removal.

## Enabling the visual twin (native thumbnails)

1. In the "Image reading" settings card, check the text-only models that should get a visual twin, then save and **restart DSH**.
2. In the model picker, choose the "(vision)" variant of that model (for example `deepseek-v4-flash (vision)`).
3. Paste or drag in an image → native thumbnail → the image block is analyzed automatically into textual evidence.

### Usage examples

```text
Use image_scan on <path> and look closely at whatever interests you.
(For complex scenes follow up with vision_analyze; if there is text, use image_ocr first;
 for a batch of images use image_batch; for documents use document_to_image page by page;
 to modify an image use image_edit, e.g. action=resize / watermark / remove_background.)
```

## Operating modes

Selected at the top of the "Image reading" card in the Web settings; changes take effect immediately.

| Mode | Calls the external vision API? | Model guidance | Typical use |
|---|---|---|---|
| **Privacy** | **Never** (even when an API is configured) | Local tools only: image_scan / image_ocr / image_sample / image_crop / image_palette / image_compare / image_edit | Sensitive images, offline work, zero external traffic |
| **Smart** (default) | Allowed, but look locally first and decide | Quick `image_scan` first; text → OCR, simple image → local, complex image → `vision_analyze` | Everyday use, fewer turns and less time |
| **Strict** | Allowed | Pick the route freely, cross-validate several evidence sources, inspect details | Work needing high accuracy and traceability |

> The privacy constraint is a host-side hard gate (`runtime.js`): in this mode `isVlmConfigured()` always returns `false`, `vision_analyze` forces `include_vlm=false`, and the image bridge guidance states that only local tools may be used.

## Settings card fields

The card follows the settings-panel design language (grouped cards / pill buttons / collapsible advanced section) and contains:

- **Usage mode**: privacy / smart / strict (`mode`).
- **Enable the external vision API (optional)**: the external vision endpoint is only shown and only callable once this is checked; unchecked, everything stays local and images are never sent out (`vlm_enabled`).
- Once checked, the following appear:
  - **Vision API base URL** (`vlm_base`, e.g. `https://api.openai.com/v1` or `http://127.0.0.1:1234`; empty disables the external VLM)
  - **Vision model** (`vlm_model`)
  - **Vision API key** (`vlm_key`, `password` + `secret`: write-only, never read back or displayed; leave empty to keep the current value, saving a new value overwrites it)
  - **Key environment variable** (`vlm_key_env`, used as a fallback when the key field is empty)
- **Vision bridge model multi-select** (`vision_models`): checking a model generates its "(vision)" variant; changes require a **DSH restart**. Already-checked models are force-merged into the list so their checkmark survives, consistently with the twin injection.
- **Advanced settings** (collapsible):

| Field | Default | Meaning |
|---|---|---|
| `vlm_timeout_ms` | `300000` | External vision request timeout in milliseconds. |
| `vlm_max_tokens` | `8192` | Maximum output tokens for the external vision call. |
| `bridge_export_dir` | empty (system temp directory, `picturereader-bridge`) | Directory the image bridge exports to. |
| `max_image_bytes` | `52428800` (50 MB) | Maximum size of a single image read, in bytes. |
| `scan_default_size` | `32` | Default `image_scan` grid size. |
| `scan_palette` | `auto` | Default `image_scan` palette (auto/full/basic/gray). |
| `scan_mode` | `auto` | Default `image_scan` mode (auto/ascii/color). |
| `ocr_language` | empty | Default OCR language, as a BCP-47 tag (e.g. `ru`, `en-US`, `zh-Hans`) or a RapidOCR model key (e.g. `eslav`, `cyrillic`, `latin`), selecting the recognition model. Leave empty for the two-model default (Chinese/English + East Slavic); see the OCR languages table above. |
| `multimodal_models` | empty | Multimodal allowlist (comma separated): these models receive images directly without degradation. |
| `request_guard` | `true` | Request guard — last-resort image block degradation on llm/stream. |
| `batch_probe_first` | `3` | How many leading images `image_batch` probes to decide whether a batch is text-dense. |
| `batch_ocr_limit_chars` | `800` | Per-image OCR excerpt length in `image_batch`. |
| `doc_dpi` | `150` | `document_to_image` render DPI. |
| `doc_max_pages` | `50` | `document_to_image` maximum page count. |
| `debug` | `false` | Debug logging (diagnostics from the llm/stream image bridge and the model cache reader). |

## Environment variables

Every variable below overrides the corresponding value from the installer state file, and is read at call time, so edits are picked up without restarting DSH.

### Paths and the shared environments

| Variable | Default | Purpose |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | Root of the DSH state directory; the installer state file and the default venv prefix live under it. |
| `DSH_MEDIA_PYTHON` | `~/.dsh/picturereader/venvs/media/bin/python` | Interpreter of the shared **media** environment, used by **both** `document_to_image` and `image_edit`. |
| `DSH_OCR_PYTHON` | `~/.dsh/picturereader/venvs/ocr/bin/python` | Interpreter of the **RapidOCR** environment used by `image_ocr`. This is the environment the installer creates; on a Termux device it is the wrapper `scripts/termux/setup.sh` generates. |
| `DSH_OCR_THREADS` | unset (ONNX Runtime's own default) | Cap on the ONNX Runtime thread pool for one OCR run. Worth setting to `2` on a phone or a small VM: without it ONNX Runtime keeps every core busy for the whole run, which heats the device and drains the battery. An empty or non-numeric value is ignored. |
| `DSH_PADDLE_PYTHON` | `~/.dsh/picturereader/venvs/paddle/bin/python` | Interpreter of the **legacy** PaddleOCR environment. Consulted only when no RapidOCR interpreter exists (`ocrEngine()` tries `ocrPython()` first, then this one). |
| `DSH_PADDLE_CACHE` | `~/.paddlex-cache` | PaddleX model cache directory (legacy PaddleOCR engine only). |
| `DSH_SOFFICE` | auto-detected (`/usr/bin/soffice`, `/usr/bin/libreoffice`, `/usr/local/bin/soffice`, …) | LibreOffice headless executable used by `document_to_image`. |
| `DSH_REALESRGAN_EXE` | `realesrgan-ncnn-vulkan` | Path to the super-resolution CLI used by `image_edit`'s `upscale` (Vulkan). |

For each venv interpreter the lookup order is: the environment variable, then the state file written by the installer, then the default prefix `~/.dsh/picturereader/venvs/<role>/bin/python`.

### External vision API / VLM (optional, also configurable in the settings card)

| Variable | Default | Purpose |
|---|---|---|
| `SEE_API_KEY` / `GLM_API_KEY` | empty | Vision API key (the settings card's `vlm_key` takes precedence). |
| `SEE_BASE` | Zhipu endpoint or the card's `vlm_base` | OpenAI-compatible vision endpoint. |
| `SEE_MODEL` | `glm-4v-flash` or the card's `vlm_model` | Vision model name. |
| `SEE_SERVER_EXE` / `SEE_SERVER_MODEL` / `SEE_SERVER_MMPROJ` | empty | Paths for auto-starting a local llama-server (optional). |
| `SEE_SERVER_PORT` / `SEE_SERVER_NGL` / `SEE_SERVER_CTX` | `8080` / `20` / `16384` | Local server parameters. |

> The settings card's `vlm_base` / `vlm_model` / `vlm_key` take precedence over the environment. In privacy mode no call is made even when everything is configured. When the endpoint has no `/v1` suffix, `/v1/chat/completions` is appended automatically.

## Code Mode compatibility

DSH presents tools in three `mode`s: `native` (the default, the model may call every tool directly), `code` (the model may only call `run_code` directly; every other tool is folded into the SDK generated for `run_code`), and `both`.

- **Every picturereader tool is mode-independent**: all of them are directly callable under `native` and `both`, and all of them remain **fully usable** under `code`, just through an in-program call inside `run_code` (`await tools.image_scan(...)`, `await tools.image_edit(...)`, `await tools.vision_analyze(...)`). The tools are projected into the generated SDK, none are dropped.
- **If you see** `Error: unknown tool "vision_analyze" ... only run_code is callable directly ...` — the plugin is not broken; the session is in `code` mode and the call was made directly anyway. Pick either fix:
  1. set that deployment's `tools.mode` to `both` (easiest: direct calls and `run_code` both work, with no slowdown);
  2. stay in `code` mode and call through `run_code` instead (see the example below).
- **Recommendation**: keep `native` or `both` for everyday use. `code` is a platform-level hardening mode that leaves only `run_code`, and for local image tools it is a net loss (more turns, more tokens), so enable it only when you must.

Calling the tools through `run_code` in `code` mode (Python):

```python
async def main():
    r = await tools.image_scan({"file_path": "/home/user/pictures/img.png"})
    return r

await main()
```

## How it compares

Compared with the common alternatives (`dsh-tool-vision`, `dsh-image-paste`, `dsh-vision-bridge`, …):

1. **Not tied to one vendor**: the visual twin works for any provider (including pi-ai based ones such as `opencode-go`, xiaomi and qiu), not just one API.
2. **The whole chain can run offline**: privacy mode makes zero outbound calls, with pure-JS local pixel tools and RapidOCR on ONNX Runtime, no cloud dependency.
3. **Complete toolchain**: cropping, color extraction, comparison, batching, document conversion and **local editing with image_edit** — all in one plugin.
4. **Native thumbnails**: real DSH image blocks (via `inputModalities`), not a text-path imitation.
5. **Fast**: local tools answer in milliseconds, and VLM calls are controlled (low-information guard plus the smart mode's "only when worth it"), saving turns and time.
6. **Write-only keys and a privacy hard gate**: the API key is stored as `role:'secret'`, never read back or displayed, and privacy mode forces `isVlmConfigured()=false` through `runtime.js`.

| Capability | **picturereader** | dsh-tool-vision | dsh-image-paste | dsh-vision-bridge |
|---|---|---|---|---|
| Native thumbnails for text-only models | ✅ visual twin adapter | ❌ | ⚠️ partial | ❌ |
| Any provider (including pi-ai based) | ✅ | vendor-bound | — | — |
| Privacy mode hard gate | ✅ | — | — | ❌ |
| Local pixel toolchain (scan/ocr/crop/palette/compare) | ✅ all built in | ⚠️ basic | ❌ | ❌ |
| Local image editing (resize/filters/watermark/background removal …) | ✅ image_edit | ❌ | ❌ | ❌ |
| Document to image (pdf/word/excel/ppt) | ✅ | ❌ | ❌ | ❌ |
| Batch / context validation | ✅ | ❌ | ❌ | ❌ |
| External VLM bridge (optional, OpenAI compatible) | ✅ | ✅ | ❌ | ✅ |
| Fully usable offline | ✅ | ⚠️ | ✅ | ❌ |

## Troubleshooting

If dragging and dropping an image does not work, check the following:

1. **Check the `dsh-file-drop` plugin**: in the DSH settings, see whether `dsh-file-drop` is enabled. If it is, try disabling it — its "drop an image and inject text" behaviour can conflict with the visual twin and the image bridge (duplicate or competing injection).
2. **Check the visual twin configuration**: make sure the models that should get a vision bridge are checked in the "Image reading" card, then restart DSH.
3. **Check the browser console**: open the developer tools and look for `[picturereader]` log lines. If there are errors, note them down.
4. **Check the network requests**: in the Network tab of the developer tools, look for requests such as `/picturereader/models`. If they are absent, the plugin may not have loaded correctly.
5. **Check the installation**: `python3 scripts/install.py --verify` reports which components are present, missing or broken.
6. **Restart DSH**: some configuration changes only take effect after a restart.

## Known limitations

- **DSH attachments are limited to roughly 5 MB per image by default**: very large images may be rejected by the host upload limit; the tool-side `max_image_bytes` (50 MB by default) is the read limit.
- **Native thumbnails require the visual twin**: a text-only model is not treated as image-capable by DSH by default, so you must check it in the settings card to generate its "(vision)" variant and restart.
- **WebP is not supported**: `image_scan` / `vision_analyze` and friends report an error for WebP, so convert to PNG or JPEG first; `image_edit`'s `convert` action can turn WebP into PNG or JPEG.
- **Some `image_edit` actions need optional dependencies**: `remove_background` (rembg) and `raw_convert` (rawpy) come from `--with-optional`, and `upscale` needs the external realesrgan CLI; when one is missing the tool returns an installation hint instead of crashing.
- **rembg downloads the U²-Net model on first run**: roughly 35–176 MB, cached in `~/.u2net` and usable offline afterwards.
- **OCR models other than the two bundled ones are downloaded on first use**: `ch` and `eslav` ship with the environment, but naming any other language pulls its model on the first call and needs a network. Multi-source fallback is used, and noisy download lines are filtered so the first call does not fail.
- **Vision bridge model changes need a DSH restart** (`vision_models` is not hot-reloaded).
- **`dsh-file-drop` should be disabled**: its "drop an image and inject text" behaviour can conflict with the visual twin and the image bridge (duplicate or competing injection). Native thumbnails plus automatic image bridge analysis already cover that need.
- **The external VLM needs a network and an endpoint**: with no endpoint configured, or while offline, the call is skipped with a clear message; privacy mode never calls out at all.
- **The legacy PaddleOCR environment needs Python 3.13 or older**: `paddlepaddle` publishes no cp314 wheels, so installing it with `--engine paddle` fails on a 3.14 interpreter. The default RapidOCR environment has no such limit.

## Development

```sh
# The "linux" branch — the primary line; sources live at the repository root
npm install
npm test                              # node:test
python3 scripts/install.py --verify    # check the local installation
python3 scripts/install.py --selftest  # the installer's own self-test
python3 scripts/uninstall.py --dry-run # component inventory and sizes
node scripts/preview.mjs               # generate fixtures and preview the rendering
```

- **Hot plugging**: the business logic is concentrated in `src/core.js`, plus the installer-aware path resolution in `src/paths.js`; tools are reloaded dynamically by mtime on each execution. Tool definitions (schemas and descriptions) and settings-card changes require restarting the host.
- **Repository layout**: `src/` holds the plugin sources, `scripts/` the Python backends (`doc-to-image.py`, `image-edit.py`) and the install/uninstall entry points, `skills/` the bundled image-reading skill, `tests/` the `node:test` suites, and `client.js` the Web settings card.
- **ZCode build**: lives on the [zcode branch](https://github.com/ThinkForge-core/picturereader/tree/zcode) of this repository (sources under `zcode/`), exposes the tools through an MCP server and is installed with `npm install picturereader-zcode`. Both builds share `src/core.js` and the image-reading skill.

### Two branches, and which one to clone

`linux` is the primary line: all the shared code, the installer, the OCR engine, the capability profile and the tests. `termux` is **exactly `linux` plus one commit** that adds `scripts/termux/setup.sh` and the "Termux / Android" README section — **no JavaScript and no test differs between the two branches**. A fix therefore lands on `linux` once and reaches the device with a merge, and the test result is identical on both.

```sh
git clone https://github.com/ThinkForge-core/picturereader.git             # Linux — this is the default branch
git clone -b termux https://github.com/ThinkForge-core/picturereader.git   # Termux / Android
```

If you are installing on a phone or tablet, **do not run `scripts/install.py` from this branch in Termux**: it cannot build the Python environments there. Clone the `termux` branch and follow its README, which drives `scripts/termux/setup.sh` instead. `install.py --verify` remains safe and useful on a device as a read-only check, and it is the last step the Termux bootstrap tells you to run.

Because the branches share all their code and their tests, Termux behaviour is verified on `linux` with the environment variable Termux itself sets:

```sh
PREFIX=/data/data/com.termux/files/usr npm test
```

## License

MIT
