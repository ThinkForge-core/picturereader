/**
 * Portability guard.
 *
 * The project is Linux-only and English-only. This test fails the moment a
 * platform reference or a Chinese string is reintroduced, which is what keeps
 * the refactor from silently regressing — deleting the Windows/macOS code is
 * only durable if something checks it.
 *
 * Rules:
 *  (a) no platform references anywhere in the tracked sources;
 *  (b) no CJK text in the user-facing surface (README, skills, settings card);
 *  (c) no Cyrillic anywhere, in every file the suite can read.
 *
 * Code comments elsewhere may still be non-English, so (b) deliberately covers
 * only the files whose entire content reaches a user. (c) is deliberately
 * unscoped and asymmetric with (b): CJK belongs to this project's subject matter
 * (the recognition models are named and explained in the prose), while Cyrillic
 * never does — a Cyrillic string here is always a localized reply alias, a stray
 * docstring example or a fixture left over from a Russian-language session, i.e.
 * the English-only rule leaking into a repository that ships to everyone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directories that never contain project source. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'fixtures-out', '.npmcache-local', '__pycache__']);

/** File extensions we scan. */
const SCAN_EXTENSIONS = ['.js', '.mjs', '.py', '.json', '.yml', '.yaml', '.md', '.swift'];

/**
 * Platform markers that must not appear anywhere.
 *
 * `windows`/`macos`/`darwin` are matched case-insensitively as words so that
 * "Windows-style path" or a stray `OS_WINDOWS` constant would be caught, while
 * harmless identifiers do not match. A small allowlist keeps legitimate uses
 * (this very file, and the README's feature name "window") from tripping it.
 */
const PLATFORM_PATTERNS = [
  { name: 'powershell', re: /powershell/i },
  { name: 'windowsHide', re: /windowsHide/ },
  { name: 'windows OCR engine', re: /\bwindows(\.media\.ocr|\s+ocr)\b/i },
  { name: 'macOS engine', re: /\bmacos\b/i },
  { name: 'darwin', re: /\bdarwin\b/i },
  { name: 'xcrun/swiftc', re: /\bxcrun\b|\bswiftc\b/ },
  { name: 'WSL', re: /\bWSL\b/ },
  { name: 'legacy setup scripts', re: /setup-(ocr|rapid|macos|doc-venv|image-venv)\.mjs/ },
  { name: 'win32 platform check', re: /process\.platform\s*===\s*['"]win32['"]/ },
  { name: 'drive-letter path', re: /[A-Za-z]:\\\\/ }
];

// NOTE: `rapidocr` used to be banned here, because the RapidOCR engine was one
// of the platform-specific forks this refactor removed. It is now the default
// engine on *every* platform — including aarch64/Termux, where PaddleOCR cannot
// be installed at all — so it is no longer a platform marker. What must stay
// banned is naming a platform in order to *branch* on it.

/**
 * APIs that were deleted. These only matter where they would actually run or be
 * read, so they are checked in the plugin sources and the settings card — the
 * installer's prose may legitimately mention a key in order to explain that it
 * is now ignored.
 */
const REMOVED_API_PATTERNS = [
  { name: 'removed env var', re: /DSH_(MACOS_OCR_BIN|RAPID_PYTHON|RAPID_BASE_PYTHON|DOC_PYTHON|IMAGE_PYTHON)/ },
  { name: 'removed setting', re: /\bocr_engine\b/ }
];

/** Files where a removed API would be a real regression. */
const API_SCOPE = [/^src[\/]/, /^client\.js$/, /^tests[\/](?!portability\.test\.js)/];

/** Files whose every byte is user-facing: CJK must never appear in them. */
const USER_FACING_FILES = [
  'README.md',
  'client.js',
  'skills/image-reading.md',
  'skills/vision-analyze.md'
];

/**
 * Collect every scannable file under a directory.
 *
 * Hidden directories (`.git`, and any local install sandbox such as `.pr-test`
 * that a user created inside the checkout) are skipped: they hold tooling or
 * third-party packages, never project source.
 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (entry.startsWith('.')) continue;
      collect(full, out);
      continue;
    }
    if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

const HAS_CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\u201c\u201d]/;

/** Cyrillic, including the supplement and the two extended blocks. */
const HAS_CYRILLIC = /[\u0400-\u04ff\u0500-\u052f\u2de0-\u2dff\ua640-\ua69f]/;

function scan(patterns, files) {
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const { name, re } of patterns) {
      const match = re.exec(text);
      if (match === null) continue;
      const line = text.slice(0, match.index).split('\n').length;
      offenders.push(`${relative(ROOT, file)}:${line} — ${name} (${JSON.stringify(match[0])})`);
    }
  }
  return offenders;
}

