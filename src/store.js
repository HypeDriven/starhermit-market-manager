// Market Manager — the save document. Pure (no storage, no platform) so the
// engine client and the node tests share it.
//
// The browser build kept its records in localStorage (mm.progress.v1,
// mm.localBoards.v1, mm.settings.v1, mm.lastPlayed.v1) and mirrored progress
// and the local boards into the cloud slot game:<slug> as one JSON document
// { v: 1, savedAt, progress, boards } (the JS SDK's saveJSON). The engine
// client's save is that document, with the game's settings and the last
// played stage beside them: { v: 1, progress, boards, settings, lastPlayed }.
// keyStore() gives src/session.js its records from it, mergeDocs() is the
// browser build's saveconflict merge, readForeign() reads the old slot.

import { mergeProgress } from './session.js';

export const LOCAL_BOARD_LIMIT = 50;
/** session.js record keys → document fields. */
export const KEY_FIELDS = { 'progress.v1': 'progress', 'localBoards.v1': 'boards', 'settings.v1': 'settings', 'lastPlayed.v1': 'lastPlayed' };
const FIELDS = Object.values(KEY_FIELDS);

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Only the document's own fields of anything (the old cloud doc included). */
export function normalize(raw) {
  const src = obj(raw) || {};
  const out = { v: 1 };
  for (const f of FIELDS) if (obj(src[f])) out[f] = clone(src[f]);
  return out;
}

/** Both devices' local boards, de-duplicated by session, best first (the browser build's mergeBoards). */
export function mergeBoards(a, b) {
  const out = {};
  for (const board of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    out[board] = {};
    const da = (a || {})[board] || {}, db = (b || {})[board] || {};
    for (const key of new Set([...Object.keys(da), ...Object.keys(db)])) {
      const seen = new Set();
      out[board][key] = [...(da[key] || []), ...(db[key] || [])]
        .filter((e) => { const k = e && (e.sessionId || JSON.stringify(e)); if (!e || seen.has(k)) return false; seen.add(k); return true; })
        .sort((x, y) => y.score - x.score || x.durationMs - y.durationMs)
        .slice(0, LOCAL_BOARD_LIMIT);
    }
  }
  return out;
}

// Another device saved since this one last loaded the slot: keep the better
// of each record (session.js mergeProgress), both boards, and this device's
// settings and last played stage.
export function mergeDocs(remote, local) {
  const r = normalize(remote), l = normalize(local);
  const out = { v: 1 };
  if (r.progress || l.progress) out.progress = mergeProgress(r.progress, l.progress);
  if (r.boards || l.boards) out.boards = mergeBoards(r.boards, l.boards);
  for (const f of ['settings', 'lastPlayed']) {
    const v = l[f] || r[f];
    if (v) out[f] = v;
  }
  return out;
}

/** The browser build's cloud slot text ({ v, savedAt, progress, boards } as JSON), or null. */
export function readForeign(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const doc = JSON.parse(text);
    return obj(doc) ? normalize(doc) : null;
  } catch { return null; }
}

/** session.js's record store over `doc` (setKeyStore); onWrite() after each change. */
export function keyStore(doc, onWrite) {
  return {
    load(key) {
      const f = KEY_FIELDS[key];
      return f && doc[f] !== undefined ? clone(doc[f]) : null;
    },
    save(key, data) {
      const f = KEY_FIELDS[key];
      if (!f) return;
      doc[f] = clone(data);
      if (onWrite) onWrite();
    },
  };
}

/** A ranked run on the local board (the browser build's submitScoreLocal): { boards, rank }. */
export function recordLocal(boards, { name, score, date, durationMs, sessionId, dailyDate }) {
  const out = clone(obj(boards) || {});
  const boardKey = dailyDate ? 'daily' : 'global';
  const dateKey = dailyDate || 'all';
  out[boardKey] = out[boardKey] || {};
  const list = out[boardKey][dateKey] || [];
  const entry = { name, score, date, durationMs: durationMs || 0, sessionId };
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.durationMs - b.durationMs);
  out[boardKey][dateKey] = list.slice(0, LOCAL_BOARD_LIMIT);
  return { boards: out, rank: out[boardKey][dateKey].indexOf(entry) + 1 };
}

/** A local board's entries (daily by date, else the all-time global board). */
export function localEntries(boards, board, date) {
  const byDate = (obj(boards) || {})[board || 'global'] || {};
  return byDate[date || 'all'] || [];
}
