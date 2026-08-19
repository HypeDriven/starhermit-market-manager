# Market Manager

A bright isometric neighborhood market management game for the browser.
Stock displays, serve queues, hire staff, and unlock new departments through
earned revenue.

## Run

Any static file server works. The included server adds daily seeds,
replay-validated leaderboards, and heartbeats:

```
node server.js 8080     # then open http://localhost:8080
```

The game also runs fully offline from a plain static server (practice,
journey, tutorials, and a local daily all work without the API).

## Test

```
node tests/rules.test.mjs
```

Covers every legal action and invalid-action reason, scoring components,
terminal states, serialization round-trips, deterministic replay
(property-style: same version + seed + commands → identical state hashes),
command fuzzing, move limits, daily determinism, and offline validation of
all 40 journey stages, 4 tutorials, 5 challenges, 3 practice difficulties,
and sample dailies (each proven winnable by a greedy auto-player).

## Layout

- `index.html`, `css/` — semantic UI shell (works without WebGL for help/settings)
- `src/rng.js` — seeded RNG, stable hashing
- `src/rules.js` — pure deterministic rules engine (no DOM)
- `src/content.js` — versioned stages, themes, tutorials, daily ruleset, validators
- `src/session.js` — sessions, undo, replay envelopes, persistence, achievements
- `src/render.js` — Three.js isometric market (vendored three r160 in `lib/`)
- `src/ui.js`, `src/audio.js`, `src/platform.js`, `src/main.js` — DOM UI, WebAudio synth, optional backend adapter, bootstrap
- `server.js` — authoritative script (daily seeds, score validation, leaderboards)
- `ARCHITECTURE.md` — module contracts

## Modes

Learn (4 interactive lessons) · Journey (40 authored stages with mastery
gates) · Daily (one shared UTC seed) · Practice (3 difficulties, undo) ·
Challenge (move limits, speed, altered layouts) · Score chase (replay-validated
boards, friends/local filtering).
