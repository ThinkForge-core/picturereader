/**
 * OCR engine tests.
 *
 * Two things need guarding here:
 *
 *  1. The tiling maths in `scripts/ocr.py` is what makes a long screenshot
 *     readable at all (`plan_tiles`). It is pure Python with no OCR
 *     dependencies, so it is exercised directly through `python3`.
 *  2. The JavaScript wire contract around the runner — argument pass-through,
 *     base64 decoding and engine selection — is checked against a stub
 *     interpreter, so no model has to be installed for the suite to pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OCR_PY = join(ROOT, 'scripts', 'ocr.py');

/** Whether a usable `python3` exists; the Python-side test skips when not. */
function python3() {
  try {
    execFileSync('python3', ['-c', 'pass'], { stdio: 'ignore' });
    return 'python3';
  } catch {
    return null;
  }
}

const PY = python3();

/** Run a snippet against scripts/ocr.py with a clean argv. */
function runPy(code) {
  return execFileSync(PY, ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})\n${code}`], {
    encoding: 'utf8'
  });
}

/** A stub "interpreter" that records its argv and prints a canned payload. */
function makeStub(dir) {
  const stub = join(dir, 'stub-ocr');
  const record = join(dir, 'argv.txt');
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      'writeFileSync(process.env.STUB_RECORD, process.argv.slice(2).join("\\n"));',
      'const payload = {',
      "  engine: 'rapid', langs: ['ch', 'eslav'], width: 1080, height: 20000,",
      "  tiles: 14, notes: ['tiled'], lines: [{ text: 'Привет', score: 0.99, x: 1, y: 2, width: 3, height: 4 }]",
      '};',
      // Reproduce the `proot-distro login` hazard: a banner on stdout, one of
      // whose lines is valid base64 alphabet. Only the payload behind the
      // marker must survive.
      "process.stdout.write('root\\nWelcome to Debian\\n');",
      "process.stdout.write('@@PICTUREREADER-OCR@@\\n');",
      "process.stdout.write(Buffer.from(JSON.stringify(payload)).toString('base64') + '\\n');"
    ].join('\n')
  );
  chmodSync(stub, 0o755);
  return { stub, record };
}

test('plan_tiles: bands tile the image exactly and every tile covers its band', { skip: PY === null }, () => {
  const out = runPy(`
import json, ocr
cases = [(1080, 11040, 1600, 120), (1080, 300, 1600, 120), (3000, 2200, 1600, 120), (100, 100, 1600, 120)]
report = {}
for (w, h, m, ov) in cases:
    tiles = ocr.plan_tiles(w, h, m, ov)
    # every ownership band must lie inside its tile
    for (x0, y0, x1, y1, bx0, by0, bx1, by1) in tiles:
        assert x0 <= bx0 and y0 <= by0 and bx1 <= x1 and by1 <= y1, "band escapes its tile"
        assert x1 <= w and y1 <= h and bx1 <= w and by1 <= h, "tile escapes the image"
        assert bx1 > bx0 and by1 > by0, "empty band"
    # bands must cover the whole image exactly once, column-major walk
    cols = sorted({t[4] for t in tiles})
    covered_x = []
    for c in cols:
        col = sorted([t for t in tiles if t[4] == c], key=lambda t: t[5])
        covered_x.append((col[0][4], col[-1][6]))
        for a, b in zip(col, col[1:]):
            # Within one column only the vertical band advances.
            assert a[7] == b[5], "vertical bands must be contiguous"
            assert a[4] == b[4] and a[6] == b[6], "a column must share its x extent"
    for a, b in zip(covered_x, covered_x[1:]):
        assert a[1] == b[0], "columns must be contiguous"
    assert covered_x[0][0] == 0 and covered_x[-1][1] == w, "columns must cover the width"
    first = sorted([t for t in tiles if t[4] == cols[0]], key=lambda t: t[5])
    assert first[0][5] == 0 and first[-1][7] == h, "rows must cover the height"
    # no tile may exceed the engine limit, which is what avoids downscaling
    for (x0, y0, x1, y1, *_rest) in tiles:
        assert max(x1 - x0, y1 - y0) <= m, "tile larger than max_side"
    report["%dx%d" % (w, h)] = len(tiles)
print(json.dumps(report))
`);
  const report = JSON.parse(out);
  assert.ok(report['1080x11040'] > 1, 'a long screenshot must be tiled');
  assert.equal(report['1080x300'], 1, 'a short image must stay a single tile');
  assert.equal(report['100x100'], 1);
  assert.ok(report['3000x2200'] > 1, 'a wide image must be tiled too');
});

test('plan_tiles: a 1080x20000 screenshot is never downscaled', { skip: PY === null }, () => {
  const out = runPy(`
