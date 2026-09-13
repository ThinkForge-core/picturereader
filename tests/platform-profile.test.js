/**
 * Host capability profile tests.
 *
 * `image_edit` withholds a few actions under Termux, because they need
 * packages Termux cannot install. That has to be decided at *module load* (the
 * tool's `enum` is fixed at boot), so this file sets PREFIX before importing
 * anything, and the node test runner gives each file its own process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Pretend to be Termux before any plugin module is loaded.
process.env.PREFIX = '/data/data/com.termux/files/usr';

const profile = await import('../src/platform-profile.js');
const imageEdit = await import('../src/image-edit.js');
const tool = await import('../src/tool.js');

test('isTermux: detected from the Termux PREFIX, not from the OS name', () => {
  assert.equal(profile.isTermux({ PREFIX: '/data/data/com.termux/files/usr' }), true);
  assert.equal(profile.isTermux({ PREFIX: '/data/data/com.termux' }), true);
  assert.equal(profile.isTermux({ PREFIX: '/usr' }), false);
  assert.equal(profile.isTermux({ PREFIX: '/data/data/com.other/files/usr' }), false);
  assert.equal(profile.isTermux({}), false);
  assert.equal(profile.isTermux({ PREFIX: undefined }), false);
});

test('availableEditActions: withholds exactly the actions Termux cannot run', () => {
  const all = ['resize', 'remove_background', 'raw_convert', 'upscale', 'rotate', 'exif_read'];
  const onTermux = profile.availableEditActions(all, { termux: true });
  assert.deepEqual(onTermux, ['resize', 'rotate', 'exif_read']);
  // The input array must not be mutated, and the unknown-action set is exactly
  // the documented one — a new unavailable action must be added deliberately.
  assert.deepEqual(all, ['resize', 'remove_background', 'raw_convert', 'upscale', 'rotate', 'exif_read']);
  assert.deepEqual(
    Object.keys(profile.TERMUX_UNAVAILABLE_EDIT_ACTIONS).sort(),
    ['raw_convert', 'remove_background', 'upscale']
  );
  // On a normal Linux host nothing is withheld.
  assert.deepEqual(profile.availableEditActions(all, { termux: false }), all);
});

test('termuxEditNote: explains the omission only on Termux', () => {
  assert.equal(profile.termuxEditNote({ termux: false }), '');
  const note = profile.termuxEditNote({ termux: true });
  assert.match(note, /remove_background/);
  assert.match(note, /raw_convert/);
  assert.match(note, /upscale/);
  assert.ok(note.endsWith('.'));
});

test('image_edit: the booted tool list excludes the Termux-unavailable actions', () => {
  const unavailable = Object.keys(profile.TERMUX_UNAVAILABLE_EDIT_ACTIONS);
  for (const action of unavailable) {
    assert.ok(!imageEdit.ACTIONS.includes(action), `${action} must not be offered under Termux`);
    assert.ok(imageEdit.ALL_ACTIONS.includes(action), `${action} must still exist in the full list`);
  }
  assert.equal(imageEdit.ACTIONS.length, imageEdit.ALL_ACTIONS.length - unavailable.length);

  // And the model-facing schema must match what the executor accepts.
  const edit = imageEdit.createImageEditTool({});
  assert.deepEqual(edit.parameters.properties.action.enum, imageEdit.ACTIONS);
  for (const action of unavailable) {
    assert.ok(!edit.parameters.properties.action.enum.includes(action), `${action} must not be in the schema enum`);
  }
  assert.equal(edit.parameters.properties.action.enum.length, imageEdit.ACTIONS.length);
});

test('image_edit: a withheld action is refused with the reason, not "unknown action"', async () => {
  const edit = imageEdit.createImageEditTool({});
  await assert.rejects(
    () => edit.execute({ action: 'raw_convert', file_path: 'x.cr2' }, {}),
    (error) => {
      assert.match(error.message, /raw_convert/);
      assert.match(error.message, /Termux/);
      assert.doesNotMatch(error.message, /unknown action/);
      return true;
    }
  );
});

test('image_edit: the description tells the model what is missing here', () => {
  const edit = imageEdit.createImageEditTool({});
  assert.match(edit.description, /Termux/);
  assert.match(edit.description, /remove_background/);
});

test('the other tools are unaffected by the host profile', () => {
  // OCR is the whole point of the Termux setup: it must stay available, and its
  // tiling parameter must still be advertised.
  const ocr = tool.createImageOcrTool({});
  assert.ok(ocr.parameters.properties.tile);
  assert.equal(tool.createImageScanTool({}).name, 'image_scan');
});
