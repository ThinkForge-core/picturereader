# picturereader: guide for agents

A map for an automated reader working in this repository. `README.md` is the
full user manual; this file covers only what an agent needs before touching
anything: how the plugin loads, which changes are live and which need a host
restart, the two failure classes that have already bitten this codebase, and how
to run the tests.

This checkout is the **fork** `ThinkForge-core/picturereader` of
`jing-hy/picturereader`, and it is a different product rather than a staging
area: Linux and Termux only, an English-only user surface, and a DSH 0.1.7 host
API. What that means for merges, and which of the other repository's changes
must not come back, is in "Fork, upstream and merges" below.

## Hard rules

- **Never modify a DSH checkout.** This plugin mounts into DSH only through
  `cordis.patch.yml` plus a profile (`$DSH_HOME/profiles/<name>/`); it never
  reaches into the harness sources.
- **`npm test` must stay green.** Engine-backed tests skip when the matching
  venv is absent, so the suite is expected to pass on a fresh checkout too.
- English in code, comments, docs and commit messages. No emoji, and no Cyrillic
  text at any point — not even in a fixture or an input alias.
  `tests/portability.test.js` fails the suite on the first Cyrillic character,
  so a Russian sample string or a localized yes/no reply is a red build, not a
  style question.
- The same guard also fails on a platform word — the two desktop operating
  systems this fork dropped, an OCR engine named after one of them, their
  compiler toolchain, a `process.platform` check naming them — and it scans
  **this file and `README.md` along with the sources**. Read the pattern list in
  `tests/portability.test.js` before writing platform prose, and describe the
  deleted engines without naming them, as the platforms row below does.
- Do not run `scripts/install.py` / `scripts/uninstall.py` against a live
  profile just to "check" something — they create venvs and rewrite
  `$DSH_HOME/profiles/*/package.json`. Use `--dry-run`, `--selftest` or
  `--verify` for a read-only answer unless the task really is an install.

## Branches

Two long-lived branches, and the split is deliberate — check which one you are
on before committing.

| Branch | What it is |
|---|---|
| `linux` | The primary line: all shared code, the installer, the OCR engine, the capability profile, the tests. |
| `termux` | **`linux` plus one commit** that adds only `README.md` (the Termux section) and `scripts/termux/setup.sh`. No source, no tests. |

`termux` is a strict descendant of `linux`, so a fix lands on `linux` once and
reaches the tablet with a merge rather than a cherry-pick:

```sh
git checkout termux && git merge linux     # no source conflicts by construction
```

Because the termux delta carries no JavaScript, **the test result is the same on
both branches** — verify Termux behaviour by running the suite on `linux` with
the environment variable Termux sets:

```sh
PREFIX=/data/data/com.termux/files/usr npm test
```

`src/platform-profile.js` keys off exactly that variable (`isTermux()`), which is
also what withholds the three `image_edit` actions the device cannot run.

## Fork, upstream and merges

`origin` is the fork (`ThinkForge-core/picturereader`, public, used as an
off-machine backup), `upstream` is the author's repository, and `linux` is the
line that ships. The `git-github-ssh` skill carries the general
procedure (its upstream-synchronisation section); what this repository adds is
below.

Fork commits are not upstream candidates - the two are different products - and
the working agreement for this checkout is not to open pull requests at all.
Work is finished by a local commit.

### The version number does not say who is ahead

Both repositories cut a `3.4.0` from the same parent (`bea02b1`) without seeing
each other: upstream's 3.4.0 is "native vision awareness", this fork's is
"RapidOCR + Termux". The fork has since moved to 3.4.2, so upstream can report a
*lower* version while carrying work this checkout does not have. Compare
`git log`, never the manifest.

### What diverges, and why it must survive a merge

| Area | What this fork does | Why a merge must not revert it |
|---|---|---|
| Platforms | Linux and Termux/Android only. The two non-Linux OCR engines (Apple Vision and the Microsoft built-in one), the `scripts/setup-*.mjs` helpers and the platform-conditional engine options are deleted (`c09317c`). | `tests/portability.test.js` fails the suite on the first platform word anywhere in the tree. |
| OCR | RapidOCR is the only engine and the default: ONNX Runtime, tiling so long screenshots are never downscaled, two recognition models with a configurable tie-break, a thread cap for phone-class hosts (`9eead39`, `20bcd5f`, `43f0db9`, `94316b1`). | PaddleOCR cannot be installed on aarch64 at all, which is what the Termux branch is for. |
| Language | An English-only user surface: `README.md`, `client.js`, `skills/*`. | The same guard fails on the first CJK character in those files. **This is why upstream's `zh` dictionary in `client.js` is dropped on every merge instead of being kept.** |
| DSH version | Targets 0.1.7-rc.2: the entry exports `Config`, every editable field is `live()` (`.volatile()`), values are resolved through `readConfig()`, and the browser half injects `configForms` (`fca0b98`). | 0.1.7 deleted `settings.register` and renamed `settingsScope`; the older shape does not load here at all. |
| Live ctx | Services are reached only through `inject`; `hostLlm()` in `src/bridge.js` exists for the single place a service is wanted outside a declared injection. | The live ctx is a Cordis proxy that throws on any undeclared public property. Upstream resolves the llm service as `ctx.get?.('llm') ?? ctx.llm`, which would take down every `llm/stream` call on this host. |
| Branches | `linux` is the primary line; `termux` is `linux` plus one README/setup commit. | Keeps the tablet delta a merge rather than a cherry-pick. |