import ocr
tiles = ocr.plan_tiles(1080, 20000, 1600, 120)
print(max(max(t[2]-t[0], t[3]-t[1]) for t in tiles))
print(len(tiles))
`);
  const [maxSide, count] = out.trim().split('\n').map(Number);
  assert.ok(maxSide <= 1600, `tiles must stay within the engine limit, got ${maxSide}`);
  assert.ok(count >= 10, `expected many tiles for a very long image, got ${count}`);
});

test('language selection: auto covers CJK and Cyrillic, a tag narrows it', { skip: PY === null }, () => {
  const out = runPy(`
import json, ocr
print(json.dumps({
  "auto": ocr.language_list("auto"),
  "empty": ocr.language_list(""),
  "ru": ocr.language_list("ru-RU"),
  "en": ocr.language_list("en-US"),
  "zh": ocr.language_list("zh-Hans"),
  "zhHant": ocr.language_list("zh-Hant"),
  "ja": ocr.language_list("ja"),
  "key": ocr.language_list("cyrillic"),
  "unknown": ocr.language_list("qq-ZZ"),
}))
`);
  const r = JSON.parse(out);
  assert.deepEqual(r.auto, ['ch', 'eslav'], 'auto must read both scripts');
  assert.deepEqual(r.empty, ['ch', 'eslav']);
  assert.deepEqual(r.ru, ['eslav']);
  assert.deepEqual(r.en, ['en']);
  assert.deepEqual(r.zh, ['ch']);
  assert.deepEqual(r.zhHant, ['chinese_cht']);
  assert.deepEqual(r.ja, ['japan']);
  assert.deepEqual(r.key, ['cyrillic'], 'a raw engine key must pass through');
  assert.deepEqual(r.unknown, ['ch', 'eslav'], 'an unknown tag falls back to auto');
});

test('ocr.py: every recognition model exists for the version it asks for', { skip: PY === null }, () => {
  // Guards the mapping between a language key and the model set that ships it:
  // prompting PP-OCRv6 for `eslav`, or PP-OCRv5 for `japan`, is a hard error.
  const out = runPy(`
