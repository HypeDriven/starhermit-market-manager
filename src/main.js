// Market Manager — bootstrap and glue. Owns the game loop, screen state
// machine, input routing (pointer picks, keyboard, gamepad), tutorials,
// hints, settings application, and platform submission.
// Import-safe in Node: all DOM work happens inside boot(), which only runs
// when a document exists. render.js is imported lazily on first Play so the
// title screen paints fast and this module loads even before render.js ships.

import {
  createSession, loadSettings, saveSettings, loadProgress, saveProgress,
  recordResult, saveKey, loadKey, TICK_MS,
} from './session.js';
import {
  journeyStages, tutorialStages, challengeStages, practiceConfig,
  dailyConfig, dailyDateUtc, themeById, THEMES,
} from './content.js';
import { createUI, humanizeReason } from './ui.js';
import { createAudio } from './audio.js';
import { createPlatform } from './platform.js';
import {
  detectLevel, presetForLevel, resolve as resolveGraphics, describe as describeGraphics, legacyPreset, gpuName,
} from './gfx.js';
import { createGraphicsPanel } from './gfx-panel.js';
import { shStrings } from './sh-strings.js';
import { T, N, initLanguage, onLanguage, getLang } from './i18n.js';

// Keyboard actions → default KeyboardEvent.code values; mirrors the control.*
// lines in starhermit.txt. The player's StarHermit bindings replace them.
const DEFAULT_BINDINGS = {
  back: ['Escape'], pause: ['KeyP'], hint: ['KeyH'], undo: ['KeyU'], camera: ['KeyR'],
  prev: ['ArrowUp', 'ArrowLeft', 'KeyW', 'KeyA'], next: ['ArrowDown', 'ArrowRight', 'KeyS', 'KeyD'],
};
function keyLabel(code) {
  const named = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };
  if (named[code]) return named[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code || '—';
}

// Help "Controls" card; keyboard rows show the effective bindings.
const controlMap = (b) => [
  { keys: N('Tap / click a shelf'), action: N('restock it (or open its actions)') },
  { keys: N('Tap / click a checkout'), action: N('serve the next guest') },
  { keys: [...b.prev, ...b.next].map(keyLabel).join(' '), action: N('move focus between market actions') },
  { keys: N('Enter / Space'), action: N('confirm the focused action') },
  { keys: b.hint.map(keyLabel).join(' / '), action: N('hint') },
  { keys: b.undo.map(keyLabel).join(' / '), action: N('undo (Practice only)') },
  { keys: b.camera.map(keyLabel).join(' / '), action: N('reset camera') },
  { keys: [...b.pause, ...b.back].map(keyLabel).join(' / '), action: N('pause / close panel') },
  { keys: N('Gamepad d-pad / left stick'), action: N('move focus') },
  { keys: N('Gamepad A'), action: N('confirm') },
  { keys: N('Gamepad B'), action: N('cancel / close') },
  { keys: N('Gamepad Start'), action: N('pause') },
  { keys: N('Gamepad Y'), action: N('hint') },
];
const shT = () => shStrings([getLang()]);

const REPEAT_DELAY_MS = 220;
const GAMEPAD_DEADZONE = 0.25;
const MAX_CATCHUP_STEPS = 4;
const MAX_LOOP_ERRORS = 5;

