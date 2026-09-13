/**
 * picturereader — image_edit tool.
 *
 * Local image editing / processing tool. One tool, many actions dispatched by
 * `action` (P0 basic transforms / P1 advanced / P2 optional extras), backed by
 * the installer-managed `media` Python environment (scripts/image-edit.py;
 * Pillow + OpenCV-headless by default, optional rembg/rawpy, pure CPU, no GPU
 * and no large models).
 *
 * Same architecture as document_to_image:
 *   - the Node side materializes the input image from the DSH virtual file
 *     system into a local temp file;
 *   - it builds a request JSON (action plus all parameters) and writes it to a
 *     temp file;
 *   - spawnSync runs scripts/image-edit.py with the `media` interpreter;
 *   - the last JSON line of its stdout is the result.
 *
 * Interpreter resolution: `DSH_MEDIA_PYTHON` -> installer state file ->
 * default venv prefix. When it is missing the tool returns a clear hint
 * pointing at `python3 scripts/install.py`.
 *
 * Supported actions:
 *   P0: resize / rotate / flip / convert / adjust / blur / sharpen /
 *       composite / watermark / thumbnail
 *   P1: edges / equalize_hist / denoise / perspective / stitch / remove_background
 *   P2: exif_read / exif_write / raw_convert / upscale / colorspace / morphology
 *
 * @module picturereader/image-edit
 */

import { join, basename as pathBasename, resolve as pathResolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mediaPython, installHint } from './paths.js';
import { defaultOutputDir, missingFileHint } from './workspace-paths.js';
import { availableEditActions, termuxEditNote, TERMUX_UNAVAILABLE_EDIT_ACTIONS } from './platform-profile.js';

/** Absolute path to scripts/image-edit.py (this module lives in src/). */
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'image-edit.py');

/** Hard cap on how many bytes we read into memory per input image. */
const MAX_INPUT_BYTES = 200 * 1024 * 1024; // 200 MB

/** Default action->timeout (ms). Background removal and upscaling are slow. */
const ACTION_TIMEOUT_MS = {
  default: 120_000,
  remove_background: 300_000,
  upscale: 600_000,
  denoise: 180_000,
  perspective: 120_000,
};

const ALL_ACTIONS = [
  // P0
  'resize', 'rotate', 'flip', 'convert', 'adjust', 'blur', 'sharpen',
  'composite', 'watermark', 'thumbnail',
  // P1
  'edges', 'equalize_hist', 'denoise', 'perspective', 'stitch', 'remove_background',
  // P2
  'exif_read', 'exif_write', 'raw_convert', 'upscale', 'colorspace', 'morphology',
];

/**
 * Actions this host can run. Under Termux the three that need extras Termux
 * cannot install are withheld (see platform-profile.js) rather than offered and
 * then failing at runtime.
 */
const ACTIONS = availableEditActions(ALL_ACTIONS);

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('image_edit: cancelled');
}

/** Resolve a writable output path: explicit out, or a generated path under out_dir/temp. */
function resolveOutPath(rawOut, rawDir, fingerprint, cwd) {
  const base = rawDir !== undefined && rawDir !== null && String(rawDir).trim().length > 0
    ? (cwd ? pathResolve(cwd, String(rawDir).trim()) : pathResolve(String(rawDir).trim()))
    : defaultOutputDir('edit', { cwd, stamp: fingerprint });
  if (rawOut !== undefined && rawOut !== null && String(rawOut).trim().length > 0) {
    const p = String(rawOut).trim();
    return { out: (cwd ? pathResolve(cwd, p) : pathResolve(p)), base };
  }
  return { out: join(base, `edit_${Date.now()}-${randomBytes(4).toString('hex')}.png`), base };
}

/**
 * Run image-edit.py for a materialized request. Returns the parsed JSON result.
 */
function runImageEditPython(reqPath, timeoutMs, signal) {
  throwIfAborted(signal);
  const python = mediaPython();
  const res = spawnSync(python, [SCRIPT_PATH, reqPath], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  if (res.error) {
    if (res.error.code === 'ABORT_ERR' || signal?.aborted) {
      throw new Error('image_edit: cancelled');
    }
    if (res.error.code === 'ENOENT') {
      throw new Error(
        `image_edit: the Python environment for image processing is missing (expected interpreter: ${python}). ${installHint()}.`
      );
    }
    throw new Error(`image_edit: cannot run the image script: ${res.error.message}`);
  }
  if (res.signal && res.signal === 'SIGTERM' && signal?.aborted) {
    throw new Error('image_edit: cancelled');
  }
  if (res.signal || res.status === null) {
    throw new Error('image_edit: the processing process was terminated (timeout or interrupt)');
  }
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line || '{}');
  } catch (e) {
    throw new Error(`image_edit: cannot parse the image script output: ${e.message}`);
  }
  if (parsed?.error) {
    throw new Error(`image_edit: ${parsed.error}`);
  }
  return parsed;
}

