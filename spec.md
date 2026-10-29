# Market Manager — Game Design Document

Running spec. Present tense: everything below describes what the shipped game does today.
Anything the design wants but the code does not yet do is collected in **§17 Design intent not yet implemented**.

## 1. Overview

**Pitch:** run a small neighborhood market for one timed shift — keep the shelves full, keep the checkout line
short, and spend the takings on staff, upgrades and new departments before closing time.

| | |
|---|---|
| Genre | Single-player real-time management / tycoon puzzle |
| Players | 1, plus asynchronous leaderboards |
| Session | 2–8 minutes per shift (120–240 ticks at 500 ms) |
| Platforms | StarHermit engine 1.24.0 script game (host API 1.21, `engine.minor=20`): played natively by the StarHermit client and in desktop and mobile browsers by the engine's web runtime; portrait and landscape |
| Rendering | `starhermit:scene` orthographic isometric market under a `starhermit:ui` shell; an action list of every market command is an equal keyboard / gamepad play path |
| Content id | 40 journey stages, 4 lessons, 5 challenges, 3 practice paces, 1 daily |

### File map

| Path | Contents |
|---|---|
| `starhermit.txt` | Manifest: name, owner, `server=score-script.js`, cover, `launch=index.html`, `engine.entry=native/main.ts`, `engine.version=1.24.0`, `engine.minor=20`, capabilities (platform, storage, clipboard), the seven actions with keys and gamepad defaults. |
| `index.html`, `starhermit-files.json` | The engine's web loader (pins engine 1.24.0 on wiki.starhermit.com by hash) and the package's file index, both written by `npm run package` — never edited by hand. |
| `native/main.ts` | Entry module: the screen state machine, rounds, the fixed-step 500 ms tick, commands, picks, tutorials, hints, undo, results and posting, settings, keyboard / gamepad actions, pointer and touch routing, lifecycle. |
| `native/screens.ts` | Every screen, the header and footer, the HUD, drawers, action list, toasts and countdown on `starhermit:ui`; the content strings `src/ui.js` held (refusal reasons, mode cards, help cards, stage names). |
| `native/render.ts` | The market on `starhermit:scene`: geometry, people, effects, camera framing, picking, colour-vision palettes, the per-tier look and post effects. |
| `native/audio.ts` | One-shots from `sfx/`, the music layers and ambience rendered into looping clips. |
| `native/platform.ts` | The save document on `starhermit:storage` (`saves`), the old cloud slot's migration, conflict merges, legacy settings, the player, invite link, the platform clock, the high-score board (read and post through `score-script.js`). |
| `native/quality.ts` | The browser build's graphics presets and budgets keyed by the runtime's quality tier and level. |
| `native/style.ts` | Registers `assets/ui-style.json` and the theme; the high-contrast and colour-vision token sets. |
| `native/i18n.ts` | The interface language from the runtime's preferences, `T()` / `N()` / `S()`. |
| `native/game.ts` | Typed facade over the browser build's pure modules (`allowJs`). |
| `src/rules.js` | Pure deterministic rules engine. `createGame`, `validateCommand`, `applyCommand`, `step`, `computeScore`, `verifyReplay`. |
| `src/content.js` | All content as data: department catalog, themes, maps, 40 journey stages, 4 tutorials, 5 challenges, practice and daily generators, offline validators. |
| `src/session.js` | Session object (command log, hash chain, undo, replay envelope, snapshot/resume), the game's settings, progression, achievements; records kept through an injectable key store. |
| `src/store.js` | The save document: normalize, merge (two devices), the old cloud slot, the key store over it, local boards. Pure, shared with the node tests. |
| `src/i18n.js`, `src/locales/` | The string catalogue: `T(key, vars)` keyed by the US-English text, nine locale dictionaries (es-ES and fr-CA list only their differences from es-419 / fr-FR). |
| `src/sh-strings.js` | Account strings in the nine locales. |
| `src/rng.js` | mulberry32 seeded RNG, stable stringify, FNV-1a state hashing. |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished run's total and posts it to the `high-score` leaderboard. |
| `server.js` | Optional Node host with the legacy `/api/v1` routes (not called by the client; left out of the package). |
| `assets/` | `title-backdrop.webp`, `results-banner.webp`, `ui-style.json` (from `tools/ui-style.css`). |
| `sfx/` | 15 Opus clips plus `manifest.txt` (canonical), `manifest.json` (generator), `manifest.md` (legacy prompt table). |
| `tools/` | `ui-style.css` + `css.mjs` (the UI style sheet → `assets/ui-style.json`), `package-web.mjs` (`npm run package`), `browser-play.mjs` (the browser check), `i18n-sync.mjs` (locale rows in step with the keys). |
| `tests/` | `rules.test.mjs` (75 assertions), `store.test.mjs`, `i18n.test.mjs` + `i18n-keys.mjs`, `native.mjs` + `native/*.play` (engine checks and play scripts). |

