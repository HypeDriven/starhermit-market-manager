// Market Manager on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js), content
// (src/content.js), sessions with undo, replay envelopes, progress and
// achievements (src/session.js) and the save document (src/store.js) are the
// browser build's, unchanged in what they decide; this module is what
// src/main.js did around them — the screen state machine (title → mode
// select → stage select → setup → countdown → active ⇄ paused → results),
// picks from the market (tap a shelf to restock it, a checkout to serve,
// a covered department to unlock, else the actions drawer), the keyboard
// and gamepad action list, tutorials with highlighted targets, hints, undo
// (Practice), results with achievements, local boards and posting ranked
// runs to the high-score board, the theme / camera / colour-vision /
// left-handed / haptics settings, and the lifecycle (a hidden window pauses
// the shift with a "while you were away" note, as visibilitychange did).
// Screens and the HUD are drawn by screens.ts (starhermit:ui), the market by
// render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps: the market ticks every 30 fixed steps
// (500 ms at 60 Hz) while a shift is active, so pauses, a hidden window and
// slow frames never cost time and play scripts replay exactly.
import "./i18n.ts";
import { frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate, clipboard } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, onWheel, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import {
  Content, Rules, Sess, Store, type Achievement, type Action, type Command, type Config, type GameEvent, type LocalEntry, type Progress,
  type Score, type Session, type Settings,
} from "./game.ts";
import * as audio from "./audio.ts";
import { N, S, T, type Msg } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens, humanizeReason, pointerOnHud } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Screen = "title" | "mode-select" | "stage-select" | "setup" | "game" | "pause" | "results" | "help" | "settings";
export type Mode = "learn" | "journey" | "daily" | "practice" | "challenge" | "score";
export interface StageItem { id: string; name: string; blurb: string | null; goals: Config["goals"]; par?: { ticks: number }; won: boolean; best: number | null; locked: boolean }
export interface Pending { mode: Mode; id?: string; config?: Config; fromStageSelect?: boolean; items?: StageItem[] }
export interface Results {
  session: Session; config: Config; score: Score; newly: Achievement[]; best: number | null;
  next: { name: string; mode: Mode; id: string } | null; submitted: "local" | false | null; rank: number | null;
  lb: platform.Posted | "posting" | null;
}
export interface Toast { msg: Msg; kind: "good" | "bad" | "info"; until: number }

export const app = {
  screen: "title" as Screen,
  /** Frame the screen opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  /** Where How to play and Settings go back to. */
  overlayReturn: null as Screen | null,
  settings: null as unknown as Settings,
  progress: null as unknown as Progress,
  pending: null as Pending | null,
  round: null as { mode: Mode; id: string; config: Config; session: Session } | null,
  active: false,
  paused: false,
  awayTicks: null as number | null,
  countdown: null as Msg | null,
  tutorial: null as { steps: NonNullable<Config["tutorial"]>["steps"]; index: number } | null,
  results: null as Results | null,
  /** The setup screen's leaderboard preview: entries and their label. */
  board: null as { entries: LocalEntry[]; label: string } | null,
  /** The selection the actions drawer shows (render.js pick). */
  pick: null as render.Pick | null,
  staffOpen: false,
  /** The keyboard / gamepad action list (the old focusable board mirror) is open. */
  mirrorOpen: false,
  toasts: [] as Toast[],
};
const now = (): number => frame().time;

