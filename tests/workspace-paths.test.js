/**
 * Tests for the workspace/sandbox path helpers (src/workspace-paths.js).
 *
 * These pin the one rule that is invisible in the code but decides whether an
 * agent can read what it has just written: inside the DSH file sandbox `/tmp` is
 * a private, per-command tmpfs, so the plugin defaults its output into the
 * session workspace and explains the `/tmp` case instead of answering a bare
 * "file not found".
 *
 * Run: node --test tests/workspace-paths.test.js
 * @module picturereader/tests/workspace-paths
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SCRATCH_DIR, defaultOutputDir, missingFileHint } from '../src/workspace-paths.js';

const CWD = join('/', 'work', 'project');

test('defaultOutputDir: output goes into the session workspace', () => {
  assert.equal(defaultOutputDir('doc', { cwd: CWD, stamp: 'sess-1' }),
    join(CWD, SCRATCH_DIR, 'doc', 'sess-1'));
});

test('defaultOutputDir: kind and session keep tools and sessions apart', () => {
  const doc = defaultOutputDir('doc', { cwd: CWD, stamp: 'a' });
  const edit = defaultOutputDir('edit', { cwd: CWD, stamp: 'a' });
  const other = defaultOutputDir('doc', { cwd: CWD, stamp: 'b' });
  assert.equal(new Set([doc, edit, other]).size, 3);
});

test('defaultOutputDir: an unknown session still gets a directory', () => {
  assert.ok(defaultOutputDir('crop', { cwd: CWD }).endsWith(join('crop', 'anon')));
});

test('defaultOutputDir: without a cwd it falls back to the OS temp dir', () => {
  const dir = defaultOutputDir('doc', { stamp: 'sess-1' });
  assert.ok(dir.startsWith(resolve(tmpdir())), dir);
  assert.ok(dir.includes('picturereader-doc'));
});

test('defaultOutputDir: a relative cwd is resolved, never returned as-is', () => {
  assert.ok(defaultOutputDir('edit', { cwd: 'relative/dir', stamp: 's' }).startsWith('/'));
});

test('missingFileHint: a temp path explains the sandbox tmpfs', () => {
  const hint = missingFileHint(join(resolve(tmpdir()), 'shot.png'));
  assert.match(hint, /temp directory/);
  assert.ok(hint.includes(SCRATCH_DIR), 'the hint must name the workspace scratch dir');
});

test('missingFileHint: a workspace path says nothing extra', () => {
  assert.equal(missingFileHint(join(CWD, 'shot.png')), '');
});

test('missingFileHint: a sibling of the temp dir is not inside it', () => {
  // REGRESSION PIN: a prefix test without a separator would swallow this path
  // and blame the sandbox for an ordinary typo somewhere else entirely.
  assert.equal(missingFileHint(`${resolve(tmpdir())}-backup/shot.png`), '');
});

test('missingFileHint: a relative or empty path is never judged', () => {
  assert.equal(missingFileHint('shot.png'), '');
  assert.equal(missingFileHint(''), '');
  assert.equal(missingFileHint(undefined), '');
});