## 2. Vision and design pillars

**1. The floor is the game.** Every decision is legible from the market floor itself: an empty shelf is visibly
empty, a queue is a visible line of figures, a guest about to storm off wears a reddening patience ring.
*Rules in:* state carried by shape, count and position. *Rules out:* numeric-only dashboards, hidden modifiers,
information that only exists in a menu.

**2. Two things to do, always in tension.** The whole verb set is restock / serve / hire / upgrade / unlock,
and coins spent on one is coins not spent on another. *Rules in:* one shared currency, costs that scale with
what you neglected. *Rules out:* separate soft currencies, timers that gate spending, anything you buy without
giving up something else.

**3. Cozy, not frantic.** A 500 ms tick, patience budgets of 28–60 ticks and a hard shift end mean the pressure
comes from the clock closing, not from twitch. *Rules in:* generous input windows, calm warm palette, gentle
audio. *Rules out:* reaction tests, failure states that arrive without warning, punishing misclicks.

**4. Determinism you can audit.** Every run is a seed plus a command log; the same log replays to the same
state hash on the client and on the server. *Rules in:* integer state, fixed neighbour order in pathfinding,
seeded RNG carried inside the state. *Rules out:* wall-clock in rules, `Math.random`, float score accumulation,
any rule that reads render state.

**5. The 3D view is a bonus, never a requirement.** The action list holds every legal action with the same
labels and costs; the game is completable by keyboard or gamepad alone. *Rules in:* the scene as presentation of state.
*Rules out:* actions reachable only by raycast, information conveyed only by animation or color.

## 3. Player experience

**Target player:** someone who likes tidy systems and small optimisation loops — the tycoon-lite / cozy-sim
audience — playing a few minutes on a phone or between tasks on a desktop.

**First 60 seconds.** Title screen shows a single dominant **Play**, a daily chip and a one-line nudge
("New around here? Start with Learn, or jump straight into Journey"). Play goes to mode select; **Learn** →
*Lesson 1: Stock the Shelves* opens with a briefing that states the goal in words ("Serve 3 guests"), then a
3-2-1 countdown, then a banner that teaches one verb and refuses to advance until the player performs it:
step 1 requires a `restock`, step 2 requires a `serve`, step 3 congratulates and sets the goal. Hire, upgrade
and unlock are switched off in lesson 1 (`allowed`), so the only glowing thing on the floor is the thing being
taught. The **H** key / hint button highlights the highest-value legal action at any moment, ranked
serve → restock → unlock → hire → upgrade.

**Typical session shape.** Open shift with everything stocked → first guests arrive on the spawn interval →
first queue forms → serve → coins arrive → decide between refilling the shelf that just emptied or banking
toward the 120-coin stocker → mid-shift the automation carries the routine work → last third is spent chasing
the goal line before `maxTicks`.

**The emotional beat:** the moment the first hired staff member acts on their own and the market keeps running
without you. Everything before that is manual labour; everything after is management.

## 4. Core loop and rules contract

All rule ownership below is `src/rules.js` unless stated.

### Board

`parseMap()` reads an ASCII map into a `{w,h,cells}` grid. Characters: `#` wall, `.` floor, `E` entrance
(exactly one, required), `S` stockroom, `C` checkout (at least one, required), any lowercase letter a display
belonging to the department with that map key. Maps live in `content.js` (`M.small1` … `M.lanes`, built by
`room()` + `withDoor()`, door always at row 2 of the left wall).

### Entities

- **Display** — `{id, deptId, x, y, level, capacity, stock, price, unitCost}`. Level 1–3.
- **Checkout** — `{id, x, y, level, queue[]}`. Level 1–3.
- **Department** — `{id, key, name, unlocked, unlockCost}`. Five types: Rise & Crumb Bakery (cap 4 / price 6 /
  cost 2), Green Basket (5 / 5 / 2), Cold Corner (4 / 8 / 3), Petal & Stem (3 / 12 / 5), Carvery Counter (3 / 15 / 7).
- **Customer** — `{id, x, y, status, targetDisplayId, checkoutId, path, pathIndex, dwell, browseWait, patience, carry}`
  with `status ∈ {to-display, shopping, to-checkout, queued, leaving, gone}`.
- **Staff** — `stocker` and `cashier`, each `{hired, cost}` plus a tick timer.

### Legal actions (`validateCommand`, surfaced by `legalActions`)