/**
 * Build the `image_edit` tool.
 * @param ctx - the Cordis context providing `ctx.fs`.
 */
export function createImageEditTool(ctx) {
  return {
    name: 'image_edit',
    description: [
      'Local photo editing / image processing on a local image via a single unified tool (Pillow + OpenCV, pure CPU, no GPU/model). ' +
        'One call performs ONE action; see "action". All operate on a file_path and write to an output path.',
      'Supported actions (P0 basic): resize, rotate, flip, convert, adjust, blur, sharpen, composite, watermark, thumbnail.',
      'Supported actions (P1 advanced): edges, equalize_hist, denoise, perspective, stitch, remove_background.',
      'Supported actions (P2 extras): exif_read, exif_write, raw_convert, upscale, colorspace, morphology.',
      'Common params: action (required); file_path (input, required); out (optional output path, default auto in out_dir/temp); ' +
        'out_dir (optional); file_paths (array of extra inputs, used by composite/watermark/stitch). ' +
        'Action-specific params: see the action descriptions below.',
      'resize: width,height (required ints), mode (stretch|fit|fill, default stretch).',
      'rotate: angle (deg, required), expand (bool default true), fill (hex or r,g,b or transparent).',
      'flip: axis (horizontal|vertical|both, required).',
      'convert: format is inferred from OUT extension (png/jpg/webp/bmp/tiff/gif).',
      'adjust: brightness,contrast,saturation (float, 1.0 = unchanged).',
      'blur: type (gaussian|box|motion), radius (default 2).',
      'sharpen: radius (default 2), percent (default 150), threshold (default 3).',
      'composite: overlays file_paths[0] onto file_path at position (x,y or center/top_left/top_right/bottom_left/bottom_right/top_center/bottom_center) with alpha (0..1).',
      'watermark: type (text|image). text: text,color (#rrggbb),font_size,alpha,position. image: file_paths[0],position,alpha.',
      'thumbnail: width,height (max bounds, keeps aspect ratio).',
      'edges (P1): low,high (Canny thresholds).',
      'equalize_hist (P1): mode (auto|clahe).',
      'denoise (P1): strength (default 10).',
      'perspective (P1): points (8 ints, 4 corners), width,height (out size).',
      'stitch (P1): direction (horizontal|vertical), file_paths for additional images. mode (resize|raw).',
      'remove_background (P1): needs rembg installed. post_process (bool).',
      'exif_read (P2): returns extra.exif. exif_write (P2): fields (map of tag name -> value).',
      'raw_convert (P2): needs rawpy; input is a RAW file (cr2/nef/arw/dng...). camera_wb (bool).',
      'upscale (P2): needs realesrgan-ncnn-vulkan CLI (env DSH_REALESRGAN_EXE); scale (2|4), model, n.',
      'colorspace (P2): target (rgb|hsv|lab|gray|cmyk).',
      'morphology (P2): op (erode|dilate|open|close|gradient), size (kernel, default 3).',
      'Requires the plugin Python environment (Pillow + OpenCV). If it is missing the tool returns a setup hint pointing at `python3 scripts/install.py`.'
      + (termuxEditNote() ? ' ' + termuxEditNote() : '')
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'The processing action to perform. Exactly one action per call.'
        },
        file_path: {
          type: 'string',
          description: 'Main input image path (required). For raw_convert this is the RAW file.'
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra input paths (the foreground for composite/watermark, further images for stitch).'
        },
        out: {
          type: 'string',
          description: 'Output path including the extension, which determines the format. Defaults to an auto-generated file under out_dir or the temp dir.'
        },
        out_dir: {
          type: 'string',
          description: 'Output directory (optional; defaults to the system temp directory).'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          out_path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          format: { type: 'string' },
          summary: { type: 'string' },
          extra: { type: 'object', additionalProperties: true }
        },
        required: ['ok', 'action', 'summary']
      },
      render: (_args, value) => {
        const lines = [value.summary || `image_edit (${value.action})`];
        if (value.out_path) {
          lines.push(`  output: ${value.out_path}`);
          lines.push(`  size: ${value.width}x${value.height}px, ${value.bytes} bytes, ${value.format || ''}`);
        }
        if (value.extra?.exif) {
          lines.push(`  exif fields: ${Object.keys(value.extra.exif).length}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      // ---- action validation ----
      const action = typeof args.action === 'string' ? args.action.trim() : '';
      if (!ACTION_SET.has(action)) {
        if (action in TERMUX_UNAVAILABLE_EDIT_ACTIONS) {
          throw new Error(
            `image_edit: the "${action}" action is not available here — ${TERMUX_UNAVAILABLE_EDIT_ACTIONS[action]}. `
              + `Install the extras in the plugin environment to enable it (supported here: ${ACTIONS.join(', ')}).`
          );
        }
        throw new Error(`image_edit: unknown action "${action}" (supported: ${ACTIONS.join(', ')}).`);
      }

      // ---- materialize every input file ----
      const rawMain = typeof args.file_path === 'string' ? args.file_path.trim() : '';
      if (!rawMain) {
        throw new Error('image_edit: file_path is required (the input image path).');
      }
      const raws = [rawMain];
      if (Array.isArray(args.file_paths)) {
        for (const p of args.file_paths) {
          if (typeof p === 'string' && p.trim().length > 0) raws.push(p.trim());
        }
      }

      const cwd = exec.agent?.session?.header?.cwd;
      const fingerprint = exec.agent?.session?.id || 'anon';
      const { out, base } = resolveOutPath(args.out, args.out_dir, fingerprint, cwd);

      const tmpDir = mkdtempSync(join(tmpdir(), 'picturereader-edit-src-'));
      const materialized = []; // { localPath }
      try {
        for (const raw of raws) {
          throwIfAborted(exec.signal);
          const target = await ctx.fs.resolve(raw, {
            ...(cwd !== undefined ? { cwd } : {}),
            signal: exec.signal
          });
          const display = target.displayPath;
          const info = await ctx.fs.stat(target, exec.signal);
          if (!info || info.type !== 'file') {
            throw new Error(`image_edit: file not found: ${display}${missingFileHint(display)}`);
          }
          const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_INPUT_BYTES);
          const localBase = pathBasename(display) || `img${Date.now()}`;
          // Keep the original extension: Pillow/rawpy sniff by content or
          // extension, and raw_convert feeds a RAW file.
          const localPath = join(tmpDir, localBase);
          writeFileSync(localPath, bytes);
          materialized.push({ localPath, displayPath: display });
        }

        // ---- build the request JSON (action + passthrough params + materialized paths) ----
        const passKeys = ['width', 'height', 'mode', 'keep_ratio', 'angle', 'expand', 'fill', 'axis',
          'brightness', 'contrast', 'saturation', 'type', 'radius', 'percent', 'threshold',
          'position', 'alpha', 'text', 'color', 'font_size', 'low', 'high', 'strength',
          'points', 'direction', 'post_process', 'fields', 'camera_wb', 'scale', 'model', 'n',
          'target', 'op', 'size'];
        const params = {};
        for (const k of passKeys) {
          if (args[k] !== undefined && args[k] !== null) params[k] = args[k];
        }
        const request = {
          action,
          from: materialized[0].localPath,
          out,
          ...(materialized.length > 1 ? { from_extra: materialized.slice(1).map((m) => m.localPath) } : {}),
          ...params,
        };
        const reqPath = join(tmpDir, 'request.json');
        writeFileSync(reqPath, JSON.stringify(request));

        // ---- call the backend (injectable seam for tests) ----
        const runner = typeof ctx._imageEditRunner === 'function'
          ? ctx._imageEditRunner
          : (rp, tm, sig) => runImageEditPython(rp, tm, sig);
        const timeout = ACTION_TIMEOUT_MS[action] || ACTION_TIMEOUT_MS.default;
        const result = runner(reqPath, timeout, exec.signal);

        return {
          ok: true,
          action,
          out_path: result.out_path ?? out,
          width: result.width ?? null,
          height: result.height ?? null,
          bytes: result.bytes ?? null,
          format: result.format ?? null,
          summary: result.summary || `image_edit ${action} finished.`,
          extra: result.extra ?? undefined,
          _baseDir: base,
        };
      } finally {
        // Clean up the input temp dir (the output stays for later tools).
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch { /* best effort */ }
      }
    }
  };
}

const ACTION_SET = new Set(ACTIONS);
export { ACTIONS, ALL_ACTIONS };

// Registration factory, consistent with the other tools (called from index.js).
export function registerImageEdit(ctx) {
  ctx.tools.register(createImageEditTool(ctx));
}
