---
name: image-reading
description: Read and understand images like a multimodal model using the picturereader tools (image_scan / image_ocr / image_sample). Applies a verified 5-step workflow (global tone → find subjects → verify text → judge material → synthesize) guided by grounded principles and cross-image insights. Use whenever you need to look at an image.
---

# Image-reading methodology (image-reading)

Goal: **"see" an image like a multimodal model and produce a coherent description**, where
every conclusion is traceable and verifiable.
This skill is built from four layers of knowledge — experience / skill / principle / insight
(classified with the Gogomoe knowledge framework; every lesson comes from a post-mortem of real image runs).

## Where the image must live

Pass a path inside the **session workspace** (a relative path resolves against the session
cwd). Do **not** stage the file in `/tmp`: inside the DSH file sandbox `/tmp` is a private
tmpfs that is discarded when the shell command exits, so a screenshot written there by a
command is `file not found` for these tools even though the command succeeded. Crop and
edit outputs default to `<workspace>/.picturereader/...`, readable from both sides.

## Workflow (skill)

### 1. Set the global tone (first scan)

Scan the whole image with the default parameters (size=40) and read four fields:
- **`hue families` (highest priority)**: the true share of each pure hue family. In dark or low-saturation
  scenes the real colours appear only here — a high grey/white share in `colors by area` does not mean the
  image is grey and white.
- **`structure`**: parallel bands / symmetry (interpretation in insights).
- **`texture`**: high rough = realistic photograph; high smooth = flat artwork or water/sky/fog (see insights).
- **`regions`**: position / size / colour of large structures.

### 2. Find the subject (global → local, verify actively)

- For **oddly coloured areas, large dark blocks, adjacent tall thin colour blocks, dense clusters of small colour blocks**,
  zoom in with `px_per_cell` (smaller value = finer: 8-12 for outlines, 4-6 for structure, 2-3 for detail; if the region
  is too small the tool reports the actual density — shrink focus/region and retry).
- Read the zoomed view by **shape**: head + shoulders + torso = a person; arcs + symmetric light and shade = cylinder/sphere/installation;
  vertical thin structures = stone pillar/tower/pole; alternating thin bands = panel/grille.
- **A subject can be "invisible" because it has low contrast against the background** (see insights 4) — anything suspected must be
  zoomed into and confirmed; never skip it just because regions did not list it separately.

### 3. Verify text

- Suspected text / signage / UI → `image_ocr` (restricted with region/focus).
- If an OCR pass returns no text but you can still see characters → retry on a tighter region (glowing, curved, game-rendered text).
- **OCR results take precedence over the model's description** (see insights 3).

### 4. Judge the material

Use `image_sample` to take an 8×8 sample of a small area and read the RGB distribution and the contrast statistics
(smooth gradients = sky/skin/water; high-contrast stripes = metal/wood grain; dark green with G>R>B = vegetation/paint).

### 5. Synthesize the description

Output a coherent description (scene / subject / ambient light / details), **labelling the evidence level of
every conclusion**: hard fact (backed by pixel/OCR/sample data) vs inference (inferred from structure, phrased as "looks like").
Quote concrete numbers where you can; if you are unsure, say you are unsure, and never fabricate.

## Behavioural principles (principles)

1. **Grade the evidence**: label every conclusion "measured" or "inferred"; an inference must state what it rests on.
2. **Numbers first**: support descriptions with concrete metrics ("blue tone 74%", "symmetry 80%", "OCR read 1.00") rather than vague adjectives.
3. **Global before local**: the first pass sets the tone, the second pass zooms in to verify — do not skip steps.
4. **Suspect it, verify it**: for any "subject that may have been missed", verify with zoom/sampling/OCR before concluding.
5. **Do not fabricate**: say so when unsure; a model's description (multimodal models included) cannot be taken as fact directly (see insights 3).

## Regularities (insights, induced across images)

1. **In dark scenes the real colours live only in hue families**: low-saturation/dark tones (dusk, fog, night scenes)
   get flattened to grey-black by the 14-colour palette, so the grey/white share in `colors` is an illusion — hue families
   split by pure hue and are unaffected.
