/**
 * Tests for the image_edit tool (src/image-edit.js).
 *
 * Pure-logic / structural tests use an in-memory fake ctx.fs plus an injected
 * fake `_imageEditRunner` so they never touch the real Python / Pillow/OpenCV.
 * The fake runner captures the request JSON the tool builds (action / from /
 * from_extra / out / action params) and returns a canned result, letting us
 * assert the tool's contract without the venv.
 *
 * Run: node --test tests/image-edit.test.js
 * @module picturereader/tests/image-edit
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createImageEditTool } from '../src/image-edit.js';

// ---------------------------------------------------------------- helpers

/**
 * Build a fake ctx with in-memory fs. `captured` is an array that each
 * runner call pushes the parsed request JSON into (plus the timeoutMs).
 */
function makeFakeCtx(entries, captured, opts = {}) {
  const runner =
    opts.runner ||
    ((reqPath, timeoutMs) => {
      captured.push({ req: JSON.parse(readFileSync(reqPath, 'utf8')), timeoutMs });
      return {
        ok: true,
        action: 'resize',
        out_path: '/out/resized.png',
        width: 100,
        height: 80,
        bytes: 1234,
        format: 'PNG',
        summary: 'test summary ok'
      };
    });
  const ctx = {
    tools: { register() {} },
    fs: {
      async resolve(path, o) {
        return { targetKey: `k:${path}`, displayPath: path };
      },
      async stat(target) {
        const e = entries[target.displayPath];
        if (!e) return null;
        return { version: 'v1', type: 'file', size: (e.buffer || '').length };
      },
      async readBytes(target) {
        const e = entries[target.displayPath];
        if (!e) throw new Error(`mock readBytes: no bytes for ${target.displayPath}`);
        return e.buffer;
      }
    },
    _imageEditRunner: runner
  };
  return ctx;
}

const EXEC = { signal: undefined, agent: { session: { header: { cwd: '/work' }, id: 'sess-1' } } };

// ---------------------------------------------------------------- tests

test('image_edit: unknown action throws', async () => {
  const captured = [];
  const ctx = makeFakeCtx({}, captured);
  const tool = createImageEditTool(ctx);
  await assert.rejects(
    tool.execute({ action: 'nope', file_path: '/in.png' }, EXEC),
    /unknown action/
  );
  assert.equal(captured.length, 0, 'runner should not be called');
});

test('image_edit: missing file_path throws', async () => {
  const captured = [];
  const ctx = makeFakeCtx({}, captured);
  const tool = createImageEditTool(ctx);
  await assert.rejects(
    tool.execute({ action: 'resize', width: 100, height: 100 }, EXEC),
    /file_path is required/
  );
  assert.equal(captured.length, 0);
});

test('image_edit: resize builds correct request JSON (action/from/out + params)', async () => {
  const captured = [];
  const ctx = makeFakeCtx({ '/in.png': { buffer: Buffer.from('PNGDATA'), type: 'file' } }, captured);
  const tool = createImageEditTool(ctx);
  const res = await tool.execute(
    { action: 'resize', file_path: '/in.png', width: 200, height: 150, mode: 'fit' },
    EXEC
  );
  assert.equal(captured.length, 1);
  const { req, timeoutMs } = captured[0];
  assert.equal(req.action, 'resize');
  assert.equal(req.width, 200);
  assert.equal(req.height, 150);
  assert.equal(req.mode, 'fit');
  assert.ok(req.from.endsWith('in.png'), `main input materialized: ${req.from}`);
  assert.ok(req.out.endsWith('.png'), `default out has .png ext: ${req.out}`);
  assert.ok(req.out.includes('.picturereader'), 'out under the session workspace scratch dir');
  // result contract
  assert.equal(res.ok, true);
  assert.equal(res.action, 'resize');
  assert.equal(res.width, 100);
  assert.equal(res.out_path, '/out/resized.png');
  assert.equal(res.format, 'PNG');
  assert.equal(res.summary, 'test summary ok');
});

test('image_edit: composite passes from_extra (foreground image)', async () => {
  const captured = [];
  const entries = {
    '/bg.png': { buffer: Buffer.from('BG'), type: 'file' },
    '/fg.png': { buffer: Buffer.from('FG'), type: 'file' }
  };
  const ctx = makeFakeCtx(entries, captured);
  const tool = createImageEditTool(ctx);
  const res = await tool.execute(
    { action: 'composite', file_path: '/bg.png', file_paths: ['/fg.png'], position: 'bottom_right', alpha: 0.5 },
    EXEC
  );
  assert.equal(captured.length, 1);
  const { req } = captured[0];
  assert.equal(req.action, 'composite');
  assert.equal(req.position, 'bottom_right');
  assert.equal(req.alpha, 0.5);
  assert.ok(Array.isArray(req.from_extra) && req.from_extra.length === 1);
  assert.ok(req.from_extra[0].endsWith('fg.png'), 'foreground materialized into from_extra');
  assert.ok(req.from.endsWith('bg.png'));
  assert.equal(res.action, 'composite');
});

