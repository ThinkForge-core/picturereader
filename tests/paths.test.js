/**
 * Path resolution tests (src/paths.js).
 *
 * The resolver is what makes installation reproducible: an explicit
 * environment variable wins, then the installer's state file, then the default
 * venv prefix. These tests pin that order and the fail-soft behaviour for a
 * missing, unreadable or malformed state file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dshHome,
  statePath,
  venvPrefix,
  readState,
  resetStateCache,
  venvPython,
  mediaPython,
  paddlePython,
  paddleCacheHome,
  which,
  sofficePath,
  installHint,
  VENV_ROLES
} from '../src/paths.js';

/** Create a throwaway DSH home and point the resolver at it. */
function withHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-paths-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  resetStateCache();
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    resetStateCache();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Write a state file under the given DSH home. */
function writeState(home, state) {
  const dir = join(home, 'picturereader');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'env.json'), typeof state === 'string' ? state : JSON.stringify(state, null, 2));
  resetStateCache();
}

test('dshHome / statePath / venvPrefix follow DSH_HOME', (t) => {
  const home = withHome(t);
  assert.equal(dshHome(), home);
  assert.equal(statePath(), join(home, 'picturereader', 'env.json'));
  assert.equal(venvPrefix(), join(home, 'picturereader', 'venvs'));
});

test('venvPython: the environment variable wins over everything', (t) => {
  const home = withHome(t);
  writeState(home, { venvs: { media: { python: '/from/state/python' } } });
  process.env.DSH_MEDIA_PYTHON = '/from/env/python';
  t.after(() => { delete process.env.DSH_MEDIA_PYTHON; });
  assert.equal(mediaPython(), '/from/env/python');
});

test('venvPython: the state file wins over the default prefix', (t) => {
  const home = withHome(t);
  writeState(home, {
    venvs: {
      media: { python: '/state/media/python', path: '/state/media' },
      paddle: { python: '/state/paddle/python' }
    }
  });
  assert.equal(mediaPython(), '/state/media/python');
  assert.equal(paddlePython(), '/state/paddle/python');
});

test('venvPython: a missing state file falls back to the venv prefix', (t) => {
  const home = withHome(t);
  assert.equal(readState(), null);
  assert.equal(mediaPython(), join(home, 'picturereader', 'venvs', 'media', 'bin', 'python'));
  assert.equal(paddlePython(), join(home, 'picturereader', 'venvs', 'paddle', 'bin', 'python'));
});

test('venvPython: a venv entry may be a plain path string', (t) => {
  const home = withHome(t);
  writeState(home, { venvs: { media: '/plain/string/python' } });
  assert.equal(mediaPython(), '/plain/string/python');
});

test('venvPython: malformed or unexpected state falls back instead of throwing', (t) => {
  const home = withHome(t);

  writeState(home, '{ this is not json');
  assert.equal(readState(), null);
  assert.equal(mediaPython(), join(home, 'picturereader', 'venvs', 'media', 'bin', 'python'));

  writeState(home, '[1,2,3]'); // valid JSON, wrong shape
  assert.equal(readState(), null);

  writeState(home, { venvs: 'nope' });
  assert.equal(mediaPython(), join(home, 'picturereader', 'venvs', 'media', 'bin', 'python'));

  writeState(home, { venvs: { media: { python: '   ' } } });
  assert.equal(mediaPython(), join(home, 'picturereader', 'venvs', 'media', 'bin', 'python'));

  writeState(home, { venvs: { media: { path: '/only/a/path' } } });
  assert.equal(mediaPython(), join(home, 'picturereader', 'venvs', 'media', 'bin', 'python'));
});

test('readState: caches by mtime and notices an edit', (t) => {
  const home = withHome(t);
  writeState(home, { venvs: { media: { python: '/first/python' } }, marker: 1 });
  assert.equal(readState().marker, 1);

  // A rewrite with a different mtime must be observed without a manual reset.
  writeState(home, { venvs: { media: { python: '/second/python' } }, marker: 2 });
  resetStateCache();
  assert.equal(readState().marker, 2);
  assert.equal(mediaPython(), '/second/python');
});

test('readState: an unreadable file yields null, not an exception', (t) => {
  const home = withHome(t);
  writeState(home, { venvs: {} });
  chmodSync(statePath(), 0o000);
  resetStateCache();
  try {
    assert.equal(readState(), null);
    assert.equal(mediaPython(), join(home, 'picturereader', 'venvs', 'media', 'bin', 'python'));
  } finally {
    chmodSync(statePath(), 0o600);
  }
});

test('paddleCacheHome: env, then state, then the home default', (t) => {
  const home = withHome(t);
  assert.ok(paddleCacheHome().endsWith('.paddlex-cache'));

  writeState(home, { caches: { paddlex: '/state/cache' } });
  assert.equal(paddleCacheHome(), '/state/cache');

  process.env.DSH_PADDLE_CACHE = '/env/cache';
  t.after(() => { delete process.env.DSH_PADDLE_CACHE; });
  assert.equal(paddleCacheHome(), '/env/cache');
});

test('which: finds an executable on PATH and rejects a missing one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-which-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const exe = join(dir, 'picturereader-test-exe');
  writeFileSync(exe, '');
  const env = { PATH: dir };
  assert.equal(which('picturereader-test-exe', env), exe);
  assert.equal(which('definitely-not-here-xyz', env), null);
  assert.equal(which('picturereader-test-exe', { PATH: '' }), null);
  assert.equal(which('picturereader-test-exe', {}), null);
});

test('sofficePath: DSH_SOFFICE wins when the file exists', (t) => {
  const home = withHome(t);
  const dir = mkdtempSync(join(tmpdir(), 'pr-soffice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'soffice');
  writeFileSync(fake, '#!/bin/sh\n');
  process.env.DSH_SOFFICE = fake;
  t.after(() => { delete process.env.DSH_SOFFICE; });
  assert.equal(sofficePath(), fake);

  // A DSH_SOFFICE pointing at nothing must not be returned as-is.
  process.env.DSH_SOFFICE = join(dir, 'missing-soffice');
  assert.notEqual(sofficePath(), join(dir, 'missing-soffice'));
});

test('sofficePath: the state file is used when the environment is silent', (t) => {
  const home = withHome(t);
  const dir = mkdtempSync(join(tmpdir(), 'pr-soffice2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, 'soffice');
  writeFileSync(fake, '#!/bin/sh\n');
  delete process.env.DSH_SOFFICE;
  writeState(home, { tools: { soffice: fake } });
  assert.equal(sofficePath(), fake);

  // A stale state path that no longer exists must be skipped.
  rmSync(fake);
  resetStateCache();
  assert.notEqual(sofficePath(), fake);
});

test('VENV_ROLES / installHint describe the installer contract', () => {
  assert.deepEqual([...VENV_ROLES], ['media', 'paddle']);
  assert.match(installHint(), /scripts\/install\.py/);
});