function boot() {
  // The game language follows Settings › Language (sh-language.js).
  initLanguage();
  // ------------------------------------------------------------ services
  const settings = loadSettings();
  let progress = loadProgress();
  const audio = createAudio(settings);
  const platform = createPlatform();
  let bindings = DEFAULT_BINDINGS;
  let codeToAction = new Map();
  const setBindings = (b) => {
    bindings = b;
    codeToAction = new Map();
    for (const [action, codes] of Object.entries(b)) for (const c of codes) codeToAction.set(c, action);
  };
  setBindings(DEFAULT_BINDINGS);
  // Local copy + per-player StarHermit settings KV (changed keys only).
  const persistSettings = () => { saveSettings(settings); platform.pushSettings(settings); };

  let renderer = null;
  let rendererPromise = null;
  let gpu = '';
  let webgl = detectWebGL();
  // Graphics: Auto picks a preset from the StarHermit hardware level (SwiftShader = level 0 → Low;
  // phones and tablets cap at Balanced).
  const mobile = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const gpuApi = globalThis.StarHermitGpu;
  const gpuSystem = gpuApi ? gpuApi.detectSystem() : {};
  const gpuLevel = detectLevel(gpu, { ...gpuSystem, webgl, mobile: !!gpuSystem.mobile || mobile });
  const detectedPreset = presetForLevel(gpuLevel);
  if (!settings.graphics || typeof settings.graphics !== 'object') {
    settings.graphics = { preset: legacyPreset(settings.quality) };
  }

  // ---------------------------------------------------------- round state
  // appScreen: title | mode-select | stage-select | setup | game | pause |
  //            results | help | settings | compat
  let appScreen = 'boot';
  let overlayReturn = null;        // screen to restore after help/settings
  let pending = null;              // { mode, id, config, fromStageSelect, stageArgs }
  let round = null;                // { mode, id, config, session }
  let active = false;
  let paused = false;
  let hiddenAt = null;
  let awayTicks = null;
  let countdownToken = 0;
  let lastCmdKey = '';
  let hintTimer = null;
  let tutorial = null;             // { steps, index }
  let loopErrors = 0;
  let lastResults = null;

  // ------------------------------------------------------------------ UI
  const ui = createUI({ callbacks: {
    onPlay, onModeChosen, onStageChosen, onStart, onBack,
    onCommand: issueCommand, onPickProxy, onPause: () => pauseGame(true),
    onResume: resumeGame, onQuit: quitRound, onRetry, onNext,
    onUndo: doUndo, onHint: showHint,
    onHelp: () => openOverlay('help'),
    onOpenSettings: () => openOverlay('settings'),
    onCloseOverlay: closeOverlay,
    onSettings: applySettingsPatch,
    onReplayTutorials,
    onCompatContinue,
    explain: (cmd) => (round ? round.session.explain(cmd) : { ok: false, reason: 'game-over' }),
  } });

  ui.wireSettings(THEMES);
  ui.applySettingsClasses(settings);

  const gfxPanel = createGraphicsPanel(document.getElementById('gfx-section'), {
    locale: getLang(),
    getSaved: () => settings.graphics,
    onChange: applyGraphics,
    getInfo: graphicsInfo,
  });
  applyGraphics(settings.graphics);

  platform.onError = (info) => {
    if (info.kind === 'rate-limited') ui.toast(N('Server is busy — will retry in a moment'), 'info');
  };
  platform.onIdentity = ({ nickname }) => {
    ui.setPlayerInfo({ nickname, status: platform.syncStatus, hosted: platform.hosted });
  };
  // A cloud-save conflict merge rewrote the local cache: pick up the merged progress.
  platform.onMerged = () => {
    progress = loadProgress();
    if (appScreen === 'title') ui.showTitle(progress);
  };
  platform.onSync = (status) => {
    ui.setPlayerInfo({ nickname: platform.nickname, status, hosted: platform.hosted });
  };
  // Sign-in (platform host, no token) / invite (signed in); hidden locally.
  const refreshAccount = () => ui.setAccountButtons({ signIn: platform.canSignIn(), invite: platform.hosted });
  ui.wireAccount({
    labels: { signIn: shT().signIn, invite: shT().invite },
    onSignIn: () => platform.signIn(),
    onInvite: async () => {
      const link = platform.inviteLink();
      if (!link) return;
      try { await navigator.clipboard.writeText(link); ui.toast(shT().copied, 'good'); }
      catch { ui.toast(shT().copyFailed, 'bad'); }
    },
  });
  refreshAccount();
  platform.onAuth((a) => {
    refreshAccount();
    ui.setPlayerInfo({ nickname: platform.nickname, status: platform.syncStatus, hosted: platform.hosted });
    if (!a.signedIn) ui.toast(shT().signedOut, 'info'); // keep playing locally
  });

  // First gesture unlocks WebAudio.
  const unlockAudio = () => {
    audio.unlock();
    if (round && active && !paused) audio.startMusic(musicIntensity());
  };
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  // Daily chip on the title screen.
  function refreshDailyInfo() {
    const now = new Date(platform.serverNow());
    const date = dailyDateUtc(now);
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const mins = Math.max(0, Math.round((next - now.getTime()) / 60000));
    const countdownText = T('new market in {h}h {m}m', { h: Math.floor(mins / 60), m: String(mins % 60).padStart(2, '0') });
    ui.setDailyInfo({ date, countdownText });
  }
  refreshDailyInfo();
  setInterval(() => { if (appScreen === 'title') refreshDailyInfo(); }, 30000);

  // Start the platform session without blocking the title screen. A remote
  // cloud save wins over the local cache, so progress reloads when one lands.
  platform.init().then(async (info) => {
    if (info && info.remoteLoaded) progress = loadProgress();
    if (info && info.hosted) {
      ui.setPlayerInfo({ nickname: platform.nickname, status: platform.syncStatus, hosted: true });
      const [kv, b] = await Promise.all([platform.loadSettings(), platform.loadBindings(DEFAULT_BINDINGS)]);
      setBindings(b);
      // Settings KV wins over the local copy, key by key.
      const patch = {};
      for (const k of Object.keys(settings)) if (kv[k] !== undefined && kv[k] !== null) patch[k] = kv[k];
      if (Object.keys(patch).length) {
        applySettingsPatch(patch);
        if (patch.graphics) applyGraphics(settings.graphics);
        ui.applySettingsClasses(settings);
      }
      platform.primeSettings(settings);
    }
    if (appScreen === 'title') ui.showTitle(progress);
    refreshDailyInfo();
  }).catch(() => {});

  // ------------------------------------------------------------ boot done
  if (webgl) {
    goTitle();
  } else {
    appScreen = 'compat';
    ui.showScreen('compat');
  }

  // --------------------------------------------------------- navigation
  function goTitle() {
    appScreen = 'title';
    ui.showTitle(progress);
    refreshDailyInfo();
  }

  function onCompatContinue() {
    webgl = false;
    document.documentElement.classList.add('force-mirror');
    ui.toast(N('Playing without the 3D view — use the on-screen action buttons'), 'info');
    goTitle();
  }

  function onPlay() {
    // Returning players resume their last mode/stage in one action.
    const last = loadKey('lastPlayed.v1');
    if (last && last.mode && last.id) {
      try {
        prepareStage(last.mode, last.id, false);
        startRound();
        return;
      } catch { /* stale entry: fall through to mode select */ }
    }
    onModeChosen(null);
  }

  function onModeChosen(mode) {
    if (mode == null) {
      appScreen = 'mode-select';
      ui.showModeSelect(platform.hosted);
      return;
    }
    if (mode === 'daily') {
      prepareStage('daily', dailyDateUtc(new Date(platform.serverNow())), false);
      return;
    }
    showStageSelectFor(mode);
  }

  function showStageSelectFor(mode) {
    const items = stageItems(mode);
    pending = { mode, stageArgs: [mode, items] };
    appScreen = 'stage-select';
    ui.showStageSelect(mode, items);
  }

  function stageItems(mode) {
    if (mode === 'learn') {
      const tuts = tutorialStages();
      return tuts.map((t, i) => ({
        id: t.id, name: t.name, blurb: t.tutorial.steps[0].text, goals: t.goals, par: t.par,
        won: progress.tutorialsDone.includes(t.id),
        best: null,
        locked: i > 0 && !progress.tutorialsDone.includes(tuts[i - 1].id),
      }));
    }
    if (mode === 'practice') {
      return ['relaxed', 'standard', 'intense'].map((d) => {
        const c = practiceConfig(d);
        return { id: d, name: c.name, blurb: null, goals: c.goals, par: c.par, won: false, best: null, locked: false };
      });
    }
    if (mode === 'challenge') {
      return challengeStages().map((c, i, all) => {
        const rec = progress.challenges[c.id];
        return {
          id: c.id, name: c.name, blurb: c.blurb, goals: c.goals, par: c.par,
          won: !!rec?.won, best: rec?.best || null,
          locked: i > 0 && !progress.challenges[all[i - 1].id]?.won,
        };
      });
    }
    // journey + score chase share the journey catalog
    const stages = journeyStages();
    return stages.map((s, i) => {
      const rec = progress.journey[s.id];
      const unlocked = i === 0 || !!progress.journey[stages[i - 1].id]?.won;
      return {
        id: s.id, name: s.name, blurb: s.mastery ? N('Mastery stage') : null, goals: s.goals, par: s.par,
        won: !!rec?.won, best: rec?.best || null,
        locked: mode === 'score' ? !rec?.won : !unlocked,
      };
    });
  }

  function onStageChosen(mode, id) {
    prepareStage(mode, id, true);
  }

  function buildConfig(mode, id) {
    if (mode === 'learn') return tutorialStages().find((t) => t.id === id);
    if (mode === 'journey' || mode === 'score') return journeyStages().find((s) => s.id === id);
    if (mode === 'challenge') return challengeStages().find((c) => c.id === id);
    if (mode === 'practice') return practiceConfig(id);
    if (mode === 'daily') return dailyConfig(id);
    throw new Error('unknown mode ' + mode);
  }

  function prepareStage(mode, id, fromStageSelect) {
    const config = buildConfig(mode, id);
    if (!config) throw new Error('unknown stage ' + id);
    pending = { mode, id, config, fromStageSelect, stageArgs: pending?.stageArgs };
    appScreen = 'setup';
    ui.showSetup(mode, config, platform.hosted);
    if (mode === 'daily' || mode === 'score') {
      // Leaderboard preview: the platform board signed in, local records otherwise.
      const board = config.dailyDate ? 'daily' : 'global';
      platform.getLeaderboard({ board, date: config.dailyDate || null })
        .then((entries) => {
          if (pending && pending.config === config && appScreen === 'setup') {
            ui.showSetupBoard(entries, platform.hosted ? N('Platform leaderboard') : N('Top shifts'));
          }
        })
        .catch(() => {});
    }
  }

  function onStart() {
    startRound();
  }

  function onBack(from) {
    if (from === 'setup') {
      if (pending?.fromStageSelect && pending?.stageArgs) {
        appScreen = 'stage-select';
        ui.showStageSelect(...pending.stageArgs);
      } else if (pending?.mode === 'daily') {
        goTitle();
      } else {
        onModeChosen(null);
      }
    } else if (from === 'stage-select') {
      onModeChosen(null);
    } else {
      goTitle();
    }
  }

  // ----------------------------------------------------------- graphics
  function applyGraphics(saved) {
    settings.graphics = { ...(saved || {}) };
    delete settings.quality; // superseded by settings.graphics.preset
    persistSettings();
    const r = resolveGraphics(settings.graphics, detectedPreset, gpuLevel);
    const root = document.documentElement;
    root.dataset.gfxPreset = r.preset;
    root.dataset.gfxDetail = r.detail;
    root.dataset.gfxAuto = r.auto ? 'true' : 'false';
    if (renderer) renderer.setGraphics(settings.graphics);
  }

  function motionReduced() {
    const os = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    return !!settings.reducedMotion || os;
  }

  function graphicsInfo(words) {
    if (renderer) return { ...renderer.graphicsInfo(words), webgl };
    const r = resolveGraphics(settings.graphics, detectedPreset, gpuLevel);
    const ratio = Math.min(window.devicePixelRatio || 1, r.maxRatio) * r.scale;
    const px = [Math.round(window.innerWidth * ratio), Math.round(window.innerHeight * ratio)];
    return { gpu, level: gpuLevel, detected: detectedPreset, resolved: r, summary: describeGraphics(r, px, words), postFailed: false, webgl };
  }

  // ----------------------------------------------------------- renderer

  async function ensureRenderer() {
    if (renderer || !webgl) return renderer;
    if (!rendererPromise) {
      rendererPromise = import('./render.js').then(({ createRenderer }) => {
        renderer = createRenderer(document.getElementById('scene-host'), {
          graphics: settings.graphics,
          detected: detectedPreset,
          level: gpuLevel,
          gpu,
          reducedMotion: motionReduced(),
          colorblind: settings.colorblind || 'none',
          camera: settings.camera || 'isometric',
          onPick, onHover,
        });
        return renderer;
      }).catch((e) => {
        console.error('renderer failed to load', e);
        webgl = false;
        document.documentElement.classList.add('force-mirror');
        ui.toast('3D view failed to load — the button controls still work', 'bad');
        return null;
      });
    }
    return rendererPromise;
  }

  function onHover() { /* hover previews are decorative; nothing required */ }

  function onPick(pick) {
    if (!round || !active || paused) return;
    if (!pick || pick.kind === 'floor') {
      ui.hideContextPanel();
      if (renderer) renderer.setHighlight(null);
      return;
    }
    const session = round.session;
    if (pick.kind === 'display') {
      const cmd = { type: 'restock', displayId: pick.id };
      if (round.config.allowed.restock && session.explain(cmd).ok) issueCommand(cmd);
      else ui.showContextPanel(pick, session.state, round.config);
    } else if (pick.kind === 'checkout') {
      const cmd = { type: 'serve', checkoutId: pick.id };
      if (session.explain(cmd).ok) issueCommand(cmd);
      else ui.showContextPanel(pick, session.state, round.config);
    } else if (pick.kind === 'department') {
      const dept = session.state.departments.find((d) => d.id === pick.id);
      const cmd = { type: 'unlock', deptId: pick.id };
      if (dept && !dept.unlocked && session.explain(cmd).ok) issueCommand(cmd);
      else ui.showContextPanel(pick, session.state, round.config);
    }
  }

  // Mirror focus also drives the 3D highlight so sighted players see where
  // the keyboard cursor is.
  function onPickProxy(pick) {
    if (!renderer) return;
    if (!pick) { renderer.setHighlight(null); return; }
    renderer.setHighlight([{ kind: pick.kind, id: pick.id }]);
  }

  // -------------------------------------------------------------- rounds
  async function startRound() {
    if (!pending) return;
    const { mode, id, config } = pending;
    saveKey('lastPlayed.v1', { mode, id });

    const session = createSession({ config, mode, allowUndo: mode === 'practice' });
    round = { mode, id, config, session };
    active = false;
    paused = false;
    loopErrors = 0;
    lastCmdKey = '';
    audio.setSeed(config.seed);

    session.on('terminal', ({ score }) => finishRound(score));

    const r = await ensureRenderer();
    if (r) {
      r.buildMarket(session.state, config, themeById(settings.theme || config.theme));
      r.setPaused(false);
      r.start();
    }

    tutorial = config.tutorial ? { steps: config.tutorial.steps, index: 0 } : null;

    appScreen = 'game';
    ui.showScreen('game');
    ui.updateHUD(session.state, session, config, { score: 0 });
    ui.updateBoardMirror(session.state, config);
    showTutorialStep();

    await runCountdown();
    if (!round || round.session !== session) return; // quit during countdown
    active = true;
    startLoop();
    audio.unlock();
    audio.startMusic(musicIntensity());
  }

  async function runCountdown() {
    const token = ++countdownToken;
    if (settings.reducedMotion) return;
    for (const n of ['3', '2', '1']) {
      if (token !== countdownToken) return;
      ui.showCountdown(n);
      audio.playEvent('countdown');
      ui.announce(n, 'assertive');
      await sleep(650);
    }
    if (token !== countdownToken) return;
    ui.showCountdown(N('Go'));
    ui.announce(N('Go'), 'assertive');
    await sleep(400);
    ui.hideCountdown();
  }

  function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

  function quitRound() {
    countdownToken++;
    active = false;
    paused = false;
    tutorial = null;
    if (round) {
      // Ending early counts as an abandoned attempt, not a result.
      round = null;
    }
    ui.showTutorial(null);
    ui.hideContextPanel();
    if (renderer) { renderer.setHighlight(null); renderer.stop(); }
    audio.stopMusic();
    audio.setPaused(false);
    goTitle();
  }

  // ---------------------------------------------------------- game loop
  let rafId = null;
  let lastTime = 0;
  let acc = 0;

  function startLoop() {
    if (rafId != null) return;
    lastTime = performance.now();
    acc = 0;
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function loop(t) {
    rafId = requestAnimationFrame(loop);
    const dt = Math.min(1000, t - lastTime);
    lastTime = t;
    pollGamepad();
    if (!active || paused || !round) return;
    acc += dt;
    let steps = 0;
    while (acc >= TICK_MS && steps < MAX_CATCHUP_STEPS && active && !paused) {
      acc -= TICK_MS;
      steps++;
      try {
        const events = round.session.stepTick();
        afterTick(events);
      } catch (e) {
        handleLoopError(e);
        break;
      }
    }
    if (acc >= TICK_MS) acc = 0; // shed backlog instead of spiraling
  }

  function handleLoopError(e) {
    console.error('tick error', e);
    if (++loopErrors >= MAX_LOOP_ERRORS && active) {
      ui.toast(N('Something went wrong repeatedly — the shift was paused'), 'bad');
      pauseGame(true);
    }
  }

  function afterTick(events) {
    if (!round) return;
    const { session, config } = round;
    if (renderer) renderer.syncState(session.state, events);
    ui.updateHUD(session.state, session, config);
    ui.updateBoardMirror(session.state, config);
    audio.mapEvents(events);
    audio.startMusic(musicIntensity());
    for (const ev of events) {
      if (ev.kind === 'served') ui.toast(N('Guest served +{n}'), 'good', { n: ev.amount });
      else if (ev.kind === 'left-angry') ui.toast(N('A guest left angry'), 'bad');
      else if (ev.kind === 'left-empty') ui.toast(N('A guest found empty shelves'), 'info');
    }
  }

  function musicIntensity() {
    if (!round) return 0;
    const { session, config } = round;
    const queued = session.state.checkouts.reduce((n, c) => n + c.queue.length, 0);
    const timePressure = 1 - Math.max(0, config.maxTicks - session.state.tick) / config.maxTicks;
    return Math.min(1, queued / 6 + timePressure * 0.4);
  }

  // ------------------------------------------------------------ commands
  function issueCommand(cmd) {
    if (!round || !active || paused || round.session.isOver) return;
    const session = round.session;
    // Per-tick UI-side dedup: ignore a repeat of the identical command while
    // the previous one is still being processed this tick. Session-level
    // command ids dedup anything that still slips through.
    const key = session.state.tick + ':' + JSON.stringify(cmd);
    if (key === lastCmdKey) return;
    lastCmdKey = key;

    const res = session.issue(cmd);
    if (!res.ok) {
      ui.toast(humanizeReason(res.reason), 'bad');
      audio.playEvent('error');
      buzz(60);
      return;
    }
    audio.uiClick();
    buzz(10);
    audio.mapEvents(res.events);
    if (renderer) renderer.syncState(session.state, res.events);
    ui.updateHUD(session.state, session, round.config);
    ui.updateBoardMirror(session.state, round.config);
    clearHint();
    tutorialCheck(cmd);
  }

  // ------------------------------------------------------------- pause
  function pauseGame(manual) {
    if (!round || !active || paused) return;
    paused = true;
    appScreen = 'pause';
    audio.setPaused(true);
    if (renderer) renderer.setPaused(true);
    ui.showPause(manual ? null : awayTicks);
    awayTicks = null;
  }

  function resumeGame() {
    if (!round || !paused) return;
    paused = false;
    appScreen = 'game';
    awayTicks = null;
    audio.setPaused(false);
    if (renderer) renderer.setPaused(false);
    ui.hidePause();
    ui.showScreen('game');
    lastTime = performance.now();
    acc = 0;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (active && !paused) {
        hiddenAt = performance.now();
        pauseGame(false);
      }
      if (renderer) renderer.stop();
    } else {
      if (hiddenAt != null) {
        awayTicks = Math.floor((performance.now() - hiddenAt) / TICK_MS);
        hiddenAt = null;
        if (paused) ui.showPause(awayTicks); // refresh the away note
      }
      if (renderer && round) renderer.start();
    }
  });

  window.addEventListener('resize', () => { if (renderer) renderer.resize(); });

  // --------------------------------------------------------------- undo
  function doUndo() {
    if (!round || !round.session.canUndo() || paused) return;
    if (round.session.undo()) {
      if (renderer) renderer.syncState(round.session.state, []);
      ui.updateHUD(round.session.state, round.session, round.config);
      ui.updateBoardMirror(round.session.state, round.config);
      ui.toast(N('Undone'), 'info');
      audio.uiClick();
    }
  }

  // --------------------------------------------------------------- hint
  function showHint() {
    if (!round || !active || paused) return;
    const legal = round.session.legalActions();
    if (!legal.length) { ui.announce(N('No actions available right now')); return; }
    const order = ['serve', 'restock', 'unlock', 'hire', 'upgrade'];
    const pick = order.flatMap((t) => legal.filter((a) => a.type === t))[0];
    const target = hintTarget(pick);
    if (target && renderer) renderer.setHighlight([target]);
    const [hk, hv] = hintText(pick);
    ui.announce(hk, 'assertive', hv);
    ui.toast(hk, 'info', hv);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(clearHint, 3000);
  }

  function hintTarget(action) {
    if (action.type === 'restock') return { kind: 'display', id: action.displayId };
    if (action.type === 'serve') return { kind: 'checkout', id: action.checkoutId };
    if (action.type === 'unlock') return { kind: 'department', id: action.deptId };
    if (action.type === 'upgrade') return { kind: action.targetKind, id: action.targetId };
    return null; // hire: staff panel, nothing on the board
  }

  function hintText(action) {
    if (action.type === 'serve') return [N('Serve checkout {n} — guests are waiting'), { n: action.checkoutId.slice(1) }];
    if (action.type === 'restock') return [N('Restock shelf {n}'), { n: action.displayId.slice(1) }];
    if (action.type === 'unlock') return [N('You can afford to unlock a department')];
    if (action.type === 'hire') return [action.role === 'cashier' ? N('Hire a cashier from the staff panel') : N('Hire a stocker from the staff panel')];
    return [action.targetKind === 'checkout' ? N('Upgrade a checkout') : N('Upgrade a shelf')];
  }

  function clearHint() {
    clearTimeout(hintTimer);
    hintTimer = null;
    if (renderer && !tutorial) renderer.setHighlight(null);
  }

  // ----------------------------------------------------------- tutorial
  function showTutorialStep() {
    if (!tutorial) { ui.showTutorial(null); return; }
    const step = tutorial.steps[tutorial.index];
    if (!step) { ui.showTutorial(null); return; }
    ui.showTutorial(step.text);
    if (step.require && renderer && round) {
      const targets = round.session.legalActions()
        .filter((a) => matchesRequire(a, step.require))
        .map(hintTarget)
        .filter(Boolean);
      renderer.setHighlight(targets.length ? targets : null);
    }
  }

  function matchesRequire(action, require) {
    if (!require) return true;
    if (action.type !== require.type) return false;
    if (require.role && action.role !== require.role) return false;
    if (require.targetKind && action.targetKind !== require.targetKind) return false;
    return true;
  }

  function tutorialCheck(cmd) {
    if (!tutorial || !round) return;
    const step = tutorial.steps[tutorial.index];
    if (step && step.require && matchesRequire(cmd, step.require)) {
      tutorial.index++;
      showTutorialStep();
    }
  }

  function finishTutorialIfNeeded() {
    if (!round || round.mode !== 'learn') return;
    if (round.session.state.phase !== 'won') return;
    if (!settings.tutorialsDone.includes(round.id)) {
      settings.tutorialsDone.push(round.id);
      persistSettings();
    }
    if (!progress.tutorialsDone.includes(round.id)) {
      progress.tutorialsDone.push(round.id);
    }
  }

  // ------------------------------------------------------------ terminal
  async function finishRound(score) {
    if (!round) return;
    const { session, config, mode, id } = round;
    active = false;
    stopLoop();
    audio.stopMusic();

    finishTutorialIfNeeded();
    const newly = recordResult(progress, session);
    saveProgress(progress);
    platform.queueCloudSave();
    // Badge flourish lands after the win/lose sting so the two never overlap.
    if (newly.length) setTimeout(() => audio.playEvent('achievement'), 700);

    let submitted = null;
    let rank = null;
    if (mode === 'daily' || mode === 'score') {
      // The run also records to the local board (personal best).
      const res = await platform.submitScore(session.replayEnvelope());
      submitted = res && res.ok ? 'local' : false;
      if (res && res.ok && typeof res.rank === 'number') rank = res.rank;
      if (res && res.ok) platform.queueCloudSave();
    }

    const best = mode === 'journey' || mode === 'score'
      ? progress.journey[id]?.best
      : mode === 'challenge'
        ? progress.challenges[id]?.best
        : config.dailyDate ? progress.daily[config.dailyDate]?.score : null;

    const next = nextAction(mode, id, session.state.phase === 'won');
    lastResults = { session, config, score, newly, best, next, submitted, rank };
    appScreen = 'results';
    buzz(session.state.phase === 'won' ? [40, 60, 40] : 120);
    ui.showResults(lastResults);
    // Signed in: ranked modes (not Learn / Practice) post to the platform board.
    if (platform.hosted && mode !== 'learn' && mode !== 'practice') {
      const shown = lastResults;
      shown.lb = { pending: true };
      ui.setLeaderboardLine(lbText(shown.lb));
      platform.submitPlatformScore(score.total).then((r) => {
        shown.lb = r;
        shown.lbLine = lbText(r);
        if (lastResults === shown && appScreen === 'results') ui.setLeaderboardLine(shown.lbLine);
      });
    }
  }

  function lbText(r) {
    if (!r) return null;
    if (r.pending) return shT().lbPosting;
    return !r.posted ? shT().lbNotPosted : r.rank ? shT().lbRank.replace('{rank}', r.rank) : shT().lbPosted;
  }

  // Settings › Language (or the account preference arriving) changed the game
  // language: markup is re-applied by i18n.js; re-render whatever is on screen
  // in place. A running shift keeps going untouched.
  function relocalize() {
    ui.labelAccount({ signIn: shT().signIn, invite: shT().invite });
    gfxPanel.setLocale(getLang());
    refreshDailyInfo();
    ui.setPlayerInfo({ nickname: platform.nickname, status: platform.syncStatus, hosted: platform.hosted });
    if (lastResults && lastResults.lb) lastResults.lbLine = lbText(lastResults.lb);
    if (round) {
      ui.relocalizeGame();
      ui.updateHUD(round.session.state, round.session, round.config);
      ui.updateBoardMirror(round.session.state, round.config);
      if (paused && appScreen === 'pause') ui.showPause(awayTicks);
    }
    if (appScreen === 'help') ui.showHelp(controlMap(bindings));
    else if (['title', 'mode-select', 'stage-select', 'setup', 'results'].includes(appScreen)) restoreScreen(appScreen);
  }
  onLanguage(relocalize);

  function nextAction(mode, id, won) {
    if (mode === 'journey' && won) {
      const stages = journeyStages();
      const i = stages.findIndex((s) => s.id === id);
      if (i >= 0 && i + 1 < stages.length) {
        return { name: stages[i + 1].name, mode: 'journey', id: stages[i + 1].id };
      }
    }
    if (mode === 'learn' && won) {
      const tuts = tutorialStages();
      const i = tuts.findIndex((t) => t.id === id);
      if (i >= 0 && i + 1 < tuts.length) {
        return { name: tuts[i + 1].name, mode: 'learn', id: tuts[i + 1].id };
      }
    }
    return null;
  }

  function onRetry() {
    if (!round) return;
    const { mode, id } = round;
    round = null;
    pending = { ...pending, mode, id, config: buildConfig(mode, id) };
    startRound();
  }

  function onNext() {
    const next = lastResults?.next;
    if (!next) return;
    round = null;
    prepareStage(next.mode, next.id, false);
    startRound();
  }

  // ----------------------------------------------------------- overlays
  function openOverlay(name) {
    overlayReturn = appScreen;
    if (name === 'help') {
      appScreen = 'help';
      ui.showHelp(controlMap(bindings));
    } else {
      appScreen = 'settings';
      ui.showSettings(settings);
      gfxPanel.refresh();
    }
  }

  function closeOverlay() {
    const dest = overlayReturn || 'title';
    overlayReturn = null;
    restoreScreen(dest);
  }

  function restoreScreen(dest) {
    appScreen = dest;
    if (dest === 'game' || dest === 'pause') {
      if (dest === 'pause') ui.showPause(null);
      else ui.showScreen('game');
    } else if (dest === 'title') goTitle();
    else if (dest === 'mode-select') onModeChosen(null);
    else if (dest === 'stage-select' && pending?.stageArgs) ui.showStageSelect(...pending.stageArgs);
    else if (dest === 'setup' && pending) ui.showSetup(pending.mode, pending.config, platform.hosted);
    else if (dest === 'results' && lastResults) ui.showResults(lastResults);
    else goTitle();
  }

  // ------------------------------------------------------------ settings
  function applySettingsPatch(patch) {
    Object.assign(settings, patch);
    persistSettings();
    ui.applySettingsClasses(settings);
    audio.setVolumes(settings);
    if (renderer) {
      renderer.setGraphics(settings.graphics);
      renderer.setReducedMotion(motionReduced());
      renderer.setColorblind(settings.colorblind || 'none');
      renderer.setCamera(settings.camera || 'isometric');
      if (round) renderer.setTheme(themeById(settings.theme || round.config.theme));
    }
  }

  function onReplayTutorials() {
    settings.tutorialsDone = [];
    persistSettings();
    progress.tutorialsDone = [];
    saveProgress(progress);
    platform.queueCloudSave();
    ui.toast(N('Tutorial progress reset'), 'info');
    showStageSelectFor('learn');
  }

  // ------------------------------------------------------------ haptics
  function buzz(pattern) {
    if (!settings.haptics) return;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
    } catch { /* haptics are best-effort */ }
  }

  // ------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

    const act = codeToAction.get(e.code);
    if (act === 'back') {
      if (appScreen === 'help' || appScreen === 'settings') closeOverlay();
      else if (appScreen === 'game' && active && !paused) pauseGame(true);
      else if (appScreen === 'pause') resumeGame();
      return;
    }
    if (typing) return;

    if (appScreen === 'game' && active && !paused) {
      if (act === 'pause') { pauseGame(true); e.preventDefault(); }
      else if (act === 'hint') { showHint(); e.preventDefault(); }
      else if (act === 'undo') { doUndo(); e.preventDefault(); }
      else if (act === 'camera') { if (renderer) renderer.resetCamera(); e.preventDefault(); }
      else if (act === 'prev' || act === 'next') {
        moveMirrorFocus(act === 'prev' ? -1 : 1);
        e.preventDefault();
      }
    } else if (appScreen === 'pause' && act === 'pause') {
      resumeGame();
      e.preventDefault();
    }
  });

  function mirrorButtons() {
    return Array.from(document.querySelectorAll('#mirror-list button:not([disabled])'));
  }

  function moveMirrorFocus(dir) {
    const buttons = mirrorButtons();
    if (!buttons.length) return;
    const i = buttons.indexOf(document.activeElement);
    const next = buttons[(i + dir + buttons.length) % buttons.length];
    next.focus();
  }

  // ------------------------------------------------------------ gamepad
  let padState = { moveAt: 0, buttons: {} };

  function pollGamepad() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    const pads = navigator.getGamepads();
    const pad = pads && Array.from(pads).find(Boolean);
    if (!pad) return;

    const now = performance.now();
    const ax = Math.abs(pad.axes[0] || 0) > GAMEPAD_DEADZONE ? pad.axes[0] : 0;
    const ay = Math.abs(pad.axes[1] || 0) > GAMEPAD_DEADZONE ? pad.axes[1] : 0;
    const left = pad.buttons[14]?.pressed || ax < 0;
    const right = pad.buttons[15]?.pressed || ax > 0;
    const up = pad.buttons[12]?.pressed || ay < 0;
    const down = pad.buttons[13]?.pressed || ay > 0;
    if ((left || right || up || down) && now - padState.moveAt > REPEAT_DELAY_MS) {
      padState.moveAt = now;
      if (appScreen === 'game' && active && !paused) moveMirrorFocus(left || up ? -1 : 1);
    }

    const press = (idx) => {
      const was = padState.buttons[idx];
      const is = !!pad.buttons[idx]?.pressed;
      padState.buttons[idx] = is;
      return is && !was;
    };
    if (press(9)) { // Start: pause / resume
      if (appScreen === 'game' && active && !paused) pauseGame(true);
      else if (appScreen === 'pause') resumeGame();
    }
    if (press(1)) { // B: cancel / close
      if (appScreen === 'help' || appScreen === 'settings') closeOverlay();
      else if (appScreen === 'game') ui.hideContextPanel();
    }
    if (press(3) && appScreen === 'game' && active && !paused) showHint(); // Y: hint
    if (press(0)) { // A: confirm
      const el = document.activeElement;
      if (el && el.tagName === 'BUTTON' && !el.disabled) el.click();
      else if (appScreen === 'game') moveMirrorFocus(1);
    }
  }

  // ------------------------------------------------------------- errors
  window.addEventListener('error', (e) => {
    console.error('uncaught', e.error || e.message);
    ui.toast(N('Something hiccuped — the game kept going'), 'bad');
  });

  // ------------------------------------------------------------ helpers
  function detectWebGL() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return false;
      gpu = gpuName(gl, navigator.userAgent || '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
