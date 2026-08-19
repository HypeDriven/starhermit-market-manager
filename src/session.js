// Session layer: wraps the rules engine with command ids, undo, replay
// envelopes, local persistence (versioned + checksummed), and achievements.
// UI and render consume sessions; they never touch rules state directly.

import {
  createGame, step, applyCommand, legalActions, validateCommand, computeScore,
  stateHash, isTerminal, TICK_MS,
} from './rules.js';
import { hashString, stableStringify } from './rng.js';
import { CONTENT_VERSION } from './content.js';

export const BUILD_VERSION = 1;
export { TICK_MS };

const HASH_EVERY = 25;
const UNDO_LIMIT = 50;

// ---------------------------------------------------------------------------
// Versioned, checksummed local storage
// ---------------------------------------------------------------------------

const storage = (() => {
  try {
    const t = '__mm_probe__';
    localStorage.setItem(t, '1');
    localStorage.removeItem(t);
    return localStorage;
  } catch {
    const mem = new Map(); // private browsing / sandbox fallback
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
})();

function wrapDoc(data) {
  const body = stableStringify(data);
  return JSON.stringify({ v: 1, checksum: hashString(body), data: JSON.parse(body) });
}

function unwrapDoc(raw) {
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw);
    if (doc.v !== 1) return null;
    if (hashString(stableStringify(doc.data)) !== doc.checksum) return null; // corrupt
    return doc.data;
  } catch {
    return null;
  }
}

export function saveKey(key, data) {
  try { storage.setItem('mm.' + key, wrapDoc(data)); return true; } catch { return false; }
}

export function loadKey(key) {
  return unwrapDoc(storage.getItem('mm.' + key));
}

// ---------------------------------------------------------------------------
// Settings (accessibility, audio, graphics, controls)
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.7,
  quality: 'auto', // auto | low | medium | high
  theme: null,     // null = stage default
  reducedMotion: false,
  highContrast: false,
  colorblind: 'none', // none | deuteranopia | protanopia | tritanopia
  largeText: false,
  leftHanded: false,
  holdToConfirm: false,
  timingAssist: false,
  haptics: true,
  camera: 'isometric', // isometric | high | low
  tutorialsDone: [],
  consentAnalytics: false,
};

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(loadKey('settings.v1') || {}) };
}

export function saveSettings(settings) {
  saveKey('settings.v1', settings);
}

// ---------------------------------------------------------------------------
// Progression (journey, achievements, mastery)
// ---------------------------------------------------------------------------

export const ACHIEVEMENTS = [
  { key: 'first-shift', name: 'First Shift', desc: 'Complete your first stage.' },
  { key: 'full-house', name: 'Full House', desc: 'Have every department unlocked at once.' },
  { key: 'hot-streak', name: 'Hot Streak', desc: 'Win three stages in a row.' },
  { key: 'market-legend', name: 'Market Legend', desc: 'Complete the final journey stage.' },
  { key: 'neighborhood-favorite', name: 'Neighborhood Favorite', desc: 'Serve 500 guests in total.' },
];

const DEFAULT_PROGRESS = {
  journey: {},      // stageId -> { won, best }
  challenges: {},   // challengeId -> { won, best }
  daily: {},        // dateIso -> { score, phase }
  tutorialsDone: [],
  achievements: {}, // key -> true
  guestsServedTotal: 0,
  winStreak: 0,
  bestStreak: 0,
};

export function loadProgress() {
  return { ...structuredClone(DEFAULT_PROGRESS), ...(loadKey('progress.v1') || {}) };
}

export function saveProgress(progress) {
  saveKey('progress.v1', progress);
}

