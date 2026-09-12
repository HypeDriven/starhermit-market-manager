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
| Platforms | Desktop and mobile browsers; portrait and landscape; offline-capable |
| Rendering | Three.js orthographic isometric scene over a semantic HTML/CSS shell; a full DOM mirror is an equal play path |
| Content id | 40 journey stages, 4 lessons, 5 challenges, 3 practice paces, 1 daily |

### File map

| Path | Contents |
|---|---|
| `index.html` | Entry point. Every screen exists as a `<section class="screen" data-screen="…">`; only one is unhidden at a time. |
| `css/style.css` | The whole DOM shell: palette tokens, screens, HUD, drawers, breakpoints, a11y classes. |
| `src/main.js` | Bootstrap, screen state machine, tick loop, input routing (pointer/keyboard/gamepad), tutorials, hints, settings, submission. |
| `src/rules.js` | Pure deterministic rules engine. No DOM, no timers. `createGame`, `validateCommand`, `applyCommand`, `step`, `computeScore`, `verifyReplay`. |
| `src/content.js` | All content as data: department catalog, themes, maps, 40 journey stages, 4 tutorials, 5 challenges, practice and daily generators, offline validators. |
| `src/session.js` | Session object (command log, hash chain, undo, replay envelope, snapshot/resume), settings, progression, achievements. |
| `src/ui.js` | DOM shell: screen switching, HUD, context/staff drawers, results table, help cards, the accessibility board mirror. |
| `src/render.js` | Three.js scene: market geometry, customer figures, particles, camera framing, picking, quality tiers, colorblind palettes. |
| `src/audio.js` | WebAudio: authored `.opus` one-shots with synthesised fallbacks, ambience bed, two-layer adaptive music. |
| `src/platform.js` | StarHermit adapter: launch-token auth, identity, cloud saves, read-only platform leaderboards; own-server dev backend and local-board fallback. |
| `src/rng.js` | mulberry32 seeded RNG, stable stringify, FNV-1a state hashing. |
| `server.js` | Static host + `/api/v1` time, daily, scores, leaderboard, heartbeat. Replays every submission server-side. |
| `sfx/` | 15 Opus clips plus `manifest.txt` (canonical), `manifest.json` (generator), `manifest.md` (legacy prompt table). |
| `assets/` | `title-backdrop.webp`, `results-banner.webp`. |
| `tests/rules.test.mjs` | 75 assertions over the engine, content, session and progression. `npm test`. |
| `tests/e2e.mjs` | Playwright-core playthrough of the real UI at desktop and mobile. `npm run test:e2e`. |

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

**5. The 3D view is a bonus, never a requirement.** The DOM mirror lists every legal action with the same
labels and costs; the game is completable with WebGL off. *Rules in:* canvas as presentation of state.
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
| **Journey** | 40 stages `j01`–`j40` | Authored curve; stage N+1 unlocks by beating N; every 4th stage is a `mastery` test | No — progress saved locally, cloud-mirrored when signed in |
| **Daily** | `dailyConfig(YYYY-MM-DD)` | One seed per UTC day from `hash('market-manager-daily-'+date)`; 2–4 departments, map, money, spawn rate, patience, goal and theme all derived from that seed | Yes — against the own-server backend only; on-platform the board is read-only |
| **Practice** | relaxed / standard / intense | Spawn 12/8/5, patience 48/36/28, goal serve 15/22/32, starting money 120/100/90; **undo enabled** | No |
| **Challenge** | 5 stages `c01`–`c05` | Constraints: 10-move limit; 110-tick speed shift; every shelf starts empty; single checkout at spawn 6; hiring disabled | No — progress saved locally, cloud-mirrored when signed in |
| **Score chase** | any beaten stage | Same rules, submission on | Yes — against the own-server backend only; on-platform the board is read-only |

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

