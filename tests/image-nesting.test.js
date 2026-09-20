/**
 * Regression: an image nested inside a `tool-result` (the shape `read_image`
 * returns) must be seen and replaced.
 *
 * The visual twin marks a checked model as image-capable, so the harness stops
 * projecting images to text and `read_image` is allowed to return one. Both
 * guards below then have to remove it themselves. They used to check only the
 * top level of `message.content`, found nothing inside `tool-result.content`,
 * and forwarded the image to a text-only adapter - which failed the whole turn
 * with UNSUPPORTED_CONTENT and left the image in the durable log, so every
 * later request failed the same way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { hasImageBlock, contentHasImageBlock, bridgeMessages, attachImageBridge } from '../src/bridge.js';
import { setRuntimeConfig } from '../src/runtime.js';

// The twin resolves its export directory at module load, so DSH_HOME must point
// at a scratch directory before the module is evaluated.
const home = await mkdtemp(join(tmpdir(), 'pr-nesting-home-'));
process.env.DSH_HOME = home;
const { sanitizeImages, registerTwinAdapters } = await import('../src/picturereader-vision.mjs');

const attachment = { attachmentId: 'nested123456', mediaType: 'image/png', name: 'shot.png' };

/** One message shaped like a `read_image` tool result. */
function toolResultMessage() {
  return {
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: 'call-1',
      isError: false,
      content: [
        { type: 'text', text: '<path>/tmp/shot.png</path>' },
        { type: 'image', attachment },
      ],
    }],
  };
}

const ctx = { attachments: { readImage: async () => ({ data: Buffer.from([1, 2, 3]) }) } };

test('contentHasImageBlock / hasImageBlock see a nested tool-result image', () => {
  const message = toolResultMessage();
  assert.equal(contentHasImageBlock(message.content), true);
  assert.equal(hasImageBlock([message]), true);
  assert.equal(hasImageBlock([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]), false);
});

test('bridgeMessages replaces a nested image and keeps its siblings', async () => {
  setRuntimeConfig({ mode: 'privacy' });
  const dir = await mkdtemp(join(tmpdir(), 'pr-nesting-bridge-'));
  try {
    const message = toolResultMessage();
    const out = await bridgeMessages([message], ctx, dir);
    assert.notEqual(out[0], message, 'the message must be rebuilt');
    const block = out[0].content[0];
    assert.equal(block.type, 'tool-result', 'the tool-result block survives');
    assert.equal(block.content.some((b) => b.type === 'image'), false, 'no image survives');
    assert.ok(block.content.some((b) => b.type === 'text' && b.text.includes('[mode:Privacy]')), 'guidance replaces it');
    assert.equal(block.content[0].text, '<path>/tmp/shot.png</path>', 'the sibling text is untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
    setRuntimeConfig({ mode: 'smart' });
  }
});

test('twin sanitizeImages replaces a nested image with local-reading guidance', async () => {
  const message = toolResultMessage();
  const out = await sanitizeImages(ctx, [message]);
  const block = out[0].content[0];
  assert.equal(block.content.some((b) => b.type === 'image'), false, 'no image reaches the adapter');
  const note = block.content.find((b) => b.type === 'text' && b.text.includes('image_scan'));
  assert.ok(note, 'a text note pointing at image_scan replaces the image');
  assert.equal(block.content[0].text, '<path>/tmp/shot.png</path>', 'the sibling text is untouched');
});

test('twin sanitizeImages leaves image-free messages identical', async () => {
  const message = { role: 'user', content: [{ type: 'text', text: 'plain' }] };
  const out = await sanitizeImages(ctx, [message]);
  assert.equal(out[0], message, 'untouched messages keep their identity');
});

/** Register the bridge on a recording context and return the post-execute guard. */
function postExecuteGuard() {
  const handlers = new Map();
  attachImageBridge({
    on: (name, fn) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
    get: () => undefined,
  });
  const guard = handlers.get('tools/post-execute')?.[0];
  assert.ok(guard, 'the post-execute guard is registered');
  return guard;
}

/** A `read_image` execution on one exact route. */
function readImageExec(model) {
  return {
    name: 'read_image',
    arguments: { file_path: '/tmp/shot.png' },
    agent: { session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model } }) } },
  };
}

const readImageResult = {
  isError: false,
  content: [{ type: 'text', text: 'read' }, { type: 'image', attachment }],
};

