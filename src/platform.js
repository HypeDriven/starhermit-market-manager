// Market Manager — optional hosted backend adapter.
// Same-origin REST per ARCHITECTURE.md "Platform contract". Every call
// times out fast and falls back to local behavior so offline play is fully
// supported. No tokens, no credential persistence. When the backend is
// unavailable, a local leaderboard with the same entry shape keeps Score
// chase working solo.

import { saveKey, loadKey } from './session.js';

const PROBE_TIMEOUT_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 30000;
const LOCAL_BOARD_KEY = 'localBoards.v1';
const LOCAL_BOARD_LIMIT = 50;

export function createPlatform() {
  let available = false;
  let timeOffset = 0; // serverNow - clientNow, round-trip adjusted
  let lastHeartbeat = 0;
  let onError = null; // (info: {kind, status?, message}) — recoverable UI states

  function report(info) {
    if (typeof onError === 'function') {
      try { onError(info); } catch { /* listener errors must not break play */ }
    }
  }

  async function request(path, { method = 'GET', body, timeout = PROBE_TIMEOUT_MS } = {}) {
    if (typeof fetch !== 'function') throw new Error('fetch-unavailable');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
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

  async function init() {
    try {
      const sendAt = Date.now();
      const data = await request('/api/v1/time');
      const rtt = Date.now() - sendAt;
      if (data && typeof data.now === 'number') {
        timeOffset = data.now - (sendAt + rtt / 2);
        available = true;
      }
    } catch {
      available = false;
      timeOffset = 0;
    }
    return available;
  }

  function serverTimeOffset() {
    return available ? timeOffset : 0;
  }

  function serverNow() {
    return Date.now() + serverTimeOffset();
  }

  async function getDaily() {
    if (!available) return null;
    try {
      const d = await request('/api/v1/daily');
      if (d && typeof d.date === 'string' && typeof d.seed === 'number') {
        return { date: d.date, seed: d.seed >>> 0, excluded: !!d.excluded };
      }
      return null;
    } catch {
      return null;
    }
  }

  async function submitScore(envelope) {
    if (!available) return submitScoreLocal(envelope);
    try {
      const data = await request('/api/v1/scores', { method: 'POST', body: envelope, timeout: 4000 });
      return data && data.ok ? { ok: true, rank: data.rank } : { error: 'rejected' };
    } catch (e) {
      // Fall back to the local board so the run is not lost.
      const local = submitScoreLocal(envelope);
      return { ...local, offline: true, error: undefined };
    }
  }

  async function getLeaderboard(board, date) {
    if (!available) return localEntries(board, date);
    try {
      const q = new URLSearchParams({ board: board || 'global' });
      if (date) q.set('date', date);
      const data = await request('/api/v1/leaderboard?' + q.toString());
      return Array.isArray(data && data.entries) ? data.entries : [];
    } catch {
      return localEntries(board, date);
    }
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
      name: 'You',
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
  async function heartbeat() {
    if (!available) return;
    const now = Date.now();
    if (now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeat = now;
    try {
      await request('/api/v1/heartbeat', { method: 'POST', body: { ok: true } });
    } catch { /* presence is best-effort */ }
  }

  // Minimal analytics beacon: fired only with explicit consent. No pointers,
  // no text — just an event name from a fixed funnel vocabulary.
  function beacon(name) {
    if (!available || typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    try {
      navigator.sendBeacon('/api/v1/beacon', JSON.stringify({ event: String(name).slice(0, 40) }));
    } catch { /* best-effort */ }
  }

  return {
    get available() { return available; },
    get onError() { return onError; },
    set onError(cb) { onError = cb; },
    init,
    serverTimeOffset,
    serverNow,
    getDaily,
    submitScore,
    getLeaderboard,
    heartbeat,
    beacon,
  };
}