| Input | Desktop | Mobile |
|---|---|---|
| Restock a shelf | Click the shelf, or its button in the context drawer / mirror list | Tap the shelf |
| Serve a queue | Click the checkout | Tap the counter |
| Hire / upgrade / unlock | Staff drawer button, or the shelf's context drawer | Same drawers, docked to the bottom thumb zone |
| Move focus | Arrow keys or WASD cycle the mirror list | — |
| Confirm | Enter / Space on the focused button | Tap |
| Hint | `H` or the hint button | Hint button |
| Undo (Practice) | `U` or the undo button | Undo button |
| Reset camera | `R` | Two-finger drag re-frames; `resetCamera` on rotation |
| Pause | `P` or `Esc` | Pause button |
| Camera | Drag to pan, wheel to zoom (clamped 0.65×–2.4×, focus clamped 3 world units past the room edge) | One-finger drag pans, pinch zooms |
| Gamepad | D-pad/stick move focus (220 ms repeat, 0.25 deadzone), A confirm, B cancel, Start pause, Y hint | — |

Tap versus drag is separated by thresholds, not by timers: a pointer that moves under 8 px and releases within
350 ms is a tap; anything else is a camera drag (`FX.tapMaxDistPx`, `FX.tapMaxMs`). Drags use pointer capture
and cancel safely on `pointercancel` / lost capture. Every command carries a unique id
(`{sessionId}-c{seq}`) and duplicate ids are absorbed idempotently, so a double-fire costs nothing — there is
no blanket debounce. Input is never locked during play; only the pre-shift countdown holds commands, and
quitting during it is safe (the countdown token is invalidated).

**Feedback for every input:** accepted commands produce a scene effect (coin burst, shelf flash, crate puff),
an authored SFX, an updated HUD, a mirror-list refresh and an optional haptic pulse. Rejected commands produce
the `error` cue, a toast carrying the humanised reason, and a distinct vibration.

## 7. Screens and UI flow

```
boot → (no WebGL) compat ─┐
     → title ─┬→ mode-select ─┬→ stage-select ─→ setup ─→ game ⇄ pause
              │              └→ setup (daily/practice)      │
              ├→ help                                        └→ results ─┬→ setup (retry/next)
              └→ settings                                                └→ mode-select
```

`main.js` owns `appScreen`; `ui.showScreen()` unhides exactly one section and moves focus to its heading.
Help and settings are overlays that remember `overlayReturn` and restore it on close, so they behave the same
from the title and from pause.

**Layout.** Wide (≥1024 px): centered panels, HUD strip across the top of the floor, context and staff drawers
as right-side rails (mirrored by the left-handed setting). Compact (<1024 px): the same drawers dock to the
bottom edge. Portrait phone (≤700 px): safe-area padded status bar, the canvas takes the remaining height, the
HUD action row sits in the thumb zone with 44 px targets, drawers become bottom sheets. Landscape phone
(≤500 px tall): the HUD compresses to a single rail so the floor keeps its height.

**Never cut off:** the objective line, the four HUD stats, the pause button, the drawer's primary action row,
and the results total. All bottom-anchored elements add `env(safe-area-inset-bottom)`; the header adds
`env(safe-area-inset-top)`.

## 8. Art direction

**Palette (DOM, `css/style.css`):** ground `#fdf3e3`, soft `#fbe7c6`, panel `#fffaf1`, ink `#3d2b1f`, soft ink
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

**Reduced motion** (setting or `prefers-reduced-motion`) removes the countdown, all CSS transitions and
animations, camera shake and particle bursts; state changes become instant. Quality tiers cap particles at
300/800/2000 and drop shadows entirely at Low.

**Visual assets the design calls for:** a title/menu backdrop that shows the fantasy before the player commits
(shipped), a results illustration that reads as "shift over" (shipped), a 16:9 cover for the platform grid
(shipped). The floor itself is procedural geometry by design — no imported meshes.

## 9. Audio direction

**Mix philosophy:** quiet, warm and diegetic-leaning. Nothing in the mix is louder than the coin chime that
confirms a sale, because that is the sound of the game working. Four buses — `music`, `effects`, `ambience`,
`voice` — sit under a master at 0.9; each has its own slider. Music ducks to 25 % while a terminal sting plays.

**Ambience:** a continuously looping low-passed noise bed (420 Hz cutoff, gain 0.05) at market-room level.

