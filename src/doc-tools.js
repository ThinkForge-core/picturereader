/**
 * picturereader — document_to_image tool.
 *
 * Converts a local Office/PDF document into a list of per-page PNG paths so a
 * text-only model can then analyze them with the existing image_scan /
 * image_ocr / image_sample / vision_analyze tools. Purely local (no network).
 *
 * Supported inputs: .pdf / .docx / .doc / .xlsx / .xls / .pptx / .ppt
 *
 * Conversion chain (runs in the installer-managed `media` Python environment
 * via scripts/doc-to-image.py so the timeouts / page caps / LibreOffice
 * handling stay in one reusable place):
 *
 *   .pdf  ──────────────►  PyMuPDF(fitz) render each page to PNG
 *   office  ──LibreOffice──► PDF ──fitz──► PNG
 *            (soffice --headless --convert-to pdf, independent profile)
 *
 * Environment requirements (checked at runtime, with clear messages instead
 * of crashes):
 *   - the `media` venv with pymupdf installed — its interpreter comes from
 *     `DSH_MEDIA_PYTHON`, the installer state file, or the default venv
 *     prefix; otherwise the tool points at `python3 scripts/install.py`.
 *   - LibreOffice `soffice`, resolved by `paths.sofficePath()`
 *     (`DSH_SOFFICE` -> state file -> PATH -> known locations). Missing ->
 *     the error names the package to install.
 *
 * @module picturereader/doc-tools
 */

import { extname, join, basename as pathBasename, resolve as pathResolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mediaPython, sofficePath, installHint } from './paths.js';
import { defaultOutputDir, missingFileHint } from './workspace-paths.js';

/** Absolute path to scripts/doc-to-image.py (this module lives in src/). */
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'doc-to-image.py');

/** Hard cap on how many bytes we read into memory per input document. */
const MAX_INPUT_BYTES = 512 * 1024 * 1024; // 512 MB

const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']);

