---
name: vision-analyze
description: Unified image understanding tool that combines pixel scan, OCR, and optional VLM for complete image analysis. Use when you need one call to both verify what is in the image and get a natural-language interpretation.
whenToUse: Use when you need several kinds of evidence about an image in one call (pixel scan + OCR + VLM description).
---

# The vision_analyze unified image-reading tool

## Tool overview

`vision_analyze` is the unified image-reading entry point of picturereader; one call returns:
- **Pixel-scan evidence** (image_scan)
- **OCR text recognition** (image_ocr)
- **VLM semantic description** (optional, requires SEE_BASE to be configured)

## Where the image must live

Pass a path inside the **session workspace** (`screenshots/shot.png` is enough: a relative
path resolves against the session cwd). Do **not** put the file in `/tmp`. A shell command
runs inside the DSH file sandbox, where `/tmp` is a private tmpfs discarded when the command
exits, while this plugin runs in the DSH host process and sees the host's own `/tmp`. A
screenshot written to `/tmp` by a shell command is therefore reported here as `file not
found` - the file exists, in the other mount namespace. Outputs these tools generate
(`document_to_image`, `image_edit`, `image_crop`) default to `<workspace>/.picturereader/...`,
which both sides can read.

## Core features

### 1. Low-information interception
Automatically detects blank/simple images to prevent VLM hallucination:
- too few colour kinds (≤8)
- a single colour taking up too much of the image (≥90%)
- one dominant colour with very few edges
- brightness variance too small

### 2. Evidence cross-validation
- When the VLM description conflicts with the pixel/OCR evidence, go with what the pixel/OCR pass measured
- All evidence is returned as text for the main model to reason over

### 3. Optional VLM configuration
- No VLM is configured by default, so only pixel-scan and OCR evidence are returned
- To use a VLM, set the `SEE_BASE` environment variable

### 4. Smart invocation strategy
- **Simple image**: do not call an external API; pixel scan + OCR are enough
- **Complex/detailed image**: call the external API for semantic understanding
- **Multiple questions**: several questions about the same image from different angles are supported

## Usage advice

### Recommended workflow

It is best to look first with `image_scan` yourself and only decide whether to call the VLM once you know what the image contains:

```
# Look at the image content first
image_scan(file_path="screenshots/shot.png", size=32)

# Decide the next step from the result
# - simple image → describe it directly, no VLM needed
# - text needed → image_ocr
# - complex scene → vision_analyze (with VLM)
```

### When to call the VLM

A pixel scan is enough for simple images; complex scenes can call the VLM for semantic understanding. You decide, based on the image content.

### Cross-validation

The main model must cross-validate the VLM result:

1. **Pixel evidence first**: when the VLM description conflicts with the pixel scan, go with the pixel evidence
2. **OCR first**: when text recognised by the VLM conflicts with OCR, go with OCR
3. **Logic check**: when the VLM description is illogical (e.g. "the sky is green"), mark it as a hallucination
4. **Multi-question validation**: ask several questions about the same image from different angles and check consistency

### Multi-question strategy

You can ask several questions about the same image from different angles to get a fuller understanding:

```
# First: overall description
vision_analyze(
  file_path="screenshots/shot.png",
  prompt="Describe the overall content of this image",
  include_scan=true,
  include_ocr=true,
  include_vlm=true
)

# Second: asking about details
vision_analyze(
  file_path="screenshots/shot.png",
  prompt="What text is in the image? List it in detail",
  include_scan=false,
  include_ocr=false,
  include_vlm=true
)

# Third: reasoning and judgement
vision_analyze(
  file_path="screenshots/shot.png",
  prompt="Is this interface design reasonable? What problems does it have?",
  include_scan=false,
  include_ocr=false,
  include_vlm=true
)
```

## How to use it

### Basic usage (no VLM)
```
vision_analyze(
  file_path="screenshots/shot.png",
  include_scan=true,
  include_ocr=false,
  include_vlm=false
)
```

### Full usage (with VLM)
```
vision_analyze(
  file_path="screenshots/shot.png",
  prompt="Describe this interface: which elements are there? Is the layout normal?",
  include_scan=true,
  include_ocr=true,
  include_vlm=true,
  allow_low_info=false,
  stop_after=false
)
```

### Asking several questions
```
# Ask several questions about the same image from different angles
vision_analyze(file_path="screenshots/shot.png", prompt="overall description", include_vlm=true)
vision_analyze(file_path="screenshots/shot.png", prompt="what text is there?", include_vlm=true)
vision_analyze(file_path="screenshots/shot.png", prompt="is the design reasonable?", include_vlm=true)
```

## Parameters

