# Market Manager — Architecture

StarHermit engine script game (engine 1.24.0, host API 1.21, `engine.minor=20`):
`native/*.ts` on the engine's modules (`starhermit:scene`, `ui`, `audio`,
`storage`, `platform`) over the pure ES modules in `src/`, which the engine
imports unchanged (`allowJs`) and node tests run directly.

## Module map

- `src/rng.js` — seeded RNG (`createRng`, `hashString`, `stableStringify`, `hashState`). DONE.
- `src/rules.js` — pure deterministic rules engine. DONE. Never import DOM/three here.
- `src/content.js` — versioned stages, themes, tutorials, daily, validators, `autoPlay`. DONE.
- `src/session.js` — sessions, undo, replay envelopes, persistence, settings, progress, achievements. DONE.
- `src/store.js` — the save document (normalize, two-device merge, the old cloud slot, the key store session.js uses, local boards). Pure.
- `native/main.ts` — entry: screen state machine, the fixed-step 500 ms tick, commands, picks, tutorials, hints, results, input.
- `native/screens.ts` — every screen and the HUD on `starhermit:ui`.
- `native/render.ts` — the market on `starhermit:scene`. Contract below.
- `native/audio.ts` — one-shots, rendered music layers and ambience.
- `native/platform.ts` — the save on `starhermit:storage`, migration, legacy settings, player, clock, leaderboard.
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

## Render contract (native/render.ts)

Module-level scene (the runtime draws `scene` each frame through `renderer.camera`):

- `applyLook(look)` — the graphics tier's look (native/quality.ts); rebuilds a live market when the asset budget changes.
- `buildMarket(state, config, theme)`, `syncState(state, events)`, `clear()`.
- `setHighlight(targets)` — `null` or `[{kind, id}]` pulsing rings.
- `setTheme`, `setColorblind`, `setCamera`, `resetCamera`, `setReducedMotion`, `setPaused`, `setActive(on)`.
- `update(dt, width, height, topInset, bottomInset, scale)` — each frame: framing between the HUD bands (setViewOffset), springs, motion, effects.
- Input: `pointerDown/Move/Up/Cancel/Leave`, `wheel`, `pickAt(x, y)` → `{kind, id?, x?, y?}`, `targetRects()` (named areas for ui.target).

## Platform contract (native/platform.ts)

The save (`saves`) is `{ v: 1, progress, boards, settings, lastPlayed }`; the old
JS-SDK cloud slot (`{ v, savedAt, progress, boards }`) is foreign and migrates
once. Conflicts merge with `store.mergeDocs`. Legacy settings-KV keys are carried
over (theme, camera, colorblind, leftHanded, haptics, tutorialsDone) and removed.
Signed in, ranked runs post `{ type: 'result', scores: { 'high-score': total } }`
through a practice session to `score-script.js`. The Daily's UTC day uses
`serverNow()` when known.

## State model

`boot → title → mode-select → setup → countdown → active ↔ paused → results → progression`.
Suspending the game (a hidden window) pauses the shift (the fixed-step tick stops);
on return show a brief "while you were away" note. Closing a drawer or overlay must never
touch simulation state.