// ------------------------------------------------------------------ helpers
/** ui.js announce(). */
export function announce(msg: Msg, assertive = false): void {
  const politeness = assertive ? "assertive" as const : "polite" as const;
  ui.announce(T(msg[0], msg[1]).slice(0, 500), { politeness });
}
/** ui.js toast(): a pill at the bottom for 3.2 s, also announced. */
export function toast(msg: Msg, kind: Toast["kind"] = "info"): void {
  app.toasts.push({ msg, kind, until: now() + 3.2 });
  if (app.toasts.length > 4) app.toasts.shift();
  announce(msg, kind === "bad");
}
/** Timers on the game clock (the old setTimeout calls). */
const timers: { at: number; fn: () => void; tag?: string }[] = [];
function after(seconds: number, fn: () => void, tag?: string): void { timers.push({ at: now() + seconds, fn, tag }); }
function cancel(tag: string): void { for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.tag === tag) timers.splice(i, 1); }
/** Haptics (main.js buzz, navigator.vibrate) when the setting is on; the runtime skips it where the device cannot. */
function buzz(ms: number): void { if (app.settings.haptics) { try { vibrate(ms); } catch { /* best effort */ } } }

export function show(screen: Screen, focus: string | null = null): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  app.mirrorOpen = false;
  ui.setFocus(null);
  render.setActive(screen === "game");
}
export const playing = (): boolean => !!app.round && app.active && !app.paused;

// ------------------------------------------------------------------ navigation (main.js)
function goTitle(): void { show("title", "btn-play"); }

export function onPlay(): void {
  // Returning players resume their last mode/stage in one action.
  const last = Sess.loadKey("lastPlayed.v1") as { mode?: Mode; id?: string } | null;
  if (last && last.mode && last.id) {
    try { prepareStage(last.mode, last.id, false); startRound(); return; } catch { /* stale: mode select */ }
  }
  onModeChosen(null);
}
export function onModeChosen(mode: Mode | null): void {
  if (mode == null) { app.pending = null; show("mode-select", "mode-learn"); return; }
  if (mode === "daily") { prepareStage("daily", Content.dailyDateUtc(new Date(platform.nowMs())), false); return; }
  showStageSelectFor(mode);
}
function showStageSelectFor(mode: Mode): void {
  app.pending = { mode, items: stageItems(mode) };
  const first = app.pending.items!.find((it) => !it.locked);
  show("stage-select", first ? `stage-${first.id}` : "btn-stages-back");
}
export function stageItems(mode: Mode): StageItem[] {
  const p = app.progress;
  if (mode === "learn") {
    const tuts = Content.tutorialStages();
    return tuts.map((t, i) => ({
      id: t.id, name: t.name, blurb: t.tutorial!.steps[0]!.text, goals: t.goals, par: t.par, won: p.tutorialsDone.includes(t.id), best: null,
      locked: i > 0 && !p.tutorialsDone.includes(tuts[i - 1]!.id),
    }));
  }
  if (mode === "practice") {
    return ["relaxed", "standard", "intense"].map((d) => {
      const c = Content.practiceConfig(d);
      return { id: d, name: c.name, blurb: null, goals: c.goals, par: c.par, won: false, best: null, locked: false };
    });
  }
  if (mode === "challenge") {
    return Content.challengeStages().map((c, i, all) => {
      const rec = p.challenges[c.id];
      return { id: c.id, name: c.name, blurb: c.blurb ?? null, goals: c.goals, par: c.par, won: !!rec?.won, best: rec?.best || null, locked: i > 0 && !p.challenges[all[i - 1]!.id]?.won };
    });
  }
  // journey + score chase share the journey catalog
  const stages = Content.journeyStages();
  return stages.map((s, i) => {
    const rec = p.journey[s.id];
    const unlocked = i === 0 || !!p.journey[stages[i - 1]!.id]?.won;
    return {
      id: s.id, name: s.name, blurb: s.mastery ? N("Mastery stage") : null, goals: s.goals, par: s.par, won: !!rec?.won, best: rec?.best || null,
      locked: mode === "score" ? !rec?.won : !unlocked,
    };
  });
}
export function onStageChosen(mode: Mode, id: string): void { prepareStage(mode, id, true); }
function buildConfig(mode: Mode, id: string): Config | undefined {
  if (mode === "learn") return Content.tutorialStages().find((t) => t.id === id);
  if (mode === "journey" || mode === "score") return Content.journeyStages().find((s) => s.id === id);
  if (mode === "challenge") return Content.challengeStages().find((c) => c.id === id);
  if (mode === "practice") return Content.practiceConfig(id);
  if (mode === "daily") return Content.dailyConfig(id);
  throw new Error(`unknown mode ${String(mode)}`);
}
function prepareStage(mode: Mode, id: string, fromStageSelect: boolean): void {
  const config = buildConfig(mode, id);
  if (!config) throw new Error(`unknown stage ${id}`);
  app.pending = { mode, id, config, fromStageSelect, items: app.pending?.items };
  app.board = null;
  show("setup", "btn-start");
  if (mode === "daily" || mode === "score") {
    // Leaderboard preview: the platform board signed in, local records otherwise.
    const board = config.dailyDate ? "daily" : "global";
    const local = (): LocalEntry[] => Store.localEntries(Sess.loadKey("localBoards.v1"), board, config.dailyDate || null);
    const showBoard = (entries: LocalEntry[], label: string): void => {
      if (app.pending && app.pending.config === config && app.screen === "setup") app.board = entries.length ? { entries, label } : null;
    };
    if (platform.signedIn()) {
      void platform.topScores(50).then((rows) => {
        if (rows) showBoard(rows, N("Platform leaderboard"));
        else showBoard(local(), N("Top shifts"));
      });
    } else showBoard(local(), N("Top shifts"));
  }
}
export function startShift(): void { startRound(); }
export function onBack(): void {
  audio.uiClick();
  if (app.screen === "setup") {
    if (app.pending?.fromStageSelect && app.pending.items) show("stage-select", app.pending.id ? `stage-${app.pending.id}` : null);
    else if (app.pending?.mode === "daily") goTitle();
    else onModeChosen(null);
  } else if (app.screen === "stage-select") onModeChosen(null);
  else goTitle();
}

