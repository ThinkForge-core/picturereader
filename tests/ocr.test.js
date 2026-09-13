/**
 * OCR tests.
 *
 * PaddleOCR is the only OCR engine, so the tests that actually recognize text
 * need the installer-managed `paddle` venv. When that environment is absent
 * they are skipped instead of failing, which keeps the suite green on a fresh
 * checkout; everything that does not need the engine (crop, PNG encode,
 * language mapping, the "environment missing" error path) always runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cropRgba,
  encodePng,
  ocrImage,
  decodeImage,
  paddleAvailable,
  paddlePython,
  paddleLangFor,
  PADDLE_DEFAULT_LANG
} from '../src/core.js';
import { createImageOcrTool } from '../src/tool.js';
import { makeQuadrantRgba } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures-out', 'ocr-test.png');
const CHECKED_IN_FIXTURE = join(HERE, 'fixtures', 'ocr-text.png');

/** Whether the PaddleOCR environment is installed (gates the real OCR tests). */
const PADDLE_READY = existsSync(paddlePython());
const NEED_PADDLE = PADDLE_READY ? false : `PaddleOCR venv not found at ${paddlePython()} — run: python3 scripts/install.py`;

/** Provide the text-bearing test image from the checked-in fixture. */
function ensureOcrTestImage() {
  mkdirSync(dirname(OUT), { recursive: true });
  if (existsSync(OUT)) return;
  if (!existsSync(CHECKED_IN_FIXTURE)) {
    throw new Error(`missing test fixture: ${CHECKED_IN_FIXTURE}`);
  }
  copyFileSync(CHECKED_IN_FIXTURE, OUT);
}

test('cropRgba: crops a fraction region', () => {
  const rgba = makeQuadrantRgba();
  const cropped = cropRgba(rgba, 100, 100, [0, 0, 0.5, 0.5]);
  assert.equal(cropped.width, 50);
  assert.equal(cropped.height, 50);
  // top-left pixel of the crop is the red quadrant
  assert.deepEqual([cropped.data[0], cropped.data[1], cropped.data[2]], [216, 27, 27]);
});

test('cropRgba: full region returns the whole image', () => {
  const rgba = makeQuadrantRgba();
  const cropped = cropRgba(rgba, 100, 100, undefined);
  assert.equal(cropped.width, 100);
  assert.equal(cropped.height, 100);
  assert.deepEqual([cropped.data[0], cropped.data[1], cropped.data[2]], [216, 27, 27]);
});

test('encodePng: roundtrips through the PNG decoder', () => {
  const rgba = makeQuadrantRgba();
  const bytes = encodePng(rgba, 100, 100);
  const decoded = decodeImage(bytes, '.png');
  assert.equal(decoded.width, 100);
  assert.equal(decoded.height, 100);
  assert.deepEqual([decoded.data[0], decoded.data[1], decoded.data[2]], [216, 27, 27]);
});

test('paddleLangFor: maps BCP-47 tags onto PaddleOCR 3.x language codes', () => {
  // PaddleOCR 3.x takes a language, not the 2.x group name.
  assert.equal(paddleLangFor('en-US'), 'en');
  assert.equal(paddleLangFor('zh-Hans'), 'ch');
  assert.equal(paddleLangFor('zh-Hant'), 'chinese_cht');
  assert.equal(paddleLangFor('zh-TW'), 'chinese_cht');
  assert.equal(paddleLangFor('ja'), 'japan');
  assert.equal(paddleLangFor('ko'), 'korean');
  // East Slavic languages select the eslav model through their own code
  assert.equal(paddleLangFor('ru'), 'ru');
  assert.equal(paddleLangFor('ru-RU'), 'ru');
  assert.equal(paddleLangFor('uk'), 'uk');
  assert.equal(paddleLangFor('be'), 'be');
  // other Cyrillic languages keep their code and reach the cyrillic model
  assert.equal(paddleLangFor('bg'), 'bg');
  assert.equal(paddleLangFor('mk'), 'mk');
  assert.equal(paddleLangFor('kk'), 'kk');
  assert.equal(paddleLangFor('sr'), 'rs_cyrillic', 'Serbian defaults to the Cyrillic model');
  // Latin-script languages are passed through as themselves
  assert.equal(paddleLangFor('de-CH'), 'de');
  assert.equal(paddleLangFor('fr'), 'fr');
  assert.equal(paddleLangFor('es'), 'es');
  assert.equal(paddleLangFor('pl'), 'pl');
  assert.equal(paddleLangFor('tr'), 'tr');
  assert.equal(paddleLangFor('vi'), 'vi');
  // other scripts
  assert.equal(paddleLangFor('ar'), 'ar');
  assert.equal(paddleLangFor('fa'), 'fa');
  assert.equal(paddleLangFor('hi'), 'hi');
  assert.equal(paddleLangFor('th'), 'th');
  assert.equal(paddleLangFor('ka'), 'ka');
  // case and surrounding whitespace are ignored
  assert.equal(paddleLangFor('  EN-us '), 'en');
  assert.equal(paddleLangFor('ZH'), 'ch');
  // unknown or empty input falls back to the default
  assert.equal(paddleLangFor('qq-ZZ'), PADDLE_DEFAULT_LANG);
  assert.equal(paddleLangFor(''), PADDLE_DEFAULT_LANG);
  assert.equal(paddleLangFor(undefined), PADDLE_DEFAULT_LANG);
  assert.equal(paddleLangFor(null), PADDLE_DEFAULT_LANG);
  assert.equal(PADDLE_DEFAULT_LANG, 'ch');
});