### Merge recipe

Upstream ships fixes worth having, and upstream is written against a DSH that no
longer exists, so resolve by hand: never `-X theirs`, and never "take upstream's
file" for `client.js`, `README.md`, `package.json` or `src/index.js`.

```sh
git fetch upstream
git log --oneline HEAD..upstream/main     # what they have and we do not
git log --oneline upstream/main..HEAD     # our divergence - this is what conflicts
git merge upstream/main
```

Four conflict classes recur, and each has one answer:

1. **Settings surface** - anything upstream registers through a `settings` scope
   becomes an exported, `live()`-marked `Config` field read through `readConfig()`.
2. **Service access** - `ctx.<service>` or `ctx.get(...)` in upstream code becomes
   an `inject` entry, or a best-effort accessor like `hostLlm()`.
3. **Language** - upstream's CJK comments: keep the code, write the comment in
   English. CJK strings leave the user-facing files entirely.
4. **Platforms** - upstream's non-Linux branches and `setup-*.mjs` references are
   deleted, not merged.

Then verify, and only then hand the artifact to the profile:

```sh
npm test                                  # must be 0 failures
npm pack --cache .npmcache-local          # ~/.npm is not writable in the sandbox
dsh plugin --profile web add file:$PWD/picturereader-<version>.tgz
# restart the `dsh web` process before expecting the new host half to load
```

### Install a copied tarball, never a symlink to this checkout

The profile has to take the packed `.tgz`. A `link:` to this checkout brings its
own `node_modules` along, and therefore a second `@deepseek-ai/schemastery`; if
the version that resolves first lacks `Schema.volatile()`, `live()` degrades to a
plain field, `Config` ends up with no volatile field at all, the settings service
never publishes the namespace, and the card reports "Settings namespace
unavailable (picturereader not registered server-side?)" while everything else
looks healthy. Confirm the schema before blaming the host:

```sh
node --input-type=module -e "import { Config } from './src/index.js'; const d = Config.dict; console.log(Object.keys(d).filter(k => !d[k]?.meta?.volatile))"
```

The only field allowed to print is `vision_bridge_enabled`: it is deprecated,
unreferenced, and deliberately not volatile.

## Layout

| Path | What lives there |
|---|---|
| `src/index.js` | Plugin entry: config schema, `inject`, and the one `ctx.tools.register(...)` block per tool. |
| `src/core.js` | Engine-agnostic business logic: decode/scan/palette/OCR runners, `inject`-free helpers. Re-imported by mtime on every execution. |
| `src/tool.js` | `image_scan` / `image_ocr` / `image_sample` factories and the shared `BYTE_CAP` / `MAX_PIXELS` caps. |
| `src/more-tools.js` | `image_crop` / `image_palette` / `image_compare` / `image_edit`-adjacent small tools. |
| `src/image-batch.js` | `image_batch` factory (batch manifest). |
| `src/image-edit.js` | `image_edit` factory; materializes inputs and shells out to `scripts/image-edit.py`. |
| `src/doc-tools.js` | `document_to_image` (PDF/Office -> PNG pages). |
| `src/paths.js` | Interpreter resolution: `DSH_*_PYTHON` env -> installer state file -> `$DSH_HOME/picturereader/venvs/<role>`. |
| `src/workspace-paths.js` | Output directories and the sandbox-aware "file not found" hint. |
| `src/vision-analyze.js`, `src/vlm.js`, `src/bridge.js` | Optional external VLM bridge and the visual twin. |
| `scripts/*.py` | Python backends (`ocr.py`, `image-edit.py`, `doc-to-image.py`) and the installer. |
| `client.js` | Web settings card (browser bundle, rebuilt separately from the host). |
| `tests/` | `node:test` suites; `tests/fixtures.mjs` builds deterministic images in memory. |

## Commands

```sh
npm test                                  # node --test over tests/
node --test tests/image-edit.test.js      # one suite while iterating
node --test --test-name-pattern 'batch'   # filter by test name
python3 scripts/install.py --verify       # check an existing installation (read-only)
python3 scripts/install.py --selftest     # installer's own self-test
python3 scripts/uninstall.py --dry-run    # component inventory and sizes
node scripts/preview.mjs                  # regenerate fixtures and preview the rendering
```

## What is live, and what needs a host restart

`src/core.js` is imported through `importCore()` with an mtime cache-buster on
every tool execution, so **core.js fixes take effect without a restart**.

Everything else is captured when the plugin is applied: `index.js` runs
`ctx.tools.register(factory(ctx))` once, and each factory closes over the
imported modules. So changes to **`index.js`, the tool factories
(`tool.js`, `image-batch.js`, `image-edit.js`, `more-tools.js`, `doc-tools.js`),
tool schemas/descriptions, or `client.js`** are invisible to an already-running
host until it is restarted. There is no plugin-reload command in DSH.

