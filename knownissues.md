# Known Issues — Market Manager

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_P, 16k ctx),
alongside the game's own unit tests and live probing of the running server in headless Chrome.
Re-verification pass 2026-09-05 fixed the four confirmed defects below (see **Resolved defects**).

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node tests/rules.test.mjs`) | 67/67 pass, 0 failures |
| `node --check` on all modules (`src/*.js`, `server.js`, `tests/rules.test.mjs`) | clean |
| `tests/e2e.mjs` (`npm run test:e2e`, desktop + mobile) | PASS — both playthroughs complete, 0 page errors |
| Headless-Chrome boot + interaction (served on :39405) | Boots to title and into the mode picker; only console error is a `404 /favicon.ico` |
| API fuzzing (`/api/v1/*`, malformed bodies, malformed percent-escapes) | server stayed up |
| Corrupt-`localStorage` sweep (8 corruptions × 1 key, reload each time) | PASS — no page errors, game still renders every time |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |

## Resolved defects

Fixes from the 2026-09-05 re-verification pass. All four were confirmed still present in the
pre-fix source, then fixed and re-verified (see the per-item verification notes).

### 1. Score submissions are replayed against the *client's* config — arbitrary score inflation on the daily board — RESOLVED

- **Fix:** `server.js:78-104` (`validateSubmission`). The server now resolves the authoritative
  published config for the submitted content and replays against *that* rather than the submitted
  `envelope.config`:
  - daily → `dailyConfig(cfg.dailyDate)`; journey (`j…`) → `journeyStage(cfg.id)`;
    practice (`practice-…`) → `practiceConfig(...)`; challenge → the matching `CHALLENGES` entry.
    Any id that does not resolve to real published content returns `unknown-content`.
  - Each resolved config's own `seed` must equal `envelope.seed`, otherwise `seed-mismatch`.
  - `verifyReplay` runs against `{ ...envelope, config: authoritative }`, so `createGame`
    builds the world from published fields (`startingMoney`, `map`, `departments`, `goals`,
    `maxTicks`, …) and the inflation vector is closed.
- **Verification:** tampered daily (`startingMoney` +5,000,000) accepted but scored identically to
  the honest run (both 3033) instead of +5,000,000 — no inflation. Fabricated journey id
  `j-does-not-exist-9999` → `422 unknown-content`.

### 2. Journey / practice content ids are accepted without existing — RESOLVED

- **Fix:** `server.js:88-100`. `journeyStage(cfg.id)` / `practiceConfig(...)` are now called (the
  import was previously unused); unknown journey stages and unparseable practice difficulties
  return `422 unknown-content`. Only real content resolves to an authoritative config.
- **Verification:** `POST` with `config.id = 'j-does-not-exist-9999'` → `422 {"error":"unknown-content"}`.

### 3. The duration plausibility ceiling is set by the submitter — RESOLVED

- **Fix:** `server.js:115` (`validateSubmission`). The ceiling is computed from the authoritative
  config's `maxTicks` (`authoritative.maxTicks`), which is always present for published content, so
  the upper bound can no longer be raised by a client-chosen `maxTicks` (nor become `NaN` when it is
  omitted).
- **Verification:** an honest replay posted with `durationMs` beyond the published ceiling
  (240 × 500 × 20 = 2.4M) → `422 implausible-duration`; the same envelope's ceiling was unaffected
  by a tampered client `maxTicks: 999999`.

### 4. `.mm-data/` — the server's default data directory — is not gitignored — RESOLVED

- **Fix:** `.gitignore` — added `.mm-data/` (the directory `server.js:36` creates at module load).
- **Verification:** `git status --porcelain` no longer lists `.mm-data/` after a server start.

## Suspected — not confirmed

### 1. Static-file boundary check is a string prefix, not a path boundary

- **File:** `server.js:203-205` (`serveStatic`)
- **Concern:** `const file = path.normalize(path.join(ROOT, pathname)); if (!file.startsWith(ROOT)) …`
  — `ROOT` is `path.dirname(...)` and therefore has no trailing separator, so any sibling directory
  whose name begins with `market-manager` (e.g. `market-manager-old/`) would satisfy the prefix test
  and be served.
- **Why unconfirmed:** no such sibling exists in this checkout, and a live `GET /../fleet-signals/spec.md`
  correctly returned 404. Creating a prefix-sharing sibling to prove exploitation would have meant
  writing into `~/games`, which was out of scope for this pass.

### 2. Per-IP rate-limit buckets are never swept

- **File:** `server.js:51-58` (`rateLimited`)
- **Concern:** `buckets.set(ip, b)` with no expiry pass and no cap; unique source addresses accumulate
  for the process lifetime.
- **Why unconfirmed:** the growth is one small object per address and no leak threshold is specified;
  needs an operational judgement rather than a code fix decision.

## Checked, no defects found

- **Rules engine** (`src/rules.js`): 67 unit tests covering construction/serialization, legal actions
  and invalid reasons, economy, the customer/queue simulation, terminal states and scoring,
  determinism and replay, fuzzing, greedy-bot solvability of every stage, move-limit/challenge rules
  and daily determinism — all pass.
- **Score tie-break shape** (`src/rules.js:662`): `computeScore` returns
  `tiebreak: { goalComplete, invalidCount, ticksElapsed }`, matching the spec's ordering, and the
  leaderboard sort falls back to `durationMs` then `sessionId`.
- **Idempotency of submissions** (`server.js:150`): duplicate `sessionId` + `configId` pairs update
  the existing row in place rather than adding a second entry.
- **Malformed input robustness:** malformed JSON, `null`/array bodies, wrong-typed fields on every
  `/api/v1/*` route, and a malformed percent-escape in the URL path (`GET /%E0%A4%A`) all left the
  process running. `serveStatic` does not call `decodeURIComponent`, which is what crashes three
  sibling games in this batch.
- **Corrupt / absent `localStorage`:** 8 reload cycles with `localBoards.v1` set to `''`, `'{'`,
  `'null'`, `'[]'`, `'"x"'`, `'{"v":999999}'`, `' garbage'` and `'{"version":-1,"data":null}'` all
  booted cleanly with no page errors.
- **Model false positive worth recording:** the review claimed `readBody` can leave its promise
  pending after `req.destroy()`. It cannot — `reject(new Error('too-large'))` is called on the line
  before `req.destroy()`, so the promise is already settled.

## Not tested

- **Three.js render correctness** (`src/render.js`, 1489 lines). The title screen creates no canvas;
  the isometric scene was only exercised far enough to confirm it produces no runtime errors.
- **Audio** (`src/audio.js`): headless Chrome blocks the AudioContext before a user gesture.
- **Learn / Journey / Challenge play-throughs in the browser.** Only the mode picker and the first
  screens were driven; the rules engine's own golden-session tests cover the logic.
- **`MM_DATA_DIR` deployment path and durable-store behaviour under concurrent writes.**