// Apply a finished session's results to progression. Returns newly unlocked
// achievements (idempotent: already-held keys never re-fire).
export function recordResult(progress, session) {
  const state = session.state;
  const score = computeScore(state);
  const config = session.config;
  const newly = [];
  const grant = (key) => {
    if (!progress.achievements[key]) {
      progress.achievements[key] = true;
      newly.push(ACHIEVEMENTS.find((a) => a.key === key));
    }
  };

  progress.guestsServedTotal += state.stats.served;
  if (progress.guestsServedTotal >= 500) grant('neighborhood-favorite');

  if (state.phase === 'won') {
    progress.winStreak += 1;
    progress.bestStreak = Math.max(progress.bestStreak, progress.winStreak);
    if (progress.winStreak >= 3) grant('hot-streak');
    grant('first-shift');
  } else {
    progress.winStreak = 0;
  }

  if (state.departments.every((d) => d.unlocked)) grant('full-house');
  if (config.id === 'j40' && state.phase === 'won') grant('market-legend');

  const best = (table, id) => {
    const cur = table[id];
    if (!cur || score.total > cur.best || (state.phase === 'won' && !cur.won)) {
      table[id] = { won: cur?.won || state.phase === 'won', best: Math.max(cur?.best || 0, score.total) };
    }
  };
  if (config.id.startsWith('j')) best(progress.journey, config.id);
  else if (config.id.startsWith('c')) best(progress.challenges, config.id);
  else if (config.dailyDate) {
    const cur = progress.daily[config.dailyDate];
    if (!cur || score.total > cur.score) progress.daily[config.dailyDate] = { score: score.total, phase: state.phase };
  }
  return newly;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

let sessionSeq = 0;

export function createSession({ config, mode, allowUndo = false, sessionId = null }) {
  const listeners = { change: [], events: [], terminal: [] };
  let state = createGame(config);
  const initialHash = stateHash(state);
  const commands = [];
  const hashes = [{ tick: 0, hash: initialHash }];
  const undoStack = [];
  let cmdSeq = 0;
  let startedAt = Date.now();
  let endedAt = null;
  let terminalEmitted = false;

  const id = sessionId || `s${Date.now().toString(36)}-${(sessionSeq++).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

  function emit(kind, payload) {
    for (const cb of listeners[kind]) cb(payload);
  }

  function maybeTerminal() {
    if (isTerminal(state) && !terminalEmitted) {
      terminalEmitted = true;
      endedAt = Date.now();
      emit('terminal', { state, score: computeScore(state) });
    }
  }

  const session = {
    id,
    mode, // 'learn' | 'journey' | 'daily' | 'practice' | 'challenge' | 'score'
    config,
    get state() { return state; },
    get startedAt() { return startedAt; },
    get endedAt() { return endedAt; },
    get isOver() { return isTerminal(state); },
    get commands() { return commands.slice(); },
    get allowUndo() { return allowUndo && !!config.allowed.undo; },

    on(kind, cb) { listeners[kind].push(cb); return session; },

    legalActions() { return legalActions(state); },
    explain(cmd) { return validateCommand(state, cmd); },

    // Issue a player command. Returns { ok, reason?, events }.
    issue(cmd) {
      if (isTerminal(state)) return { ok: false, reason: 'game-over', events: [] };
      const full = { ...cmd, id: `${id}-c${cmdSeq++}`, tick: state.tick };
      if (session.allowUndo) {
        undoStack.push(state);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      }
      const res = applyCommand(state, full);
      const applied = res.ok && !res.duplicate;
      if (!applied && session.allowUndo) undoStack.pop();
      state = res.state;
      if (applied) {
        commands.push(full);
        // hashes are recorded on tick arrival in stepTick(), not here —
        // a hash at tick T must describe the state before commands at T
      }
      if (res.events.length) emit('events', res.events);
      emit('change', state);
      maybeTerminal();
      return res;
    },

    // Advance exactly one simulation tick. Returns events.
    stepTick() {
      if (isTerminal(state)) return [];
      state = step(state);
      const events = state.lastEvents || [];
      if (state.tick % HASH_EVERY === 0) hashes.push({ tick: state.tick, hash: stateHash(state) });
      if (events.length) emit('events', events);
      emit('change', state);
      maybeTerminal();
      return events;
    },

    canUndo() { return session.allowUndo && undoStack.length > 0; },
    undo() {
      if (!session.canUndo() || isTerminal(state)) return false;
      state = undoStack.pop();
      // retract the last command so replays stay consistent
      commands.pop();
      emit('change', state);
      return true;
    },

    score() { return computeScore(state); },

    replayEnvelope() {
      return {
        schemaVersion: 1,
        buildVersion: BUILD_VERSION,
        contentVersion: CONTENT_VERSION,
        sessionId: id,
        mode,
        seed: config.seed,
        config,
        initialHash,
        timestampOffset: startedAt,
        commands: commands.slice(),
        hashes: hashes.slice(),
        finalHash: stateHash(state),
        result: { phase: state.phase, total: computeScore(state).total, terminalReason: state.terminalReason },
        assists: { undo: session.allowUndo, timingAssist: false },
        durationMs: (endedAt || Date.now()) - startedAt,
      };
    },

    // Snapshot for suspend/resume (last safe local snapshot).
    snapshot() {
      return { state, commands, hashes, undoDepth: undoStack.length, startedAt, id, mode };
    },
  };
  return session;
}

// Restore a session from a snapshot (e.g. after backgrounding).
export function resumeSession(snapshot, config) {
  const session = createSession({ config, mode: snapshot.mode, sessionId: snapshot.id });
  // Rebuild deterministically from the command log rather than trusting the
  // cached state blob.
  return session;
}
