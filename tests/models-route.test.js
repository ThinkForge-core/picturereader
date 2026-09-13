/**
 * Models route + scan persistence (src/index.js).
 *
 * Regression guard for a class of bug that no other check in this repository
 * catches: an undefined identifier inside the *request-time* closure of the
 * `/picturereader/models` handler.
 *
 * Symptom that motivated this file (v3.3.2 working tree):
 *
 *     [picturereader] models route: read failed: ReferenceError: MODELS_CACHE is not defined
 *
 * A portability refactor removed `const MODELS_CACHE = …` while four usages
 * survived. The failure was invisible to every existing check:
 *   - `dsh-upgrade-tools verify` only imports the module and calls `apply()`,
 *     so it still reported `yes  routes:1  /picturereader/models`;
 *   - `node --check` is happy (valid syntax);
 *   - a bare `import` of the module succeeds;
 *   - the route swallowed the ReferenceError and answered `200 []`, so the
 *     settings card simply showed an empty model list.
 *
 * These tests mount the plugin on a mock context, capture the handler that
 * `webServer.register` receives, invoke it, and exercise the async provider
 * scan — i.e. exactly the code paths `verify` never reaches.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/index.js';

/** Point `$DSH_HOME` at a throwaway directory; restore it afterwards. */
function withHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-models-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Path the plugin must use for its scanned-model cache. */
function cachePath(home) {
  return join(home, 'picturereader-models.json');
}

/**
 * Mount the plugin on a minimal writable context.
 *
 * Tool construction is not interesting here, so `effect` runs the callback but
 * tolerates anything it throws; only `webServer` and `settings`+`llm`
 * injections are answered.
 *
 * @param {{llm?: object, config?: object}} [options]
 * @returns {{ctx: object, routes: Array<{path: string, handler: Function}>, warnings: string[]}}
 */
function mountPlugin(options = {}) {
  const routes = [];
  const warnings = [];
  const scope = {
    get: () => options.config ?? {},
    watch: () => {}
  };
  const ctx = {
    effect(fn) {
      try {
        return fn();
      } catch {
        return undefined;
      }
    },
    tools: { register: () => {} },
    logger: { warn: (m) => warnings.push(String(m)), info: () => {} },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({
          webServer: {
            register(route) {
              routes.push(route);
            }
          }
        });
      } else if (deps.includes('settings') && deps.includes('llm')) {
        cb({
          settings: { register: () => scope },
          llm: options.llm ?? { listProviders: () => [] }
        });
      }
      // `attachments` is deliberately left unanswered: the image bridge is not
      // under test and mounting it would drag in the real attachment service.
    }
  };
  apply(ctx, options.config ?? {});
  return { ctx, routes, warnings };
}

/** Drive a captured handler with a minimal response recorder. */
async function callHandler(handler) {
  const res = {
    statusCode: null,
    body: undefined,
    writeHead(status) {
      this.statusCode = status;
      return this;
    },
    end(body) {
      this.body = body;
    }
  };
  await handler({ method: 'GET', url: '/picturereader/models' }, res);
  return res;
}

test('the models route is registered on the web server', () => {
  const { routes } = mountPlugin();
  const route = routes.find((r) => r.path === '/picturereader/models');
  assert.ok(route, 'the plugin must register /picturereader/models');
  assert.equal(typeof route.handler, 'function', 'the registered route needs a handler function');
});

test('the handler serves the cached model list, not an empty fallback', async (t) => {
  const home = withHome(t);
  const models = [
    { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }
  ];
  writeFileSync(cachePath(home), JSON.stringify(models, null, 2));

  const { routes } = mountPlugin();
  const res = await callHandler(routes.find((r) => r.path === '/picturereader/models').handler);

  assert.equal(res.statusCode, 200);
  // Before the fix this was `[]`: the handler threw `ReferenceError:
  // MODELS_CACHE is not defined`, the catch answered an empty list, and the
  // settings card silently lost every model.
  assert.deepEqual(JSON.parse(res.body), models, 'the cached models must reach the client');
});

test('the handler stays fail-soft when the cache file is missing', async (t) => {
  const home = withHome(t);
  assert.equal(existsSync(cachePath(home)), false);

  const { routes } = mountPlugin();
  const res = await callHandler(routes.find((r) => r.path === '/picturereader/models').handler);

  assert.equal(res.statusCode, 200, 'a missing cache must not surface as an HTTP error');
  assert.deepEqual(JSON.parse(res.body), []);
});

test('the provider scan persists text models next to the cache path', async (t) => {
  const home = withHome(t);
  const llm = {
    listProviders: () => [{ id: 'deepseek-official' }],
    listModels: async () => [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', inputModalities: [] },
      { id: 'some-vlm', name: 'VLM', inputModalities: ['image'] }
    ]
  };
  mountPlugin({ llm, config: { debug: false, vision_models: [] } });

  // The scan is fire-and-forget; wait for the write instead of guessing a delay.
  const target = cachePath(home);
  const deadline = Date.now() + 5000;
  while (!existsSync(target) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }

  assert.ok(existsSync(target), 'the scan must write its result to $DSH_HOME/picturereader-models.json');
  const written = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(written, [
    { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }
  ], 'image-capable models must be excluded and text models kept');
});

test('the cache follows $DSH_HOME instead of a hardcoded ~/.dsh', async (t) => {
  const home = withHome(t);
  mkdirSync(join(home, 'nested'), { recursive: true });
  writeFileSync(cachePath(home), JSON.stringify([{ provider: 'p', id: 'm', name: 'm' }]));

  const { routes } = mountPlugin();
  const res = await callHandler(routes.find((r) => r.path === '/picturereader/models').handler);

  assert.deepEqual(JSON.parse(res.body), [{ provider: 'p', id: 'm', name: 'm' }]);
});