| Command | Cost | Preconditions | Failure reasons |
|---|---|---|---|
| `restock {displayId}` | `(capacity − stock) × unitCost` | department unlocked, shelf not full, affordable | `department-locked`, `display-full`, `not-enough-money` |
| `serve {checkoutId}` | free | queue non-empty | `queue-empty`, `no-such-checkout` |
| `hire {role}` | `staff[role].cost` (120 stocker / 150 cashier) | not already hired, affordable | `already-hired`, `not-enough-money` |
| `upgrade {targetKind,targetId}` | display `[60,120]`, checkout `[80,160]` by current level | level < 3, department unlocked, affordable | `max-level`, `not-enough-money` |
| `unlock {deptId}` | `dept.unlockCost` | department locked, affordable | `already-unlocked`, `not-enough-money` |

Every command is additionally gated by `state.config.allowed.<verb>` (`not-allowed`), by the phase
(`game-over`) and by the move limit (`no-moves-left`). Reason strings are stable and lowercase; `ui.js`
`REASON_TEXT` maps each to one short sentence shown as a toast.

Effects: `restock` fills to capacity; `upgrade` on a display adds +2 capacity and +1 price and leaves the new
shelf space empty; `upgrade` on a checkout adds +6 patience per level to everyone queued there; `unlock` opens
the department and auto-fills its shelves when the stage runs with `initialStocked`.

### Resolution order

Commands apply immediately and synchronously on a cloned state. `step()` — one tick, driven by `main.js` at
`TICK_MS = 500` — resolves in a fixed order:

1. `spawnTimer − 1`; at zero spawn one customer at the entrance targeting a random stocked unlocked display
   (falling back to any unlocked display), then reschedule to `max(3, spawnInterval + rng.int(±spawnJitter))`.
2. Every customer acts in array order: walkers advance one path node; `shopping` guests burn `dwell`, then take
   one unit (`stock − 1`, `carry = price`), join the shortest queue and path to their queue slot, or burn
   `browseWait` and leave empty-handed; `queued` guests burn one patience and leave angry at
   `patience + (checkoutLevel−1)×6 ≤ 0`. Customers with status `gone` are filtered out.
3. Staff automation: the stocker fires every `staffEvery.stocker` ticks (default 6) on the emptiest affordable
   unlocked shelf; the cashier fires every 4 ticks on the longest non-empty queue.
4. `rngState` is written back into the state, then `checkTerminal`.

Pathfinding is BFS over walkable tiles with a fixed neighbour order (`+x, +y, −x, −y`), so paths, ties and
queue slots are identical on every machine. Queue slot `n` is the checkout's first walkable neighbour, stepped
`n` times further in the same direction.

### Terminal states (`checkTerminal`)

Checked after every command and every tick, in this order:

1. Goals met → `won` / `goal-complete`. Goals are any subset of `serve`, `earn`, `unlock`, `maxAngry`.
2. Move limit reached **and** `canStillProgress()` false (both staff not hired) → `lost` / `out-of-moves`.
3. `tick ≥ maxTicks` → `won`/`goal-complete` if goals are met at that instant, otherwise `lost`/`shift-ended`.

### Scoring (`computeScore`, all integers)

```
guests       = served × 100
revenue      = total coins taken at checkouts
satisfaction = served × 10 − angry × 30 − emptyLeft × 15
departments  = unlockedDepartments × 250
throughput   = floor(served × 1000 / max(1, tick))
reserves     = money on hand at the end
total        = max(0, sum of the six)
```

*Worked example — the e2e desktop run of journey stage `j01`:* 6 served, 0 angry, 0 left empty, 36 coins of
revenue, 1 department, ended at tick 98 with 76 coins. → guests 600, revenue 36, satisfaction 60, departments
250, throughput `floor(6000/98)` = 61, reserves 76 → **total 1083**. The results table shows exactly these six
rows plus the total; nothing is rounded for display.

**Tie-breaks**, in order: goal complete (1/0), fewer invalid actions, lower ticks elapsed, then `durationMs`
and finally the session id (applied by the leaderboard sort in `server.js` / `platform.js`).

### RNG, undo and hints

One mulberry32 stream seeded from `config.seed` lives inside the state as `rngState`, so a serialized state
resumes the exact same sequence. Undo exists only where `config.allowed.undo` is true (Practice), keeps a
bounded 50-deep stack of previous states and pops the command off the log so replays stay valid. Hints call the same
`legalActions()` the UI uses — there is no separate hint knowledge.

### Replay verification

`session.replayEnvelope()` emits `{seed, config, commands[], hashes[], initialHash, finalHash, result, durationMs}`.
`hashes[i]` is the FNV-1a hash of the stable-stringified state on *arrival* at tick T, recorded every 25 ticks. `verifyReplay()` re-simulates and reports hash, phase and score mismatches.

## 5. Modes and progression