test('paddleLangFor: never returns a PaddleOCR 2.x group name', () => {
  // Regression guard. PaddleOCR 2.x used group names such as "cyrillic" and
  // "latin"; PaddleOCR 3.x rejects them with
  // "No models are available for lang='cyrillic'", so the mapping must emit
  // per-language codes only.
  const groupNames = ['cyrillic', 'latin', 'arabic', 'devanagari', 'eslav'];
  const probes = ['ru', 'uk', 'bg', 'sr', 'de', 'fr', 'es', 'en', 'ar', 'fa', 'hi', 'zh', 'ja', 'ko', 'unknown'];
  for (const probe of probes) {
    const code = paddleLangFor(probe);
    assert.ok(!groupNames.includes(code), `paddleLangFor(${probe}) must not return the 2.x group name "${code}"`);
  }
  // And every one of these really is a language PaddleOCR accepts.
  const accepted = new Set([
    'ch', 'chinese_cht', 'en', 'japan', 'korean', 'th', 'el', 'te', 'ta', 'ka',
    'ru', 'uk', 'be', 'bg', 'mk', 'kk', 'sr', 'rs_cyrillic',
    'de', 'fr', 'es', 'pl', 'tr', 'vi', 'ar', 'fa', 'hi'
  ]);
  for (const probe of probes) {
    if (probe === 'unknown') continue;
    assert.ok(accepted.has(paddleLangFor(probe)), `unexpected code ${paddleLangFor(probe)} for ${probe}`);
  }
});

test('paddleAvailable: false for a missing interpreter', async () => {
  assert.equal(await paddleAvailable('/definitely/not/here/python'), false);
});

function makeFakeCtx(bytes) {
  const emitted = [];
  const ctx = {
    tools: { register() {} },
    emit(...args) { emitted.push(args); },
    fs: {
      async resolve(path) { return { targetKey: `/img/${path}`, displayPath: `/img/${path}` }; },
      async stat() { return { version: 'v1', type: 'file', size: bytes.length }; },
      async readBytes() { return bytes; }
    }
  };
  return { ctx, emitted };
}

const EXEC = { signal: undefined, agent: { session: { header: { cwd: '/work' } } } };

test('image_ocr: a missing environment produces an actionable error', { skip: PADDLE_READY ? 'PaddleOCR is installed' : false }, async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const { ctx } = makeFakeCtx(readFileSync(OUT));
  const tool = createImageOcrTool(ctx);
  await assert.rejects(
    () => tool.execute({ file_path: 'ui.png' }, EXEC),
    /PaddleOCR environment is missing.*scripts\/install\.py/
  );
});

test('image_ocr tool: argument validation does not need the engine', async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const { ctx } = makeFakeCtx(readFileSync(OUT));
  const tool = createImageOcrTool(ctx);
  await assert.rejects(
    () => tool.execute({ file_path: 'ui.png', region: [0, 0, 0.5, 0.5], focus: [0, 0, 4, 4] }, EXEC),
    /region and focus are mutually exclusive/
  );
  await assert.rejects(() => tool.execute({ file_path: 'ui.png', language: '   ' }, EXEC), /language must be a non-empty/);
  await assert.rejects(() => tool.execute({ file_path: 'notes.txt' }, EXEC), /unsupported image type/);
  await assert.rejects(() => tool.execute({ file_path: 'x.webp' }, EXEC), /WebP is not supported/);
  await assert.rejects(() => tool.execute({}, EXEC), /file_path must be a non-empty string/);
});