**Music:** two seeded layers on a 500 ms grid. The calm layer is a slow pentatonic arpeggio over C-D-E-G-A-C;
the busy layer (a high noise tick plus an octave-up triangle) fades in with intensity derived from queue
pressure. Pitch variance comes from the seeded RNG, so a replay sounds identical.

**Fallbacks:** every event has a synthesised voice in `playEvent()`. Authored `.opus` clips are fetched lazily
after the first user gesture and preferred once decoded; a missing or failed clip degrades to synthesis
silently, and each event plays exactly one sound either way.

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

The shipped languages are en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT. Today all UI
copy is authored inline in English: static labels in `index.html`, dynamic strings in `src/ui.js`
(`REASON_TEXT`, `MODES`, `HELP_RULES`, results and HUD formatting) and `src/main.js` (toasts, hints, tutorial
prompts via `content.js`). `<html lang="en">` is fixed and there is no locale picker, so the other eight
locales are design intent, not shipped behaviour (§17). Numbers and clocks are already formatted only at the
presentation layer (`ticksToClock`, the results table), which is the seam a locale layer plugs into. Layout
already tolerates ~40 % string expansion: panels wrap, buttons size to content with a 44 px minimum, and no
label is positioned by a fixed pixel width.

## 11. Accessibility

- **Keyboard-only path is complete.** `#mirror-list` holds a button for every legal action — restock, serve,
  hire, upgrade, unlock — with the same labels and costs as the pointer path. Arrow keys/WASD cycle it,
  Enter/Space confirms. Focus survives the per-tick rebuild because panels are re-keyed by command, not
  replaced wholesale.
- **Focus management:** each screen change focuses its `tabindex="-1"` heading; overlays restore the previous
  screen; a skip link jumps to `#app`.
- **Announcements:** `#live-announcer` (polite) carries objective and hint text, `#live-alerts` (assertive)
  carries the countdown and the shift result; `#board-mirror` is a polite live region summarising tick, coins,
  departments, queue length, served and angry counts.
- **Contrast:** the default palette clears 4.5:1 for body text on panels; High contrast forces pure
  black-on-white with visible 1 px borders and disables the decorative backdrop and results banner.
- **Reduced motion, Larger text (20 px), Left-handed drawer mirroring, Haptics, Hold-to-confirm** are all
  settings, persisted in `localStorage` and applied as `<html>` classes.
- **Targets:** 44 × 44 CSS px minimum with 8 px separation, enforced by the `--tap` token.
- **No-WebGL:** the compat screen offers "Continue anyway", which sets `html.force-mirror` so the action list
  becomes permanently visible and the whole game is playable as text controls.
- **No color-only signalling:** patience is a ring that shrinks as well as reddens; locked departments are
  greyed *and* labelled; invalid actions are explained in words.

## 12. StarHermit integration

`starhermit.txt` declares `name`, `launch=index.html`, `owner`, `server=server.js`, `cover=coverart.png`.

**Own server (`server.js`, local dev backend).** When the game is served by its own static host, the
client probes `GET /api/v1/time` (round-trip-adjusted offset for the UTC daily boundary), reads the day
via `GET /api/v1/daily`, submits runs with `POST /api/v1/scores` (the server resolves the *authoritative*
published config for the submitted content id, rejects ids that do not resolve (`unknown-content`) and
seeds that disagree (`seed-mismatch`), replays with `verifyReplay`, and rejects implausible durations
computed from the published `maxTicks`; idempotent on `sessionId + configId`), reads ranked entries via
`GET /api/v1/leaderboard?board=&date=&configId=`, and pings `POST /api/v1/heartbeat` while a round is
live. Daily and score-chase modes are ranked only against this backend.

