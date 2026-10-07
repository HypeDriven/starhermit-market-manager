// Market Manager — StarHermit platform adapter over the shared SDK
// (window.StarHermit from starhermit-sdk.js). The SDK owns the launch token,
// renewal, profile lookup, the game:<slug> cloud-save slot, the settings KV
// and key bindings. Hosted mode = signed in. Standalone (no launch token) the
// game makes no own-server requests at all: local clock, local boards.
// localStorage is always the offline cache: any failure falls back to local
// play with no console noise.

import { saveKey, loadKey } from './session.js';

const CLOUD_DEBOUNCE_MS = 2000;
const SETTINGS_DEBOUNCE_MS = 1500;
const LOCAL_BOARD_KEY = 'localBoards.v1';
const LOCAL_BOARD_LIMIT = 50;

// ---------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------

export function createPlatform({ sh: shDep } = {}) {
  const sh = shDep || globalThis.StarHermit;
  sh.init();
  let timeOffset = 0;       // serverNow - clientNow, round-trip adjusted (signed in only)
  let nickname = sh.signedIn ? 'Player ' + String(sh.userId).slice(0, 6) : null;
  let syncStatus = sh.signedIn ? 'synced' : 'local'; // local|synced|saving|offline|error
  let onError = null;     // (info: {kind, status?, message}) — recoverable UI states
  let onIdentity = null;  // ({nickname, hosted})
  let onSync = null;      // (status)
  const authListeners = new Set();

  function report(info) {
    if (typeof onError === 'function') {
      try { onError(info); } catch { /* listener errors must not break play */ }
    }
  }

  // ------------------------------------------------------------- identity
  // Nickname via the profile route (never /api/v1/me, never usernames).
  async function fetchProfile(userId) {
    const p = await sh.profile(userId);
    return p ? String(p.displayName).slice(0, 24) : 'Player ' + String(userId).slice(0, 6);
  }

  function emitIdentity() {
    if (typeof onIdentity === 'function') {
      try { onIdentity({ nickname, hosted: sh.signedIn }); } catch { /* listener guard */ }
    }
  }

  function setSync(status) {
    if (syncStatus === status) return;
    syncStatus = status;
    if (typeof onSync === 'function') {
      try { onSync(status); } catch { /* listener guard */ }
    }
  }

  sh.on('saved', (ok) => setSync(ok ? 'synced' : 'offline'));
  sh.on('auth', (a) => {
    if (!a.signedIn) { nickname = null; setSync('local'); }
    for (const fn of authListeners) { try { fn(a); } catch { /* listener guard */ } }
  });

  // ----------------------------------------------------------- cloud save
  // ONE slot (game:<slug>): {progress, boards}. Remote wins on conflict;
  // localStorage stays the offline cache underneath.
  function cloudDoc() {
    return {
      v: 1,
      savedAt: Date.now(),
      progress: loadKey('progress.v1') || null,
      boards: loadKey(LOCAL_BOARD_KEY) || {},
    };
  }

  // Held during the start-up load: a doc queued then would still be PUT after
  // the remote one is adopted, over the newer cloud save.
  let cloudLoading = false;
  let cloudHeld = false;
  function queueCloudSave() {
    if (!sh.signedIn) return; // offline: localStorage is the only store
    if (cloudLoading) { cloudHeld = true; return; }
    setSync('saving');
    sh.saveJSON(cloudDoc(), CLOUD_DEBOUNCE_MS);
  }

  async function loadCloudSave() {
    if (!sh.signedIn) return false;
    cloudLoading = true;
    const doc = await sh.loadJSON().finally(() => { cloudLoading = false; });
    cloudHeld = false; // superseded: adopted remote, or the seed push below
    if (!doc || typeof doc !== 'object') {
      queueCloudSave(); // no save yet: seed the slot from the local cache
      return false;
    }
    if (doc.progress && typeof doc.progress === 'object') saveKey('progress.v1', doc.progress);
    if (doc.boards && typeof doc.boards === 'object') saveKey(LOCAL_BOARD_KEY, doc.boards);
    setSync('synced');
    return true;
  }

  // ------------------------------------------------------- settings KV
  let lastSettings = null;
  let pendingPatch = null;
  let settingsTimer = null;
  async function loadSettings() { return sh.signedIn ? (await sh.getSettings()) || {} : {}; }
  function primeSettings(obj) { lastSettings = JSON.stringify(obj); }
  function pushSettings(obj) {
    if (!sh.signedIn || lastSettings === null) return;
    const json = JSON.stringify(obj);
    if (json === lastSettings) return;
    const prev = JSON.parse(lastSettings);
    lastSettings = json;
    pendingPatch = pendingPatch || {};
    for (const k of Object.keys(obj)) {
      if (JSON.stringify(obj[k]) !== JSON.stringify(prev[k])) pendingPatch[k] = obj[k];
    }
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(flushSettings, SETTINGS_DEBOUNCE_MS);
  }
  function flushSettings() {
    clearTimeout(settingsTimer);
    settingsTimer = null;
    if (!pendingPatch || !sh.signedIn) return Promise.resolve(null);
    const patch = pendingPatch;
    pendingPatch = null;
    return sh.patchSettings(patch);
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const flush = () => { if (sh.signedIn) { sh.flushSave(true); flushSettings(); } };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  // ----------------------------------------------------------------- init
  async function init() {
    const hosted = sh.signedIn;
    const result = { hosted, remoteLoaded: false };

    // Platform clock only with a launch token; standalone uses the local clock.
    if (hosted) {
      cloudLoading = true; // the time sync below already counts as the load window
      try {
        const sendAt = Date.now();
        const data = await sh.api('/api/v1/time');
        const rtt = Date.now() - sendAt;
        if (data && typeof data.now === 'number') timeOffset = data.now - (sendAt + rtt / 2);
      } catch {
        timeOffset = 0;
      }
    }

    if (hosted) {
      fetchProfile(sh.userId).then((name) => { nickname = name; emitIdentity(); });
      result.remoteLoaded = await loadCloudSave();
    }
    return result;
  }

  function serverTimeOffset() {
    return timeOffset;
  }

  function serverNow() {
    return Date.now() + serverTimeOffset();
  }

  // ------------------------------------------------------------ leaderboards
  // Read-only per the platform contract: clients never submit scores.
  // Personal bests live in progress + the local board and cloud-save with it.
  async function getLeaderboard({ board = 'global', date = null } = {}) {
    if (sh.signedIn) {
      // The game's first platform board, when one exists; else local records.
      const lb = await sh.leaderboard(null, { pageSize: LOCAL_BOARD_LIMIT });
      if (!lb || !lb.board) return localEntries(board, date);
      return Promise.all((lb.items || []).slice(0, LOCAL_BOARD_LIMIT).map(async (e, i) => {
        const name = e.userId != null ? await fetchProfile(String(e.userId)) : (e.name || 'Player');
        const score = Number(e.score != null ? e.score : e.value);
        return { name, score: Number.isFinite(score) ? score : 0, rank: e.rank || i + 1 };
      }));
    }
    return localEntries(board, date);
  }

  // Leaderboards are read-only on the platform and there is no own server,
  // so every run records to the local board (cloud-saved when signed in).
  async function submitScore(envelope) {
    return submitScoreLocal(envelope);
  }

  // ------------------------------------------------------ local fallback
  function readLocalBoards() {
    return loadKey(LOCAL_BOARD_KEY) || {};
  }

  function submitScoreLocal(envelope) {
    const boards = readLocalBoards();
    const boardKey = envelope.config && envelope.config.dailyDate ? 'daily' : 'global';
    const dateKey = envelope.config && envelope.config.dailyDate
      ? envelope.config.dailyDate
      : 'all';
    boards[boardKey] = boards[boardKey] || {};
    const list = boards[boardKey][dateKey] || [];
    const entry = {
      name: nickname || 'You',
      score: envelope.result ? envelope.result.total : 0,
      date: new Date(serverNow()).toISOString().slice(0, 10),
      durationMs: envelope.durationMs || 0,
      sessionId: envelope.sessionId,
    };
    list.push(entry);
    list.sort((a, b) => b.score - a.score || a.durationMs - b.durationMs);
    boards[boardKey][dateKey] = list.slice(0, LOCAL_BOARD_LIMIT);
    saveKey(LOCAL_BOARD_KEY, boards);
    const rank = boards[boardKey][dateKey].indexOf(entry) + 1;
    return { ok: true, rank, local: true };
  }

  function localEntries(board, date) {
    const boards = readLocalBoards();
    const byDate = boards[board || 'global'] || {};
    return byDate[date || 'all'] || [];
  }

  return {
    get hosted() { return sh.signedIn; },
    get nickname() { return nickname; },
    get syncStatus() { return syncStatus; },
    get onError() { return onError; },
    set onError(cb) { onError = cb; },
    get onIdentity() { return onIdentity; },
    set onIdentity(cb) { onIdentity = cb; },
    get onSync() { return onSync; },
    set onSync(cb) { onSync = cb; },
    init,
    serverTimeOffset,
    serverNow,
    submitScore,
    getLeaderboard,
    queueCloudSave,
    loadSettings,
    primeSettings,
    pushSettings,
    flushSettings,
    loadBindings: (defaults) => (sh.signedIn ? sh.loadBindings(defaults) : Promise.resolve(defaults)),
    canSignIn: () => sh.canSignIn(),
    signIn: () => sh.signIn(),
    inviteLink: () => (sh.signedIn ? sh.inviteLink() : null),
    onAuth: (fn) => authListeners.add(fn),
  };
}