2. **High symmetry ≠ man-made for sure**: water reflections and mirror compositions are highly symmetric too. To tell them apart, look at:
   large smooth areas (water/sky with high smooth) + a water-sky separation line (bright above, dark below, mirrored top-to-bottom)
   + vertical thin structures (stone pillars) = lake/natural mirror; complex texture, monotonous colour, hard geometric edges = man-made building/installation.
3. **A small model cannot be trusted with small text**: a small multimodal model hallucinates on low-resolution text (it "reads" content
   from the full image and admits there is none after cropping); glowing/curved/stylised lettering defeats OCR as well — **text must always
   be taken from what OCR actually reads**.
4. **Low-contrast subjects go "invisible"**: a dark object (a figure in dark clothing, say) merges into a dark background block,
   and neither the coarse grid nor regions marks it — actively zooming into dark areas is the only reliable way to find it.
5. **Large smooth areas ≠ flat line art**: water, sky, mist and walls are all smooth (high smooth),
   so judge them together with tone/structure/scene; never call something "flat" on smooth alone.
6. **"What it looks like" and "what it is" must be kept apart**: structural evidence (symmetry/shape/tone) supports "what it looks like";
   "what it is" needs OCR/sampling/stronger evidence — without that, keep it as an inference.
7. **hue families is a fingerprint of the scene type** (induced from 34 training images):
   - cyan high (>60%) = water/fog/lake/morning mist scene (Eastern waterscapes, mist-shrouded ruins)
   - green high (>40%) = forest/bamboo grove/grassland/moss
   - orange or red high = figures in red cloaks or warm-coloured costume, firelight, sunset glow
   - blue high (>70%) = night/cool-toned sci-fi scene
   - achromatic high + rough high = ruins/rock/dark environment
   - green + yellow both high = emerald energy band/glowing vegetation/floating fairyland
   - symmetry high + central vertical structure = central subject (waterfall/tree/gate) in a centred composition
8. **A multimodal model's colour descriptions are unreliable for "glow/energy"** (recurring during training): it systematically
   calls measured cyan/blue/green cool glow (screen light, energy barrier, light shaft in fog) "pink/purple".
   For glowing elements, always take the colour from the measured hue.
9. **Signals for recognising people**: orange/red dominant + local small warm patches + symmetry = candidate figure in costume;
   game characters often wear red/orange (red cloak, red hair, warm-toned combat suit), so when you detect a warm dominant tone,
   actively zoom in to look for figures.
10. **Brand/game names/title text**: a multimodal model guesses wrong (it said "Genshin Impact"/"Honkai Impact 3rd" when the image really showed
    Arknights: Endfield), so OCR (PaddleOCR) must read it for real (game HUDs often carry the game name/parameters/watermark along the bottom).

## Case notes (experience, brief)

- Lake xianxia image: 97% symmetry was misjudged as a "man-made facade", when it was really a water reflection + stone pillars in the lake
  + pink-purple mist → the lesson became insight 2.
- Game glowing banner image: an OCR pass over 12 cells came back entirely empty and the multimodal model hallucinated "ask, answer, write",
  while OCR (PaddleOCR) read "Dare to explore, question the heavens" in one pass → the lesson became insight 3.
- Dark-background figure image: a figure in black merged into the background and was missed; at px_per_cell=3 the head, shoulders and torso
  became clear → the lesson became insight 4.

(New experience keeps being filed into this skill under the categories above.)

## The vision_analyze unified tool

When you need several kinds of evidence in one call, use `vision_analyze`:
- automatically detects blank/simple images (low-information interception)
- optional pixel scan (include_scan)
- optional OCR text recognition (include_ocr)
- optional VLM semantic description (include_vlm, requires SEE_BASE to be configured)
- all evidence is returned as text for the main model to reason over

### Recommended workflow

It is best to look first with `image_scan` yourself and only decide whether to call the VLM once you know what the image contains. A pixel scan is enough for simple images; complex scenes can call the VLM.

### Asking several questions

You can ask several questions about the same image from different angles to get a fuller understanding.

### Cross-validation

When the VLM description conflicts with the pixel/OCR evidence, go with what was measured.

See `skills/vision-analyze.md` for detailed usage.