**Hosted platform (`<slug>.starhermit.com`).** `src/platform.js` reads the launch token from the URL
fragment (`#game_token=`, read once then stripped; query params are local-dev fallbacks only), decodes
`sub` / `game_scope` from the JWT payload, and sends `Authorization: Bearer` on every call, re-minting
the token via `POST /api/v1/games/{slug}/launch-token` every 45 min (retry ~60 s on failure). The
account nickname comes from `GET /api/v1/users/{sub}/profile` — never `/api/v1/me`, never usernames;
fallback `"Player " + id.slice(0,8)` — and is shown with a sync chip on the title screen. Progress and
local boards mirror to the platform cloud slot (`GET`/`PUT /api/v1/me/cloud-saves/{slug}` as a stored
zip + base64; remote wins on conflict; ~2 s debounce + `pagehide`/`visibilitychange` flush;
localStorage stays the offline cache). Platform leaderboards are read-only: `GET /api/v1/games/{slug}`
yields the `leaderboardId`, entries come from
`GET /api/v1/leaderboards/{leaderboardId}/entries` (userIds resolved to nicknames via the profile
helper), and the top of the board renders on the shift briefing. Clients never submit scores on-platform;
a ranked run records to the local board instead. Achievements stay local (part of the cloud-saved doc).
There is no presence, telemetry, or per-game daily endpoint on the platform surface — heartbeat exists
only against the own dev server, and the old analytics beacon was removed.

Everything degrades: `platform.init()` probes time out fast, and any failure falls back to local play
against localStorage with no console noise.

## 13. Technical architecture

**Module boundaries.** `rules.js` is pure and DOM-free; `content.js` is data plus offline validators;
`session.js` wraps rules with a command log, hash chain, undo stack and replay envelope; `main.js` is the only
module that owns time; `ui.js` and `render.js` only read state and emit callbacks; `platform.js` is the only
module that touches the network. `main.js` imports `render.js` lazily on first Play, so the title screen paints
without Three.js and the module still imports under Node.

**Determinism.** Integer state, seeded RNG stored inside the state, fixed BFS neighbour order, no wall-clock in
rules, `JSON.parse(JSON.stringify())` cloning on every mutation. Replays verify against periodic state hashes
plus a final hash.

**Persistence.** `localStorage` under an `mm.` prefix, each document version-wrapped: `settings.v1`,
`progress.v1`, `lastPlayed.v1`, `localBoards.v1`. Every read is try/caught and falls back to defaults, so
corrupt or absent storage boots cleanly. Signed-in platform sessions additionally mirror `progress.v1` and
`localBoards.v1` to the cloud slot (§12); the remote copy wins on conflict. Server state is a single JSON
file under `.mm-data/` (override with `MM_DATA_DIR`), written atomically-ish and gitignored.

**Loop.** A `requestAnimationFrame` accumulator in `main.js` steps the session at 500 ms with at most
`MAX_CATCHUP_STEPS = 4` catch-up ticks after a stall; backgrounding pauses and the pause screen reports
"while you were away". Five consecutive loop errors stop the loop rather than spinning.

**Performance budgets.** Quality tiers set pixel ratio (1 / 1.5 / 2), shadow map (off / 1024 / 2048), particle
cap (300 / 800 / 2000) and prop density; Auto picks from the device. Scene rebuilds only happen on stage load;
per-tick work is transform updates plus particle integration.

**How the e2e drives the real UI.** `tests/e2e.mjs` boots its own static server, launches Chrome via
playwright-core, and clicks only visible DOM: help, settings (asserting the `high-contrast` class lands on
`<html>`), Play, the Journey card, the first stage card, Start, the canvas itself, hint, staff toggle, pause →
settings → resume, then plays the shift to results through HUD and mirror buttons. It fails on any page error
or non-allowlisted console error.

## 14. Testing and acceptance criteria

`npm test` (`tests/rules.test.mjs`, 75 assertions) covers: map parsing and construction errors, serialization
round-trips and version rejection, every `validateCommand` reason, restock/upgrade/unlock/hire economics, the
customer lifecycle (browse, take, queue, serve, angry, empty), staff automation cadence, all three terminal
paths, the score formula and tie-break shape, RNG and replay determinism, command-id idempotency, fuzzed
commands, greedy-bot solvability of every published stage, move-limit and challenge rules, daily seed
determinism, snapshot resume producing an identical hash, and achievement grant conditions.

`npm run test:e2e` runs the flow in §13 at 1280×800 (mouse) and 390×844 (touch) and asserts: title reachable,
6 mode cards, 6 help cards, stage 1 unlocked for a new player, the briefing states the goal, the countdown
appears, the tick loop advances the board mirror, the pause button is visible on the floor, the staff panel
lists both roles, results headline matches "Shift complete/over", the score table has exactly 6 component rows,
and navigation returns to the title — with zero page errors and zero unexpected console errors.

