// The browser build's semantic HTML shell (index.html + src/ui.js +
// css/style.css) as starhermit:ui, built every frame: the page header and
// footer, the title over its backdrop (Play, Daily market, All modes, How to
// play, Settings, Sign in / Invite, the daily chip, the player line, the
// Journey summary), the mode cards, the stage grids, the shift briefing
// (goals, length, rules, standing, the leaderboard preview), the HUD
// (objective, moves, coins, time, guests, score, Undo / Hint / Staff /
// Pause), the tutorial banner, the actions drawer of a picked shelf,
// checkout or department, the staff drawer, the board summary, the
// keyboard / gamepad action list (the old focusable board mirror), toasts,
// the countdown, the pause menu (with the "while you were away" note), the
// results (score breakdown, tiebreak, best, local rank, the leaderboard
// line, achievements, Retry / Next / Mode select), How to play (the six rule
// cards and the effective controls) and Settings (theme, camera, colour
// vision, left-handed, haptics, Replay tutorials, and the runtime's Options
// and key bindings for the rest).
// The old media queries are layouts picked by the window's logical size:
// wide (≥ 1024 px: drawers under the HUD), compact (< 1024 px: drawers at
// the bottom), portrait phones (≤ 700 px wide: the objective on its own
// line, the stats wrapping, the HUD buttons in a bar at the bottom) and
// short landscape (≤ 500 px tall: tighter stats without their labels).
import { frame, openMenu } from "starhermit:engine";
import { bindings, pointer, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Rules, type Command, type Config, type State } from "./game.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, applySettingsPatch, closeOverlay, copyInvite, doUndo, explain, hideContextPanel, hudRects, issueCommand, leaderboardLine, mirror,
  onBack, onModeChosen, onNext, onPlay, onReplayTutorials, onResultsModes, onRetry, onStageChosen, startShift, openOverlay, pauseGame, pickProxy,
  quitRound, resumeGame, showHint, signIn, stageItems, toggleStaff, tutorialText, view, type Mode,
} from "./main.ts";