test('post-execute: a read_image image is replaced by a real decision', async () => {
  setRuntimeConfig({ mode: 'smart', request_guard: true, multimodal_models: '' });
  const guard = postExecuteGuard();
  let nextCalls = 0;
  const decision = await guard(readImageExec('deepseek-v4-flash'), readImageResult, async () => {
    nextCalls += 1;
    return { kind: 'accept' };
  });
  assert.equal(nextCalls, 0, 'the replacement must not be delegated to next()');
  assert.equal(decision.kind, 'accept');
  assert.ok(Array.isArray(decision.content), 'an accept decision carries the replacement content');
  assert.ok(decision.content[0].text.includes('image_scan'), 'the model is pointed at the local tools');
  assert.equal(decision.content.some((b) => b.type === 'image'), false, 'the image is gone from the log copy');
});

test('post-execute: a whitelisted multimodal model keeps its image', async () => {
  setRuntimeConfig({ mode: 'smart', request_guard: true, multimodal_models: 'deepseek-v4-flash' });
  try {
    const guard = postExecuteGuard();
    let nextCalls = 0;
    const decision = await guard(readImageExec('deepseek-v4-flash'), readImageResult, async () => {
      nextCalls += 1;
      return { kind: 'accept' };
    });
    assert.equal(nextCalls, 1, 'a whitelisted route keeps the tool result untouched');
    assert.equal(decision.content, undefined);
  } finally {
    setRuntimeConfig({ mode: 'smart', request_guard: true, multimodal_models: '' });
  }
});

/** A fake LLM service exposing one wrappable provider. */
function fakeLlm() {
  const seen = [];
  const target = {
    listModels: async () => [],
    resolveModel: async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] }),
    prepareCall: async (p, m) => ({
      model: { provider: p, id: m, name: m, inputModalities: ['text'] },
      stream: async function* (options) { seen.push(options); },
    }),
    stream: async function* (options) { seen.push(options); },
  };
  const registration = { provider: { id: 'test-provider' }, adapter: target };
  return { seen, target, registration, llm: { registration: () => registration } };
}

/** A minimal Cordis-like context for `registerTwinAdapters`. */
function twinCtx(get) {
  return { on: () => {}, off: () => {}, effect: (fn) => fn(), get };
}

/** One request carrying a pasted image. */
function imageRequest(model) {
  return { model, messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment }] }] };
}

async function drain(iterable) {
  for await (const _chunk of iterable) { /* drain */ }
}

const CONFIG = () => ({ vision_models: [{ id: 'checked-model', provider: 'test-provider' }] });

test('twin: only a checked model gets the local-reading rewrite', async () => {
  const { seen, registration, llm } = fakeLlm();
  const attachments = { readImage: async () => ({ data: Buffer.from([1, 2, 3]) }) };
  registerTwinAdapters(twinCtx((name) => (name === 'attachments' ? attachments : undefined)), llm, CONFIG);

  const unchecked = await registration.adapter.prepareCall('test-provider', 'other-model', undefined);
  await drain(unchecked.stream(imageRequest('other-model')));
  assert.equal(seen.at(-1).messages[0].content[1].type, 'image', 'an unchecked route keeps its image');

  const checked = await registration.adapter.prepareCall('test-provider', 'checked-model', undefined);
  await drain(checked.stream(imageRequest('checked-model')));
  const block = seen.at(-1).messages[0].content[1];
  assert.equal(block.type, 'text', 'a checked route degrades the image locally');
  assert.ok(block.text.includes('image_scan'), 'the note points at the local tools');
});

test('twin: a failing local analysis still never forwards the image', async () => {
  const { seen, registration, llm } = fakeLlm();
  const broken = { readImage: async () => { throw new Error('boom'); } };
  registerTwinAdapters(twinCtx((name) => (name === 'attachments' ? broken : undefined)), llm, CONFIG);

  const checked = await registration.adapter.prepareCall('test-provider', 'checked-model', undefined);
  await drain(checked.stream(imageRequest('checked-model')));
  const block = seen.at(-1).messages[0].content[1];
  assert.equal(block.type, 'text', 'the image is replaced even when its analysis fails');
  assert.ok(block.text.includes('image_scan'));
});

test('twin: a crashing sanitizer falls back to a static note, not the image', async () => {
  const { seen, registration, llm } = fakeLlm();
  const throwing = () => { throw new Error('ctx boom'); };
  registerTwinAdapters(twinCtx(throwing), llm, CONFIG);

  const checked = await registration.adapter.prepareCall('test-provider', 'checked-model', undefined);
  await drain(checked.stream(imageRequest('checked-model')));
  const block = seen.at(-1).messages[0].content[1];
  assert.equal(block.type, 'text', 'the image must never reach the adapter');
  assert.match(block.text, /image omitted/);
});