// ------------------------------------------------------------------ rounds
function startRound(): void {
  if (!app.pending || !app.pending.config) return;
  const { mode, id, config } = app.pending;
  Sess.saveKey("lastPlayed.v1", { mode, id });
  const session = Sess.createSession({ config, mode, allowUndo: mode === "practice" });
  app.round = { mode, id: id!, config, session };
  app.active = false;
  app.paused = false;
  app.results = null;
  app.pick = null;
  app.staffOpen = false;
  lastCmdKey = "";
  tickSteps = 0;
  cancel("countdown");
  cancel("hint");
  session.on("terminal", ({ score }) => finishRound(score));
  render.buildMarket(session.state, config, Content.themeById(app.settings.theme || config.theme));
  render.setPaused(false);
  app.tutorial = config.tutorial ? { steps: config.tutorial.steps, index: 0 } : null;
  show("game");
  showTutorialStep();
  runCountdown(session);
}
function runCountdown(session: Session): void {
  const go = (): void => {
    app.countdown = null;
    if (!app.round || app.round.session !== session) return;
    app.active = true;
    audio.startMusic(musicIntensity());
  };
  if (preferences().reducedMotion) { go(); return; }
  const beats = ["3", "2", "1"];
  beats.forEach((n, i) => after(i * 0.65, () => {
    app.countdown = [n];
    audio.play("countdown");
    announce([n], true);
  }, "countdown"));
  after(3 * 0.65, () => { app.countdown = [N("Go")]; announce([N("Go")], true); }, "countdown");
  after(3 * 0.65 + 0.4, go, "countdown");
}
export function quitRound(): void {
  cancel("countdown");
  app.countdown = null;
  app.active = false;
  app.paused = false;
  app.tutorial = null;
  app.round = null; // ending early counts as an abandoned attempt, not a result
  app.pick = null;
  render.setHighlight(null);
  render.clear();
  audio.stopMusic();
  audio.setPaused(false);
  goTitle();
}