// ------------------------------------------------------------------ content strings (src/ui.js)
/** Stable reason codes → short explanations. */
export const REASON_TEXT: Record<string, string> = {
  "display-full": N("That shelf is already full"),
  "queue-empty": N("No one is waiting there"),
  "not-enough-money": N("Not enough coins"),
  "department-locked": N("That department is still locked"),
  "max-level": N("Already fully upgraded"),
  "already-hired": N("Already on the team"),
  "already-unlocked": N("Already unlocked"),
  "no-moves-left": N("Out of moves"),
  "game-over": N("This shift has ended"),
  "not-allowed": N("Not allowed in this stage"),
  "no-such-display": N("No shelf there"),
  "no-such-checkout": N("No checkout there"),
  "no-such-role": N("No such role"),
  "no-such-target": N("Nothing to upgrade there"),
  "no-such-department": N("No such department"),
  "malformed-command": N("That action did not make sense"),
  "unknown-command": N("Unknown action"),
};
/** The reason's key (translated where drawn). */
export function humanizeReason(reason: string | undefined): string {
  return REASON_TEXT[reason ?? ""] || N("That will not work right now");
}
const MODES: { id: Mode; name: string; blurb: string; duration: string; standing: "casual" | "ranked"; standingText: string }[] = [
  { id: "learn", name: N("Learn"), blurb: N("Four short lessons that teach one rule at a time by doing."), duration: N("2–4 min each"), standing: "casual", standingText: N("Practice · not ranked") },
  { id: "journey", name: N("Journey"), blurb: N("Forty authored stages, from first shift to market legend."), duration: N("3–8 min each"), standing: "casual", standingText: N("Progress saved locally") },
  { id: "daily", name: N("Daily"), blurb: N("One shared market per UTC day. Same seed for everyone."), duration: N("~4 min"), standing: "ranked", standingText: N("Local board · personal best") },
  { id: "practice", name: N("Practice"), blurb: N("Pick a pace and play freely. Undo is allowed here."), duration: N("3–5 min"), standing: "casual", standingText: N("Not ranked · undo on") },
  { id: "challenge", name: N("Challenge"), blurb: N("Five constrained stages: move limits, speed, altered floors."), duration: N("2–6 min each"), standing: "casual", standingText: N("Progress saved locally") },
  { id: "score", name: N("Score chase"), blurb: N("Play any beaten stage for a higher score on the board."), duration: N("3–8 min"), standing: "ranked", standingText: N("Local board · personal best") },
];
const HELP_RULES = [
  { icon: "1", title: N("Restock shelves"), text: N("Guests buy from stocked shelves. Tap a shelf (or its button) to refill it from the stockroom. Refilling costs coins per item.") },
  { icon: "2", title: N("Serve the queue"), text: N("Guests with goods line up at a checkout. Tap the counter to serve the next guest before their patience runs out.") },
  { icon: "3", title: N("Unlock departments"), text: N("Greyed-out shelves belong to locked departments. Pay the unlock cost to open them and raise your goal progress.") },
  { icon: "4", title: N("Upgrade stations"), text: N("Upgraded shelves hold more and sell for more. Upgraded checkouts keep queued guests patient longer.") },
  { icon: "5", title: N("Hire staff"), text: N("A stocker refills the emptiest shelf every few ticks; a cashier serves the longest queue. Staff act on their own.") },
  { icon: "6", title: N("Win the shift"), text: N("Meet every goal — guests served, coins earned, departments unlocked — before the shift timer ends. Fewer angry guests means a better score.") },
];
/** Content names (content.js) are English data, translated at display time; Practice and Daily names are composed. */
export function stageName(name: string): string {
  const s = String(name || "");
  let m = /^Practice — (\w+)$/.exec(s);
  if (m) return T("Practice — {pace}", { pace: T(m[1]!) });
  m = /^Daily Market — (.+)$/.exec(s);
  if (m) return T("Daily Market — {date}", { date: m[1]! });
  return T(s);
}
const deptName = (name: string): string => T(name);
function fmtTime(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
const ticksToClock = (ticks: number): string => fmtTime((ticks * Rules.TICK_MS) / 1000);

// ------------------------------------------------------------------ layout
interface Layout {
  lw: number; lh: number; sc: number; wide: boolean; phone: boolean; short: boolean;
  /** The page between the header and footer (logical px from the safe area's top). */
  top: number; bottom: number;
}
const HEADER_H = 32;
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const footLines = textWidth(T("Market Manager — an original neighborhood market game. Plays offline."), "footer-text") > lw - 32 ? 2 : 1;
  return {
    lw, lh, sc, wide: lw >= 1024, phone: lw <= 700 && lh > lw, short: lh <= 500 && lw > lh,
    top: HEADER_H, bottom: 12 + 25.6 * (footLines === 1 ? 1 : 0.5) + footLines * 18.6,
  };
}
const lastSize = new Map<string, number>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
const fresh = (): boolean => frame().frame !== app.openedFrame;
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; reason?: string }
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 4;
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): boolean {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 40);
    const align = style === "btn-wide" ? "start" : "center";
    opts.content = () => { ui.style({ text: { align } }).paragraph(b.text, inner); };
  }
  let u = ui.style(style, s).id(b.id);
  if (b.reason) u = u.tooltip(b.reason);
  const hit = u.button(b.text, opts);
  if (hit && fresh()) { b.act(); return true; }
  return false;
}
/** index.html .stack: one full-width button a line. */
function stack(label: string, list: Btn[], width: number, gap = 8): void {
  ui.column(label, () => { for (const b of list) button(b, width); }, { spacing: gap, width });
}
/** index.html .row: buttons at their own widths in centred rows that wrap at `width`. */
function flow(label: string, list: Btn[], width: number, gap = 8, align: "center" | "start" = "center"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  for (const b of list) {
    const bw = Math.min(width, buttonWidth(b.text, b.style ?? "btn"));
    if (rows[rows.length - 1]!.length && used + gap + bw > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + bw;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, buttonWidth(b.text, b.style ?? "btn") > width ? width : null);
    }, { spacing: gap }));
  }, { spacing: gap, width, align });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, id?: string): void {
  if (textWidth(text, cls, "heading") <= width) (id ? ui.id(id) : ui).style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
function rect(r: { x: number; y: number; width: number; height: number }): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  const hc = ui.preferences().highContrast;
  if (app.screen === "game") gameScreen(L);
  else {
    // index.html body: the page colour (the market is not drawn on these screens).
    draw.box(0, 0, f.width, f.height, "page");
    if (app.screen === "pause") { draw.box(0, 0, f.width, f.height, "overlay"); }
    if (app.screen === "title") {
      const sa = f.safeArea;
      draw.box(0, sa.top + L.top * L.sc, f.width, f.height - sa.top - sa.bottom - (L.top + L.bottom) * L.sc, hc ? "page" : "title-bg");
    }
    switch (app.screen) {
      case "title": page("title", L, titleScreen, 560, "title-panel"); break;
      case "mode-select": page("modes", L, modeScreen, 712); break;
      case "stage-select": page("stages", L, stageScreen, 712); break;
      case "setup": page("setup", L, setupScreen); break;
      case "pause": page("pause", L, pauseScreen); break;
      case "results": page("results", L, resultsScreen, 712); break;
      case "help": page("help", L, helpScreen, 712); break;
      case "settings": page("settings", L, settingsScreen, 712); break;
    }
  }
  chrome(L);
  overlays(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
  if (mirror.want) { ui.setFocus(mirror.want); mirror.want = null; }
}

/** index.html header (the game's name) and footer (its line), over everything but the countdown and toasts. */
function chrome(L: Layout): void {
  const f = frame();
  const sa = f.safeArea;
  draw.box(0, 0, f.width, sa.top + HEADER_H * L.sc, "page");
  ui.place("header", { anchor: "top-start", x: 16, y: 6 }, () => ui.style("app-title").label("Market Manager"));
  rect({ x: 0, y: 0, width: f.width, height: sa.top + HEADER_H * L.sc });
  if (L.bottom > 0 && !(app.screen === "game" && L.phone)) {
    const h = L.bottom * L.sc + sa.bottom;
    draw.box(0, f.height - h, f.width, h, "page");
    rect({ x: 0, y: f.height - h, width: f.width, height: h });
    ui.place("footer", { anchor: "bottom", y: 6 + 12.8 * (L.bottom > 60 ? 0.5 : 1) }, () =>
      para(T("Market Manager — an original neighborhood market game. Plays offline."), L.lw - 32, "footer-text", "footer-text"));
  }
}

/** index.html .screen > .panel: centred in the page, at most `width` wide, scrolling inside when taller than the page. */
function page(key: string, L: Layout, build: (w: number, L: Layout) => void, width = 560, cls = "panel"): void {
  const pad = L.phone ? 18 : 24;
  const outer = Math.min(width, L.lw - 32);
  const avail = Math.max(80, L.lh - L.top - L.bottom - 32);
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const inner = outer - 2 * pad - 2 - (scroll ? 14 : 0);
  const opening = frame().frame - app.openedFrame <= 5;
  const y = L.top + 16 + (scroll ? 0 : Math.max(0, (avail - h) / 2));
  ui.place(`page-${key}`, { anchor: "top", y }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => build(inner, L), { style: cls, width: outer - (scroll ? 14 : 0), spacing: 12, padding: pad });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}

// ------------------------------------------------------------------ title and menus
function titleScreen(w: number): void {
  ui.column("title-head", () => {
    heading("h1", "Market Manager", w, "title-heading");
    para(T("Stock the shelves. Serve the rush. Grow the corner market."), w, "tagline", "tagline");
  }, { spacing: 4, width: w, align: "center" });
  // Daily chip: the date (the platform's clock signed in) and the time to the next market.
  const nowMs = platform.nowMs();
  const d = new Date(nowMs);
  const date = Content.dailyDateUtc(d);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const mins = Math.max(0, Math.round((next - nowMs) / 60000));
  const chip = `${T("Daily market:")} ${date} · ${T("new market in {h}h {m}m", { h: Math.floor(mins / 60), m: String(mins % 60).padStart(2, "0") })}`;
  ui.column("chips", () => {
    ui.column("daily-chip", () => para(chip, w - 26, "chip-text-center", "daily-chip-text"), { style: "chip" });
    const who = playerLine();
    if (who) ui.column("player-chip", () => para(who, w - 26, "chip-text-center", "player-chip-text"), { style: "chip" });
  }, { spacing: 8, width: w, align: "center" });
  const won = Object.values(app.progress.journey || {}).filter((r) => r.won).length;
  para(won
    ? T("Journey: {won} of 40 stages complete · {guests} guests served all time", { won, guests: app.progress.guestsServedTotal || 0 })
    : T("New around here? Start with Learn, or jump straight into Journey."), w, "muted-center", "journey-summary");
  ui.column("title-menu", () => {
    button({ id: "btn-play", text: T("Play"), style: "btn-big", act: onPlay }, w);
    button({ id: "btn-daily", text: T("Daily market"), act: () => onModeChosen("daily") }, w);
    button({ id: "btn-modes", text: T("All modes"), act: () => onModeChosen(null) }, w);
  }, { spacing: 8, width: w });
  flow("title-row", [
    { id: "btn-help-title", text: T("How to play"), style: "btn-ghost", act: () => openOverlay("help") },
    { id: "btn-settings-title", text: T("Settings"), style: "btn-ghost", act: () => openOverlay("settings") },
  ], w);
  const account: Btn[] = [];
  if (!platform.signedIn()) account.push({ id: "btn-signin", text: S("signIn"), style: "btn-ghost", act: signIn });
  if (platform.inviteLink()) account.push({ id: "btn-invite", text: S("invite"), style: "btn-ghost", act: copyInvite });
  if (account.length) flow("account-row", account, w);
}
const SYNC_TEXT: Record<string, string> = {
  synced: N("progress synced to your account"), saving: N("saving…"), offline: N("offline — will sync later"), error: N("sync problem — progress is safe on this device"),
};
function playerLine(): string | null {
  if (!platform.signedIn()) return null;
  const who = T("Playing as {name}", { name: platform.displayName() || T("Player") });
  const sync = SYNC_TEXT[platform.syncState()];
  return sync ? `${who} · ${T(sync)}` : who;
}

/** CSS grid auto-fit minmax(min, 1fr): the column count and width for `w`. */
function gridCols(w: number, min: number, gap: number): { cols: number; cw: number } {
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  return { cols, cw: (w - (cols - 1) * gap) / cols };
}
function modeScreen(w: number): void {
  heading("h2", T("Choose a mode"), w, "modes-heading");
  const { cols, cw } = gridCols(w, 220, 12);
  const inner = cw - 34;
  ui.grid("mode-cards", () => {
    for (const m of MODES) {
      const standing = platform.signedIn() && (m.id === "journey" || m.id === "challenge") ? T("Progress synced · posts to the platform leaderboard")
        : platform.signedIn() && (m.id === "daily" || m.id === "score") ? T("Personal best · posts to the platform leaderboard")
          : T(m.standingText);
      const hit = ui.style("mode-card", { width: cw }).id(`mode-${m.id}`).button(T(m.name), {
        content: () => {
          ui.column(`mode-${m.id}-c`, () => {
            para(T(m.name), inner, "card-h");
            para(T(m.blurb), inner, "card-p");
            para(T("About {duration}", { duration: T(m.duration) }), inner, "meta");
            para(`${m.standing === "ranked" ? "◆" : "◇"} ${standing}`, inner, "meta");
          }, { spacing: 4, width: inner });
        },
      });
      if (hit && fresh()) onModeChosen(m.id);
    }
  }, { columns: cols, gap: 12, align: "stretch", width: w });
  flow("modes-nav", [{ id: "btn-modes-back", text: T("Back"), style: "btn-ghost", act: onBack }], w, 8, "start");
}
const MODE_HEADINGS: Record<string, string> = {
  learn: N("Lessons"), journey: N("Journey stages"), daily: N("Daily market"), practice: N("Practice pace"), challenge: N("Challenges"), score: N("Score chase — pick a stage"),
};
function goalSummary(goals: Config["goals"] | undefined): string {
  const parts: string[] = [];
  if (goals?.serve) parts.push(T("serve {n}", { n: goals.serve }));
  if (goals?.earn) parts.push(T("earn {n}", { n: goals.earn }));
  if (goals?.unlock) parts.push(T("unlock {n}", { n: goals.unlock }));
  return parts.length ? T("Goals: {list}", { list: parts.join(", ") }) : T("Open play");
}
function stageScreen(w: number): void {
  const p = app.pending;
  if (!p) return;
  const items = stageItems(p.mode);
  heading("h2", T(MODE_HEADINGS[p.mode] || N("Stages")), w, "stage-heading");
  const { cols, cw } = gridCols(w, 180, 8);
  const inner = cw - 26;
  ui.grid("stage-list", () => {
    for (const it of items) {
      const lines = (): void => {
        ui.column(`stage-${it.id}-c`, () => {
          para(stageName(it.name), inner, "stage-name");
          para(it.blurb ? T(it.blurb) : goalSummary(it.goals), inner, "stage-sub");
          para(it.best ? T("Par {time} · best {best}", { time: ticksToClock(it.par?.ticks ?? 0), best: it.best }) : T("Par {time}", { time: ticksToClock(it.par?.ticks ?? 0) }), inner, "stage-sub");
          if (it.locked) para(T("Locked"), inner, "badge");
          else if (it.won) para(T("Cleared"), inner, "badge-won");
        }, { spacing: 2, width: inner });
      };
      let u = ui.style("stage-card", { width: cw }).id(`stage-${it.id}`);
      if (it.locked) u = u.tooltip(T("Finish earlier stages to unlock this one"));
      const hit = u.button(stageName(it.name), { disabled: it.locked, content: lines });
      if (hit && !it.locked && fresh()) onStageChosen(p.mode, it.id);
    }
  }, { columns: cols, gap: 8, align: "stretch", width: w });
  flow("stages-nav", [{ id: "btn-stages-back", text: T("Back"), style: "btn-ghost", act: onBack }], w, 8, "start");
}
function modeLabel(mode: Mode): string {
  const label = ({ learn: N("Lesson"), journey: N("Journey"), daily: N("Daily"), practice: N("Practice"), challenge: N("Challenge"), score: N("Score chase") } as Record<string, string>)[mode];
  return label ? T(label) : mode;
}
function goalLinesFromConfig(config: Config): string[] {
  const g = config.goals || {};
  const lines: string[] = [];
  if (g.serve) lines.push(T("Serve {n} guests", { n: g.serve }));
  if (g.earn) lines.push(T("Earn {n} coins in sales", { n: g.earn }));
  if (g.unlock) lines.push(T("Have {n} departments open", { n: g.unlock }));
  if (g.maxAngry !== undefined) lines.push(T("No more than {n} guests leave angry", { n: g.maxAngry }));
  return lines.length ? lines : [T("Play freely")];
}
function rulesSummary(config: Config): string {
  const ACTION_WORDS: Record<string, string> = { restock: N("restock"), serve: N("serve"), unlock: N("unlock"), upgrade: N("upgrade"), hire: N("hire"), undo: N("undo") };
  const off = Object.entries(config.allowed || {}).filter(([, v]) => !v).map(([k]) => (ACTION_WORDS[k] ? T(ACTION_WORDS[k]!) : k));
  const bits: string[] = [];
  if (config.moveLimit != null) bits.push(T("only {n} moves", { n: config.moveLimit }));
  if (off.length) bits.push(T("no {list}", { list: off.join(", ") }));
  if (config.initialStocked === false) bits.push(T("shelves start empty"));
  return bits.length ? T("Special rules: {list}", { list: bits.join(" · ") }) : T("Standard rules");
}
function setupScreen(w: number): void {
  const p = app.pending;
  if (!p || !p.config) return;
  const config = p.config;
  heading("h2", stageName(config.name), w, "setup-heading");
  para(`${goalSummary(config.goals)} · ${modeLabel(p.mode)}`, w, "lead", "setup-summary");
  if (config.blurb) para(T(config.blurb), w, "muted", "setup-blurb");
  ui.column("setup-goals", () => goalLinesFromConfig(config).forEach((t, i) => ui.row(`goal-${i}`, () => {
    ui.style("body").label("•");
    para(t, w - 40, "body");
  }, { spacing: 8, padding: { start: 10 } })), { spacing: 4, width: w });
  const facts: [string, string][] = [
    [T("Expected length"), T("Up to {time}", { time: ticksToClock(config.maxTicks) })],
    [T("Rules"), rulesSummary(config)],
    [T("Standing"), platform.signedIn()
      ? (p.mode === "learn" || p.mode === "practice" ? T("Casual — progress syncs to your account") : T("Ranked — your total posts to the platform leaderboard"))
      : T("Casual — result stays on this device")],
  ];
  // index.html .fact-list: the term (at least 9em) beside its value; stacked on narrow panels.
  const termW = Math.max(144, ...facts.map(([k]) => textWidth(k, "dt") + 12));
  const side = w - termW >= 200;
  ui.column("setup-facts", () => facts.forEach(([k, v], i) => {
    if (side) ui.row(`fact-${i}`, () => { ui.style("dt", { width: termW }).id(`fact-${i}-k`).label(k); para(v, w - termW, "dd", `fact-${i}-v`); }, { spacing: 0, align: "start" });
    else ui.column(`fact-${i}`, () => { para(k, w, "dt", `fact-${i}-k`); para(v, w, "dd", `fact-${i}-v`); }, { spacing: 2 });
  }), { spacing: 6, width: w });
  if (app.board) {
    para(T(app.board.label), w, "muted", "setup-board-label");
    ui.column("setup-board", () => app.board!.entries.slice(0, 10).forEach((e, i) => ui.row(`board-${i}`, () => {
      ui.style("board-rank").label(`#${e.rank != null ? e.rank : i + 1}`);
      ui.style("body").label(` ${e.name || T("Player")} — `);
      ui.style("strong").label(String(e.score != null ? e.score : 0));
    }, { spacing: 0, padding: { start: 22 } })), { spacing: 2, width: w });
  }
  flow("setup-btns", [
    { id: "btn-start", text: T("Start shift"), style: "btn-primary", act: startShift },
    { id: "btn-setup-back", text: T("Back"), style: "btn-ghost", act: onBack },
  ], w);
}

// ------------------------------------------------------------------ pause, results
function pauseScreen(w: number): void {
  heading("h2", T("Paused"), w, "pause-heading");
  const away = app.awayTicks;
  if (away != null) {
    para(T(away === 1
      ? "While you were away, {n} tick went by. The market waited — nothing was simulated."
      : "While you were away, {n} ticks went by. The market waited — nothing was simulated.", { n: away }), w, "muted", "pause-away-note");
  }
  stack("pause-menu", [
    { id: "btn-resume", text: T("Resume"), style: "btn-primary", act: resumeGame },
    { id: "btn-pause-help", text: T("How to play"), act: () => openOverlay("help") },
    { id: "btn-pause-settings", text: T("Settings"), act: () => openOverlay("settings") },
    { id: "btn-quit", text: T("End shift"), style: "btn-ghost", act: quitRound },
  ], w);
}
const TERMINAL_TEXT: Record<string, string> = {
  "goal-complete": N("Every goal met. The neighborhood noticed."),
  "shift-ended": N("The shift ended before all goals were met."),
  "out-of-moves": N("Out of moves — the market could not keep up."),
};
function resultsScreen(w: number): void {
  const r = app.results;
  if (!r) return;
  const st = r.session.state;
  const won = st.phase === "won";
  if (!ui.preferences().highContrast) ui.widget("", { role: "none", size: { width: w, height: Math.min(132, w * 448 / 1024) }, style: "banner-img" });
  heading("h2", won ? T("Shift complete") : T("Shift over"), w, "results-heading");
  const reason = TERMINAL_TEXT[st.terminalReason ?? ""];
  if (reason) para(T(reason), w, "lead", "results-reason");
  const c = r.score.components;
  const rows: [string, number][] = [
    [T("Guests served"), c.guests], [T("Sales revenue"), c.revenue], [T("Satisfaction"), c.satisfaction],
    [T("Departments"), c.departments], [T("Throughput"), c.throughput], [T("Coins in reserve"), c.reserves],
  ];
  ui.column("results-table", () => {
    rows.forEach(([k, v], i) => ui.row(`score-${i}`, () => {
      para(k, w - 100, "score-th");
      ui.spacer();
      ui.style("score-td").id(`score-${i}-v`).label(String(v));
    }, { width: w, style: "score-row", align: "center" }));
    ui.row("score-total", () => {
      ui.style("total-th").label(T("Total"));
      ui.spacer();
      ui.style("total-td").id("results-total").label(String(r.score.total));
    }, { width: w, style: "score-foot", align: "center" });
  }, { spacing: 0, width: w });
  const tb = r.score.tiebreak;
  para(T("Tiebreak: {goals} · {invalid} · {time} elapsed", {
    goals: tb.goalComplete ? T("goals met") : T("goals missed"),
    invalid: T(tb.invalidCount === 1 ? "{n} invalid action" : "{n} invalid actions", { n: tb.invalidCount }),
    time: ticksToClock(tb.ticksElapsed),
  }), w, "muted", "results-tiebreak");
  if (r.best != null || r.submitted) {
    const rankText = typeof r.rank === "number" && r.rank > 0 ? ` · ${T("rank #{rank}", { rank: r.rank })}` : "";
    const tag = r.submitted === "local" ? ` · ${T("saved to the local board")}${rankText}` : r.submitted === false ? ` · ${T("not recorded")}` : "";
    const text = (r.best != null ? T("Best on this stage: {best}", { best: r.best }) : T("Result recorded")) + tag;
    ui.column("results-best", () => para(text, w - 26, "chip-text", "results-best-text"), { style: "chip" });
  }
  const lb = leaderboardLine();
  if (lb) para(lb, w, "muted", "results-lb");
  r.newly.forEach((a, i) => ui.column(`ach-${i}`, () => {
    para(`${T("Achievement: {name}", { name: T(a.name) })} — ${T(a.desc)}`, w - 30, "body", `ach-${i}-t`);
  }, { style: "ach", width: w }));
  const btns: Btn[] = [{ id: "btn-retry", text: T("Retry"), style: "btn-primary", act: onRetry }];
  if (r.next) btns.push({ id: "btn-next", text: T("Next: {name}", { name: stageName(r.next.name) }), act: onNext });
  btns.push({ id: "btn-results-modes", text: T("Mode select"), style: "btn-ghost", act: onResultsModes });
  flow("results-btns", btns, w);
}

// ------------------------------------------------------------------ how to play, settings
const KEY_GLYPHS: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
/** An action's effective keys (main.js keyLabel over the player's bindings). */
function keysFor(action: string): string[] {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => KEY_GLYPHS[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)];
}
function controlMap(): { keys: string; action: string }[] {
  const j = (a: string[], sep: string): string => a.join(sep) || "—";
  return [
    { keys: N("Tap / click a shelf"), action: N("restock it (or open its actions)") },
    { keys: N("Tap / click a checkout"), action: N("serve the next guest") },
    { keys: j([...keysFor("prev"), ...keysFor("next")], " "), action: N("move focus between market actions") },
    { keys: N("Enter / Space"), action: N("confirm the focused action") },
    { keys: j(keysFor("hint"), " / "), action: N("hint") },
    { keys: j(keysFor("undo"), " / "), action: N("undo (Practice only)") },
    { keys: j(keysFor("camera"), " / "), action: N("reset camera") },
    { keys: j([...keysFor("pause"), ...keysFor("back")], " / "), action: N("pause / close panel") },
    { keys: N("Gamepad d-pad / left stick"), action: N("move focus") },
    { keys: N("Gamepad A"), action: N("confirm") },
    { keys: N("Gamepad B"), action: N("cancel / close") },
    { keys: N("Gamepad Start"), action: N("pause") },
    { keys: N("Gamepad Y"), action: N("hint") },
  ];
}
function helpScreen(w: number): void {
  heading("h2", T("How to play"), w, "help-heading");
  const { cols, cw } = gridCols(w, 220, 12);
  const inner = cw - 34;
  ui.grid("help-cards", () => {
    for (const r of HELP_RULES) {
      ui.column(`help-${r.icon}`, () => {
        ui.row(`help-${r.icon}-h`, () => {
          ui.column(`help-${r.icon}-i`, () => ui.style("icon-text").label(r.icon), { style: "help-icon", align: "center", justify: "center", width: 28, height: 28 });
          para(T(r.title), inner - 36, "card-h");
        }, { spacing: 8, align: "center" });
        para(T(r.text), inner, "card-p");
      }, { style: "card", spacing: 6, width: cw });
    }
    ui.column("help-controls", () => {
      para(T("Controls"), inner, "card-h");
      for (const [i, c] of controlMap().entries()) para(`• ${T(c.keys)} — ${T(c.action)}`, inner, "card-p", `control-${i}`);
    }, { style: "card", spacing: 4, width: cw });
  }, { columns: cols, gap: 12, align: "stretch", width: w });
  flow("help-nav", [{ id: "btn-help-close", text: T("Close"), style: "btn-ghost", act: closeOverlay }], w, 8, "start");
}
function settingsScreen(w: number): void {
  heading("h2", T("Settings"), w, "settings-heading");
  const s = app.settings;
  const inner = w - 34;
  const select = (id: string, label: string, options: [string, string][], cur: string): void => {
    const idx = Math.max(0, options.findIndex(([v]) => v === cur));
    const sw = Math.min(240, inner * 0.55);
    ui.row(`${id}-row`, () => {
      para(label, inner - sw - 12, "body");
      ui.spacer();
      const next = ui.style({ width: sw }).id(id).select(label, idx, options.map(([, l]) => l));
      if (next !== idx) applySettingsPatch({ [id === "set-theme" ? "theme" : id === "set-camera" ? "camera" : "colorblind"]: options[next]![0] || null });
    }, { width: inner, align: "center" });
  };
  ui.column("fs-display", () => {
    para(T("Display"), inner, "card-h");
    select("set-theme", T("Theme"), [["", T("Stage default")], ...Content.THEMES.map((t) => [t.id, T(t.name)] as [string, string])], s.theme || "");
    select("set-camera", T("Camera"), [["isometric", T("Isometric")], ["high", T("High")], ["low", T("Low")]], s.camera || "isometric");
    select("set-colorblind", T("Color vision"), [["none", T("Standard")], ["deuteranopia", T("Deuteranopia-safe")], ["protanopia", T("Protanopia-safe")], ["tritanopia", T("Tritanopia-safe")]], s.colorblind || "none");
  }, { style: "fieldset", spacing: 10, width: w });
  ui.column("fs-access", () => {
    para(T("Accessibility and controls"), inner, "card-h");
    const check = (id: string, key: "leftHanded" | "haptics", label: string): void => {
      const cur = !!s[key];
      const next = ui.id(id).style({ width: inner }).checkbox(label, cur);
      if (next !== cur && fresh()) applySettingsPatch({ [key]: next });
    };
    check("set-left-handed", "leftHanded", T("Left-handed layout"));
    check("set-haptics", "haptics", T("Haptics"));
    para(T("Sound, graphics, language, larger text, high contrast and reduced motion are in the StarHermit Options."), inner, "muted", "options-note");
    flow("options-btns", [
      { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
      { id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() },
    ], inner, 8, "start");
  }, { style: "fieldset", spacing: 10, width: w });
  flow("settings-btns", [
    { id: "btn-replay-tutorials", text: T("Replay tutorials"), act: onReplayTutorials },
    { id: "btn-settings-close", text: T("Close"), style: "btn-ghost", act: closeOverlay },
  ], w);
}

// ------------------------------------------------------------------ the HUD (index.html .hud-top)
function goalParts(state: State): string {
  const g = state.config.goals;
  const parts: string[] = [];
  if (g.serve) parts.push(T("serve {cur}/{max}", { cur: Math.min(state.stats.served, g.serve), max: g.serve }));
  if (g.earn) parts.push(T("earn {cur}/{max}", { cur: Math.min(state.stats.revenue, g.earn), max: g.earn }));
  if (g.unlock) { const have = state.departments.filter((d) => d.unlocked).length; parts.push(T("unlock {cur}/{max}", { cur: Math.min(have, g.unlock), max: g.unlock })); }
  if (g.maxAngry !== undefined) parts.push(T("angry {cur}/{max} max", { cur: state.stats.angry, max: g.maxAngry }));
  return parts.length ? T("Goals — {list}", { list: parts.join(" · ") }) : T("Free play");
}
type Icon = "undo" | "hint" | "staff" | "pause";
/** The old inline SVG icons, drawn: undo arrow, light bulb, two people, pause bars. */
function drawIcon(kind: Icon, r: ui.Rect, color: string): void {
  const s = r.width / 24;
  const X = (v: number): number => r.x + v * s, Y = (v: number): number => r.y + v * s;
  if (kind === "pause") {
    draw.roundRect(X(6), Y(4), 4 * s, 16 * s, s, color);
    draw.roundRect(X(14), Y(4), 4 * s, 16 * s, s, color);
  } else if (kind === "hint") {
    draw.circle(X(12), Y(9), 6 * s, color);
    draw.rect(X(9), Y(12), 6 * s, 4 * s, color);
    draw.roundRect(X(9), Y(17), 6 * s, 3.5 * s, 1.5 * s, color);
  } else if (kind === "staff") {
    draw.circle(X(9), Y(8), 3.2 * s, color);
    draw.polygon(arc(X(9), Y(19), 5.5 * s), color);
    draw.circle(X(17), Y(9), 2.4 * s, color);
    draw.polygon(arc(X(18.2), Y(19), 3.8 * s), color);
  } else {
    // ↶: a curved shaft and the arrow head
    const pts: [number, number][] = [];
    for (let i = 0; i <= 12; i++) { const a = -PI2 / 4 + (i / 12) * PI2 / 2; pts.push([X(14 + Math.cos(a) * 5), Y(15 + Math.sin(a) * 5)]); }
    for (let i = 1; i < pts.length; i++) draw.line(pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1], color, 2 * s);
    draw.line(X(14), Y(20), X(8), Y(20), color, 2 * s);
    draw.line(X(14), Y(10), X(7), Y(10), color, 2 * s);
    draw.polygon([[X(3), Y(10)], [X(9), Y(5)], [X(9), Y(15)]], color);
  }
}
const PI2 = Math.PI * 2;
/** The upper half-disc under a figure's head (its shoulders). */
function arc(cx: number, cy: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= 12; i++) { const a = Math.PI + (i / 12) * Math.PI; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return out;
}
function iconButton(id: string, label: string, kind: Icon, act: () => void, disabled = false): void {
  const hit = ui.style("btn-icon").id(id).tooltip(label).button(label, {
    disabled,
    content: () => ui.widget("", { role: "none", size: { width: 20, height: 20 }, draw: (r, ws) => drawIcon(kind, r, ws.highContrast ? ws.colors.text : disabled ? "#3d2b1f80" : "#3d2b1f") }),
  });
  if (hit && fresh()) { ui.setFocus(null); act(); }
}
function hudButtons(): void {
  const r = app.round!;
  if (r.session.allowUndo) iconButton("btn-undo", T("Undo last action"), "undo", doUndo, !r.session.canUndo());
  iconButton("btn-hint", T("Show a hint"), "hint", showHint);
  iconButton("btn-staff-toggle", T("Toggle staff panel"), "staff", toggleStaff);
  iconButton("btn-pause", T("Pause game"), "pause", () => pauseGame(true));
}
function stat(id: string, label: string, value: string, L: Layout): void {
  ui.column(id, () => {
    if (!L.short) ui.style("stat-label").label(label);
    ui.style("stat-value").id(`${id}-v`).label(value);
  }, { style: L.short ? "stat-tight" : "stat", spacing: 0 });
}
function statWidth(label: string, value: string, L: Layout): number {
  return Math.max(L.short ? 0 : textWidth(label, "stat-label"), textWidth(value, "stat-value")) + (L.short ? 16 : 24) + 2;
}

