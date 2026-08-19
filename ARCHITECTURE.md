# Market Manager — Architecture

Browser game. Vanilla ES modules, no build step. Three.js is vendored at
`lib/three.module.min.js` (import via the `three` import map entry defined in
`index.html`). Everything must run from a static file server and offline after
first load.

## Module map

- `src/rng.js` — seeded RNG (`createRng`, `hashString`, `stableStringify`, `hashState`). DONE.
- `src/rules.js` — pure deterministic rules engine. DONE. Never import DOM/three here.
- `src/content.js` — versioned stages, themes, tutorials, daily, validators, `autoPlay`. DONE.
- `src/session.js` — sessions, undo, replay envelopes, persistence, settings, progress, achievements. DONE.
- `src/render.js` — Three.js scene. Contract below.
- `src/ui.js` — DOM shell: screens, HUD, panels, accessibility. Owned by UI implementation.
- `src/audio.js` — WebAudio synth SFX + adaptive music, volume buses. Owned by UI implementation.
- `src/platform.js` — optional hosted backend adapter with graceful local fallback. Contract below.
- `src/main.js` — bootstrap + glue. Owns the game loop.
- `server.js` — optional Node authoritative script (daily seeds, score validation, leaderboards).
- `tests/rules.test.mjs` — `node tests/rules.test.mjs` must stay green.

## Rules API (src/rules.js) — what presentation consumes

State is plain JSON. Key fields:

- `tick` (monotonic), `phase` ('active'|'won'|'lost'), `terminalReason`
- `money`, `invalidCount`, `commandCount`
- `grid: {w, h, cells[y][x]}` where cell `{t}` uses `TILE`: FLOOR 0, WALL 1, ENTRANCE 2, STOCKROOM 3, DISPLAY 4, CHECKOUT 5. Display cells also carry `{dept}` (map letter).
- `entrance {x,y}`, `stockroom {x,y}`
- `departments: [{id, key, name, unlocked, unlockCost}]`
- `displays: [{id, deptId, x, y, level, capacity, stock, price, unitCost}]`
- `checkouts: [{id, x, y, level, queue: [customerId...]}]`
- `customers: [{id, x, y, status ('to-display'|'shopping'|'to-checkout'|'queued'|'leaving'|'gone'), targetDisplayId, checkoutId, patience, patienceMax, carry, path, pathIndex}]`
- `staff: {stocker: {hired, cost}, cashier: {hired, cost}}`
- `stats: {served, angry, emptyLeft, revenue, restockSpend, spawned}`
- `config: {maxTicks, moveLimit, goals {serve?, earn?, unlock?, maxAngry?}, allowed {restock, serve, hire, upgrade, unlock, undo}, ...}`
- `lastEvents` — events of the most recent `step()` (presentation-only).

Exports: `createGame(config)`, `step(state)`, `applyCommand(state, cmd)`,
`validateCommand(state, cmd)` (→ `{ok, reason}`; reasons are stable lowercase
strings like `'display-full'`, `'queue-empty'`, `'not-enough-money'`,
`'department-locked'`, `'max-level'`, `'already-hired'`, `'no-moves-left'`),
`legalActions(state)`, `computeScore(state)` (→ `{components, total, tiebreak}`),
`restockCost(display)`, `upgradeCost(state, kind, target)`, `queueSlot(state, checkout, index)`,
`findPath`, `stateHash`, `isTerminal`, `COMMANDS`, `TILE`, `TICK_MS` (500).

Event kinds (in `lastEvents` / session 'events'): `spawn`, `take`, `restock`,
`served`, `left-angry`, `left-empty`, `hire`, `upgrade`, `unlock`, `terminal`.
Events carry relevant ids/positions (e.g. `{kind:'served', customerId, checkoutId, amount}`).

## Content API (src/content.js)

`journeyStages()` (40), `tutorialStages()` (4), `challengeStages()` (5),
`practiceConfig('relaxed'|'standard'|'intense')`, `dailyConfig(dateIso)`,
`dailyDateUtc()`, `THEMES` (5, `{id, name, sky, fog, ground, tile, accent, key, intensity}`),
`themeById(id)`, `DEPARTMENT_TYPES`. Stage configs carry `id, name, seed, map,
departments, goals, par, theme, blurb?, tutorial? {steps: [{text, require}]}`, and
`mastery?`.

## Session API (src/session.js)