**QA bar, as checkable statements:**

1. Every implemented feature is reachable by clicking visible UI in a browser — no dev console, no URL flags.
2. A full playthrough at 390×844 and at 1280×800 produces no console errors or warnings.
3. No text or control is clipped or hidden under browser chrome or a display cutout at either size.
4. First-time players are taught: Learn gates each lesson on performing the verb, and the hint button always
   names a legal action.
5. The game is completable with WebGL disabled and with a keyboard only.
6. `node --check` passes on every first-party `.js`/`.mjs` file.

## 15. Asset inventory

| Path | Purpose | Source | Status |
|---|---|---|---|
| `assets/title-backdrop.webp` | Title-screen backdrop behind the menu panel (scrimmed 55–80 %) | FLUX.2 klein, 1536×864, seed 4711, 30 steps | Generated this pass, wired in `css/style.css` |
| `assets/results-banner.webp` | Decorative "closing time" banner atop the results panel | FLUX.2 klein, 1024×448, seed 9081, 30 steps | Generated this pass, wired in `index.html` |
| `coverart.png` | 16:9 platform cover named by `starhermit.txt` | FLUX.2 klein, 1216×688, seed 2213 → 1200×675 | Regenerated this pass, replacing an off-brand template placeholder |
| `favicon.svg`, `icon.png` | Browser and platform icons | Hand-authored SVG | Shipped |
| `sfx/spawn·take·restock·served·left-angry·left-empty·hire·upgrade·unlock·won·lost·error·ui-click.opus` | 13 gameplay and UI one-shots | MOSS-SoundEffect v2.0, 48 kHz mono Opus 96 k | Shipped |
| `sfx/countdown.opus` | Pre-shift 3-2-1 beat | MOSS-SoundEffect v2.0, 100 steps | Generated this pass, wired in `src/main.js` + `src/audio.js` |
| `sfx/achievement.opus` | Badge-earned flourish | MOSS-SoundEffect v2.0, 100 steps | Generated this pass, wired in `src/main.js` + `src/audio.js` |
| `sfx/manifest.txt` | Canonical file → event id → description → context | Authored | Written this pass |
| `sfx/manifest.json` | Generator input for `tools/generate_sfx_from_manifests.py` | Authored | In sync with `manifest.txt` |
| Market geometry, guests, props, particles | The entire 3D scene | Procedural Three.js in `src/render.js` | Shipped — by design, no imported meshes |
| `lib/three.module.min.js` | Renderer | Three.js, vendored | Shipped |

No animation clips are needed: guests are simplified capsule figures moved by tile interpolation, not skinned
characters, so Kimodo has nothing to author for this game.

## 16. Known limitations

- **UI copy is English only.** The nine required locales are declared but not implemented (§17).
- **`voice` bus is reserved.** It has a slider and a gain node but no content routes to it.
- **`timingAssist` and `holdToConfirm` are presentation-only toggles.** Wiring timing assist into the rules
  would change determinism and ranked replays, so it is deliberately inert.
- **Local/offline board entries are named 'You'.** Hosted play names entries with the platform nickname;
  offline entries have no identity beyond the session id.
- **Audio is unverified in CI.** Headless Chrome blocks the AudioContext before a user gesture, so the SFX and
  music paths are exercised manually, not by `tests/e2e.mjs`.
- **`render.js` has no visual regression coverage.** The e2e proves it produces no runtime errors and that
  picking works; it does not compare pixels.
- **Local progress is device-local unless signed in.** Without a platform session, clearing site data resets
  journey unlocks, badges and the local board; signed-in sessions re-sync from the cloud slot.

## 17. Design intent not yet implemented

1. **Localization.** A `src/i18n.js` string catalogue for en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA,
   pt-BR and it-IT, chosen from `navigator.languages` with a settings override, `<html lang>` updated on
   change, and `data-i18n` keys on the static markup. Today every string is inline English.
2. **Voice/announcer content** on the reserved `voice` bus (shift-start and last-minute callouts).
3. **Timing assist** as an actual rules-level assist (widened patience) in unranked modes only.