function gameScreen(L: Layout): void {
  const r = app.round;
  if (!r) return;
  const f = frame();
  const sa = f.safeArea;
  const st = r.session.state;
  const cfg = r.config;
  const live = app.active && !app.paused;
  const padX = L.wide ? 24 : 12;
  const stats: [string, string, string][] = [
    ["hud-money", T("Coins"), String(st.money)],
    ["hud-time", T("Time"), ticksToClock(Math.max(0, cfg.maxTicks - st.tick))],
    ["hud-served", T("Guests"), T("{served} served · {angry} angry", { served: st.stats.served, angry: st.stats.angry })],
    ["hud-score", T("Score"), String(app.active || st.tick > 0 ? r.session.score().total : 0)],
  ];
  const objective = goalParts(st);
  const moves = cfg.moveLimit != null ? T("Moves left: {n}", { n: Math.max(0, cfg.moveLimit - st.commandCount) }) : null;
  const top = L.top + (L.short ? 4 : 8);
  let hudBottom = top;
  const objectiveBox = (maxW: number): void => {
    ui.column("hud-objective", () => {
      ui.column("objective-box", () => para(objective, maxW - 26, "objective-text", "hud-objective"), { style: "objective" });
      if (moves) ui.column("moves-chip", () => ui.style("chip-text").id("hud-moves").label(moves), { style: "chip" });
    }, { spacing: 6 });
  };
  const nButtons = r.session.allowUndo ? 4 : 3;
  if (L.phone) {
    // index.html @media (max-width: 700px) and (portrait): the objective on its own line, stats wrapping, buttons in a bottom bar.
    const w = L.lw - 2 * padX;
    const ro = ui.place("hud-top", { anchor: "top-start", x: padX, y: top }, () => {
      ui.column("hud-col", () => {
        objectiveBox(w);
        const rows: [string, string, string][][] = [[]];
        let used = 0;
        for (const s of stats) {
          const sw = statWidth(s[1], s[2], L);
          if (rows[rows.length - 1]!.length && used + 8 + sw > w) { rows.push([]); used = 0; }
          used += (rows[rows.length - 1]!.length ? 8 : 0) + sw;
          rows[rows.length - 1]!.push(s);
        }
        rows.forEach((row, i) => ui.row(`stats-${i}`, () => { for (const s of row) stat(s[0], s[1], s[2], L); }, { spacing: 8 }));
      }, { spacing: 8, width: w });
    });
    hudBottom = ro.y / L.sc + ro.height / L.sc - sa.top / L.sc;
    rect(ro);
    // The bottom bar (index.html .hud-actions fixed at the bottom).
    const barH = 60;
    const barPx = barH * L.sc + sa.bottom;
    draw.box(0, f.height - barPx, f.width, barPx, "action-bar");
    rect({ x: 0, y: f.height - barPx, width: f.width, height: barPx });
    if (live) ui.place("hud-actions", { anchor: "bottom", y: 8 }, () => ui.row("hud-actions-row", hudButtons, { spacing: 8 }));
    view.bottom = barPx;
  } else {
    const objMax = Math.max(160, L.lw - 2 * padX - stats.reduce((n, s) => n + statWidth(s[1], s[2], L) + 8, 0) - nButtons * 52 - 24);
    const ro = ui.place("hud-objective-p", { anchor: "top-start", x: padX, y: top }, () => objectiveBox(objMax));
    const rs = ui.place("hud-right", { anchor: "top-end", x: padX, y: top }, () => ui.row("hud-right-row", () => {
      ui.row("hud-stats", () => { for (const s of stats) stat(s[0], s[1], s[2], L); }, { spacing: 8, align: "start" });
      if (live) ui.row("hud-actions", hudButtons, { spacing: 8, align: "start" });
    }, { spacing: 12, align: "start" }));
    rect(ro); rect(rs);
    hudBottom = (Math.max(ro.y + ro.height, rs.y + rs.height) - sa.top) / L.sc;
    view.bottom = L.bottom * L.sc + sa.bottom;
  }
  hudBottom += L.short ? 4 : 8;
  // The HUD band's wash (index.html .hud-top background), under the HUD.
  draw.box(0, sa.top + L.top * L.sc, f.width, (hudBottom - L.top) * L.sc, "hud-band");
  // Tutorial banner directly under the HUD.
  const tut = tutorialText();
  if (tut) {
    const bw = Math.min(600, L.lw - 24);
    const tb = ui.place("tutorial-banner", { anchor: "top", y: hudBottom + 4 }, () =>
      ui.column("tutorial-col", () => para(T(tut), bw - 34, "banner-text", "tutorial-text"), { style: "tutorial-banner", align: "center" }));
    rect(tb);
    hudBottom = (tb.y + tb.height - sa.top) / L.sc;
  }
  view.top = sa.top + hudBottom * L.sc;
  if (!live) return;
  marketTargets(st);
  // The drawers over the board summary (index.html: .drawer z-index 15 over #board-mirror).
  boardMirror(L);
  drawers(L, hudBottom);
}