Practical consequence for verification: the test suite exercises the sources
you just edited, but a *live* tool call in a running session still runs the old
code. Either restart the host, or drive the factory out of process with a ctx
that mimics the live one (see the seam note below).

## Two failure classes that must not regress

### 1. The live ctx is a Cordis proxy

The `ctx` a factory receives throws
`cannot get property "X" without inject` for any public property that was not
declared through `inject`/`provide`. Underscore-prefixed names are exempt from
the trap (which is why the `_imageEditRunner` seam works, while reading
`ctx.ocrImage` crashed every `image_batch` call). Untyped test contexts are
plain objects and hide this completely.

- Read optional test seams through a try/catch helper — see
  `readOptionalSeam` in `src/image-batch.js` — and keep a regression test that
  runs the tool against a throwing `Proxy` (see `tests/batch.test.js`).
- When a tool genuinely needs a service, add it to `inject` in `src/index.js`;
  do not rely on a property happening to exist.

### 2. Tool output must be lossless JSON

The harness validates the returned value against the tool's `output.schema` and
rejects anything that is not lossless JSON. Concretely: a property declared
`{ type: 'string' }` or `{ type: 'integer' }` must not be `null`, and an own key
holding `undefined` is still a key (`JSON.stringify` drops it, the validator
does not). `image_edit` shipped `width: result.width ?? null` and
`extra: result.extra ?? undefined`, which failed every action with
`tool "image_edit" returned invalid output`.

- **Omit** optional fields instead of nulling them, and only assign typed fields
  from real values (`Number.isFinite`, `typeof === 'string'`).
- When a backend legitimately has no value (`exif_read` writes no file), make
  the schema property optional and leave the key out.
- Cover it with a test that asserts no value is `null`/`undefined` and that the
  object round-trips through `JSON.parse(JSON.stringify(...))`.

## Tests

- Framework: `node:test` + `node:assert/strict`. No extra runner, no mocks
  library — the suites build small fake `ctx` objects with an in-memory `fs`.
- Engine-backed tests gate on the venv and **skip** rather than fail:
  `RAPID_READY` (`$DSH_HOME/picturereader/venvs/ocr`) for the default engine,
  `PADDLE_READY` (`.../venvs/paddle`) for the legacy `runPaddleOcr` primitive.
  `ocrFile` and `ocrImage` both resolve the engine through `ocrEngine()`, so
  they need *an* engine, not a specific one. Keep that property when adding
  tests.
- The RapidOCR venv ships only the `ch` and `eslav` recognition models plus the
  detectors. A test that names another language (`en`, `ja`, ...) triggers a
  model download and fails on a read-only or offline host — stick to the bundled
  keys, or assert on the resolved model key rather than a BCP-47 tag.
- Report what the engine actually returns. `image_ocr` reports the resolved
  **model keys** (`eslav`, `ch+eslav`), not the tag the caller passed (`ru`).
- Never name a **platform-gated** `image_edit` action directly. Under Termux
  `availableEditActions` removes `remove_background` / `raw_convert` / `upscale`
  from the tool enum, so a test that calls one fails with "action is not
  available here". Filter by the tool's own enum
  (`createImageEditTool({}).parameters.properties.action.enum`) instead, as
  `tests/image-edit.test.js` does for the timeout table. Verify with
  `PREFIX=/data/data/com.termux/files/usr npm test`.
- Assert a backend error on an action that exists on every platform: matching
  `/rembg/` in an error test passes under Termux by accident, because the
  platform gate throws a message that also contains "rembg".
- Keep fixtures deterministic (`tests/fixtures.mjs`) and never depend on a live
  network or on `~/.dsh` being writable.
- The Python venvs live outside the repository. In a write-sandboxed session
  they are readable but not writable, which surfaces as
  `[Errno 30] Read-only file system` when something tries to download a model.

## Python backends

- `scripts/ocr.py` prints a base64 JSON payload after the
  `@@PICTUREREADER-OCR@@` marker so model-loading chatter cannot corrupt it;
  long screenshots are tiled, never downscaled.
- `scripts/image-edit.py` and `scripts/doc-to-image.py` print the result as the
  last JSON line of stdout; an `error` field is a tool error.
- JS never imports Python; it spawns the resolved interpreter with a request
  file and parses stdout. Keep the wire format backward compatible or update
  both sides in the same change.

## Adding or changing a tool

1. Keep the logic in `src/core.js` when it is engine-agnostic; keep the factory
   thin (materialize inputs, call the backend, shape the output).
2. Register it in the `ctx.effect(...)` block in `src/index.js`.
3. Give it a full `parameters` schema, an `output.schema` and a `render` — the
   model reads the rendered text, and the harness validates the object.
4. Add a suite under `tests/` that covers the happy path, argument validation
   and the "missing environment" error path; assert the output shape.
5. Update `README.md` (tools table, `image_edit` actions, environment
   variables) when behavior or defaults change.