test('no Windows/macOS/platform references remain anywhere', () => {
  const files = collect(ROOT).filter((f) => !f.endsWith('tests/portability.test.js'));
  const offenders = scan(PLATFORM_PATTERNS, files);
  assert.deepEqual(offenders, [], `platform references found:\n${offenders.join('\n')}`);
});

test('no removed API is still referenced by the plugin sources', () => {
  const files = collect(ROOT).filter((f) => {
    const rel = relative(ROOT, f).split(sep);
    return API_SCOPE.some((re) => re.test(rel.join('/')));
  });
  const offenders = scan(REMOVED_API_PATTERNS, files);
  assert.deepEqual(offenders, [], `removed APIs still referenced:\n${offenders.join('\n')}`);
});

test('the user-facing surface contains no CJK text', () => {
  const offenders = [];
  for (const rel of USER_FACING_FILES) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const match = HAS_CJK.exec(text);
    if (match === null) continue;
    const line = text.slice(0, match.index).split('\n').length;
    offenders.push(`${rel}:${line} — ${JSON.stringify(match[0])}`);
  }
  assert.deepEqual(offenders, [], `CJK text found in user-facing files:\n${offenders.join('\n')}`);
});

test('no Cyrillic text anywhere in the tracked sources', () => {
  const offenders = scan([{ name: 'Cyrillic text', re: HAS_CYRILLIC }], collect(ROOT));
  assert.deepEqual(offenders, [], `Cyrillic text found:\n${offenders.join('\n')}`);
});

test('no tool accepts an engine argument any more', async () => {
  // Checked against the real tool objects rather than the source text: the
  // OUTPUT schema still reports which engine produced a result, which is
  // deliberate, so only the input parameters are constrained here.
  const { createImageOcrTool } = await import('../src/tool.js');
  const { createVisionAnalyzeTool } = await import('../src/vision-analyze.js');
  const ctx = { tools: { register() {} }, emit() {}, fs: {} };
  for (const [label, tool] of [['image_ocr', createImageOcrTool(ctx)], ['vision_analyze', createVisionAnalyzeTool(ctx)]]) {
    const properties = tool.parameters?.properties ?? {};
    assert.equal(properties.engine, undefined, `${label} must not expose an "engine" parameter`);
    assert.equal(properties.ocr_engine, undefined, `${label} must not expose an "ocr_engine" parameter`);
  }
  // The OCR language selector replaced it and must stay available.
  assert.ok(createImageOcrTool(ctx).parameters.properties.language, 'image_ocr keeps the language parameter');
  assert.ok(createVisionAnalyzeTool(ctx).parameters.properties.ocr_language, 'vision_analyze keeps ocr_language');
});

test('the deleted helper scripts and macOS-only files stay deleted', async () => {
  const gone = [
    'scripts/setup-ocr.mjs',
    'scripts/setup-rapid.mjs',
    'scripts/setup-macos.mjs',
    'scripts/setup-doc-venv.mjs',
    'scripts/setup-image-venv.mjs',
    'scripts/macos-ocr.swift',
    'scripts/install-local.mjs',
    'tests/macos.test.js',
    'tests/rapid.test.js',
    'tests/fixtures/make-fixture.swift'
  ];
  const { existsSync } = await import('node:fs');
  const survivors = gone.filter((rel) => existsSync(join(ROOT, rel)));
  assert.deepEqual(survivors, [], `these files should have been removed: ${survivors.join(', ')}`);
});

test('the two whole-project entry scripts exist', async () => {
  const { existsSync } = await import('node:fs');
  for (const rel of ['scripts/install.py', 'scripts/uninstall.py', 'scripts/_ui.py']) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} is missing`);
    const text = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(!HAS_CJK.test(text), `${rel} must be English-only`);
  }
});
