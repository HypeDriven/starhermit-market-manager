// Market Manager — DOM shell: screens, HUD, panels, accessibility mirror.
// No game-rules logic lives here; ui.js only formats state and forwards
// callbacks. All DOM access happens inside createUI() so the module imports
// cleanly outside a browser.

import { restockCost, upgradeCost } from './rules.js';

// Stable reason codes -> short human explanations.
export const REASON_TEXT = {
  'display-full': 'That shelf is already full',
  'queue-empty': 'No one is waiting there',
  'not-enough-money': 'Not enough coins',
  'department-locked': 'That department is still locked',
  'max-level': 'Already fully upgraded',
  'already-hired': 'Already on the team',
  'already-unlocked': 'Already unlocked',
  'no-moves-left': 'Out of moves',
  'game-over': 'This shift has ended',
  'not-allowed': 'Not allowed in this stage',
  'no-such-display': 'No shelf there',
  'no-such-checkout': 'No checkout there',
  'no-such-role': 'No such role',
  'no-such-target': 'Nothing to upgrade there',
  'no-such-department': 'No such department',
  'malformed-command': 'That action did not make sense',
  'unknown-command': 'Unknown action',
};

export function humanizeReason(reason) {
  return REASON_TEXT[reason] || 'That will not work right now';
}

const MODES = [
  { id: 'learn', name: 'Learn', blurb: 'Four short lessons that teach one rule at a time by doing.', duration: '2–4 min each', standing: 'casual', standingText: 'Practice · not ranked' },
  { id: 'journey', name: 'Journey', blurb: 'Forty authored stages, from first shift to market legend.', duration: '3–8 min each', standing: 'casual', standingText: 'Progress saved locally' },
  { id: 'daily', name: 'Daily', blurb: 'One shared market per UTC day. Same seed for everyone.', duration: '~4 min', standing: 'ranked', standingText: 'Ranked when online' },
  { id: 'practice', name: 'Practice', blurb: 'Pick a pace and play freely. Undo is allowed here.', duration: '3–5 min', standing: 'casual', standingText: 'Not ranked · undo on' },
  { id: 'challenge', name: 'Challenge', blurb: 'Five constrained stages: move limits, speed, altered floors.', duration: '2–6 min each', standing: 'casual', standingText: 'Progress saved locally' },
  { id: 'score', name: 'Score chase', blurb: 'Play any beaten stage for the leaderboard. Replays are verified.', duration: '3–8 min', standing: 'ranked', standingText: 'Ranked when online' },
];

const HELP_RULES = [
  { icon: '1', title: 'Restock shelves', text: 'Guests buy from stocked shelves. Tap a shelf (or its button) to refill it from the stockroom. Refilling costs coins per item.' },
  { icon: '2', title: 'Serve the queue', text: 'Guests with goods line up at a checkout. Tap the counter to serve the next guest before their patience runs out.' },
  { icon: '3', title: 'Unlock departments', text: 'Greyed-out shelves belong to locked departments. Pay the unlock cost to open them and raise your goal progress.' },
  { icon: '4', title: 'Upgrade stations', text: 'Upgraded shelves hold more and sell for more. Upgraded checkouts keep queued guests patient longer.' },
  { icon: '5', title: 'Hire staff', text: 'A stocker refills the emptiest shelf every few ticks; a cashier serves the longest queue. Staff act on their own.' },
  { icon: '6', title: 'Win the shift', text: 'Meet every goal — guests served, coins earned, departments unlocked — before the shift timer ends. Fewer angry guests means a better score.' },
];

function fmtTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function ticksToClock(ticks, tickMs) {
  return fmtTime((ticks * tickMs) / 1000);
}