let tickSteps = 0;
let loopErrors = 0;
function tick(): void {
  if (!app.round) return;
  try {
    const events = app.round.session.stepTick();
    afterTick(events);
  } catch (e) {
    console.error(`tick error: ${String(e)}`);
    if (++loopErrors >= 5 && app.active) { toast([N("Something went wrong repeatedly — the shift was paused")], "bad"); pauseGame(true); }
  }
}
function afterTick(events: GameEvent[]): void {
  if (!app.round) return;
  render.syncState(app.round.session.state, events);
  audio.mapEvents(events);
  if (app.active) audio.startMusic(musicIntensity());
  for (const ev of events) {
    if (ev.kind === "served") toast([N("Guest served +{n}"), { n: ev.amount ?? 0 }], "good");
    else if (ev.kind === "left-angry") toast([N("A guest left angry")], "bad");
    else if (ev.kind === "left-empty") toast([N("A guest found empty shelves")], "info");
  }
}
function musicIntensity(): number {
  if (!app.round) return 0;
  const { session, config } = app.round;
  const queued = session.state.checkouts.reduce((n, c) => n + c.queue.length, 0);
  const timePressure = 1 - Math.max(0, config.maxTicks - session.state.tick) / config.maxTicks;
  return Math.min(1, queued / 6 + timePressure * 0.4);
}

// ------------------------------------------------------------------ commands
let lastCmdKey = "";
/** main.js issueCommand: the player's command into the session (deduplicated per tick). */
export function issueCommand(cmd: Command): void {
  if (!app.round || !playing() || app.round.session.isOver) return;
  const session = app.round.session;
  const key = `${session.state.tick}:${JSON.stringify(cmd)}`;
  if (key === lastCmdKey) return;
  lastCmdKey = key;
  const res = session.issue(cmd);
  if (!res.ok) {
    toast([humanizeReason(res.reason)], "bad");
    audio.play("error");
    buzz(60);
    return;
  }
  audio.uiClick();
  buzz(10);
  audio.mapEvents(res.events);
  if (app.round) render.syncState(session.state, res.events);
  clearHint();
  tutorialCheck(cmd);
}
/** Cached verdicts for this state (the buttons ask every frame). */
let verdictState: unknown = null;
const verdicts = new Map<string, { ok: boolean; reason?: string }>();
export function explain(cmd: Command): { ok: boolean; reason?: string } {
  if (!app.round) return { ok: false, reason: "game-over" };
  const st = app.round.session.state;
  if (st !== verdictState) { verdictState = st; verdicts.clear(); }
  const k = JSON.stringify(cmd);
  let v = verdicts.get(k);
  if (!v) { v = app.round.session.explain(cmd); verdicts.set(k, v); }
  return v;
}

/** main.js onPick: a tap on the market. */
function onPick(pick: render.Pick | null): void {
  if (!app.round || !playing()) return;
  if (!pick || pick.kind === "floor") { hideContextPanel(); return; }
  const config = app.round.config;
  if (pick.kind === "display") {
    const cmd = { type: "restock", displayId: pick.id };
    if (config.allowed.restock && explain(cmd).ok) issueCommand(cmd);
    else app.pick = pick;
  } else if (pick.kind === "checkout") {
    const cmd = { type: "serve", checkoutId: pick.id };
    if (explain(cmd).ok) issueCommand(cmd);
    else app.pick = pick;
  } else if (pick.kind === "department") {
    const dept = app.round.session.state.departments.find((d) => d.id === pick.id);
    const cmd = { type: "unlock", deptId: pick.id };
    if (dept && !dept.unlocked && explain(cmd).ok) issueCommand(cmd);
    else app.pick = pick;
  }
}
export function hideContextPanel(): void {
  app.pick = null;
  if (!app.tutorial && !hintActive) render.setHighlight(null);
}
/** The action list's focus also drives the 3D highlight (main.js onPickProxy). */
let proxyKey = "";
export function pickProxy(pick: { kind: string; id?: string } | null): void {
  const k = pick ? `${pick.kind}:${pick.id}` : "";
  if (k === proxyKey) return;
  proxyKey = k;
  render.setHighlight(pick ? [{ kind: pick.kind, id: pick.id }] : null);
}

