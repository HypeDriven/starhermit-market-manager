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

const CONTROL_MAP = [
  { keys: 'Tap / click a shelf', action: 'restock it (or open its actions)' },
  { keys: 'Tap / click a checkout', action: 'serve the next guest' },
  { keys: 'Arrow keys or WASD', action: 'move focus between market actions' },
  { keys: 'Enter / Space', action: 'confirm the focused action' },
  { keys: 'H', action: 'hint' },
  { keys: 'U', action: 'undo (Practice only)' },
  { keys: 'R', action: 'reset camera' },
  { keys: 'P or Esc', action: 'pause / close panel' },
  { keys: 'Gamepad d-pad / left stick', action: 'move focus' },
  { keys: 'Gamepad A', action: 'confirm' },
  { keys: 'Gamepad B', action: 'cancel / close' },
  { keys: 'Gamepad Start', action: 'pause' },
  { keys: 'Gamepad Y', action: 'hint' },
];

const REPEAT_DELAY_MS = 220;
const GAMEPAD_DEADZONE = 0.25;
const MAX_CATCHUP_STEPS = 4;
const MAX_LOOP_ERRORS = 5;

function boot() {
  // ------------------------------------------------------------ services
  const settings = loadSettings();
  const progress = loadProgress();
  const audio = createAudio(settings);
  const platform = createPlatform();

  let renderer = null;
  let rendererPromise = null;
  let webgl = detectWebGL();

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

  platform.onError = (info) => {
    if (info.kind === 'rate-limited') ui.toast('Server is busy — scores will save locally for now', 'info');
    track('error-category');
  };

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
    const countdownText = `new market in ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
    ui.setDailyInfo({ date, countdownText });
  }
  refreshDailyInfo();
  setInterval(() => { if (appScreen === 'title') refreshDailyInfo(); }, 30000);

  // Probe the backend without blocking the title screen.
  platform.init().then(refreshDailyInfo).catch(() => {});

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
    ui.toast('Playing without the 3D view — use the on-screen action buttons', 'info');
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
      ui.showModeSelect();
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
        id: s.id, name: s.name, blurb: s.mastery ? 'Mastery stage' : null, goals: s.goals, par: s.par,
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
    const ranked = (mode === 'daily' || mode === 'score') && platform.available;
    ui.showSetup(mode, config, ranked);
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

  // ----------------------------------------------------------- renderer
  function resolveQuality() {
    if (settings.quality && settings.quality !== 'auto') return settings.quality;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    return coarse ? 'medium' : 'high';
  }

  async function ensureRenderer() {
    if (renderer || !webgl) return renderer;
    if (!rendererPromise) {
      rendererPromise = import('./render.js').then(({ createRenderer }) => {
        renderer = createRenderer(document.getElementById('scene-host'), {
          quality: resolveQuality(),
          reducedMotion: !!settings.reducedMotion,
          colorblind: settings.colorblind || 'none',
          camera: settings.camera || 'isometric',
          onPick, onHover,
        });
        return renderer;
      }).catch((e) => {
        console.error('renderer failed to load', e);
        webgl = false;
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
    track('start');

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
      ui.announce(n, 'assertive');
      await sleep(650);
    }
    if (token !== countdownToken) return;
    ui.showCountdown('Go');
    ui.announce('Go', 'assertive');
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
    track('error-category');
    if (++loopErrors >= MAX_LOOP_ERRORS && active) {
      ui.toast('Something went wrong repeatedly — the shift was paused', 'bad');
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
      if (ev.kind === 'served') ui.toast(`Guest served +${ev.amount}`, 'good');
      else if (ev.kind === 'left-angry') ui.toast('A guest left angry', 'bad');
      else if (ev.kind === 'left-empty') ui.toast('A guest found empty shelves', 'info');
    }
    platform.heartbeat();
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
      return;
    }
    audio.uiClick();
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
      ui.toast('Undone', 'info');
      audio.uiClick();
    }
  }

  // --------------------------------------------------------------- hint
  function showHint() {
    if (!round || !active || paused) return;
    const legal = round.session.legalActions();
    if (!legal.length) { ui.announce('No actions available right now'); return; }
    const order = ['serve', 'restock', 'unlock', 'hire', 'upgrade'];
    const pick = order.flatMap((t) => legal.filter((a) => a.type === t))[0];
    const target = hintTarget(pick);
    if (target && renderer) renderer.setHighlight([target]);
    ui.announce(hintText(pick), 'assertive');
    ui.toast(hintText(pick), 'info');
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
    if (action.type === 'serve') return `Serve checkout ${action.checkoutId.slice(1)} — guests are waiting`;
    if (action.type === 'restock') return `Restock shelf ${action.displayId.slice(1)}`;
    if (action.type === 'unlock') return 'You can afford to unlock a department';
    if (action.type === 'hire') return `Hire a ${action.role} from the staff panel`;
    return `Upgrade a ${action.targetKind}`;
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
      track('tutorial-step');
      showTutorialStep();
    }
  }

  function finishTutorialIfNeeded() {
    if (!round || round.mode !== 'learn') return;
    if (round.session.state.phase !== 'won') return;
    if (!settings.tutorialsDone.includes(round.id)) {
      settings.tutorialsDone.push(round.id);
      saveSettings(settings);
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
    track('round-end');

    finishTutorialIfNeeded();
    const newly = recordResult(progress, session);
    saveProgress(progress);

    let submitted = null;
    if (mode === 'daily' || mode === 'score') {
      // platform.submitScore falls back to the local board when offline.
      const res = await platform.submitScore(session.replayEnvelope());
      submitted = res && res.ok ? (res.local ? 'local' : true) : false;
    }

    const best = mode === 'journey' || mode === 'score'
      ? progress.journey[id]?.best
      : mode === 'challenge'
        ? progress.challenges[id]?.best
        : config.dailyDate ? progress.daily[config.dailyDate]?.score : null;

    const next = nextAction(mode, id, session.state.phase === 'won');
    lastResults = { session, config, score, newly, best, next, submitted };
    appScreen = 'results';
    ui.showResults(lastResults);
  }

  function nextAction(mode, id, won) {
    if (mode === 'journey' && won) {
      const stages = journeyStages();
      const i = stages.findIndex((s) => s.id === id);
      if (i >= 0 && i + 1 < stages.length) {
        return { label: 'Next: ' + stages[i + 1].name, mode: 'journey', id: stages[i + 1].id };
      }
    }
    if (mode === 'learn' && won) {
      const tuts = tutorialStages();
      const i = tuts.findIndex((t) => t.id === id);
      if (i >= 0 && i + 1 < tuts.length) {
        return { label: 'Next: ' + tuts[i + 1].name, mode: 'learn', id: tuts[i + 1].id };
      }
    }
    return null;
  }

  function onRetry() {
    if (!round) return;
    track('retry');
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
      ui.showHelp(CONTROL_MAP);
    } else {
      appScreen = 'settings';
      ui.showSettings(settings);
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
    else if (dest === 'setup' && pending) ui.showSetup(pending.mode, pending.config, false);
    else if (dest === 'results' && lastResults) ui.showResults(lastResults);
    else goTitle();
  }

  // ------------------------------------------------------------ settings
  function applySettingsPatch(patch) {
    Object.assign(settings, patch);
    saveSettings(settings);
    ui.applySettingsClasses(settings);
    audio.setVolumes(settings);
    if (renderer) {
      renderer.setQuality(resolveQuality());
      renderer.setReducedMotion(!!settings.reducedMotion);
      renderer.setColorblind(settings.colorblind || 'none');
      renderer.setCamera(settings.camera || 'isometric');
      if (round) renderer.setTheme(themeById(settings.theme || round.config.theme));
    }
    track('settings-change');
  }

  function onReplayTutorials() {
    settings.tutorialsDone = [];
    saveSettings(settings);
    progress.tutorialsDone = [];
    saveProgress(progress);
    ui.toast('Tutorial progress reset', 'info');
    showStageSelectFor('learn');
  }

  // ----------------------------------------------------------- analytics
  function track(name) {
    if (settings.consentAnalytics) platform.beacon(name);
  }

  // ------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

    if (e.key === 'Escape') {
      if (appScreen === 'help' || appScreen === 'settings') closeOverlay();
      else if (appScreen === 'game' && active && !paused) pauseGame(true);
      else if (appScreen === 'pause') resumeGame();
      return;
    }
    if (typing) return;

    const k = e.key.toLowerCase();
    if (appScreen === 'game' && active && !paused) {
      if (k === 'p') { pauseGame(true); e.preventDefault(); }
      else if (k === 'h') { showHint(); e.preventDefault(); }
      else if (k === 'u') { doUndo(); e.preventDefault(); }
      else if (k === 'r') { if (renderer) renderer.resetCamera(); e.preventDefault(); }
      else if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(k)) {
        moveMirrorFocus(k === 'arrowup' || k === 'arrowleft' || k === 'a' || k === 'w' ? -1 : 1);
        e.preventDefault();
      }
    } else if (appScreen === 'pause' && k === 'p') {
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
    ui.toast('Something hiccuped — the game kept going', 'bad');
    track('error-category');
  });

  // ------------------------------------------------------------ helpers
  function detectWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
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
