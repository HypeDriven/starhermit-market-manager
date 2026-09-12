// Market Manager — StarHermit platform adapter.
// Hosted mode activates iff a launch token was read from the URL fragment;
// every authenticated call sends Authorization: Bearer and the token is
// re-minted every 45 min. The game's own server.js (local dev backend) keeps
// its replay-validated score routes; on the hosted platform leaderboards are
// read-only and progress mirrors to the platform cloud slot. localStorage is
// always the offline cache: any failure falls back to local play with no
// console noise.

import { saveKey, loadKey } from './session.js';

const PROBE_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 6000;
const HEARTBEAT_INTERVAL_MS = 30000;
const REFRESH_INTERVAL_MS = 45 * 60 * 1000; // token lives 60 min — renew ahead of expiry
const REFRESH_RETRY_MS = 60 * 1000;
const CLOUD_DEBOUNCE_MS = 2000;
const LOCAL_BOARD_KEY = 'localBoards.v1';
const LOCAL_BOARD_LIMIT = 50;
const CLOUD_ENTRY_NAME = 'save.json';

// ---------------------------------------------------------------------------
// Launch token: fragment #game_token=<jwt>, read once, then stripped.
// Query params exist only as local-dev fallbacks.
// ---------------------------------------------------------------------------

function readLaunchToken() {
  if (typeof window === 'undefined' || !window.location) return null;
  const { location } = window;
  if (location.hash) {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get('game_token');
    if (token) {
      try {
        history.replaceState(null, '', location.pathname + location.search);
      } catch { /* stripping is best-effort */ }
      return token;
    }
  }
  const params = new URLSearchParams(location.search);
  return params.get('game_token') || params.get('token') || params.get('launch');
}

// base64url-decode the payload; signature verification is the platform's job.
function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer/reader (stored entries only, no compression).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

export function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// ---------------------------------------------------------------------------
// Platform adapter
// ---------------------------------------------------------------------------