// ------------------------------------------------------------------ pause
export function pauseGame(manual: boolean): void {
  if (!app.round || !app.active || app.paused) return;
  app.paused = true;
  if (manual) app.awayTicks = null;
  audio.setPaused(true);
  render.setPaused(true);
  show("pause", "btn-resume");
  render.setActive(false);
}
export function resumeGame(): void {
  if (!app.round || !app.paused) return;
  app.paused = false;
  app.awayTicks = null;
  audio.setPaused(false);
  render.setPaused(false);
  show("game");
}
// --------------------------------------------------------------- undo
export function doUndo(): void {
  if (!app.round || !app.round.session.canUndo() || app.paused) return;
  if (app.round.session.undo()) {
    render.syncState(app.round.session.state, []);
    toast([N("Undone")], "info");
    audio.uiClick();
  }
}
// --------------------------------------------------------------- hint
let hintActive = false;
export function showHint(): void {
  if (!app.round || !playing()) return;
  const legal = app.round.session.legalActions();
  if (!legal.length) { announce([N("No actions available right now")]); return; }
  const order = ["serve", "restock", "unlock", "hire", "upgrade"];
  const pick = order.flatMap((t) => legal.filter((a) => a.type === t))[0]!;
  const target = hintTarget(pick);
  if (target) { render.setHighlight([target]); hintActive = true; proxyKey = ""; }
  const msg = hintText(pick);
  announce(msg, true);
  toast(msg, "info");
  cancel("hint");
  after(3, clearHint, "hint");
}
function hintTarget(action: Action | Command): render.Target | null {
  if (action.type === "restock") return { kind: "display", id: action.displayId };
  if (action.type === "serve") return { kind: "checkout", id: action.checkoutId };
  if (action.type === "unlock") return { kind: "department", id: action.deptId };
  if (action.type === "upgrade") return { kind: action.targetKind!, id: action.targetId };
  return null; // hire: the staff panel, nothing on the market
}
function hintText(action: Action): Msg {
  if (action.type === "serve") return [N("Serve checkout {n} — guests are waiting"), { n: action.checkoutId!.slice(1) }];
  if (action.type === "restock") return [N("Restock shelf {n}"), { n: action.displayId!.slice(1) }];
  if (action.type === "unlock") return [N("You can afford to unlock a department")];
  if (action.type === "hire") return [action.role === "cashier" ? N("Hire a cashier from the staff panel") : N("Hire a stocker from the staff panel")];
  return [action.targetKind === "checkout" ? N("Upgrade a checkout") : N("Upgrade a shelf")];
}
function clearHint(): void {
  cancel("hint");
  if (!hintActive) return;
  hintActive = false;
  proxyKey = "";
  if (app.tutorial) showTutorialStep();
  else render.setHighlight(null);
}
// --------------------------------------------------------------- tutorial
function showTutorialStep(): void {
  if (!app.tutorial || !app.round) return;
  const step = app.tutorial.steps[app.tutorial.index];
  if (!step) return;
  if (step.require) {
    const targets = app.round.session.legalActions().filter((a) => matchesRequire(a, step.require)).map(hintTarget).filter((t): t is render.Target => !!t);
    render.setHighlight(targets.length ? targets : null);
  }
}
/** The lesson text on the banner (null without a lesson or after its last step). */
export function tutorialText(): string | null {
  const step = app.tutorial?.steps[app.tutorial.index];
  return step ? step.text : null;
}
function matchesRequire(action: Command, require?: { type: string; role?: string; targetKind?: string }): boolean {
  if (!require) return true;
  if (action.type !== require.type) return false;
  if (require.role && action.role !== require.role) return false;
  if (require.targetKind && action.targetKind !== require.targetKind) return false;
  return true;
}
function tutorialCheck(cmd: Command): void {
  if (!app.tutorial || !app.round) return;
  const step = app.tutorial.steps[app.tutorial.index];
  if (step && step.require && matchesRequire(cmd, step.require)) {
    app.tutorial.index++;
    proxyKey = "";
    if (app.tutorial.steps[app.tutorial.index]) showTutorialStep();
    else render.setHighlight(null);
  }
}
function finishTutorialIfNeeded(): void {
  const r = app.round;
  if (!r || r.mode !== "learn" || r.session.state.phase !== "won") return;
  if (!app.settings.tutorialsDone.includes(r.id)) { app.settings.tutorialsDone.push(r.id); Sess.saveSettings(app.settings); }
  if (!app.progress.tutorialsDone.includes(r.id)) app.progress.tutorialsDone.push(r.id);
}