| Parameter | Type | Default | Description |
|------|------|--------|------|
| `file_path` | string | required | Image path (PNG/JPEG/GIF/BMP) |
| `prompt` | string | "Describe this image in detail." | VLM prompt |
| `include_scan` | boolean | true | Whether to include pixel-scan evidence |
| `include_ocr` | boolean | false | Whether to include OCR text recognition |
| `ocr_language` | string | unset | BCP-47 language tag selecting the PaddleOCR recognition model (e.g. `en-US`, `zh-Hans`); unknown tags fall back to the multilingual default |
| `include_vlm` | boolean | true | Whether to include the VLM description (requires SEE_BASE to be configured) |
| `allow_low_info` | boolean | false | Whether low-information images may call the VLM |
| `stop_after` | boolean | false | Whether to stop the local llama-server after the call |

## Output format

```json
{
  "path": "screenshots/shot.png",
  "lowInformation": false,
  "scan": "[scan]\nimage: screenshots/shot.png (1920x1080 -> 32x18 cells, ...)\n...",
  "ocr": "[ocr]\nocr: screenshots/shot.png (1920x1080, region=full, engine=paddle, lang=en)\n...",
  "vlm": "[vlm]\nThis is a screenshot of a desktop application, containing...",
  "combined": "[scan]\n...\n\n---\n\n[ocr]\n...\n\n---\n\n[vlm]\n..."
}
```

## Use cases

### 1. UI/interface verification
```
vision_analyze(
  file_path="screenshots/ui.png",
  prompt="Which buttons does this interface have? Is the layout normal? Is anything misaligned?",
  include_scan=true,
  include_ocr=true,
  include_vlm=true
)
```

### 2. Game screenshot analysis
```
vision_analyze(
  file_path="screenshots/game.png",
  prompt="Which game is this? What characters/objects are in the frame?",
  include_scan=true,
  include_ocr=true,
  include_vlm=true
)
```

### 3. Document/image OCR
```
vision_analyze(
  file_path="screenshots/document.png",
  include_scan=false,
  include_ocr=true,
  include_vlm=false,
  ocr_language="en-US"
)
```

### 4. Visual verification of long tasks
```
# Loop verification flow
1. take a screenshot
2. vision_analyze(file_path="screenshots/step1.png", include_scan=true, include_ocr=true)
3. compare against expectations
4. if it differs, fix it
5. take another screenshot to verify
```

## Configuration

### PaddleOCR

PaddleOCR is the only OCR engine the plugin ships, and `image_ocr` needs it.
Install it with the project installer:

```bash
python3 scripts/install.py
```

That creates the `paddle` environment and warms its model cache. The result is
recorded in `~/.dsh/picturereader/env.json`, which the plugin reads at runtime;
these environment variables override it when you need a non-default location:

```bash
DSH_PADDLE_PYTHON=~/.dsh/picturereader/venvs/paddle/bin/python
DSH_PADDLE_CACHE=~/.paddlex-cache
```

### VLM (optional, not configured by default)
```bash
# Local llama-server
SEE_BASE=http://127.0.0.1:8080/v1
SEE_MODEL=Huihui-Qwen3-VL-4B-Instruct-abliterated
SEE_SERVER_EXE=/opt/llama/llama-server
SEE_SERVER_MODEL=/opt/llama/models/model.f16.gguf
SEE_SERVER_MMPROJ=/opt/llama/models/mmproj-f16.gguf
SEE_SERVER_PORT=8080
SEE_SERVER_NGL=20
SEE_SERVER_CTX=16384

# Remote API
SEE_BASE=https://api.openai.com/v1
SEE_MODEL=gpt-4-vision-preview
SEE_API_KEY=sk-xxx
```

## Notes

1. **VLM optional**: no VLM is configured by default; `vision_analyze` then skips the VLM call and returns only pixel-scan and OCR evidence
2. **Low-information interception**: blank/simple images are intercepted automatically and do not call the VLM (to prevent hallucination)
3. **Evidence priority**: pixel scan > OCR > VLM (go with what was measured on conflict)
4. **Performance**: a VLM call takes 2-5 seconds; enable it only when semantic understanding is needed
5. **WebP not supported**: convert to PNG/JPEG first

## Relation to the other tools

- **image_scan**: pixel-level scan, returns detailed colour/structure evidence
- **image_ocr**: text recognition, returns OCR text
- **image_sample**: material/texture sampling
- **vision_analyze**: unified entry point combining the evidence above + an optional VLM

**Workflow you must follow**:
1. **Look first with `image_scan` yourself** (pixel scan) → learn the image content and complexity
2. Decide from the scan result:
   - simple image (uniform colour, simple structure) → no VLM needed, describe it directly
   - text needed → use `image_ocr`
   - complex scene (many figures, many objects, complex background) → use `vision_analyze` (with VLM)
   - material detail needed → use `image_sample`
3. **Do not call the VLM directly** — look yourself first, then decide whether an external API is needed
