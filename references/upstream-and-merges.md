# picturereader: upstream, forks and merges

Part of the `picturereader` agent guide; the map and the hard rules are in `../AGENTS.md`.

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

Then verify, and only then hand the artifact to the profile. These commands are the
human's, not the agent's (`../AGENTS.md` §6) - the agent's sandbox is exactly why it
needs `--cache` and cannot write the profile:

```sh
npm test                                  # must be 0 failures
npm pack --cache .npmcache-local          # ~/.npm is not writable in the agent's sandbox
dsh plugin --profile web remove picturereader
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