/** The market's shelves, checkouts and covered departments named for screen readers and play scripts. */
function marketTargets(st: State): void {
  for (const t of render.targetRects()) {
    let label = "";
    if (t.kind === "display") {
      const d = st.displays.find((x) => x.id === t.id);
      const dept = d && st.departments.find((x) => x.id === d.deptId);
      label = T("{dept} — shelf {n}", { dept: dept ? deptName(dept.name) : T("Shelf"), n: t.id.slice(1) });
    } else if (t.kind === "checkout") label = T("Checkout {n}", { n: t.id.slice(1) });
    else { const dept = st.departments.find((x) => x.id === t.id); label = dept ? deptName(dept.name) : ""; }
    if (label && t.width > 2 && t.height > 2) ui.id(`target-${t.kind}-${t.id}`).target(label, { x: t.x, y: t.y, width: t.width, height: t.height });
  }
}
/** index.html .drawer: the actions of the picked shelf / checkout / department (end side) and the staff (start side). */
function drawers(L: Layout, hudBottom: number): void {
  const r = app.round!;
  const st = r.session.state;
  const w = Math.min(320, L.lw - 24);
  const inner = w - 34;
  const left = app.settings.leftHanded;
  const maxH = Math.max(120, L.lh - L.top - L.bottom - (L.short ? 80 : 140));
  const anchorTop = L.wide || L.short;
  const y = L.wide ? Math.max(hudBottom + 8, L.top + 110) : L.short ? L.top + 56 : 0;
  const yBottom = (L.phone ? 72 : 12) + (L.phone ? 0 : L.bottom);
  const panel = (key: string, side: "start" | "end", build: () => void): void => {
    const h = lastSize.get(key) ?? 0;
    const scroll = h > maxH;
    const anchor = anchorTop ? (side === "start" ? "top-start" : "top-end") : (side === "start" ? "bottom-start" : "bottom-end");
    const rr = ui.place(key, { anchor, x: 12, y: anchorTop ? y : yBottom }, () => {
      ui.column(`${key}-box`, () => {
        const body = (): void => {
          const c = ui.column(`${key}-in`, build, { spacing: 6, width: inner - (scroll ? 14 : 0) });
          lastSize.set(key, c.height / L.sc + 34);
        };
        if (scroll) ui.scrollArea(`${key}-scroll`, { width: inner, height: maxH - 34 }, body);
        else body();
      }, { style: "drawer", width: w, spacing: 0 });
    });
    rect(rr);
  };
  const cmdButton = (id: string, label: string, cmd: Command): void => {
    const v = explain(cmd);
    button({ id, text: label, act: () => issueCommand(cmd), disabled: !v.ok, reason: v.ok ? undefined : T(humanizeReason(v.reason)) }, inner);
  };
  if (app.staffOpen) {
    panel("staff-panel", left ? "end" : "start", () => {
      heading("drawer-h", T("Staff"), inner, "staff-h");
      const roles = [
        { role: "stocker" as const, name: N("Stocker"), does: N("Refills the emptiest shelf every few ticks."), hire: N("Hire stocker (cost {n})") },
        { role: "cashier" as const, name: N("Cashier"), does: N("Serves the longest queue every few ticks."), hire: N("Hire cashier (cost {n})") },
      ];
      for (const ro of roles) {
        const s = st.staff[ro.role];
        para(`${T(ro.name)} — ${s.hired ? T("on shift") : T("hire for {n}", { n: s.cost })}`, inner, "detail-strong", `staff-${ro.role}`);
        para(T(ro.does), inner, "hint-text", `staff-${ro.role}-does`);
        if (!s.hired) cmdButton(`hire-${ro.role}`, T(ro.hire, { n: s.cost }), { type: "hire", role: ro.role });
      }
    });
  }
  const pick = app.pick;
  if (pick) {
    let ok = true;
    panel("context-panel", left ? "start" : "end", () => {
      if (pick.kind === "display") {
        const d = st.displays.find((x) => x.id === pick.id);
        if (!d) { ok = false; return; }
        const dept = st.departments.find((x) => x.id === d.deptId);
        heading("drawer-h", T("{dept} — shelf {n}", { dept: dept ? deptName(dept.name) : T("Shelf"), n: d.id.slice(1) }), inner, "context-h");
        para(T("Stock {stock}/{cap} · sells for {price} · level {level}", { stock: d.stock, cap: d.capacity, price: d.price, level: d.level }), inner, "detail", "context-detail");
        cmdButton("ctx-restock", T("Restock (cost {n})", { n: Rules.restockCost(d) }), { type: "restock", displayId: d.id });
        cmdButton("ctx-upgrade", d.level >= 3 ? T("Upgrade (max level)") : T("Upgrade (cost {n})", { n: Rules.upgradeCost(st, "display", d) }), { type: "upgrade", targetKind: "display", targetId: d.id });
      } else if (pick.kind === "checkout") {
        const c = st.checkouts.find((x) => x.id === pick.id);
        if (!c) { ok = false; return; }
        heading("drawer-h", T("Checkout {n}", { n: c.id.slice(1) }), inner, "context-h");
        para(T("{n} waiting · level {level}", { n: c.queue.length, level: c.level }), inner, "detail", "context-detail");
        cmdButton("ctx-serve", T("Serve next guest ({n} waiting)", { n: c.queue.length }), { type: "serve", checkoutId: c.id });
        cmdButton("ctx-upgrade", c.level >= 3 ? T("Upgrade (max level)") : T("Upgrade (cost {n})", { n: Rules.upgradeCost(st, "checkout", c) }), { type: "upgrade", targetKind: "checkout", targetId: c.id });
      } else if (pick.kind === "department") {
        const dept = st.departments.find((x) => x.id === pick.id);
        if (!dept) { ok = false; return; }
        heading("drawer-h", deptName(dept.name), inner, "context-h");
        para(dept.unlocked ? T("Open for business") : T("Locked — shelves are greyed out"), inner, "detail", "context-detail");
        if (!dept.unlocked) cmdButton("ctx-unlock", T("Unlock (cost {n})", { n: dept.unlockCost }), { type: "unlock", deptId: dept.id });
      }
      button({ id: "ctx-close", text: T("Close"), style: "btn-ghost", act: () => { hideContextPanel(); pickProxy(null); } }, null);
    });
    if (!ok) hideContextPanel();
  }
}