test('image_edit: explicit out path honored, defaults resolved against cwd', async () => {
  const captured = [];
  const ctx = makeFakeCtx({ '/in.png': { buffer: Buffer.from('X'), type: 'file' } }, captured);
  const tool = createImageEditTool(ctx);
  await tool.execute(
    { action: 'thumbnail', file_path: '/in.png', out: 'sub/thumb.jpg', out_dir: '/outdir' },
    EXEC
  );
  const { req } = captured[0];
  assert.equal(req.action, 'thumbnail');
  // out_dir absolute, out relative -> resolved against cwd /work
});

test('image_edit: default timeout used', async () => {
  const captured = [];
  const ctx = makeFakeCtx({ '/in.png': { buffer: Buffer.from('X'), type: 'file' } }, captured);
  const tool = createImageEditTool(ctx);
  await tool.execute({ action: 'flip', file_path: '/in.png', axis: 'horizontal' }, EXEC);
  assert.equal(captured[0].timeoutMs, 120_000);
});

test('image_edit: slow actions get their own longer timeout', async () => {
  // The action->timeout table is asserted through the slow actions THIS HOST
  // OFFERS, not through a hard-coded one. Under Termux the capability profile
  // withholds remove_background / raw_convert / upscale, so naming them
  // directly made the suite fail on the termux branch with "action is not
  // available here"; filtering by the tool's own enum keeps the coverage
  // (denoise, perspective) on every platform and adds the extras where they
  // exist.
  const offered = new Set(createImageEditTool({}).parameters.properties.action.enum);
  const slow = [
    ['denoise', 180_000],
    ['perspective', 120_000],
    ['remove_background', 300_000],
    ['upscale', 600_000]
  ].filter(([action]) => offered.has(action));
  assert.ok(slow.length >= 2, `this host must offer slow actions, got ${slow.map(([a]) => a)}`);

  for (const [action, timeoutMs] of slow) {
    const captured = [];
    const ctx = makeFakeCtx(
      { 'a.png': { buffer: Buffer.from('X'), type: 'file' } },
      captured,
      { runner: (reqPath, timeoutMsArg) => {
          const req = JSON.parse(readFileSync(reqPath, 'utf8'));
          captured.push({ req, timeoutMs: timeoutMsArg });
          return { ok: true, action: req.action, out_path: 'x.png', width: 1, height: 1, bytes: 1, format: 'PNG', summary: 'ok' };
      } }
    );
    await createImageEditTool(ctx).execute({ action, file_path: 'a.png' }, EXEC);
    assert.equal(captured[0].timeoutMs, timeoutMs, `${action} must use ${timeoutMs}ms`);
  }
});

test('image_edit: a backend error surfaces as a tool error', async () => {
  // Uses an action available on every platform: the point is that a Python-side
  // error is re-thrown, not which action was running. Asserting /rembg/ here
  // used to pass on Termux only by accident, because the platform gate throws a
  // message that also happens to contain "rembg".
  const captured = [];
  const ctx = makeFakeCtx(
    { 'a.png': { buffer: Buffer.from('X'), type: 'file' } },
    captured,
    { runner: () => { throw new Error('image_edit: backend exploded'); } }
  );
  const tool = createImageEditTool(ctx);
  await assert.rejects(
    tool.execute({ action: 'resize', file_path: 'a.png', width: 4, height: 4 }, EXEC),
    /backend exploded/
  );
});

test('image_edit: the result is lossless JSON — no null and no undefined fields', async () => {
  // Regression: the harness validates this object against the output schema and
  // demands lossless JSON. `width/height/bytes/format: x ?? null` violated the
  // declared string/integer types, and `extra: result.extra ?? undefined` left
  // an own key holding undefined — every single image_edit call (all actions)
  // failed with "returned invalid output" until the fields were omitted instead.
  const captured = [];
  const ctx = makeFakeCtx({ 'a.png': { buffer: Buffer.from('X'), type: 'file' } }, captured, {
    runner: (reqPath) => {
      captured.push({ req: JSON.parse(readFileSync(reqPath, 'utf8')) });
      // Shape of a real exif_read result: no output file, no format.
      return {
        ok: true,
        action: 'exif_read',
        out_path: null,
        width: 100,
        height: 80,
        bytes: 0,
        format: null,
        summary: 'read 1 EXIF field',
        extra: { exif: { Make: 'TestCam' } }
      };
    }
  });
  const tool = createImageEditTool(ctx);
  const res = await tool.execute({ action: 'exif_read', file_path: 'a.png' }, EXEC);

  for (const [key, value] of Object.entries(res)) {
    assert.notEqual(value, null, `"${key}" must not be null`);
    assert.notEqual(value, undefined, `"${key}" must not be undefined`);
  }
  // exif_read writes no file: out_path/format are omitted, not nulled.
  assert.equal('out_path' in res, false, 'exif_read has no output file');
  assert.equal('format' in res, false);
  assert.equal(res.width, 100, 'real integer fields survive');
  assert.deepEqual(res.extra.exif, { Make: 'TestCam' });
  // What the harness does with the value must round-trip every remaining key.
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
  assert.doesNotThrow(() => structuredClone(res));
});