test('image_ocr tool: the schema no longer exposes an engine parameter', () => {
  const { ctx } = makeFakeCtx(Buffer.alloc(0));
  const tool = createImageOcrTool(ctx);
  assert.equal(tool.parameters.properties.engine, undefined);
  assert.ok(tool.parameters.properties.language, 'language stays, and selects the recognition model');
  assert.equal(tool.output.schema.properties.engine.type, 'string');
  assert.ok(tool.output.schema.properties.lang, 'the resolved PaddleOCR language code is reported');
});

test('ocrImage: recognizes English and Chinese text end to end', { skip: NEED_PADDLE }, async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const buffer = readFileSync(OUT);
  const result = await ocrImage(buffer, '.png', {});
  assert.ok(result.width > 0 && result.height > 0);
  const allText = result.lines.map((l) => l.text).join(' ');
  assert.match(allText, /OCR/, 'should recognize the English word OCR');
  assert.match(allText, /世/, 'should recognize Chinese characters');
  assert.ok(result.lines[0].x >= 0 && result.lines[0].width > 0, 'line box should be populated');
});

test('ocrImage: region crop restricts recognition', { skip: NEED_PADDLE }, async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const buffer = readFileSync(OUT);
  // top 20% has no text (text sits around y 60..122 of 220)
  const empty = await ocrImage(buffer, '.png', { region: [0, 0, 1, 0.2] });
  assert.equal(empty.lines.length, 0);
  // band around the text still recognizes it
  const hit = await ocrImage(buffer, '.png', { region: [0, 0.25, 1, 0.7] });
  assert.ok(hit.lines.length > 0);
});

test('image_ocr tool: full pipeline through execute', { skip: NEED_PADDLE }, async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(OUT);
  const { ctx, emitted } = makeFakeCtx(bytes);
  const tool = createImageOcrTool(ctx);
  const result = await tool.execute({ file_path: 'ui.png' }, EXEC);
  assert.equal(result.path, '/img/ui.png');
  assert.equal(result.region, 'full');
  assert.equal(result.engine, 'paddle');
  assert.equal(result.lang, PADDLE_DEFAULT_LANG);
  const allText = result.lines.map((l) => l.text).join(' ');
  assert.match(allText, /OCR/);
  assert.match(allText, /世/);
  assert.ok(result.lines.every((l) => l.score !== undefined), 'paddle lines carry confidence scores');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'fs/observed');
  const rendered = tool.output.render({}, result).map((p) => p.text).join('\n');
  assert.match(rendered, /recognized \d+ line\(s\)/);
  assert.match(rendered, /ocr: \/img\/ui\.png .*engine=paddle/);
});

test('image_ocr tool: the configured OCR language is used when no argument is given', { skip: NEED_PADDLE }, async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const { ctx } = makeFakeCtx(readFileSync(OUT));
  const tool = createImageOcrTool(ctx);
  const { setRuntimeConfig } = await import('../src/runtime.js');
  try {
    setRuntimeConfig({ mode: 'smart', ocr_language: 'ru' });
    const fromSettings = await tool.execute({ file_path: 'ui.png' }, EXEC);
    assert.equal(fromSettings.lang, 'ru', 'the settings value must reach the recognition model');

    const explicit = await tool.execute({ file_path: 'ui.png', language: 'en' }, EXEC);
    assert.equal(explicit.lang, 'en', 'an explicit argument overrides the setting');
  } finally {
    setRuntimeConfig({ mode: 'smart' });
  }
});

test('image_ocr tool: the language argument selects the reported model', { skip: NEED_PADDLE }, async () => {
  ensureOcrTestImage();
  const { readFileSync } = await import('node:fs');
  const { ctx } = makeFakeCtx(readFileSync(OUT));
  const tool = createImageOcrTool(ctx);
  const result = await tool.execute({ file_path: 'ui.png', language: 'en-US', focus: [1, 0, 5, 30] }, EXEC);
  assert.equal(result.lang, 'en');
  assert.equal(result.region, 'focus [1,0,5,30]');
});