interface MirrorEntry { key: string; cmd: Command; pick: { kind: string; id: string }; label: string }
/** ui.js updateBoardMirror: every market action as a button, in the old order. */
function mirrorEntries(state: State): MirrorEntry[] {
  const out: MirrorEntry[] = [];
  const dn = (id: string): string => { const d = state.departments.find((x) => x.id === id); return d ? deptName(d.name) : ""; };
  for (const d of state.displays) out.push({ key: `restock-${d.id}`, cmd: { type: "restock", displayId: d.id }, pick: { kind: "display", id: d.id },
    label: T("Restock {dept} shelf {n} — {stock}/{cap} stocked, cost {cost}", { dept: dn(d.deptId), n: d.id.slice(1), stock: d.stock, cap: d.capacity, cost: Rules.restockCost(d) }) });
  for (const c of state.checkouts) out.push({ key: `serve-${c.id}`, cmd: { type: "serve", checkoutId: c.id }, pick: { kind: "checkout", id: c.id },
    label: T("Serve checkout {n} — {waiting} waiting", { n: c.id.slice(1), waiting: c.queue.length }) });
  // Upgrades are core actions: keyboard-only players reach them here.
  for (const d of state.displays) out.push({ key: `upgrade-${d.id}`, cmd: { type: "upgrade", targetKind: "display", targetId: d.id }, pick: { kind: "display", id: d.id },
    label: d.level >= 3 ? T("Upgrade {dept} shelf {n} — level {level} (max)", { dept: dn(d.deptId), n: d.id.slice(1), level: d.level })
      : T("Upgrade {dept} shelf {n} — level {level}, cost {cost}", { dept: dn(d.deptId), n: d.id.slice(1), level: d.level, cost: Rules.upgradeCost(state, "display", d) }) });
  for (const c of state.checkouts) out.push({ key: `upgrade-${c.id}`, cmd: { type: "upgrade", targetKind: "checkout", targetId: c.id }, pick: { kind: "checkout", id: c.id },
    label: c.level >= 3 ? T("Upgrade checkout {n} — level {level} (max)", { n: c.id.slice(1), level: c.level })
      : T("Upgrade checkout {n} — level {level}, cost {cost}", { n: c.id.slice(1), level: c.level, cost: Rules.upgradeCost(state, "checkout", c) }) });
  for (const dept of state.departments) {
    if (dept.unlocked) continue;
    out.push({ key: `unlock-${dept.id}`, cmd: { type: "unlock", deptId: dept.id }, pick: { kind: "department", id: dept.id },
      label: T("Unlock {dept} — cost {cost}", { dept: deptName(dept.name), cost: dept.unlockCost }) });
  }
  return out;
}
/** index.html #board-mirror (the summary line) and #mirror-list (the action list, shown while it has focus). */
function boardMirror(L: Layout): void {
  const r = app.round!;
  const st = r.session.state;
  const w = Math.min(420, L.lw - 24);
  const bottom = (L.phone ? 72 : 12) + (L.phone ? 0 : L.bottom);
  const entries = mirrorEntries(st);
  mirror.ids = entries.map((e) => `mirror-${e.key}`);
  mirror.labels = entries.map((e) => e.label);
  mirror.enabled = entries.map((e) => explain(e.cmd).ok);
  const focused = ui.focused();
  const fi = focused ? mirror.labels.indexOf(focused) : -1;
  if (fi >= 0) { mirror.focus = fi; app.mirrorOpen = true; pickProxy(entries[fi]!.pick); }
  else if (app.mirrorOpen && !mirror.want && fresh() && frame().frame - mirrorOpenedAt > 2) { app.mirrorOpen = false; pickProxy(null); }
  if (app.mirrorOpen) {
    if (mirrorWasClosed) { mirrorOpenedAt = frame().frame; mirrorWasClosed = false; }
    const maxH = Math.max(120, (L.lh - L.top - L.bottom) * 0.6);
    const key = "mirror-list";
    // Always one scroll area (its height follows the content up to the limit): a layout that changed
    // between frames would lose the focus the list opened with.
    const h = lastSize.get(key) ?? maxH;
    const inner = w - 26;
    const rr = ui.place(key, { anchor: "bottom-start", x: 12, y: bottom }, () => ui.column(`${key}-box`, () => {
      ui.scrollArea(`${key}-scroll`, { width: inner, height: Math.min(h, maxH - 26) }, () => {
        const c = ui.column(`${key}-in`, () => {
          for (const [i, e] of entries.entries()) {
            const v = explain(e.cmd);
            button({ id: mirror.ids[i]!, text: e.label, style: "btn-wide", act: () => issueCommand(e.cmd), disabled: !v.ok, reason: v.ok ? undefined : T(humanizeReason(v.reason)) }, inner - 14);
          }
        }, { spacing: 8, width: inner - 14 });
        lastSize.set(key, c.height / L.sc);
      });
    }, { style: "mirror-list", width: w, spacing: 0 }));
    rect(rr);
    return;
  }
  mirrorWasClosed = true;
  const open = st.departments.filter((d) => d.unlocked).length;
  const queued = st.checkouts.reduce((n, c) => n + c.queue.length, 0);
  const text = T("Tick {tick}/{max} · {money} coins · {open}/{depts} departments open · {queued} in line · {served} served, {angry} angry", {
    tick: st.tick, max: r.config.maxTicks, money: st.money, open, depts: st.departments.length, queued, served: st.stats.served, angry: st.stats.angry,
  });
  const rr = ui.place("board-mirror", { anchor: "bottom-start", x: 12, y: bottom }, () =>
    ui.column("board-mirror-box", () => para(text, w - 26, "mirror-text", "board-mirror-text"), { style: "mirror" }));
  rect(rr);
  // The summary covers the market only on narrow windows (render.js counted it when it spanned over half the width).
  if (rr.width > frame().width * 0.5) view.bottom = Math.max(view.bottom, frame().height - rr.y);
}
let mirrorOpenedAt = 0;
let mirrorWasClosed = true;

