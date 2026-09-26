# picturereader: tests

Part of the `picturereader` agent guide; the map and the hard rules are in `../AGENTS.md`.

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