/** Validate an integer in [min, max], throwing a tool-prefixed error. */
function parseBoundedInt(raw, fallback, min, max, label) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`document_to_image: ${label} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('document_to_image: cancelled');
}

/** Resolve a writable out_dir: explicit path, or a temp dir under the OS tmp. */
function resolveOutDir(raw, fingerprint, cwd) {
  if (raw !== undefined && raw !== null && String(raw).trim().length > 0) {
    const p = String(raw).trim();
    // Resolve relative paths against the session cwd like other tools.
    return cwd ? pathResolve(cwd, p) : pathResolve(p);
  }
  return join(defaultOutputDir('doc', { cwd, stamp: fingerprint }),
    `${Date.now()}-${randomBytes(4).toString('hex')}`);
}

/**
 * Run the doc-to-image.py conversion for a single document that has already
 * been materialized at a real local path. Returns the parsed JSON summary.
 */
function runDocPython(inputPath, outDir, prefix, dpi, maxPages, timeoutMs, signal) {
  throwIfAborted(signal);
  const python = mediaPython();
  const args = [SCRIPT_PATH, inputPath, outDir, prefix, String(dpi), String(maxPages)];
  const soffice = sofficePath();
  const res = spawnSync(python, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(soffice !== null ? { DSH_SOFFICE: soffice } : {}) },
    ...(signal ? { signal } : {}),
  });
  if (res.error) {
    if (res.error.code === 'ABORT_ERR' || signal?.aborted) {
      throw new Error('document_to_image: cancelled');
    }
    if (res.error.code === 'ENOENT') {
      throw new Error(
        `document_to_image: the Python environment for conversion is missing (expected interpreter: ${python}). ${installHint()}.`
      );
    }
    if (res.error.code === 'ETIMEDOUT') {
      throw new Error('document_to_image: conversion timed out (>120s) — check whether the document is damaged or too large, or lower max_pages / dpi.');
    }
    throw new Error(`document_to_image: cannot run the conversion script: ${res.error.message}`);
  }
  if (res.signal && res.signal === 'SIGTERM' && signal?.aborted) {
    throw new Error('document_to_image: cancelled');
  }
  if (res.signal || res.status === null) {
    throw new Error('document_to_image: the conversion process was terminated (timeout or interrupt)');
  }
  if (res.status !== 0 || !res.stdout) {
    // Failure (or empty output): the script exits non-zero and puts a JSON
    // error object on stdout/stderr.
    const body = (res.stderr || res.stdout || '').trim();
    let msg = body;
    try {
      const parsed = JSON.parse(body.split('\n')[0]);
      if (parsed && parsed.error) msg = parsed.error;
    } catch { /* body is raw text */ }
    throw new Error(`document_to_image: conversion failed: ${msg || `exit code ${res.status}`}`);
  }
  // Success path: parse the last JSON line (the script prints exactly one).
  const line = res.stdout.trim().split('\n').filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch (e) {
    throw new Error(`document_to_image: cannot parse the conversion script output: ${e.message}`);
  }
}

/**
 * Build the `document_to_image` tool.
 * @param ctx - the Cordis context providing `ctx.fs`.
 */
export function createDocumentToImageTool(ctx) {
  return {
    name: 'document_to_image',
    description: [
      'Convert a local Office/PDF document (pdf / docx / doc / xlsx / xls / pptx / ppt) into a list of per-page PNG image paths, ' +
        'so the pages can then be inspected with the existing image_scan / image_ocr / image_sample / vision_analyze tools. Purely local (no network).',
      'Parameters: file_path (required, a single document) — or file_paths (array) to convert several documents in one call; ' +
        'out_dir (optional, output directory; defaults to a temp dir under the system temp); ' +
        'dpi (optional 72..300, default 150 — higher = sharper but larger PNGs); ' +
        'max_pages (optional 1..500, default 50 — render only the first N pages of multi-page docs).',
      'Returns, per document: input (original name), page_count (total page count), ' +
        'pages: [{ index, path, width, height, bytes }], out_dir (where the PNGs live), and a summary.',
      'The PNGs remain on disk in out_dir so subsequent image_scan / image_ocr calls can read them by path.',
      'PDFs render directly with PyMuPDF; other Office formats are first converted to PDF via headless LibreOffice. ' +
        'Requires the plugin Python environment (pymupdf) and LibreOffice — if either is missing the tool returns a clear setup hint.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to a single document (pdf/docx/doc/xlsx/xls/pptx/ppt). Use either this or file_paths, not both.'
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of document paths to convert in one call (batch). Use either this or file_path, not both.'
        },
        out_dir: {
          type: 'string',
          description: 'Optional output directory for the generated PNGs. Defaults to a temp dir under the system temp.'
        },
        dpi: {
          type: 'integer',
          description: 'Render resolution in dots per inch (72..300, default 150).'
        },
        max_pages: {
          type: 'integer',
          description: 'Maximum number of pages to render (1..500, default 50). Pages beyond this are skipped (noted).'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          documents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                input: { type: 'string' },
                page_count: { type: 'integer' },
                rendered: { type: 'integer' },
                truncated: { type: 'boolean' },
                pages: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      index: { type: 'integer' },
                      path: { type: 'string' },
                      width: { type: 'integer' },
                      height: { type: 'integer' },
                      bytes: { type: 'integer' }
                    },
                    required: ['index', 'path', 'width', 'height', 'bytes']
                  }
                }
              },
              required: ['input', 'page_count', 'rendered', 'pages']
            }
          },
          out_dir: { type: 'string' },
          summary: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['documents', 'out_dir', 'summary']
      },
      render: (_args, value) => {
        const lines = [`documents converted to images (out_dir: ${value.out_dir})`];
        for (const d of value.documents || []) {
          lines.push(`  ${d.input}: ${d.rendered}/${d.page_count} page(s) rendered${d.truncated ? ' (truncated)' : ''}`);
          for (const p of d.pages || []) {
            lines.push(`    page ${p.index}: ${p.width}x${p.height}px, ${p.bytes} bytes → ${p.path}`);
          }
        }
        lines.push(value.summary || '');
        if (value.note) lines.push(value.note);
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      // ---- argument collection and validation ----
      const dpi = parseBoundedInt(args.dpi, 150, 72, 300, 'dpi');
      const maxPages = parseBoundedInt(args.max_pages, 50, 1, 500, 'max_pages');

      const fp = typeof args.file_path === 'string' ? args.file_path.trim() : '';
      const fps = Array.isArray(args.file_paths)
        ? args.file_paths.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
        : [];
      if (fp.length > 0 && fps.length > 0) {
        throw new Error('document_to_image: pass either file_path (single) or file_paths (batch), not both');
      }
      const targets = fp.length > 0 ? [fp] : fps;
      if (targets.length === 0) {
        throw new Error('document_to_image: an input document is required (file_path or file_paths)');
      }

      const cwd = exec.agent?.session?.header?.cwd;
      const fingerprint = (exec.agent?.session?.id) || 'anon';
      const outDir = resolveOutDir(args.out_dir, fingerprint, cwd);

      // Pre-resolve every target: verify the extension, read the bytes and
      // materialize them in a temp dir (the Python side needs a real path).
      const materialized = []; // { ext, localPath, displayPath }
      for (const rawPath of targets) {
        throwIfAborted(exec.signal);
        const target = await ctx.fs.resolve(rawPath, {
          ...(cwd !== undefined ? { cwd } : {}),
          signal: exec.signal
        });
        const display = target.displayPath;
        const ext = extname(display).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) {
          throw new Error(
            `document_to_image: unsupported document type "${ext}" (supported: pdf / docx / doc / xlsx / xls / pptx / ppt): ${display}`
          );
        }
        const info = await ctx.fs.stat(target, exec.signal);
        if (!info) throw new Error(`document_to_image: file not found: ${display}${missingFileHint(display)}`);
        if (info.type !== 'file') throw new Error(`document_to_image: not a regular file: ${display}`);
        const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_INPUT_BYTES);
        // Materialize into a temp dir, keeping the extension: the Python side
        // picks the conversion chain by extension.
        const tmpDir = mkdtempSync(join(tmpdir(), 'picturereader-src-'));
        const localPath = join(tmpDir, `${pathBasename(display) || 'doc'}${Date.now()}-${randomBytes(2).toString('hex')}${ext}`);
        writeFileSync(localPath, bytes);
        materialized.push({ ext, localPath, displayPath: display, tmpDir });
      }

      const documents = [];
      // Injectable seam: tests may pass ctx._docRunner to replace the real spawn
      // (same pattern as the ctx.ocrImage injection used by image_batch).
      const runner = (typeof ctx._docRunner === 'function') ? ctx._docRunner : runDocPython;
      try {
        for (let i = 0; i < materialized.length; i += 1) {
          throwIfAborted(exec.signal);
          const { ext, localPath, displayPath } = materialized[i];
          const prefix = `page_${i + 1}`; // one prefix per document so equal basenames never collide
          const summary = runner(localPath, outDir, prefix, dpi, maxPages, 120_000, exec.signal);
          if (summary.error) {
            throw new Error(`document_to_image: ${summary.error}`);
          }
          documents.push({
            input: pathBasename(displayPath),
            page_count: summary.page_count ?? 0,
            rendered: (summary.pages || []).length,
            truncated: !!summary.truncated,
            pages: (summary.pages || []).map((p) => ({
              index: p.index,
              path: p.path,
              width: p.width,
              height: p.height,
              bytes: p.bytes
            }))
          });
        }
      } finally {
        // Clean up the materialized sources (the PNG output stays in out_dir
        // so later tools can read it).
        for (const m of materialized) {
          try {
            rmSync(m.tmpDir, { recursive: true, force: true });
          } catch { /* best effort */ }
        }
      }

      const totalPages = documents.reduce((s, d) => s + d.rendered, 0);
      const truncatedAny = documents.some((d) => d.truncated);
      const summary =
        `Converted ${documents.length} document(s), rendered ${totalPages} PNG page(s), output directory ${outDir}.` +
        (truncatedAny ? ' Some documents exceeded max_pages and only the first pages were rendered; raise max_pages or lower dpi to get more.' : '');

      return {
        documents,
        out_dir: outDir,
        summary,
        note: 'Every page PNG can be analyzed directly with image_scan / image_ocr / image_sample / vision_analyze by passing pages[].path.'
      };
    }
  };
}

// Registration factory, mirroring registerMoreTools in more-tools.js.
export function registerDocTools(ctx) {
  ctx.tools.register(createDocumentToImageTool(ctx));
}