`createSession({config, mode, allowUndo})` → session:

- `session.state` (immutable snapshot), `session.isOver`, `session.id`
- `session.issue(cmd)` — `{type, displayId?...}` without id/tick → `{ok, reason?, events}`
- `session.stepTick()` — advance one tick (call from fixed-timestep loop), returns events
- `session.legalActions()`, `session.explain(cmd)`
- `session.canUndo()`, `session.undo()`
- `session.score()`, `session.replayEnvelope()`
- `session.on('change'|'events'|'terminal', cb)`

Store helpers: `loadSettings()/saveSettings(s)` (see `DEFAULT_SETTINGS`),
`loadProgress()/saveProgress(p)`, `recordResult(progress, session)` → newly unlocked achievements,
`ACHIEVEMENTS`. `TICK_MS` re-exported (500ms per tick).

## Render contract (src/render.js)

Single export:

```js
import { createRenderer } from './render.js';
const renderer = createRenderer(containerEl, opts);
```

`opts`: `{ quality: 'low'|'medium'|'high', reducedMotion: boolean, colorblind: string,
camera: 'isometric'|'high'|'low', onPick: (pick|null) => void, onHover: (pick|null) => void }`.

`pick` = `{ kind: 'display'|'checkout'|'department'|'floor', id?, x, y }`
(department picks use the department `id`; floor picks carry tile coords).

Methods:

- `buildMarket(state, config, theme)` — full (re)build from a snapshot + stage config + theme object.
- `syncState(state, events)` — reconcile views to the latest snapshot; `events` are the
  events emitted since last sync (may be `[]`). Must be cheap; called up to once per animation frame.
- `setHighlight(targets)` — `null` to clear, else `[{kind:'display'|'checkout'|'department', id}]`
  to mark legal targets (outline + grounded marker, not bloom alone).
- `setQuality(q)`, `setReducedMotion(b)`, `setColorblind(mode)`, `setTheme(theme)`,
  `setCamera(mode)`, `resetCamera()`
- `setPaused(b)` — freeze decorative motion (simulation visuals derive from state, not wall time).
- `start()`, `stop()` — own requestAnimationFrame loop; must render 0 frames while stopped/hidden.
- `resize()`
- `getDrawStats()` → `{calls, triangles}`
- `dispose()` — explicit disposal of geometries/materials/renderer.

Requirements: orthographic isometric-authored camera (exposed framing constants, no magic
offsets); PBR lighting with one key light + soft fill + tone mapping (ACES); procedural
low-poly geometry (no external assets); department displays as shelved goods whose fill
matches `stock/capacity`; customers as small walkers following `path`/`x,y` with queued
customers standing at `queueSlot` positions; patience shown as a shrinking ring/bar;
selected/legal targets readable without post effects; instancing for repeated props;
layered so particles never intercept raycasts; raycast only against explicit interactive
meshes; pointer tap vs drag thresholds; visual seed derived from `config.seed` for
decoration so replays look identical; draw calls ≤ 150 desktop / ≤ 90 mobile at default tier.
Fall back gracefully (return `null` from a `tryCreateRenderer`-style guard is NOT needed —
main.js checks WebGL support before calling).

## Platform contract (src/platform.js ↔ server.js)

Same-origin, optional. All calls must time out fast and fall back to local behavior
(offline play is fully supported). Endpoints:

- `GET /api/v1/time` → `{ now: <unix ms> }` (round-trip adjusted offset for daily boundary)
- `GET /api/v1/daily` → `{ date: 'YYYY-MM-DD', seed: <uint32>, excluded: false }`
- `POST /api/v1/scores` — body: replay envelope from `session.replayEnvelope()` → `{ ok, rank? }` or `{ error }`
- `GET /api/v1/leaderboard?board=<daily|global>&date=<iso>` → `{ entries: [{name, score, date, durationMs}] }`
- `POST /api/v1/heartbeat` → `{ ok: true }` (throttled, only while actively playing)
- Rate limit: HTTP 429 with `{ error }` — treat as recoverable.

Never persist tokens. Guest mode needs none of this.

## State model

`boot → title → mode-select → setup → countdown → active ↔ paused → results → progression`.
Backgrounding the tab pauses the solo simulation (fixed-timestep accumulator stops);
on return show a brief "while you were away" note. Closing a drawer or overlay must never
touch simulation state.