// ------------------------------------------------------------------ terminal
function finishRound(score: Score): void {
  const r = app.round;
  if (!r) return;
  const { session, config, mode, id } = r;
  app.active = false;
  audio.stopMusic();
  finishTutorialIfNeeded();
  const newly = Sess.recordResult(app.progress, session).filter(Boolean);
  Sess.saveProgress(app.progress);
  // Badge flourish lands after the win/lose sting so the two never overlap.
  if (newly.length) after(0.7, () => audio.play("achievement"));
  let submitted: Results["submitted"] = null;
  let rank: number | null = null;
  if (mode === "daily" || mode === "score") {
    // The run records to the local board (personal best).
    const env = session.replayEnvelope();
    const rec = Store.recordLocal(Sess.loadKey("localBoards.v1"), {
      name: platform.displayName() || "You", score: env.result.total, date: new Date(platform.nowMs()).toISOString().slice(0, 10),
      durationMs: env.durationMs, sessionId: env.sessionId, dailyDate: config.dailyDate,
    });
    Sess.saveKey("localBoards.v1", rec.boards);
    submitted = "local";
    rank = rec.rank;
  }
  const best = mode === "journey" || mode === "score" ? app.progress.journey[id]?.best ?? null
    : mode === "challenge" ? app.progress.challenges[id]?.best ?? null
      : config.dailyDate ? app.progress.daily[config.dailyDate]?.score ?? null : null;
  const results: Results = { session, config, score, newly, best, next: nextAction(mode, id, session.state.phase === "won"), submitted, rank, lb: null };
  app.results = results;
  buzz(session.state.phase === "won" ? 140 : 120);
  platform.flush();
  // Ranked modes (not Learn / Practice) signed in: post the total to the platform board.
  if (platform.signedIn() && mode !== "learn" && mode !== "practice") {
    results.lb = "posting";
    void platform.postLeaderboard(score.total).then((p) => { results.lb = p; });
  }
  // The session ends inside a tick or command: leave the frame's work first.
  queueMicrotask(() => {
    app.pick = null;
    app.tutorial = null;
    app.staffOpen = false;
    render.setHighlight(null);
    show("results", "btn-retry");
    announce([session.state.phase === "won" ? N("Shift complete") : N("Shift over")], true);
  });
}
function nextAction(mode: Mode, id: string, won: boolean): Results["next"] {
  if (mode === "journey" && won) {
    const stages = Content.journeyStages();
    const i = stages.findIndex((s) => s.id === id);
    if (i >= 0 && i + 1 < stages.length) return { name: stages[i + 1]!.name, mode: "journey", id: stages[i + 1]!.id };
  }
  if (mode === "learn" && won) {
    const tuts = Content.tutorialStages();
    const i = tuts.findIndex((t) => t.id === id);
    if (i >= 0 && i + 1 < tuts.length) return { name: tuts[i + 1]!.name, mode: "learn", id: tuts[i + 1]!.id };
  }
  return null;
}
export function leaderboardLine(): string | null {
  const r = app.results?.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}
