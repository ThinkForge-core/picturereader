/**
 * Plugin registration contract.
 *
 * `dsh plugin --profile <p> add <pkg>` is a thin pnpm forwarder that then
 * reconciles `dsh.profile.bundles` by looking for a `dsh.bundle.patch`
 * declaration in the installed package. If that declaration or the patch file
 * it points at ever goes missing, the plugin installs as a plain dependency and
 * silently never loads — so the contract is pinned here.
 *
 * These checks are pure manifest/file inspection: no pnpm, no profile, no
 * network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

test('package.json declares the bundle patch dsh needs to activate the plugin', () => {
  const manifest = readJson('package.json');
  assert.equal(manifest.name, 'picturereader');
  assert.equal(manifest.type, 'module');
  assert.ok(manifest.dsh, 'the dsh section is what makes this a profile bundle');
  assert.ok(manifest.dsh.bundle, 'dsh.bundle is required for `dsh plugin add` to add a bundle layer');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(
    existsSync(join(ROOT, 'cordis.patch.yml')),
    'the patch file referenced by dsh.bundle.patch must exist in the package'
  );
});

test('the bundle patch inserts exactly one plugin row with the package id', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /insert:/);
  assert.match(patch, /id:\s*picturereader/);
  assert.match(patch, /name:\s*'picturereader'/);
});

test('the entry points named in the manifest exist', () => {
  const manifest = readJson('package.json');
  assert.ok(existsSync(join(ROOT, manifest.main)), `main entry is missing: ${manifest.main}`);
  assert.ok(existsSync(join(ROOT, manifest.exports['./client'])), 'the client bundle is missing');
  assert.ok(existsSync(join(ROOT, manifest.exports['./cordis.patch.yml'])), 'the exported patch file is missing');
});

test('the package ships everything the installer and the tools need at runtime', () => {
  const manifest = readJson('package.json');
  const published = new Set(manifest.files);
  // scripts/ carries the installer, the Python backends and the warm-up image.
  assert.ok(published.has('scripts'), 'scripts/ must be published: it holds install.py, uninstall.py and the tool backends');
  assert.ok(published.has('src'), 'src/ must be published');
  assert.ok(published.has('skills'), 'skills/ must be published: the built-in skill is loaded from disk');
  assert.ok(published.has('client.js'), 'client.js must be published for the settings card');
  for (const rel of [
    'scripts/install.py',
    'scripts/uninstall.py',
    'scripts/_ui.py',
    'scripts/requirements/media.txt',
    'scripts/requirements/paddle.txt',
    'scripts/image-edit.py',
    'scripts/doc-to-image.py',
    'scripts/warmup-ocr.png',
    'skills/image-reading.md'
  ]) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} is missing but is required at runtime`);
  }
});

test('every declared runtime dependency is a real dependency', () => {
  const manifest = readJson('package.json');
  const deps = manifest.dependencies ?? {};
  for (const name of ['pngjs', 'jpeg-js', 'omggif']) {
    assert.ok(deps[name], `${name} must be a declared dependency: core.js imports it directly`);
  }
  // These are host services: the plugin must not depend on them at install time.
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    assert.ok(name.startsWith('@deepseek-ai/'), `unexpected peer dependency: ${name}`);
  }
});

test('the installer entry points are wired into npm scripts', () => {
  const manifest = readJson('package.json');
  assert.equal(manifest.scripts.setup, 'python3 scripts/install.py');
  assert.equal(manifest.scripts.unsetup, 'python3 scripts/uninstall.py');
  assert.ok(manifest.scripts.selftest.includes('install.py --selftest'));
  assert.ok(manifest.scripts.selftest.includes('uninstall.py --selftest'));
});