/** The countdown and the toasts over the HUD (index.html #countdown, #toasts). */
function overlays(L: Layout): void {
  if (app.countdown) {
    const size = Math.min(144, Math.max(64, L.lw * 0.18));
    ui.place("countdown", "center", () => ui.style("countdown", { text: { size } }).id("countdown-text").label(T(app.countdown![0])));
  }
  if (app.toasts.length) {
    const w = Math.min(L.lw * 0.8, 520);
    const bottom = (L.phone && app.screen === "game" ? 72 : 12) + (L.phone && app.screen === "game" ? 0 : L.bottom);
    ui.place("toasts", { anchor: "bottom", y: bottom }, () => ui.column("toasts-col", () => {
      app.toasts.forEach((t, i) => {
        const mark = t.kind === "good" ? "✓ " : t.kind === "bad" ? "✕ " : "ⓘ ";
        ui.column(`toast-${i}`, () => para(mark + T(t.msg[0], t.msg[1]), w - 36, t.kind === "info" ? "toast-text" : "toast-text-light", `toast-${i}-t`),
          { style: t.kind === "good" ? "toast-good" : t.kind === "bad" ? "toast-bad" : "toast", align: "center" });
      });
    }, { spacing: 8, align: "center" }));
  }
}

/** Whether the pointer is over the HUD (the wheel then scrolls the UI, not the market). */
export function pointerOnHud(): boolean {
  const p = pointer();
  return !!p && hudRects.some((r) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height);
}