| Mode | Content | Differs by | Ranked |
|---|---|---|---|
| **Learn** | 4 lessons (`t01`–`t04`) | Step-gated banners that require the taught command; verbs disabled until taught; long patience (60) | No |
| **Journey** | 40 stages `j01`–`j40` | Authored curve; stage N+1 unlocks by beating N; every 4th stage is a `mastery` test | Signed in: posts to the platform board; progress saved locally, cloud-mirrored |
| **Daily** | `dailyConfig(YYYY-MM-DD)` | One seed per UTC day from `hash('market-manager-daily-'+date)`; 2–4 departments, map, money, spawn rate, patience, goal and theme all derived from that seed | Local board (personal best); signed in, also posts to the platform board |
| **Practice** | relaxed / standard / intense | Spawn 12/8/5, patience 48/36/28, goal serve 15/22/32, starting money 120/100/90; **undo enabled** | No |
| **Challenge** | 5 stages `c01`–`c05` | Constraints: 10-move limit; 110-tick speed shift; every shelf starts empty; single checkout at spawn 6; hiring disabled | Signed in: posts to the platform board; progress saved locally, cloud-mirrored |
| **Score chase** | any beaten stage | Same rules, submission on | Local board (personal best); signed in, also posts to the platform board |

**Difficulty curve (Journey).** Blocks of four: block 1 bakery-only restock/serve; block 2 adds a second
department and `unlock`; later blocks add checkouts, `hire`, `upgrade`, the split `lanes` floor and five-department
`grand5` markets. Within a block the pattern is *introduce in isolation → combine with one known concept →
mastery stage with a tightened `maxAngry` or goal*. Pressure scales through `spawnInterval` (14 → 6),
`patience` (40 → 28) and goal size, not through invented numbers.

**Content validation.** `validateStage()` checks map legality, reachability and goal shape;
`autoPlay()` runs a greedy bot; `validateAll()` proves every published stage is beatable. The rules tests run
the bot over every stage, so an unwinnable stage fails `npm test`.

**Progression and achievements** (`session.js`): per-stage `{won, best}` for journey and challenges, per-date
best for daily, a total guest counter and a win streak. Badges: First Shift, Full House (all five department
types open in one market), Hot Streak (3 wins running), Market Legend (`j40` won), Neighborhood Favorite
(500 guests lifetime). Grants are idempotent.

**Daily immutability.** A published day's seed never changes. A defective day is marked `excluded` by the
server and drops out of ranking rather than being replaced.

## 6. Controls and interaction

