# Known Issues — Market Manager

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_P, 16k ctx),
alongside the game's own unit tests and live probing of the running server in headless Chrome.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node tests/rules.test.mjs`) | 67/67 pass, 0 failures |
| `node --check` on all modules (`src/*.js`, `server.js`, `tests/rules.test.mjs`) | clean |
| `tests/e2e.mjs` | not present |
| Headless-Chrome boot + interaction (served on :39405) | Boots to title and into the mode picker; only console error is a `404 /favicon.ico` |
| API fuzzing (`/api/v1/*`, malformed bodies, malformed percent-escapes) | server stayed up |
| Corrupt-`localStorage` sweep (8 corruptions × 1 key, reload each time) | PASS — no page errors, game still renders every time |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |

## Confirmed defects

Defects 1 and 2 were reproduced end to end against the running server on port 39405.

### 1. Score submissions are replayed against the *client's* config — arbitrary score inflation on the daily board

- **File:** `server.js:69` (`validateSubmission`) together with `src/rules.js:695` (`verifyReplay`)
- **Trigger:** POST `/api/v1/scores` with the published daily `id` and `seed`, but any other config
  field changed.
- **Behaviour:** for a daily submission the server compares exactly two fields:

  ```js
  if (cfg.dailyDate) {
    const published = dailyConfig(cfg.dailyDate);
    if (cfg.id !== published.id || envelope.seed !== published.seed) return { error: 'seed-mismatch' };
  }
  ```

  and `verifyReplay` then builds the world from the submitted object:

  ```js
  let state = createGame(envelope.config);
  ```

  Nothing else in `published` is compared — `startingMoney`, `map`, `departments`, `goals`, `maxTicks`
  and the rest are all attacker-controlled. `createGame` copies `config.startingMoney` straight into
  `state.money` (`src/rules.js:90`) and `computeScore` adds `reserves: state.money` to the total
  (`src/rules.js:654`), so the inflation is direct and the replay stays internally consistent.
- **Expected:** `spec.md` §2/§5 — the server must rebuild the authoritative config from published
  content and validate the replay against *that*. `number-mahjong/server.js` in this same batch does
  exactly that (`content = dailyContent(iso, …)` then `verifyReplay(replay, prepared, board)`).
- **Evidence:** live reproduction —

  ```
  honest daily score:     30       (startingMoney = 120)
  tampered daily score:   5000030  (startingMoney = 5000120)
  POST honest -> 200 {"ok":true,"rank":1}
  POST cheat  -> 200 {"ok":true,"rank":1}
  leaderboard: [{"name":"qa-cheat","score":5000030,"date":"2026-08-20",...},
                {"name":"qa-honest","score":30,...}]
  ```

### 2. Journey / practice content ids are accepted without existing

- **File:** `server.js:80`
- **Trigger:** POST `/api/v1/scores` with `config.id` set to any string beginning with `j`.
- **Behaviour:**

  ```js
  } else if (!cfg.id.startsWith('j') && !KNOWN_STAGE_IDS.has(cfg.id) && !cfg.id.startsWith('practice-')) {
    return { error: 'unknown-content' };
  }
  ```

  `journeyStage` is imported at the top of the file but never called, so the id is never resolved
  against real content. Combined with defect 1 the entire ruleset is fabricated.
- **Expected:** `spec.md` §2 — "Represent content as versioned data … Run offline validators"; a board
  entry must reference published content.
- **Evidence:** live reproduction —

  ```
  fabricated journey score: 8999910   (config.id = 'j-does-not-exist-9999', startingMoney = 9000000)
  POST -> 200 {"ok":true,"rank":1}
  board: [{"name":"qa-fakejourney","score":8999910,"configId":"j-does-not-exist-9999",...}]
  ```

### 3. The duration plausibility ceiling is set by the submitter

- **File:** `server.js:94-97` (`validateSubmission`)
- **Trigger:** submit any envelope with a large `config.maxTicks`.
- **Behaviour:**

  ```js
  const ticks = envelope.config.maxTicks;
  const ms = envelope.durationMs || 0;
  if (ms < 1000 || ms > ticks * 500 * 20) return { error: 'implausible-duration' };
  ```

  `ticks` is read from the client config, so the upper bound is whatever the client chose. If
  `maxTicks` is omitted entirely the product is `NaN` and `ms > NaN` is always false — the upper bound
  vanishes (the lower bound `ms < 1000` still applies).
- **Expected:** the ceiling should come from the authoritative published config.
- **Evidence:** source as quoted; independently flagged by the model review and confirmed by reading.
  A companion effect of the missing `maxTicks` case is that `verifyReplay`'s
  `maxIter = envelope.config.maxTicks + envelope.commands.length + 100` is also `NaN`, so the replay
  loop runs zero iterations and the submission then fails the separate `not-terminal` check.

### 4. `.mm-data/` — the server's default data directory — is not gitignored

- **File:** `.gitignore` (lists `node_modules/`, `.local-data/`, `*.log`, `.DS_Store`) vs `server.js:15`
  (`const DATA_DIR = process.env.MM_DATA_DIR || path.join(ROOT, '.mm-data');`)
- **Trigger:** run `node server.js` once.
- **Behaviour:** `fs.mkdirSync(DATA_DIR, { recursive: true })` runs at module load, so `.mm-data/`
  appears as an untracked directory in the working tree and its `boards.json` (containing player names
  and scores) is a commit candidate. The `.gitignore` entry that was clearly meant for this is
  `.local-data/`, which nothing in the repo writes to.
- **Expected:** the runtime data directory should be ignored.
- **Evidence:** `git status --porcelain` → `?? .mm-data/` after a single server start.
  Note: this QA pass started the server, so `.mm-data/boards.json` exists in the working tree and
  contains the test entries described in defects 1-2. It has been left in place for central cleanup.

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