export function onRetry(): void {
  if (!app.round) return;
  const { mode, id } = app.round;
  app.pending = { ...(app.pending ?? { mode }), mode, id, config: buildConfig(mode, id) };
  startRound();
}
export function onNext(): void {
  const next = app.results?.next;
  if (!next) return;
  prepareStage(next.mode, next.id, false);
  startRound();
}
export function onResultsModes(): void {
  app.round = null;
  render.clear();
  onModeChosen(null);
}

// ------------------------------------------------------------------ overlays, settings
export function openOverlay(name: "help" | "settings"): void {
  if (app.screen !== "help" && app.screen !== "settings") app.overlayReturn = app.screen;
  show(name, name === "help" ? "btn-help-close" : "set-theme");
}
export function closeOverlay(): void {
  audio.uiClick();
  const dest = app.overlayReturn || "title";
  app.overlayReturn = null;
  restoreScreen(dest);
}
function restoreScreen(dest: Screen): void {
  if (dest === "pause") show("pause", "btn-resume");
  else if (dest === "game") show("game");
  else if (dest === "mode-select") show("mode-select", "mode-learn");
  else if (dest === "stage-select" && app.pending?.items) show("stage-select");
  else if (dest === "setup" && app.pending?.config) show("setup", "btn-start");
  else if (dest === "results" && app.results) show("results", "btn-retry");
  else goTitle();
}
/** A settings change (the game's own: theme, camera, colour vision, left-handed, haptics). */
export function applySettingsPatch(patch: Partial<Settings>): void {
  Object.assign(app.settings, patch);
  Sess.saveSettings(app.settings);
  applySettings();
}
function applySettings(): void {
  render.setColorblind(app.settings.colorblind || "none");
  render.setCamera(app.settings.camera || "isometric");
  if (app.round) render.setTheme(Content.themeById(app.settings.theme || app.round.config.theme));
}
export function onReplayTutorials(): void {
  app.settings.tutorialsDone = [];
  Sess.saveSettings(app.settings);
  app.progress.tutorialsDone = [];
  Sess.saveProgress(app.progress);
  toast([N("Tutorial progress reset")], "info");
  app.overlayReturn = null;
  showStageSelectFor("learn");
}
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast([S("copied")], "good"); } catch { toast([S("copyFailed")], "bad"); }
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function resetCamera(): void { render.resetCamera(); }
export function toggleStaff(): void { app.staffOpen = !app.staffOpen; }

// ------------------------------------------------------------------ keyboard and gamepad (main.js keydown / pollGamepad)
/** The action list's entries in order (screens.ts fills it each frame), and the one to focus. */
export const mirror = { ids: [] as string[], labels: [] as string[], enabled: [] as boolean[], focus: -1, want: null as string | null };
/** main.js moveMirrorFocus: the next or previous enabled action (disabled ones take no focus, as before). */
function moveMirrorFocus(dir: number): void {
  const n = mirror.ids.length;
  if (!n || !mirror.enabled.some(Boolean)) return;
  app.mirrorOpen = true;
  const focused = ui.focused();
  let i = focused ? mirror.labels.indexOf(focused) : -1;
  if (i < 0) i = mirror.focus;
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n;
    if (mirror.enabled[i]) break;
  }
  mirror.focus = i;
  mirror.want = mirror.ids[i]!;
}
onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame !== app.openedFrame;
  if (ui.capturingKeys()) return;
  const act = e.action;
  if (act === "back") {
    if (!fresh) return;
    if (app.screen === "help" || app.screen === "settings") closeOverlay();
    else if (app.screen === "game" && app.mirrorOpen) { app.mirrorOpen = false; ui.setFocus(null); pickProxy(null); }
    else if (app.screen === "game" && app.pick) hideContextPanel();
    else if (app.screen === "game" && playing()) pauseGame(true);
    else if (app.screen === "pause") resumeGame();
    return;
  }
  if (app.screen === "game" && playing()) {
    if (act === "pause") pauseGame(true);
    else if (act === "hint") showHint();
    else if (act === "undo") doUndo();
    else if (act === "camera") resetCamera();
    else if (act === "prev" || act === "next") moveMirrorFocus(act === "prev" ? -1 : 1);
  } else if (app.screen === "pause" && act === "pause" && fresh) resumeGame();
});