Actions (rebindable in the runtime's Options; the Help card lists the effective keys):

| Action | Keys | Gamepad |
|---|---|---|
| `back` — close the action list or a drawer, else pause / resume | Esc | East (B) |
| `pause` — pause / resume | P | Start |
| `hint` | H | North (Y) |
| `undo` (Practice) | U | Left shoulder |
| `camera` — reset the camera | R | Right stick press |
| `prev` / `next` — walk the action list | ↑ ← W A / ↓ → S D | D-pad, left stick |

| Input | Pointer | Touch |
|---|---|---|
| Restock a shelf | Click the shelf (or its button in the actions drawer / action list) | Tap the shelf |
| Serve a queue | Click the checkout | Tap the counter |
| Unlock a department | Click its covered shelves | Tap them |
| Hire / upgrade | Staff drawer, the shelf's or checkout's actions drawer, the action list | Same drawers |
| Confirm the focused button | Enter / Space | Tap (gamepad: South) |
| Camera | Drag to pan, wheel to zoom (clamped 0.65×–2.4×, focus clamped 3 world units past the room edge) | One-finger drag pans |

A click on a shelf that cannot be restocked (full, locked, not allowed), a checkout with no one waiting or an
open department opens its actions drawer instead. Tap versus drag is separated by thresholds: a press that
moves under 8 logical px and releases within 350 ms is a tap; anything else pans the camera. Presses on the
HUD, drawers and lists belong to the UI. Every command carries a unique id (`{sessionId}-c{seq}`) and an
identical command repeated within one tick is dropped, so a double-fire costs nothing. Input is never locked
during play; only the pre-shift countdown holds commands, and quitting during it is safe.

**The action list.** `prev` / `next` open a list of every market command — restock each shelf, serve each
checkout, upgrade each shelf and checkout, unlock each covered department — with the same labels and costs,
focused on the next enabled one (disabled ones take no focus); Enter, Space or South confirms. The focused
entry marks its target on the market. The list closes when its focus leaves it, or with `back`.

**Feedback for every input:** accepted commands produce a scene effect (coin burst, shelf flash, crate puff),
an authored sound, an updated HUD and a haptic pulse (Settings › Haptics; the runtime's vibration option and
the device decide). Rejected commands play the error cue and toast the reason in words.

## 7. Screens and UI flow

```
title ─┬→ mode-select ─┬→ stage-select ─→ setup ─→ game (countdown → shift) ⇄ pause
       │              └→ setup (daily)                   │
       ├→ setup (Play: the last stage played)             └→ results ─┬→ game (retry / next)
       ├→ help                                                         └→ mode-select
       └→ settings
```

`native/main.ts` owns the screen; `native/screens.ts` builds it every frame and focuses its first control when
it opens. Help and Settings remember where they were opened from (the title, a menu or the pause menu) and
return there. Every screen sits between the page header ("Market Manager") and footer line; the market shows
only during a shift (the pause, results, help and settings screens show the page colour behind their panel, as
the browser build hid its canvas there).

**Layouts** follow the browser build's breakpoints, picked by the window's logical size. Wide (≥ 1024 px): the
objective at the top left, the four stats and the Undo / Hint / Staff / Pause buttons at the top right, the
actions drawer under them on the right and the staff drawer on the left (swapped by Left-handed layout).
Compact (< 1024 px): the drawers dock to the bottom. Portrait phones (≤ 700 px): the objective on its own line,
the stats wrapping under it, the HUD buttons in a bar at the bottom (over the footer), the board summary above
it. Short landscape (≤ 500 px tall): tighter stats without their labels, drawers under the HUD. The room is
framed between the HUD (with the tutorial banner) and the footer or bottom bar with the camera's view offset,
so it never sits under them. The runtime's interface size and text size scale the whole UI.

**Never cut off:** panels taller than the window scroll inside; drawers and the action list scroll; long labels
wrap at word boundaries.

## 8. Art direction

**Palette (UI, `tools/ui-style.css`):** ground `#fdf3e3`, soft `#fbe7c6`, panel `#fffaf1`, ink `#3d2b1f`, soft ink
`#6f5b48`, accent `#e8743b`, deep accent `#c85a24`, good `#3d9970`, warn `#c77f1a`, bad `#c23b3b`, line
`#ecd9b8`. High contrast collapses to white/`#111`/no shadow. Colorblind modes shift accent, good and bad
(deuteranopia and protanopia to `#2f6f9f`/`#0072b2`/`#d55e00`, tritanopia to `#c23b6b`/`#009e73`/`#cc79a7`);
state is always carried by an icon or label as well as color.

**Scene themes (`content.js` `THEMES`):** Sunrise Row, Meadow Fair, Harbor Lane, Dusk Market, Frost Square —
each a sky, fog, ground, tile, accent and key-light colour plus an intensity. Stages pick a theme; the player
may override it in settings.

**Shape language:** soft-cornered clay volumes, no sharp edges, everything on a one-unit tile grid. Shelves are
a base block with two boards; checkouts are a rounded counter; guests are a capsule body with a sphere head in
a per-guest hue. Department identity is a color index cycling the palette's `dept` ramp.

**Typography:** one family (`Avenir Next`, `Segoe UI`, system-ui), 16 px base scaling to 20 px under Larger
text. Headings are accent-deep; numbers in the HUD are the only tabular-feeling text.

**Motion principles:** the camera is a critically damped spring (1.6 Hz) — it never snaps; customers interpolate
between logical tiles over 150 ms so a 500 ms tick reads as walking; feedback is particulate (14 coins on a
sale, 8 pops on a pick-up, 12 puffs on a restock, 90 confetti on a win) and short-lived (0.9 s). A shelf flashes
emissive for 0.45 s when refilled or unlocked.

**Hero of the screen:** the market floor itself. Panels are translucent-free flat cards that never cover more
than the middle third during play; the HUD is a thin strip.

**Reduced motion** (the runtime's Reduced motion option) removes the countdown, camera shake, particle bursts,
ambient motes and the idle bob; guests jump to their tiles. Bursts are capped at 300 (Low) or 2000 particles.

**Graphics.** The floor is lit by a hemisphere sky fill and a key directional light from the front-left, so its
shadows fall where the camera can see them; the shadow reaches along the view past the planters. Output is ACES
filmic tone-mapped sRGB. Per graphics tier: image-based lighting from a `RoomEnvironment` (scene environment
intensity 0.32, as three r160's per-material 0.32; the hemisphere fill drops while it is on), procedural surface
detail (canvas-drawn tile bevels and grout, grass, plaster courses, wood planks, striped awnings, a sky-to-haze
backdrop gradient, clearcoat on goods, counters, planters and guests on High/Ultra, decorative planters outside
the walls), ambient occlusion, bloom limited to highlights (threshold 0.92; particles and target rings are
pushed above 1.0), a linear colour grade (0.22 S-curve, saturation 1.1, warm highlights / cool shadows split
0.15–0.75) with a 0.2 vignette, FXAA / SMAA / MSAA, and ambient warm motes. The runtime's Options choose the
graphics level (Auto from the device, or a level), render scale, adaptive resolution, the frame-rate limit and
readout; the browser build's per-effect overrides are not offered.

**Looks per tier** (`native/quality.ts`; the browser build's presets and budgets, each tuned to hold 60 FPS on
the weakest GPU its Auto gave it), keyed by the runtime's quality tier (`frame().quality`):

| Tier | Shadows | AO | Bloom / grade | Anti-aliasing | Reflections, detail | Materials | Textures | LOD | Planters | Motes | Sparks | Bloom / AO resolution |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Low | off | off | off | off | off | Lambert | ½ | ½ | 5 | — | 0.5× | ½ / ½ |
| Balanced | 1024 | off | on | FXAA | on | Standard | 1× | ¾ | 8 | 50 | 0.75× | ½ / ½ |
| High | 2048 | on | on | SMAA | on | Physical clearcoat | 1× | 1 | 10 | 70 | 1× | ½ / ½ |
| Ultra | 4096 | high | on | MSAA | on | Physical clearcoat | 2× | 1.5 | 15 | 120 | 1.5× | full / full |

Sparks grow with the level within the tier (`frame().levelIndex`, at most 2×). A tier change rebuilds a live
market from its current state when the asset budget changes. Gameplay is identical on every tier.

**Visual assets the design calls for:** a title/menu backdrop that shows the fantasy before the player commits
(shipped), a results illustration that reads as "shift over" (shipped), a 16:9 cover for the platform grid
(shipped). The floor itself is procedural geometry by design — no imported meshes.

## 9. Audio direction

**Mix philosophy:** quiet, warm and diegetic-leaning. Nothing in the mix is louder than the coin chime that
confirms a sale. The runtime's Options own the volumes (music, effects, interface), the mute and the voice
limit; the UI click plays on the interface bus, the event sounds on effects.

**Ambience:** a looping low-passed noise bed (420 Hz, the browser build's noise buffer and gain) on the music
bus (the runtime has no ambience bus; the old ambience default is folded into its gain), silent while paused.

**Music:** two layers on a 500 ms grid, each rendered once into a seamless 4 s loop and looped together during a
shift: the calm layer is a slow pentatonic sine arpeggio over C-D-E-G-A-C; the busy layer (a high noise tick on
even steps plus an octave-up triangle) fades in with intensity from queue length and time pressure. The browser
build's seeded ±4 % pitch wobble per note is not kept.

**Clips:** authored `.opus` one-shots load one at a time once the audio runs (natively at once, in a browser
after the first press); one still loading is silent (the browser build's synthesised fallbacks are not ported).

### SFX event table (source of `sfx/manifest.txt`)

| Event id | File | Sound | Fires when |
|---|---|---|---|
| `spawn` | `sfx/spawn.opus` | Soft hollow cork pop | A guest enters through the arch |
| `take` | `sfx/take.opus` | Quick plasticky pick-up pop | A guest lifts an item off a shelf |
| `restock` | `sfx/restock.opus` | Crate thud with goods rattling | A shelf is refilled (player or stocker) |
| `served` | `sfx/served.opus` | Register chime, two coin dings | A queued guest pays (player or cashier) |
| `left-angry` | `sfx/left-angry.opus` | Low grumble, brisk footsteps | A queued guest's patience hits zero |
| `left-empty` | `sfx/left-empty.opus` | Descending tick, tap on bare shelf | A browsing guest gives up on an empty shelf |
| `hire` | `sfx/hire.opus` | Rubber stamp then welcome chime | Stocker or cashier hired |
| `upgrade` | `sfx/upgrade.opus` | Ratchet click into a bright ding | Shelf or checkout levelled up |
| `unlock` | `sfx/unlock.opus` | Key in a padlock, sparkle | Department bought open |
| `countdown` | `sfx/countdown.opus` | Wooden mallet tick with bell tail | Each 3-2-1 beat before a shift |
| `won` | `sfx/won.opus` | Brass-and-bells fanfare | Shift ends with all goals met |
| `lost` | `sfx/lost.opus` | Descending marimba phrase | Shift ends short |
| `achievement` | `sfx/achievement.opus` | Rising glockenspiel sparkle | A badge is newly earned, 700 ms after the sting |
| `error` | `sfx/error.opus` | Dull double buzz | A command is refused |
| `uiClick` | `sfx/ui-click.opus` | Short clean interface tap | Any menu/HUD button |

## 10. Localization

The game ships in en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT. Every player-facing
string — mode and stage lists, briefings, HUD, board summary and action list, drawers, toasts, refusal reasons,
hints, lessons, results, help, settings and account lines — goes through `src/i18n.js`: `T(key, vars)` keyed by
the US-English text, `N(key)` to mark table entries (stage, department, theme, achievement and lesson names in
`content.js` stay English data and are translated at display time). es-ES and fr-CA list only their
differences from es-419 and fr-FR; en-GB carries spelling changes (Colour, Neighbourhood, Harbour …). The game's
name stays "Market Manager" in every locale.

**Choosing the language.** The interface language is the runtime's (`preferences().language`: the player's
choice in Options › Language, else the account's preferred language, else the device's), mapped to the nearest
shipped locale. Every string is drawn through `T()` each frame, so a change shows on the next frame, mid-shift
included. Numbers and clocks are formatted at the presentation layer.

## 11. Accessibility

- **Keyboard and gamepad path is complete:** the action list (§6) holds every market command; every screen's
  buttons take Tab / arrows / Enter and the gamepad's D-pad and South; the market's shelves, checkouts and
  covered departments are named areas (`ui.target`) screen readers read.
- **Focus:** each screen focuses its first control when it opens; overlays return to the screen they came from.
- **Announcements:** toasts, hints, the countdown and the shift result are spoken (`ui.announce`).
- **High contrast** (runtime option): white surfaces, near-black ink and dark lines; the title backdrop and
  results banner are left out.
- **Larger text and interface size** are the runtime's; the layouts reflow.
- **Game settings:** Theme, Camera (isometric / high / low), Color vision (standard, deuteranopia-,
  protanopia-, tritanopia-safe: the UI accents and the market's department and patience palettes),
  Left-handed layout (drawers swap sides), Haptics. Reduced motion is the runtime's.
- **Targets:** 44 × 44 logical px minimum with 8 px separation.
- **No color-only signalling:** patience is a ring that shrinks as well as reddens; locked departments are
  covered *and* labelled; invalid actions are explained in words.

## 12. StarHermit integration

**Save.** The game's save (`starhermit:storage` `saves`: on the device, and in the account's cloud slot when
signed in) is the browser build's cloud document `{ v: 1, progress, boards }` with the game's settings and the
last played stage beside them (`settings`, `lastPlayed`, which the browser build kept only in localStorage).
`src/session.js` reads and writes its records through `src/store.js` `keyStore`.

- **Old cloud saves.** The slot the browser build wrote through the JS SDK (`game:<slug>`) shows as foreign:
  it is merged into this device's progress (`mergeDocs`) and replaced once (`replaceForeign`). Guests' old
  browser localStorage progress cannot be read by the engine and does not carry over.
- **Conflicts.** When another device saved first, both copies merge as the old saveconflict handler did — won
  flags and best score per Journey stage and challenge, the better score per daily date, the union of lessons
  and achievements, the larger lifetime counters and best streak, this device's current streak and settings;
  local boards are merged by session, best first — and the open screen picks the result up.
- **Legacy settings.** The browser build mirrored its settings into the account's settings KV (volumes,
  graphics, quality, theme, camera, colour vision, motion, contrast, text size, left-handed, hold-to-confirm,
  timing assist, haptics, finished lessons) and the language helper kept `ui.language` there. The game's own
  (theme, camera, colour vision, left-handed, haptics, finished lessons) carry into the save; all of them are
  removed from the KV (the runtime's Options own the rest).
- **Controls.** The actions keep the browser build's names (back, pause, hint, undo, camera, prev, next), so
  bindings the platform kept for them stay.

**Player.** Signed in, the title shows "Playing as {name} · {sync state}" and **Invite a friend** (copies the
invite link with a confirmation toast); signed out, **Sign in with StarHermit** (`requestSignIn`). A session
that ends shows "signed out" and play goes on locally.

**Daily clock.** The UTC day of the Daily market comes from the platform's clock (`serverNow`) once it has
answered, else the device's.

**Leaderboard.** Signed in, every finished Journey, Daily, Challenge or Score-chase run posts its total through
`score-script.js` (a practice session whose socket carries `{ type: 'result', scores: { 'high-score': total } }`;
the script range-checks it, 0–1,000,000 integer, higher is better, and posts it) — results are
server-authoritative in the platform's sense: the script decides what is recorded. The results screen's line
shows "Leaderboard rank: #N" (or posted / not posted). Learn and Practice post nothing. The Daily and
Score-chase briefings show that board's top entries ("Platform leaderboard"), or the local board signed out
("Top shifts"). Daily and Score-chase runs also record to the local board (in the save). Achievements stay in
the save.

Not used: hosted rooms, matchmaking, chat, replays, the old `server.js` routes.

## 13. Technical architecture

**Module boundaries.** `rules.js` is pure; `content.js` is data plus offline validators; `session.js` wraps
rules with a command log, hash chain, undo stack and replay envelope; `store.js` is the save document;
`native/main.ts` owns time and state; `screens.ts` and `render.ts` read state and call back; `platform.ts` is
the only module that touches the platform. The pure modules are the browser build's ES modules imported by the
engine unchanged in what they decide (`structuredClone` became JSON clones: the engine's interpreter has none).

**Determinism.** Integer state, seeded RNG stored inside the state, fixed BFS neighbour order, no wall-clock in
rules, JSON cloning on every mutation. Replays verify against periodic state hashes plus a final hash.

**Loop.** The runtime's fixed steps (60 Hz) advance the shift: every 30 steps one 500 ms tick while a shift is
active, so pauses, a hidden window and slow frames never cost time and play scripts replay exactly. Countdown,
hint and toast timers run on the game clock. A hidden window pauses the shift; on return the pause menu says how
many ticks went by while away ("nothing was simulated"). Five consecutive tick errors pause the shift.

**Rendering.** The runtime draws `scene` every frame through the orthographic camera (`renderer.camera`, null
on the menus); post effects are `renderer.ao` / `bloom` / `grade` / `antialias`. The camera's projection is its
own (engine.minor 20): `left/right/top/bottom` keep the band's aspect and `setViewOffset` places the band in
the window. Market rebuilds happen on stage load and when the tier's asset budget changes; per-frame work is
camera springs, transform updates and particle integration.

## 14. Testing and acceptance criteria

`npm test` runs:

- `tests/rules.test.mjs` (75 assertions): map parsing and construction errors, serialization round-trips and
  version rejection, every `validateCommand` reason, the economics, the customer lifecycle, staff cadence, the
  three terminal paths, the score formula, RNG and replay determinism, command-id idempotency, fuzzed commands,
  greedy-bot solvability of every published stage, move limits, daily determinism, snapshot resume, achievements.
- `tests/store.test.mjs`: the old cloud slot read as a document, session records through the key store, the
  two-device merge, local boards.
- `tests/i18n.test.mjs`: every key (from `T` / `N` calls in `src/` and `native/` and the content tables) in all
  nine locales with the same placeholders, no stray keys, regional inheritance.
- `tests/native.mjs`: the web index matches the files (`npm run package` ran after the last change), `tsc`,
  `starhermit check .` with zero warnings, and every `tests/native/*.play` as a signed-out render check driving
  the real UI: `menus.play` (desktop: How to play, Settings, the Daily briefing, mode and lesson lists, a
  Practice shift with the action list by keys and Enter, a hint, the shelf drawer, undo, the staff drawer,
  pause, Settings from pause, ending the shift), `journey-1.play` (desktop: Journey stage 1 played by clicking
  the checkout and shelves to the results with the First Shift achievement, then Next), `lesson-phone.play`
  (390 × 844: Lesson 1 with its banner and the staff drawer, to the results), `challenge-landscape.play`
  (844 × 390: Ten Moves Only won by hiring both staff from the drawer).

`npm run test:browser` (`tools/browser-play.mjs`) serves the packaged folder on loopback and plays Journey
stage 1 to the results in Chrome on the machine's GPU at a desktop (1366 × 768), a phone (390 × 844, DPR 3) and
a phone held sideways (844 × 390, DPR 3) through the page's accessibility mirror (mouse clicks, the action list
and hint by keys; finger taps and the staff drawer on the phones), failing on console errors or warnings or the
runtime's error screen.

## 15. Asset inventory

| Path | Purpose | Source |
|---|---|---|
| `assets/title-backdrop.webp` | Title backdrop behind the menu panel (scrimmed 55–80 %) | FLUX.2 klein, 1536×864 |
| `assets/results-banner.webp` | "Closing time" banner atop the results panel | FLUX.2 klein, 1024×448 |
| `assets/ui-style.json` | The UI's styles, converted from `tools/ui-style.css` | `npm run css` |
| `cover.jpg`, `coverart.png`, `icon.png` | Platform cover, cover source, icon | FLUX.2 klein / hand-authored |
| `sfx/*.opus` | 15 gameplay and UI one-shots | MOSS-SoundEffect v2.0, 48 kHz mono Opus |
| `sfx/manifest.*` | Event table and generator input | Authored |
| Market geometry, guests, props, particles, surface textures | The whole 3D scene | Procedural in `native/render.ts` — by design, no imported meshes |

## 16. Known limitations

- **No voice content.** The browser build's reserved `voice` bus had no content; the runtime's buses have none
  to route.
- **Hold to confirm and Timing assist are gone.** The browser build stored them but nothing read them; they are
  not offered.
- **Local board entries are named "You"** signed out (signed in, the player's display name).
- **Guests' browser progress does not migrate.** The engine cannot read the browser build's localStorage; cloud
  saves of signed-in players do migrate.
- **The music's seeded pitch wobble and the synthesised fallbacks** of the browser build are not ported (§9).
- **Particle sizes** follow the engine's Points on an orthographic camera.
- **The browser build's No-WebGL compat screen** is gone: the runtime starts or shows its own error screen.
- **Hosted signed-in paths** (foreign save, legacy settings, score posting) are covered by unit tests of their
  logic, not live-tested here.

## 17. Design intent not yet implemented

1. **Voice/announcer content** (shift-start and last-minute callouts).
2. **Timing assist** as an actual rules-level assist (widened patience) in unranked modes only.
