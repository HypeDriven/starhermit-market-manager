# Market Manager

A bright isometric neighborhood market management game on the StarHermit
engine. Stock displays, serve queues, hire staff, and unlock new departments
through earned revenue.

It is a StarHermit engine script game (engine 1.23.0, host API 1.21): one
package played natively by the StarHermit client and in browsers by the
engine's web runtime (`index.html` is the engine's loader).

## Run

```
STARHERMIT=~/sh/runtime/1.23.0/starhermit-1.23.0-linux-x86_64/starhermit
$STARHERMIT .            # play in a window
npm run package          # after every change: the web loader + file index
```

## Test

```
npm test                 # rules, save document and i18n suites, then the native checks and play scripts
npm run test:browser     # plays Journey stage 1 in Chrome (desktop, phone, landscape)
```

The rules suite covers every legal action and invalid-action reason, scoring
components, terminal states, serialization round-trips, deterministic replay,
command fuzzing, move limits, daily determinism, and offline validation of all
40 journey stages, 4 tutorials, 5 challenges, 3 practice difficulties, and
sample dailies (each proven winnable by a greedy auto-player).

## Layout

- `native/` — the engine client (TypeScript): screens and HUD (`screens.ts`),
  the market scene (`render.ts`), sound, platform and save, graphics tiers
- `src/rng.js`, `src/rules.js`, `src/content.js`, `src/session.js` — the
  seeded RNG, the pure deterministic rules engine, versioned content and
  sessions (undo, replay envelopes, progress, achievements)
- `src/store.js` — the save document; `src/i18n.js`, `src/locales/` — nine locales
- `score-script.js` — the platform script that posts leaderboard scores
- `server.js` — optional Node host with the legacy daily/score routes (not used by the client)
- `spec.md` — the running design spec; `ARCHITECTURE.md` — module contracts

## Modes

Learn (4 interactive lessons) · Journey (40 authored stages with mastery
gates) · Daily (one shared UTC seed) · Practice (3 difficulties, undo) ·
Challenge (move limits, speed, altered layouts) · Score chase (local and
platform boards).