// ------------------------------------------------------------------ pointer and touch on the market
/** Rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: { x: number; y: number; width: number; height: number }[] = [];
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
type PEvent = { kind: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number };
const events: PEvent[] = [];
let lastTouch = -1e9;
let touchId: number | null = null;
onTouch((e) => {
  lastTouch = now();
  if (e.control) return;
  const kind = e.phase === "start" ? "down" : e.phase === "move" ? "move" : e.phase === "end" ? "up" : "cancel";
  events.push({ kind, x: e.x, y: e.y, id: e.id });
});
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  events.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, id: -1 });
});
onPointerMove((x, y) => { if (now() - lastTouch >= 0.6) events.push({ kind: "move", x, y, id: -1 }); });
onWheel((_dx, dy) => { if (app.screen === "game" && !pointerOnHud()) render.wheel(dy); });
/** render.js pointer handlers: decided once the frame's UI is built (presses on the HUD and drawers are theirs). */
function pointerInput(): void {
  const t = now();
  for (const ev of events.splice(0)) {
    if (app.screen !== "game") { render.pointerCancel(); touchId = null; continue; }
    if (ev.kind === "down") {
      if (render.dragActive() || onHud(ev.x, ev.y)) continue;
      touchId = ev.id;
      render.pointerDown(ev.x, ev.y, t);
      continue;
    }
    if (ev.kind === "move") {
      if (render.dragActive() && ev.id === touchId) render.pointerMove(ev.x, ev.y, t, ev.id === -1);
      else if (ev.id === -1 && !onHud(ev.x, ev.y)) render.pointerMove(ev.x, ev.y, t, true);
      else if (ev.id === -1) render.pointerLeave();
      continue;
    }
    if (ev.id !== touchId) continue;
    touchId = null;
    if (ev.kind === "cancel") { render.pointerCancel(); continue; }
    const pick = render.pointerUp(ev.x, ev.y, t);
    if (pick !== undefined) { ui.setFocus(null); app.mirrorOpen = false; onPick(pick); }
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  app.settings = Sess.loadSettings();
  app.progress = Sess.loadProgress();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applySettings();
  goTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
onSessionEnded(() => toast([S("signedOut")], "info")); // keep playing locally
// A merge from another device or the old build rewrote the document: pick up progress and settings.
platform.onMerged(() => {
  app.progress = Sess.loadProgress();
  app.settings = Sess.loadSettings();
  applySettings();
});
let hiddenAt: number | null = null;
onSuspend(() => {
  if (playing()) { hiddenAt = Date.now(); pauseGame(false); }
  platform.flush();
});
onResume(() => {
  if (hiddenAt != null) {
    app.awayTicks = Math.floor((Date.now() - hiddenAt) / Rules.TICK_MS);
    hiddenAt = null;
  }
});

onFixedUpdate(() => {
  if (!playing()) return;
  if (++tickSteps >= Math.round(Rules.TICK_MS / (1000 / 60))) { tickSteps = 0; tick(); }
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast, app.settings?.colorblind || "none");
  audio.update();
  const t = now();
  for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.at <= t) { const fn = timers[i]!.fn; timers.splice(i, 1); fn(); }
  app.toasts = app.toasts.filter((x) => x.until > t);
  platform.flushDirty();
});
/** The HUD bands over the market (window pixels), set by screens.ts each frame: the room is framed between them. */
export const view = { top: 0, bottom: 0 };
onRender(() => {
  hudRects.length = 0;
  drawScreens();
  pointerInput();
  const f = frame();
  render.update(frameDt, f.width, f.height, view.top, view.bottom, f.scale);
});