export function createUI({ callbacks }) {
  const $ = (id) => document.getElementById(id);
  const screens = Array.from(document.querySelectorAll('[data-screen]'));
  const els = {
    sceneHost: $('scene-host'),
    dailyChip: $('daily-chip'), dailyDate: $('daily-date'), dailyCountdown: $('daily-countdown'),
    journeySummary: $('journey-progress-summary'),
    modeCards: $('mode-cards'),
    stageHeading: $('stage-heading'), stageList: $('stage-list'),
    setupHeading: $('setup-heading'), setupSummary: $('setup-summary'), setupBlurb: $('setup-blurb'),
    setupGoals: $('setup-goals'), setupDuration: $('setup-duration'),
    setupRules: $('setup-rules'), setupRanked: $('setup-ranked'),
    hudObjective: $('hud-objective'), hudMoves: $('hud-moves'),
    hudMoney: $('hud-money'), hudTime: $('hud-time'),
    hudServed: $('hud-served'), hudScore: $('hud-score'),
    btnUndo: $('btn-undo'), btnHint: $('btn-hint'), btnStaffToggle: $('btn-staff-toggle'),
    tutorialBanner: $('tutorial-banner'),
    contextPanel: $('context-panel'), staffPanel: $('staff-panel'),
    boardMirror: $('board-mirror'), mirrorList: $('mirror-list'),
    pauseAwayNote: $('pause-away-note'),
    resultsHeading: $('results-heading'), resultsReason: $('results-reason'),
    resultsTable: $('results-table'), resultsTotal: $('results-total'),
    resultsTiebreak: $('results-tiebreak'), resultsBest: $('results-best'),
    resultsAchievements: $('results-achievements'), btnNext: $('btn-next'),
    helpCards: $('help-cards'),
    settingsForm: $('settings-form'),
    countdown: $('countdown'),
    toasts: $('toasts'),
    live: $('live-announcer'), alerts: $('live-alerts'),
  };

  let currentScreen = null;
  let lastPick = null;      // selection shown in the context panel
  let lastState = null;     // last state seen, for panel/mirror refresh
  let lastConfig = null;
  let mirrorSignature = '';
  let focusMemory = new Map();

  // ---------------------------------------------------------------- helpers
  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k in node && k !== 'list' && k !== 'type' && k !== 'for') node[k] = v;
      else node.setAttribute(k, v);
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function goalLines(state) {
    const g = state.config.goals;
    const lines = [];
    if (g.serve) lines.push({ key: 'serve', text: `Serve ${g.serve} guests`, cur: state.stats.served, max: g.serve });
    if (g.earn) lines.push({ key: 'earn', text: `Earn ${g.earn} coins`, cur: state.stats.revenue, max: g.earn });
    if (g.unlock) {
      const have = state.departments.filter((d) => d.unlocked).length;
      lines.push({ key: 'unlock', text: `Unlock ${g.unlock} departments`, cur: have, max: g.unlock });
    }
    if (g.maxAngry !== undefined) lines.push({ key: 'calm', text: `Keep angry guests at ${g.maxAngry} or fewer`, cur: state.stats.angry, max: g.maxAngry, soft: true });
    return lines;
  }

  function objectiveText(state) {
    const parts = goalLines(state).map((l) => {
      if (l.key === 'calm') return `angry ${l.cur}/${l.max} max`;
      return `${l.key} ${Math.min(l.cur, l.max)}/${l.max}`;
    });
    return parts.length ? 'Goals — ' + parts.join(' · ') : 'Free play';
  }

  // ---------------------------------------------------------------- screens
  function showScreen(name) {
    if (currentScreen) focusMemory.set(currentScreen, document.activeElement);
    for (const s of screens) s.hidden = s.dataset.screen !== name;
    els.sceneHost.hidden = name !== 'game';
    const prev = currentScreen;
    currentScreen = name;
    const section = screens.find((s) => s.dataset.screen === name);
    if (!section) return;
    const remembered = focusMemory.get(name);
    const target = (remembered && section.contains(remembered) && !remembered.disabled)
      ? remembered
      : section.querySelector('[data-autofocus]')
        || section.querySelector('h1, h2[tabindex], [tabindex="-1"]')
        || section.querySelector('button:not([disabled])');
    if (target && typeof target.focus === 'function') {
      if (!target.hasAttribute('tabindex') && !/^(BUTTON|A|INPUT|SELECT)$/.test(target.tagName)) {
        target.setAttribute('tabindex', '-1');
      }
      target.focus({ preventScroll: true });
    }
    return prev;
  }

  function showTitle(progress) {
    showScreen('title');
    if (progress) {
      const won = Object.values(progress.journey || {}).filter((r) => r.won).length;
      els.journeySummary.textContent = won
        ? `Journey: ${won} of 40 stages complete · ${progress.guestsServedTotal || 0} guests served all time`
        : 'New around here? Start with Learn, or jump straight into Journey.';
    }
  }

  function showModeSelect() {
    showScreen('mode-select');
    els.modeCards.replaceChildren(...MODES.map((m) => {
      const card = el('button', { class: 'card', type: 'button' });
      card.append(
        el('h3', {}, m.name),
        el('p', {}, m.blurb),
        el('p', { class: 'meta' }, 'About ' + m.duration),
        el('p', { class: 'meta ' + m.standing }, m.standingText),
      );
      card.addEventListener('click', () => callbacks.onModeChosen(m.id));
      return card;
    }));
  }

  const MODE_HEADINGS = {
    learn: 'Lessons', journey: 'Journey stages', daily: 'Daily market',
    practice: 'Practice pace', challenge: 'Challenges', score: 'Score chase — pick a stage',
  };

  function showStageSelect(mode, items) {
    showScreen('stage-select');
    els.stageHeading.textContent = MODE_HEADINGS[mode] || 'Stages';
    els.stageList.replaceChildren(...items.map((it) => {
      const card = el('button', { class: 'stage-card' + (it.locked ? ' locked' : ''), type: 'button', role: 'listitem' });
      card.append(
        el('span', { class: 'name' }, it.name),
        it.blurb ? el('span', { class: 'sub' }, it.blurb) : el('span', { class: 'sub' }, goalSummary(it.goals)),
        el('span', { class: 'sub' }, 'Par ' + ticksToClock(it.par?.ticks ?? 0, 500) + (it.best ? ' · best ' + it.best : '')),
      );
      if (it.locked) {
        card.disabled = true;
        card.title = 'Finish earlier stages to unlock this one';
        card.append(el('span', { class: 'badge' }, 'Locked'));
      } else {
        if (it.won) card.append(el('span', { class: 'badge won' }, 'Cleared'));
        card.addEventListener('click', () => callbacks.onStageChosen(mode, it.id));
      }
      return card;
    }));
  }

  function goalSummary(goals) {
    const parts = [];
    if (goals?.serve) parts.push(`serve ${goals.serve}`);
    if (goals?.earn) parts.push(`earn ${goals.earn}`);
    if (goals?.unlock) parts.push(`unlock ${goals.unlock}`);
    return parts.length ? 'Goals: ' + parts.join(', ') : 'Open play';
  }

  function showSetup(mode, config, ranked) {
    showScreen('setup');
    els.setupHeading.textContent = config.name;
    els.setupSummary.textContent = goalSummary(config.goals) + ' · ' + modeLabel(mode);
    els.setupBlurb.textContent = config.blurb || '';
    els.setupGoals.replaceChildren(...goalLinesFromConfig(config).map((t) => el('li', {}, t)));
    els.setupDuration.textContent = 'Up to ' + ticksToClock(config.maxTicks, 500);
    els.setupRules.textContent = rulesSummary(config);
    els.setupRanked.textContent = ranked ? 'Ranked — replay submitted for verification' : 'Casual — result stays on this device';
  }

  function goalLinesFromConfig(config) {
    const g = config.goals || {};
    const lines = [];
    if (g.serve) lines.push(`Serve ${g.serve} guests`);
    if (g.earn) lines.push(`Earn ${g.earn} coins in sales`);
    if (g.unlock) lines.push(`Have ${g.unlock} departments open`);
    if (g.maxAngry !== undefined) lines.push(`No more than ${g.maxAngry} guests leave angry`);
    return lines.length ? lines : ['Play freely'];
  }

  function rulesSummary(config) {
    const off = Object.entries(config.allowed || {}).filter(([, v]) => !v).map(([k]) => k);
    const bits = [];
    if (config.moveLimit != null) bits.push(`only ${config.moveLimit} moves`);
    if (off.length) bits.push('no ' + off.join(', '));
    if (config.initialStocked === false) bits.push('shelves start empty');
    return bits.length ? 'Special rules: ' + bits.join(' · ') : 'Standard rules';
  }

  function modeLabel(mode) {
    return { learn: 'Lesson', journey: 'Journey', daily: 'Daily', practice: 'Practice', challenge: 'Challenge', score: 'Score chase' }[mode] || mode;
  }

  // ---------------------------------------------------------------- HUD
  function updateHUD(state, session, config, extras = {}) {
    lastState = state;
    lastConfig = config;
    els.hudObjective.textContent = objectiveText(state);
    els.hudMoney.textContent = String(state.money);
    els.hudTime.textContent = ticksToClock(Math.max(0, config.maxTicks - state.tick), 500);
    els.hudServed.textContent = `${state.stats.served} served · ${state.stats.angry} angry`;
    els.hudScore.textContent = String(extras.score ?? session.score().total);
    if (config.moveLimit != null) {
      els.hudMoves.hidden = false;
      els.hudMoves.textContent = `Moves left: ${Math.max(0, config.moveLimit - state.commandCount)}`;
    } else {
      els.hudMoves.hidden = true;
    }
    els.btnUndo.hidden = !session.allowUndo;
    els.btnUndo.disabled = !(extras.undoEnabled ?? session.canUndo());
    els.btnHint.disabled = !(extras.hintEnabled ?? true);
    if (lastPick) showContextPanel(lastPick, state, config);
    if (!els.staffPanel.hidden) showStaffPanel(state);
  }

  // ------------------------------------------------------- context panel
  function cmdButton(label, cmd) {
    const verdict = callbacks.explain(cmd);
    const btn = el('button', { class: 'btn', type: 'button' }, label);
    if (!verdict.ok) {
      btn.disabled = true;
      btn.title = humanizeReason(verdict.reason);
    } else {
      btn.addEventListener('click', () => callbacks.onCommand(cmd));
    }
    return btn;
  }

  function showContextPanel(pick, state, config) {
    lastPick = pick;
    lastState = state;
    lastConfig = config;
    const panel = els.contextPanel;
    panel.replaceChildren();
    if (!pick) { panel.hidden = true; return; }
    panel.hidden = false;

    if (pick.kind === 'display') {
      const d = state.displays.find((x) => x.id === pick.id);
      if (!d) { panel.hidden = true; return; }
      const dept = state.departments.find((x) => x.id === d.deptId);
      panel.append(
        el('h3', {}, `${dept ? dept.name : 'Shelf'} — shelf ${d.id.slice(1)}`),
        el('p', { class: 'detail' }, `Stock ${d.stock}/${d.capacity} · sells for ${d.price} · level ${d.level}`),
        el('div', { class: 'actions' },
          cmdButton(`Restock (cost ${restockCost(d)})`, { type: 'restock', displayId: d.id }),
          cmdButton(
            d.level >= 3 ? 'Upgrade (max level)' : `Upgrade (cost ${upgradeCost(state, 'display', d)})`,
            { type: 'upgrade', targetKind: 'display', targetId: d.id }),
        ),
      );
    } else if (pick.kind === 'checkout') {
      const c = state.checkouts.find((x) => x.id === pick.id);
      if (!c) { panel.hidden = true; return; }
      panel.append(
        el('h3', {}, `Checkout ${c.id.slice(1)}`),
        el('p', { class: 'detail' }, `${c.queue.length} waiting · level ${c.level}`),
        el('div', { class: 'actions' },
          cmdButton(`Serve next guest (${c.queue.length} waiting)`, { type: 'serve', checkoutId: c.id }),
          cmdButton(
            c.level >= 3 ? 'Upgrade (max level)' : `Upgrade (cost ${upgradeCost(state, 'checkout', c)})`,
            { type: 'upgrade', targetKind: 'checkout', targetId: c.id }),
        ),
      );
    } else if (pick.kind === 'department') {
      const dept = state.departments.find((x) => x.id === pick.id);
      if (!dept) { panel.hidden = true; return; }
      panel.append(
        el('h3', {}, dept.name),
        el('p', { class: 'detail' }, dept.unlocked ? 'Open for business' : 'Locked — shelves are greyed out'),
      );
      if (!dept.unlocked) {
        panel.append(el('div', { class: 'actions' },
          cmdButton(`Unlock (cost ${dept.unlockCost})`, { type: 'unlock', deptId: dept.id })));
      }
    } else {
      panel.hidden = true;
      return;
    }
    const close = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Close');
    close.addEventListener('click', () => { hideContextPanel(); callbacks.onPickProxy(null); });
    panel.append(close);
  }

  function hideContextPanel() {
    lastPick = null;
    els.contextPanel.hidden = true;
    els.contextPanel.replaceChildren();
  }

  // --------------------------------------------------------- staff panel
  function showStaffPanel(state) {
    lastState = state;
    const panel = els.staffPanel;
    panel.replaceChildren(el('h3', {}, 'Staff'));
    const roles = [
      { role: 'stocker', name: 'Stocker', does: 'Refills the emptiest shelf every few ticks.' },
      { role: 'cashier', name: 'Cashier', does: 'Serves the longest queue every few ticks.' },
    ];
    for (const r of roles) {
      const s = state.staff[r.role];
      const wrap = el('div', { class: 'detail' });
      wrap.append(el('strong', {}, `${r.name} — ${s.hired ? 'on shift' : `hire for ${s.cost}`}`), el('p', { class: 'hint-text' }, r.does));
      if (!s.hired) wrap.append(cmdButton(`Hire ${r.role} (cost ${s.cost})`, { type: 'hire', role: r.role }));
      panel.append(wrap);
    }
  }

  function toggleStaffPanel(state) {
    const show = els.staffPanel.hidden;
    els.staffPanel.hidden = !show;
    els.btnStaffToggle.setAttribute('aria-expanded', String(show));
    if (show) showStaffPanel(state || lastState);
  }

  // ------------------------------------------------------------ overlays
  function showPause(awayTicks) {
    if (awayTicks != null) {
      els.pauseAwayNote.hidden = false;
      els.pauseAwayNote.textContent = `While you were away, ${awayTicks} tick${awayTicks === 1 ? '' : 's'} went by. The market waited — nothing was simulated.`;
    } else {
      els.pauseAwayNote.hidden = true;
    }
    showScreen('pause');
  }

  function hidePause() {
    if (currentScreen === 'pause') showScreen('game');
  }

  const TERMINAL_TEXT = {
    'goal-complete': 'Every goal met. The neighborhood noticed.',
    'shift-ended': 'The shift ended before all goals were met.',
    'out-of-moves': 'Out of moves — the market could not keep up.',
  };

  function showResults({ session, config, score, newly, best, next, submitted }) {
    showScreen('results');
    const won = session.state.phase === 'won';
    els.resultsHeading.textContent = won ? 'Shift complete' : 'Shift over';
    els.resultsReason.textContent = TERMINAL_TEXT[session.state.terminalReason] || '';
    const rows = [
      ['Guests served', score.components.guests],
      ['Sales revenue', score.components.revenue],
      ['Satisfaction', score.components.satisfaction],
      ['Departments', score.components.departments],
      ['Throughput', score.components.throughput],
      ['Coins in reserve', score.components.reserves],
    ];
    els.resultsTable.replaceChildren(...rows.map(([k, v]) => {
      const tr = el('tr');
      tr.append(el('th', { scope: 'row' }, k), el('td', {}, String(v)));
      return tr;
    }));
    els.resultsTotal.textContent = String(score.total);
    els.resultsTiebreak.textContent =
      `Tiebreak: ${score.tiebreak.goalComplete ? 'goals met' : 'goals missed'} · ${score.tiebreak.invalidCount} invalid action${score.tiebreak.invalidCount === 1 ? '' : 's'} · ${ticksToClock(score.tiebreak.ticksElapsed, 500)} elapsed`;
    if (best != null) {
      els.resultsBest.hidden = false;
      const tag = submitted === 'local' ? ' · saved to the local board'
        : submitted === false ? ' · played offline, not submitted'
        : submitted ? ' · submitted' : '';
      els.resultsBest.textContent = `Best on this stage: ${best}` + tag;
    } else {
      els.resultsBest.hidden = true;
    }
    els.resultsAchievements.replaceChildren(...(newly || []).filter(Boolean).map((a) => {
      const li = el('li');
      li.append(el('strong', {}, 'Achievement: ' + a.name + ' — '), a.desc);
      return li;
    }));
    if (next) {
      els.btnNext.hidden = false;
      els.btnNext.textContent = next.label;
      els.btnNext.onclick = () => callbacks.onNext();
    } else {
      els.btnNext.hidden = true;
      els.btnNext.onclick = null;
    }
    announce(els.resultsHeading.textContent + '. ' + els.resultsReason.textContent, 'assertive');
  }

  // ---------------------------------------------------------------- help
  function showHelp(controlMap = []) {
    showScreen('help');
    const cards = HELP_RULES.map((r) => {
      const card = el('div', { class: 'card' });
      card.append(
        el('h3', {}, ''),
        el('p', {}, r.text),
      );
      card.querySelector('h3').append(el('span', { class: 'help-icon', ariaHidden: 'true' }, r.icon), r.title);
      return card;
    });
    if (controlMap.length) {
      const card = el('div', { class: 'card' });
      card.append(el('h3', {}, 'Controls'));
      const list = el('ul');
      for (const c of controlMap) list.append(el('li', {}, `${c.keys} — ${c.action}`));
      card.append(list);
      cards.push(card);
    }
    els.helpCards.replaceChildren(...cards);
  }

  // ------------------------------------------------------------- settings
  const SETTING_INPUTS = {
    music: 'set-music', effects: 'set-effects', ambience: 'set-ambience', voice: 'set-voice',
    quality: 'set-quality', theme: 'set-theme', camera: 'set-camera', colorblind: 'set-colorblind',
    reducedMotion: 'set-reduced-motion', highContrast: 'set-high-contrast', largeText: 'set-large-text',
    leftHanded: 'set-left-handed', holdToConfirm: 'set-hold-confirm', timingAssist: 'set-timing-assist',
    haptics: 'set-haptics', consentAnalytics: 'set-analytics',
  };

  function showSettings(settings) {
    showScreen('settings');
    for (const [key, id] of Object.entries(SETTING_INPUTS)) {
      const input = $(id);
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = !!settings[key];
      else input.value = settings[key] ?? '';
    }
    return readSettingsForm();
  }

  function readSettingsForm() {
    const patch = {};
    for (const [key, id] of Object.entries(SETTING_INPUTS)) {
      const input = $(id);
      if (!input) continue;
      if (input.type === 'checkbox') patch[key] = input.checked;
      else if (input.type === 'range') patch[key] = Number(input.value);
      else patch[key] = input.value === '' ? null : input.value;
    }
    return patch;
  }

  function wireSettings(themes) {
    const themeSelect = $('set-theme');
    for (const t of themes) themeSelect.append(el('option', { value: t.id }, t.name));
    els.settingsForm.addEventListener('input', (e) => {
      if (e.target === $('btn-replay-tutorials')) return;
      callbacks.onSettings(readSettingsForm());
    });
    els.settingsForm.addEventListener('submit', (e) => e.preventDefault());
  }

  function applySettingsClasses(s) {
    const root = document.documentElement;
    root.classList.toggle('reduced-motion', !!s.reducedMotion);
    root.classList.toggle('high-contrast', !!s.highContrast);
    root.classList.toggle('large-text', !!s.largeText);
    root.classList.toggle('left-handed', !!s.leftHanded);
    root.classList.toggle('hold-confirm', !!s.holdToConfirm);
    root.classList.toggle('timing-assist', !!s.timingAssist);
    for (const m of ['none', 'deuteranopia', 'protanopia', 'tritanopia']) {
      root.classList.toggle('colorblind-' + m, s.colorblind === m);
    }
  }

  // ------------------------------------------------------- announcements
  function announce(msg, priority = 'polite') {
    const region = priority === 'assertive' ? els.alerts : els.live;
    region.textContent = '';
    // reassign on next frame so repeated messages are re-announced
    requestAnimationFrame(() => { region.textContent = msg; });
  }

  function toast(msg, kind = 'info') {
    const node = el('p', { class: 'toast ' + kind, role: 'status' }, msg);
    els.toasts.append(node);
    announce(msg, kind === 'bad' ? 'assertive' : 'polite');
    setTimeout(() => node.remove(), 3200);
  }

  // --------------------------------------------------------- board mirror
  function updateBoardMirror(state, config) {
    lastState = state;
    lastConfig = config;
    const open = state.departments.filter((d) => d.unlocked).length;
    const queued = state.checkouts.reduce((n, c) => n + c.queue.length, 0);
    els.boardMirror.textContent =
      `Tick ${state.tick}/${config.maxTicks} · ${state.money} coins · ` +
      `${open}/${state.departments.length} departments open · ${queued} in line · ` +
      `${state.stats.served} served, ${state.stats.angry} angry`;

    const entries = [];
    for (const d of state.displays) {
      const dept = state.departments.find((x) => x.id === d.deptId);
      entries.push({
        key: 'restock-' + d.id,
        cmd: { type: 'restock', displayId: d.id },
        pick: { kind: 'display', id: d.id },
        label: `Restock ${dept ? dept.name : 'shelf'} shelf ${d.id.slice(1)} — ${d.stock}/${d.capacity} stocked, cost ${restockCost(d)}`,
      });
    }
    for (const c of state.checkouts) {
      entries.push({
        key: 'serve-' + c.id,
        cmd: { type: 'serve', checkoutId: c.id },
        pick: { kind: 'checkout', id: c.id },
        label: `Serve checkout ${c.id.slice(1)} — ${c.queue.length} waiting`,
      });
    }
    for (const dept of state.departments) {
      if (dept.unlocked) continue;
      entries.push({
        key: 'unlock-' + dept.id,
        cmd: { type: 'unlock', deptId: dept.id },
        pick: { kind: 'department', id: dept.id },
        label: `Unlock ${dept.name} — cost ${dept.unlockCost}`,
      });
    }

    const signature = JSON.stringify(entries.map((e) => {
      const v = callbacks.explain(e.cmd);
      return [e.key, e.label, v.ok, v.ok ? '' : v.reason];
    }));
    if (signature === mirrorSignature) return;
    mirrorSignature = signature;

    const focusedKey = els.mirrorList.contains(document.activeElement)
      ? document.activeElement.dataset.key
      : null;

    const list = el('ul');
    for (const e of entries) {
      const verdict = callbacks.explain(e.cmd);
      const btn = el('button', { class: 'btn', type: 'button', dataset: { key: e.key } }, e.label);
      if (!verdict.ok) {
        btn.disabled = true;
        btn.title = humanizeReason(verdict.reason);
      } else {
        btn.addEventListener('click', () => callbacks.onCommand(e.cmd));
      }
      btn.addEventListener('focus', () => callbacks.onPickProxy(e.pick));
      list.append(el('li', {}, ''));
      list.lastChild.append(btn);
    }
    els.mirrorList.replaceChildren(list);
    if (focusedKey) {
      const again = els.mirrorList.querySelector(`[data-key="${focusedKey}"]`);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------ transient
  function showCountdown(text) {
    els.countdown.hidden = false;
    els.countdown.textContent = text;
  }
  function hideCountdown() {
    els.countdown.hidden = true;
  }

  function showTutorial(text) {
    if (text == null) { els.tutorialBanner.hidden = true; return; }
    els.tutorialBanner.hidden = false;
    els.tutorialBanner.textContent = text;
  }

  function setDailyInfo(info) {
    if (!info) { els.dailyChip.hidden = true; return; }
    els.dailyChip.hidden = false;
    els.dailyDate.textContent = info.date;
    els.dailyCountdown.textContent = info.countdownText;
  }

  // ------------------------------------------------------------- static
  function wireStatic() {
    $('btn-play').addEventListener('click', () => callbacks.onPlay());
    $('btn-daily').addEventListener('click', () => callbacks.onModeChosen('daily'));
    $('btn-modes').addEventListener('click', () => callbacks.onModeChosen(null));
    $('btn-help-title').addEventListener('click', () => callbacks.onHelp());
    $('btn-settings-title').addEventListener('click', () => callbacks.onOpenSettings());
    for (const btn of document.querySelectorAll('[data-back]')) {
      btn.addEventListener('click', () => callbacks.onBack(currentScreen));
    }
    $('btn-start').addEventListener('click', () => callbacks.onStart());
    $('btn-pause').addEventListener('click', () => callbacks.onPause());
    $('btn-resume').addEventListener('click', () => callbacks.onResume());
    $('btn-quit').addEventListener('click', () => callbacks.onQuit());
    $('btn-pause-help').addEventListener('click', () => callbacks.onHelp());
    $('btn-pause-settings').addEventListener('click', () => callbacks.onOpenSettings());
    $('btn-retry').addEventListener('click', () => callbacks.onRetry());
    $('btn-results-modes').addEventListener('click', () => callbacks.onModeChosen(null));
    $('btn-help-close').addEventListener('click', () => callbacks.onCloseOverlay('help'));
    $('btn-settings-close').addEventListener('click', () => callbacks.onCloseOverlay('settings'));
    $('btn-undo').addEventListener('click', () => callbacks.onUndo());
    $('btn-hint').addEventListener('click', () => callbacks.onHint());
    els.btnStaffToggle.addEventListener('click', () => toggleStaffPanel());
    $('btn-replay-tutorials').addEventListener('click', () => callbacks.onReplayTutorials());
    $('btn-compat-continue').addEventListener('click', () => callbacks.onCompatContinue());
    $('btn-compat-help').addEventListener('click', () => callbacks.onHelp());
  }

  wireStatic();

  return {
    showScreen,
    showTitle,
    showModeSelect,
    showStageSelect,
    showSetup,
    updateHUD,
    showContextPanel,
    hideContextPanel,
    showStaffPanel,
    toggleStaffPanel,
    showPause,
    hidePause,
    showResults,
    showHelp,
    showSettings,
    wireSettings,
    applySettingsClasses,
    announce,
    toast,
    updateBoardMirror,
    showCountdown,
    hideCountdown,
    showTutorial,
    setDailyInfo,
    humanizeReason,
    get currentScreen() { return currentScreen; },
  };
}
