/**
 * picturereader three-mode / config / runtime / image-bridge unit tests.
 * Covers the routing semantics of privacy / smart / strict and the hard gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';

import {
  MODES, normalizeMode, vlmAllowed, isPrivacy, visionAnalyzeDefaults, routePolicyText, routeModeTag,
} from '../src/routing.js';
import { modeOf, vlmConfigOf, resolveVlmApiKey, MODE_KEYS } from '../src/config.js';
import { setRuntimeConfig, setRuntimeSource, getRuntimeConfig, currentMode, vlmAllowedByRuntime } from '../src/runtime.js';
import { hasImageBlock, hasShaAttachmentReference, deepFreeze, bridgeMessages } from '../src/bridge.js';

test('normalizeMode tolerates junk input', () => {
  assert.equal(normalizeMode('privacy'), 'privacy');
  assert.equal(normalizeMode('smart'), 'smart');
  assert.equal(normalizeMode('strict'), 'strict');
  assert.equal(normalizeMode(''), 'smart');
  assert.equal(normalizeMode(undefined), 'smart');
  assert.equal(normalizeMode('bogus'), 'smart');
  assert.equal(normalizeMode('  PRIVACY  '), 'smart'); // case/whitespace do not match
});

test('vlmAllowed: off in privacy, on elsewhere', () => {
  assert.equal(vlmAllowed('privacy'), false);
  assert.equal(vlmAllowed('smart'), true);
  assert.equal(vlmAllowed('strict'), true);
  assert.equal(isPrivacy('privacy'), true);
  assert.equal(isPrivacy('smart'), false);
});

test('visionAnalyzeDefaults across the three modes', () => {
  const privacy = visionAnalyzeDefaults('privacy');
  assert.equal(privacy.includeVlm, false, 'privacy must never allow the VLM');
  assert.equal(privacy.includeScan, true);
  const smart = visionAnalyzeDefaults('smart');
  assert.equal(smart.includeVlm, true);
  assert.equal(smart.includeScan, true);
  const strict = visionAnalyzeDefaults('strict');
  assert.equal(strict.includeVlm, true);
  assert.equal(strict.includeOcr, true);
});

test('routePolicyText carries the per-mode keywords', () => {
  assert.match(routePolicyText('privacy'), /Never call any external vision API/);
  assert.match(routePolicyText('privacy'), /local tools/);
  assert.match(routePolicyText('smart'), /image_scan/);
  assert.match(routePolicyText('smart'), /fewer round trips/);
  assert.match(routePolicyText('strict'), /Cross-check/);
  assert.match(routeModeTag('privacy'), /\[mode:Privacy\]/);
  assert.match(routeModeTag('smart'), /\[mode:Smart\]/);
  assert.match(routeModeTag('nonsense'), /\[mode:Smart\]/, 'an invalid mode normalizes to smart');
});

test('config.modeOf / vlmConfigOf', () => {
  assert.equal(modeOf({ mode: 'strict' }), 'strict');
  assert.equal(modeOf({ mode: 'nope' }), 'smart');
  const vlm = vlmConfigOf({ vlm_base: 'http://x', vlm_model: 'm', vlm_key: 'k', vlm_key_env: 'E' });
  assert.deepEqual(vlm, { baseUrl: 'http://x', model: 'm', apiKey: 'k', apiKeyEnv: 'E' });
});

test('resolveVlmApiKey: apiKey wins over the environment variable', () => {
  process.env.__PR_TEST_KEY__ = 'from-env';
  try {
    assert.equal(resolveVlmApiKey({ apiKey: 'direct' }), 'direct');
    assert.equal(resolveVlmApiKey({ apiKey: '', apiKeyEnv: '__PR_TEST_KEY__' }), 'from-env');
    assert.equal(resolveVlmApiKey({}), '');
  } finally {
    delete process.env.__PR_TEST_KEY__;
  }
});

test('runtime: setRuntimeConfig and the mode gate', () => {
  setRuntimeConfig({ mode: 'privacy', vlm: { baseUrl: 'http://ext', model: 'm', apiKey: 'k' } });
  assert.equal(currentMode(), 'privacy');
  assert.equal(vlmAllowedByRuntime(), false);
  assert.equal(getRuntimeConfig().mode, 'privacy');
});

test('runtime: setRuntimeSource refreshes lazily', () => {
  let cfg = { mode: 'smart', vlm_base: 'http://a', vlm_key: 'ka' };
  setRuntimeSource(() => cfg);
  assert.equal(currentMode(), 'smart');
  assert.equal(getRuntimeConfig().vlm.baseUrl, 'http://a');
  cfg = { mode: 'privacy', vlm_base: 'http://b' };
  assert.equal(currentMode(), 'privacy', 'a changed source must hot-apply');
  assert.equal(getRuntimeConfig().vlm.baseUrl, 'http://b');
  setRuntimeSource(null);
});

test('vlm privacy hard gate: false even when an external API is configured', async () => {
  const { isVlmConfigured } = await import('../src/vlm.js');
  setRuntimeConfig({ mode: 'privacy', vlm: { baseUrl: 'http://127.0.0.1:9999/v1', model: 'm', apiKey: 'k' } });
  assert.equal(isVlmConfigured(), false, 'privacy must disable the external API even when configured');
  setRuntimeConfig({ mode: 'smart', vlm: { baseUrl: '', model: '', apiKey: '' } });
});

test('bridge.hasImageBlock / deepFreeze', () => {
  const msg = { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }] };
  assert.equal(hasImageBlock([msg]), true);
  assert.equal(hasImageBlock([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]), false);
  const frozen = deepFreeze({ content: [{ type: 'text', text: 'y' }] });
  assert.equal(Object.isFrozen(frozen), true);
});

test('bridgeMessages: image messages degrade to local-tool guidance (privacy)', async () => {
  setRuntimeConfig({ mode: 'privacy' });
  const dir = await mkdtemp(join(tmpdir(), 'pr-test-'));
  const attachment = { attachmentId: 'abc123', mediaType: 'image/png', name: 'shot.png' };
  const ctx = {
    attachments: { readImage: async () => ({ data: Buffer.from([1, 2, 3]) }) },
  };
  const messages = [
    { role: 'user', content: [
      { type: 'text', text: 'look at this' },
      { type: 'image', attachment },
    ] },
    { role: 'user', content: [{ type: 'text', text: 'text only' }] },
  ];
  try {
    const out = await bridgeMessages(messages, ctx, dir);
    assert.equal(out.length, 2);
    const bridged = out[0];
    assert.notEqual(bridged, messages[0], 'the image message must be replaced by a new object');
    // the second text message must keep its identity
    assert.equal(out[1], messages[1]);
    const textBlocks = bridged.content.filter((b) => b.type === 'text');
    assert.ok(textBlocks.some((b) => b.text.includes('[mode:Privacy]')), 'carries the mode tag');
    assert.ok(textBlocks.some((b) => b.text.includes('Never call any external vision API')), 'injects the privacy policy');
    assert.ok(textBlocks.some((b) => b.text.includes('.png')), 'writes out the export path');
  } finally {
    await rm(dir, { recursive: true, force: true });
    setRuntimeConfig({ mode: 'smart' });
  }
});

test('bridgeMessages: a smart-mode hint carries the smart policy, not the privacy restriction', async () => {
  setRuntimeConfig({ mode: 'smart' });
  const dir = await mkdtemp(join(tmpdir(), 'pr-test2-'));
  const ctx = { attachments: { readImage: async () => ({ data: Buffer.from([9]) }) } };
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'xyz', mediaType: 'image/jpeg', name: null } }] }];
  try {
    const [out] = await bridgeMessages(messages, ctx, dir);
    const text = out.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    assert.ok(!text.includes('Never call any external vision API'));
    assert.match(text, /\[mode:Smart\]/);
    assert.match(text, /image_scan/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    setRuntimeConfig({ mode: 'smart' });
  }
});

test('exported constants are complete', () => {
  assert.ok(MODE_KEYS.includes('privacy'));
  assert.ok(MODE_KEYS.includes('smart'));
  assert.ok(MODE_KEYS.includes('strict'));
  assert.ok(Object.keys(MODES).length >= 3);
});

test('vlm_enabled opt-in: unchecked disables the external VLM', async () => {
  const { isVlmConfigured } = await import('../src/vlm.js');
  // Explicitly disabled: an endpoint and key alone do not enable it.
  setRuntimeConfig({ mode: 'smart', vlm_enabled: false, vlm_base: 'http://ext/v1', vlm_key: 'k' });
  assert.equal(isVlmConfigured(), false, 'unchecked opt-in disables the external VLM');
  // Checked, with endpoint and key present: available.
  setRuntimeConfig({ mode: 'smart', vlm_enabled: true, vlm_base: 'http://ext/v1', vlm_key: 'k' });
  assert.equal(isVlmConfigured(), true, 'opt-in checked plus endpoint and key means available');
  // Backwards compatibility: a flat config with vlm_base but no vlm_enabled counts as enabled.
  setRuntimeConfig({ mode: 'smart', vlm_base: 'http://ext/v1', vlm_key: 'k' });
  assert.equal(isVlmConfigured(), true, 'vlm_base without an explicit enabled flag means enabled');
  setRuntimeConfig({ mode: 'smart', vlm: { baseUrl: '', model: '', apiKey: '' } });
});

test('bridgeMessages: a SHA downgrade note exports the PNG from the attachment store and injects tool guidance', async () => {
  setRuntimeConfig({ mode: 'smart' });
  const root = await mkdtemp(join(tmpdir(), 'pr-objects-'));
  const dir = await mkdtemp(join(tmpdir(), 'pr-bridge-'));
  const hash = 'df7f126dcfac220d8eaeb99173f98f9383445eca3f2e9c6dd4dffb86e9273a86';
  const objectDir = join(root, hash.slice(0, 2));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: '[image omitted because this model accepts text only; attachment sha256:df7f126d]' }],
  }];
  try {
    await mkdir(objectDir, { recursive: true });
    await writeFile(join(objectDir, hash), png);
    assert.equal(hasShaAttachmentReference(messages), true);
    const [out] = await bridgeMessages(messages, {}, dir, { attachmentObjectsDir: root });
    assert.notEqual(out, messages[0], 'the SHA attachment message must be replaced by a new object');
    const text = out.content[0].text;
    assert.match(text, /image_scan/);
    assert.match(text, /attachment_df7f126dcfac\.png/);
    const exported = join(dir, 'attachment_df7f126dcfac.png');
    assert.deepEqual(await readFile(exported), png, 'must write the original image bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    setRuntimeConfig({ mode: 'smart' });
  }
});

test('bridgeMessages: an invalid or ambiguous SHA note keeps the original text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-objects-'));
  const dir = await mkdtemp(join(tmpdir(), 'pr-bridge-'));
  const text = '[image omitted because this model accepts text only; attachment sha256:df7f126d]';
  const messages = [{ role: 'user', content: [{ type: 'text', text }] }];
  try {
    const [out] = await bridgeMessages(messages, {}, dir, { attachmentObjectsDir: root });
    assert.equal(out, messages[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