import json, ocr
print(json.dumps({"rec": ocr.REC_VERSION, "det": ocr.DET_VERSION, "langs": sorted(ocr.REC_VERSION)}))
`);
  const r = JSON.parse(out);
  assert.equal(r.det, 'PP-OCRv5');
  assert.equal(r.rec.eslav, 'PP-OCRv5', 'East Slavic ships with PP-OCRv5');
  assert.equal(r.rec.ch, 'PP-OCRv5');
  assert.equal(r.rec.japan, 'PP-OCRv4', 'Japanese only ships with PP-OCRv4');
  assert.equal(r.rec.chinese_cht, 'PP-OCRv4');
  assert.ok(r.langs.includes('eslav') && r.langs.includes('cyrillic') && r.langs.includes('latin'));
});

test('rapid runner: options reach the interpreter and the payload comes back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picturereader-ocr-test-'));
  const { stub, record } = makeStub(dir);
  const previous = process.env.DSH_OCR_PYTHON;
  process.env.DSH_OCR_PYTHON = stub;
  process.env.STUB_RECORD = record;
  try {
    const core = await import(`../src/core.js?t=${Date.now()}`);
    const result = await core.runRapidOcrFile('/tmp/whatever.png', {
      language: 'ru-RU',
      region: [0.1, 0.2, 0.9, 0.8],
      tile: 'on'
    });
    assert.equal(result.engine, 'rapid');
    assert.deepEqual(result.langs, ['ch', 'eslav']);
    assert.equal(result.width, 1080);
    assert.equal(result.height, 20000);
    assert.equal(result.tiles, 14);
    assert.deepEqual(result.notes, ['tiled']);
    assert.equal(result.lines[0].text, 'Привет');
    assert.equal(result.lines[0].score, 0.99);

    const argv = readFileSync(record, 'utf8').split('\n');
    assert.ok(argv.some((a) => a.endsWith('ocr.py')), `runner path must be first: ${argv[0]}`);
    assert.deepEqual(argv.slice(1, 4), ['--input', '/tmp/whatever.png', '--tile']);
    assert.equal(argv[4], 'on');
    assert.ok(argv.includes('--language') && argv[argv.indexOf('--language') + 1] === 'ru-RU');
    assert.ok(argv.includes('--region') && argv[argv.indexOf('--region') + 1] === '0.1,0.2,0.9,0.8');
    assert.ok(!argv.includes('--focus'), 'focus must be omitted when only a region is given');
  } finally {
    if (previous === undefined) delete process.env.DSH_OCR_PYTHON;
    else process.env.DSH_OCR_PYTHON = previous;
    delete process.env.STUB_RECORD;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rapid runner: focus is passed through instead of a region', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picturereader-ocr-test-'));
  const { stub, record } = makeStub(dir);
  const previous = process.env.DSH_OCR_PYTHON;
  process.env.DSH_OCR_PYTHON = stub;
  process.env.STUB_RECORD = record;
  try {
    const core = await import(`../src/core.js?t=${Date.now()}-focus`);
    await core.runRapidOcrFile('/tmp/x.png', { focus: [1, 2, 3, 4] });
    const argv = readFileSync(record, 'utf8').split('\n');
    assert.ok(argv.includes('--focus') && argv[argv.indexOf('--focus') + 1] === '1,2,3,4');
    assert.ok(!argv.includes('--region'));
    assert.equal(argv[argv.indexOf('--tile') + 1], 'auto', 'tile defaults to auto');
    assert.ok(!argv.includes('--language'), 'language is omitted when not requested');
  } finally {
    if (previous === undefined) delete process.env.DSH_OCR_PYTHON;
    else process.env.DSH_OCR_PYTHON = previous;
    delete process.env.STUB_RECORD;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ocrEngine: rapid wins, paddle is the legacy fallback, null when nothing is installed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'picturereader-ocr-test-'));
  const { stub } = makeStub(dir);
  const saved = { ocr: process.env.DSH_OCR_PYTHON, paddle: process.env.DSH_PADDLE_PYTHON };
  try {
    const core = await import(`../src/core.js?t=${Date.now()}-engine`);

    process.env.DSH_OCR_PYTHON = stub;
    delete process.env.DSH_PADDLE_PYTHON;
    assert.deepEqual(await core.ocrEngine(), { engine: 'rapid', python: stub });
    assert.equal(await core.ocrAvailable(), true);

    process.env.DSH_OCR_PYTHON = join(dir, 'nope');
    process.env.DSH_PADDLE_PYTHON = stub;
    assert.deepEqual(await core.ocrEngine(), { engine: 'paddle', python: stub });

    process.env.DSH_PADDLE_PYTHON = join(dir, 'nope');
    const none = await core.ocrEngine();
    assert.equal(none.engine, null);
    assert.equal(await core.ocrAvailable(), false);
  } finally {
    if (saved.ocr === undefined) delete process.env.DSH_OCR_PYTHON; else process.env.DSH_OCR_PYTHON = saved.ocr;
    if (saved.paddle === undefined) delete process.env.DSH_PADDLE_PYTHON; else process.env.DSH_PADDLE_PYTHON = saved.paddle;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderOcr: reports the engine, the language set and the tiling note', async () => {
  const core = await import(`../src/core.js?t=${Date.now()}-render`);
  const text = core.renderOcr({
    path: 'shot.png',
    width: 1080,
    height: 20000,
    region: 'full',
    engine: 'rapid',
    lang: 'ch+eslav',
    tiles: 14,
    notes: ['tiled into 14 pieces'],
    lines: [{ text: 'Привет', score: 0.9, x: 1, y: 2, width: 3, height: 4 }]
  });
  assert.match(text, /engine=rapid/);
  assert.match(text, /lang=ch\+eslav/);
  assert.match(text, /tiles=14/);
  assert.match(text, /note: tiled into 14 pieces/);
  assert.match(text, /Привет/);
});

test('rapid runner: a wrapper banner on stdout cannot corrupt the payload', async () => {
  const core = await import(`../src/core.js?t=${Date.now()}-banner`);
  const payload = core.OCR_PAYLOAD_MARKER + '\n' + Buffer.from(JSON.stringify({ lines: [] })).toString('base64') + '\n';
  const banner = 'root\nWelcome to Debian GNU/Linux\nproot-distro: rootfs mounted\n';
  // With the marker the payload survives byte for byte.
  const decoded = Buffer.from(core.extractOcrPayload(banner + payload), 'base64').toString('utf8');
  assert.equal(decoded, '{"lines":[]}');
  // The same banner without a marker is exactly the corruption this guards:
  // "root" is valid base64 alphabet and would be concatenated onto the payload.
  assert.notEqual(core.extractOcrPayload(banner + Buffer.from('{"lines":[]}').toString('base64') + '\n'), Buffer.from('{"lines":[]}').toString('base64'));
  // And a marker with nothing behind it yields no payload rather than garbage.
  assert.equal(core.extractOcrPayload(banner + core.OCR_PAYLOAD_MARKER + '\n'), '');
});

test('image_ocr exposes tiling and reports it in the schema', async () => {
  const mod = await import('../src/tool.js');
  const tool = mod.createImageOcrTool({});
  assert.ok(tool.parameters.properties.tile, 'the tile parameter must exist');
  assert.deepEqual(tool.parameters.properties.tile.enum, ['auto', 'on', 'off']);
  assert.ok(tool.output.schema.properties.tiles, 'the output must carry the tile count');
  assert.ok(tool.output.schema.properties.notes);
  assert.match(tool.description, /tile/i);
});