export function createPlatform() {
  let token = readLaunchToken();
  let claims = token ? decodeJwtPayload(token) : null;
  let sub = claims && typeof claims.sub === 'string' ? claims.sub : null;
  let slug = claims && typeof claims.game_scope === 'string' ? claims.game_scope : null;
  const hosted = !!(token && sub && slug);
  if (!hosted) { token = null; claims = null; sub = null; slug = null; }

  let backend = false;      // the game's own server.js answered (local dev)
  let timeOffset = 0;       // serverNow - clientNow, round-trip adjusted
  let lastHeartbeat = 0;
  let leaderboardId = null; // platform leaderboard (read-only), when published
  let nickname = hosted ? 'Player ' + sub.slice(0, 8) : null;
  const profileCache = new Map(); // userId -> nickname
  let syncStatus = hosted ? 'synced' : 'local'; // local|synced|saving|offline|error
  let refreshTimer = null;
  let cloudTimer = null;
  let cloudDirty = false;
  let onError = null;     // (info: {kind, status?, message}) — recoverable UI states
  let onIdentity = null;  // ({nickname, hosted})
  let onSync = null;      // (status)

  function report(info) {
    if (typeof onError === 'function') {
      try { onError(info); } catch { /* listener errors must not break play */ }
    }
  }

  async function request(path, { method = 'GET', body, timeout = REQUEST_TIMEOUT_MS, binary = false } = {}) {
    if (typeof fetch !== 'function') throw new Error('fetch-unavailable');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const headers = {};
      if (body) headers['content-type'] = 'application/json';
      if (token) headers.authorization = 'Bearer ' + token;
      const res = await fetch(path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        credentials: 'same-origin',
      });
      if (res.status === 429) {
        let msg = 'rate-limited';
        try { msg = (await res.json()).error || msg; } catch { /* keep default */ }
        report({ kind: 'rate-limited', status: 429, message: msg });
        throw new Error(msg);
      }
      if (binary) {
        if (res.status === 404) throw Object.assign(new Error('not-found'), { notFound: true });
        if (!res.ok) {
          report({ kind: 'http', status: res.status, message: `http-${res.status}` });
          throw new Error(`http-${res.status}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (data && data.error) || `http-${res.status}`;
        report({ kind: 'http', status: res.status, message: msg });
        throw new Error(msg);
      }
      if (data && typeof data === 'object' && data.error) {
        report({ kind: 'server', status: res.status, message: String(data.error) });
        throw new Error(String(data.error));
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------- identity
  // Nickname via the profile route — never /api/v1/me (403 for launch
  // tokens), never usernames. Fallback: "Player " + id8.
  async function fetchProfile(userId) {
    if (profileCache.has(userId)) return profileCache.get(userId);
    let name = null;
    if (hosted) {
      try {
        const p = await request(`/api/v1/users/${encodeURIComponent(userId)}/profile`, { timeout: PROBE_TIMEOUT_MS });
        if (p && typeof p.nickname === 'string' && p.nickname.trim()) {
          name = p.nickname.trim().slice(0, 24);
        }
      } catch { /* keep fallback */ }
    }
    if (!name) name = 'Player ' + String(userId).slice(0, 8);
    profileCache.set(userId, name);
    return name;
  }

  function emitIdentity() {
    if (typeof onIdentity === 'function') {
      try { onIdentity({ nickname, hosted }); } catch { /* listener guard */ }
    }
  }

  // -------------------------------------------------------------- refresh
  // Scoped launch tokens re-mint against the game record; failures retry ~60 s.
  function scheduleRefresh(ms) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshToken, ms);
  }

  async function refreshToken() {
    if (!hosted) return;
    try {
      const data = await request(`/api/v1/games/${encodeURIComponent(slug)}/launch-token`, {
        method: 'POST', body: {}, timeout: REQUEST_TIMEOUT_MS,
      });
      if (data && typeof data.token === 'string' && data.token) {
        token = data.token;
        scheduleRefresh(REFRESH_INTERVAL_MS);
        return;
      }
      throw new Error('no-token');
    } catch {
      scheduleRefresh(REFRESH_RETRY_MS);
    }
  }

  // ----------------------------------------------------------- cloud save
  // ONE slot: {progress, boards} as a stored zip + base64. Remote wins on
  // conflict; localStorage stays the offline cache underneath.
  function cloudDoc() {
    return {
      v: 1,
      savedAt: Date.now(),
      progress: loadKey('progress.v1') || null,
      boards: loadKey(LOCAL_BOARD_KEY) || {},
    };
  }

  function setSync(status) {
    if (syncStatus === status) return;
    syncStatus = status;
    if (typeof onSync === 'function') {
      try { onSync(status); } catch { /* listener guard */ }
    }
  }

  function queueCloudSave() {
    if (!hosted) return; // offline: localStorage is the only store
    cloudDirty = true;
    setSync('saving');
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(flushCloudSave, CLOUD_DEBOUNCE_MS);
  }

  async function flushCloudSave() {
    clearTimeout(cloudTimer);
    if (!hosted || !cloudDirty) return;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(cloudDoc()));
      await request(`/api/v1/me/cloud-saves/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: { dataBase64: bytesToBase64(zipStore(CLOUD_ENTRY_NAME, bytes)) },
        timeout: REQUEST_TIMEOUT_MS,
      });
      cloudDirty = false;
      setSync('synced');
    } catch {
      setSync('offline'); // retried on the next change or pagehide
    }
  }

  async function loadCloudSave() {
    if (!hosted) return false;
    try {
      const bytes = await request(`/api/v1/me/cloud-saves/${encodeURIComponent(slug)}`, {
        binary: true, timeout: REQUEST_TIMEOUT_MS,
      });
      const doc = JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
      if (!doc || typeof doc !== 'object') return false;
      if (doc.progress && typeof doc.progress === 'object') saveKey('progress.v1', doc.progress);
      if (doc.boards && typeof doc.boards === 'object') saveKey(LOCAL_BOARD_KEY, doc.boards);
      cloudDirty = false;
      setSync('synced');
      return true;
    } catch {
      // 404 = no save yet: seed the cloud slot from the local cache.
      cloudDirty = true;
      flushCloudSave();
      return false;
    }
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const flush = () => { if (cloudDirty) flushCloudSave(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  // ----------------------------------------------------------------- init
  async function init() {
    const result = { hosted, backend: false, remoteLoaded: false };

    // Clock probe: valid against the platform or the own dev server, and the
    // same-origin 404 stays silent either way.
    try {
      const sendAt = Date.now();
      const data = await request('/api/v1/time', { timeout: PROBE_TIMEOUT_MS });
      const rtt = Date.now() - sendAt;
      if (data && typeof data.now === 'number') {
        timeOffset = data.now - (sendAt + rtt / 2);
        backend = !hosted; // hosted play has no own-server score route
      }
    } catch {
      backend = false;
      timeOffset = 0;
    }
    result.backend = backend;

    if (hosted) {
      scheduleRefresh(REFRESH_INTERVAL_MS);
      fetchProfile(sub).then((name) => { nickname = name; emitIdentity(); });
      // Platform game record: leaderboard id for the read-only board view.
      try {
        const g = await request(`/api/v1/games/${encodeURIComponent(slug)}`, { timeout: PROBE_TIMEOUT_MS });
        if (g && (typeof g.leaderboardId === 'string' || typeof g.leaderboardId === 'number')) {
          leaderboardId = String(g.leaderboardId);
        }
      } catch { /* local records only */ }
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
  async function getLeaderboard({ board = 'global', date = null, configId = null } = {}) {
    if (hosted && leaderboardId) {
      try {
        const q = new URLSearchParams({ pageSize: '50' });
        const data = await request(`/api/v1/leaderboards/${encodeURIComponent(leaderboardId)}/entries?` + q.toString());
        const list = Array.isArray(data && data.entries) ? data.entries : [];
        const rows = await Promise.all(list.slice(0, LOCAL_BOARD_LIMIT).map(async (e, i) => {
          const userId = e && (e.userId ?? (e.user && e.user.id) ?? e.user_id ?? null);
          let name = null;
          if (userId != null) name = await fetchProfile(String(userId));
          if (!name && e && typeof e.name === 'string' && e.name) name = e.name;
          if (!name) name = 'Player ' + String(userId ?? 'unknown').slice(0, 8);
          const score = e && Number(e.score != null ? e.score : e.value);
          return { name, score: Number.isFinite(score) ? score : 0, rank: (e && e.rank) || i + 1 };
        }));
        return rows;
      } catch {
        return localEntries(board, date);
      }
    }
    if (backend) {
      try {
        const q = new URLSearchParams({ board: board || 'global' });
        if (date) q.set('date', date);
        if (configId) q.set('configId', configId);
        const data = await request('/api/v1/leaderboard?' + q.toString());
        return Array.isArray(data && data.entries) ? data.entries : [];
      } catch {
        return localEntries(board, date);
      }
    }
    return localEntries(board, date);
  }

  // ------------------------------------------------------ own-server submit
  // Replay-validated submission exists only against the game's own server.js
  // (local dev). On the hosted platform the leaderboard is script-owned and
  // cannot accept client submissions, so the run records locally instead.
  async function submitScore(envelope) {
    if (backend) {
      try {
        const data = await request('/api/v1/scores', { method: 'POST', body: envelope, timeout: 4000 });
        return data && data.ok ? { ok: true, rank: data.rank } : { error: 'rejected' };
      } catch (e) {
        // Fall back to the local board so the run is not lost.
        const local = submitScoreLocal(envelope);
        return { ...local, offline: true, error: undefined };
      }
    }
    const local = submitScoreLocal(envelope);
    return { ...local, local: true };
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

  // ---------------------------------------------------------- heartbeat
  // Presence ping for the game's own dev server only — the platform has no
  // per-game presence endpoint, so hosted mode never sends this.
  async function heartbeat() {
    if (!backend || hosted) return;
    const now = Date.now();
    if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeat = now;
    try {
      await request('/api/v1/heartbeat', { method: 'POST', body: { ok: true } });
    } catch { /* presence is best-effort */ }
  }

  return {
    get hosted() { return hosted; },
    get backend() { return backend; },
    get ranked() { return backend; }, // replay-validated submit: own-server backend only
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
    heartbeat,
  };
}
