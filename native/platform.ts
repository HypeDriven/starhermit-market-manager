// The game's data and the StarHermit platform, on the runtime's modules:
// - the save (starhermit:storage `saves`, on the device and in the player's
//   cloud slot) is the browser build's own cloud document,
//   { v: 1, progress, boards }, with the game's settings and the last played
//   stage beside them (src/store.js; the browser build kept those two in
//   localStorage only). src/session.js reads and writes its records through
//   src/store.js keyStore; two devices' copies merge on a conflict
//   (src/store.js mergeDocs, the browser build's saveconflict merge). The
//   slot the browser build wrote (the JS SDK's saveJSON) shows as foreign: it
//   is merged in and replaced once;
// - the browser build mirrored its settings into the account's settings KV
//   (volumes, graphics, reduced motion, high contrast, larger text, theme,
//   camera, colour vision, left-handed, haptics, tutorialsDone, …) and the
//   language helper kept ui.language there: the runtime's Options own the
//   volumes, graphics, motion, contrast, text size and language now; the
//   game's own (theme, camera, colour vision, left-handed, haptics, the
//   finished lessons) move into the save; all are removed from the KV;
// - the player, the invite link, the platform's clock for the Daily, the
//   game's high-score board (the setup screen's preview) and posting a
//   ranked run's total through score-script.js (a practice session whose
//   socket carries { type: 'result', scores }, as the JS SDK's submitScores
//   did), then the rank on that board.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import { Sess, Store, type Doc, type Settings } from "./game.ts";

// --- the save document ----------------------------------------------------------------------
let live: Doc = { v: 1 };
let lastSavedAt = 0;
let dirty = false;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

function write(opts: { replaceForeign?: boolean } = {}): void {
  dirty = false;
  try { saves.save(live as unknown as JsonValue, { schema: 1, ...opts }); }
  catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Writes the document if session.js changed it this frame (called each frame). */
export function flushDirty(): void { if (dirty) write(); }
/** Replaces the live document's keys in place (session.js keeps its view). */
function replaceDoc(next: Doc): void {
  for (const k of Object.keys(live)) delete live[k];
  Object.assign(live, next);
}
/** Merges another copy into the live document (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  const next = Store.mergeDocs(other, live);
  if (JSON.stringify(next) === JSON.stringify(Store.normalize(live))) return false;
  replaceDoc(next);
  write();
  return true;
}
saves.onConflict((local, remote) => ({ merged: Store.mergeDocs(remote.data, local?.data ?? null) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud save: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = Store.readForeign(old.text);
  let changed = false;
  if (doc) {
    const next = Store.mergeDocs(doc, live);
    changed = JSON.stringify(next) !== JSON.stringify(Store.normalize(live));
    replaceDoc(next);
  }
  write({ replaceForeign: true });
  if (changed) merged();
}

// The browser build's account settings KV: its game settings (src/session.js
// DEFAULT_SETTINGS then) and the language helper's ui.language. All are
// removed; the game's own carry into the save first.
export const BROWSER_KEYS = [
  "music", "effects", "ambience", "voice", "graphics", "quality", "theme", "reducedMotion", "highContrast", "colorblind",
  "largeText", "leftHanded", "holdToConfirm", "timingAssist", "haptics", "camera", "tutorialsDone", "ui.language",
];
const CARRIED = ["theme", "colorblind", "leftHanded", "haptics", "camera", "tutorialsDone"] as const;
function removeLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  const s = Sess.loadSettings() as unknown as Record<string, unknown>;
  let changed = false;
  for (const k of CARRIED) {
    if (!keys.includes(k)) continue;
    const v = store.legacy(k);
    if (v === undefined || v === null) continue;
    if (k === "tutorialsDone") {
      if (!Array.isArray(v)) continue;
      const have = (s.tutorialsDone as string[]) || [];
      const all = [...new Set([...have, ...v.filter((x): x is string => typeof x === "string")])];
      if (all.length !== have.length) { s.tutorialsDone = all; changed = true; }
    } else if (JSON.stringify(s[k]) !== JSON.stringify(v)) { s[k] = v; changed = true; }
  }
  if (changed) Sess.saveSettings(s as unknown as Settings);
  for (const key of keys) if (BROWSER_KEYS.includes(key)) store.removeLegacy(key);
  if (changed) merged();
}

/** Reads the device's save and gives session.js its view of it (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  live = Store.normalize(cur?.data ?? null);
  Sess.setKeyStore(Store.keyStore(live, () => { dirty = true; }));
  store.onLegacy(removeLegacy);
  removeLegacy();
  if (saves.state() === "foreign") migrateForeign();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

/** For the title's player line (the old sync labels): local | saving | synced | error. */
export function syncState(): "local" | "saving" | "synced" | "error" | "offline" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (saves.status() === "saved-on-device" && st === "ready") return "offline";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { flushDirty(); void saves.flush().catch(() => undefined); }

// --- the player and the clock ---------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
onPlayerChange(() => refreshPlayer());

/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the high-score board -------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Posted { posted: boolean; rank: number | null }
export interface Row { name: string; score: number; rank: number }

/** Signed in only: post a ranked run's total through score-script.js; { posted, rank }. Never rejects. */
export async function postLeaderboard(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}

/** The game's board's top entries with the players' display names; null when unavailable. */
export async function topScores(pageSize = 50): Promise<Row[] | null> {
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize });
    return r.items.map((e, i) => ({ name: e.displayName || e.username || "", score: Number.isFinite(e.score) ? e.score : 0, rank: e.rank || i + 1 }));
  } catch { return null; }
}
