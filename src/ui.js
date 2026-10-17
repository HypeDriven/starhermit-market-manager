// Market Manager — DOM shell: screens, HUD, panels, accessibility mirror.
// No game-rules logic lives here; ui.js only formats state and forwards
// callbacks. All DOM access happens inside createUI() so the module imports
// cleanly outside a browser.

import { restockCost, upgradeCost } from './rules.js';
import { T, N } from './i18n.js';

// Stable reason codes -> short human explanations.
export const REASON_TEXT = {
  'display-full': N('That shelf is already full'),
  'queue-empty': N('No one is waiting there'),
  'not-enough-money': N('Not enough coins'),
  'department-locked': N('That department is still locked'),
  'max-level': N('Already fully upgraded'),
  'already-hired': N('Already on the team'),
  'already-unlocked': N('Already unlocked'),
  'no-moves-left': N('Out of moves'),
  'game-over': N('This shift has ended'),
  'not-allowed': N('Not allowed in this stage'),
  'no-such-display': N('No shelf there'),
  'no-such-checkout': N('No checkout there'),
  'no-such-role': N('No such role'),
  'no-such-target': N('Nothing to upgrade there'),
  'no-such-department': N('No such department'),
  'malformed-command': N('That action did not make sense'),
  'unknown-command': N('Unknown action'),
};

export function humanizeReason(reason) {
  return T(REASON_TEXT[reason] || N('That will not work right now'));
}

const MODES = [
  { id: 'learn', name: N('Learn'), blurb: N('Four short lessons that teach one rule at a time by doing.'), duration: N('2–4 min each'), standing: 'casual', standingText: N('Practice · not ranked') },
  { id: 'journey', name: N('Journey'), blurb: N('Forty authored stages, from first shift to market legend.'), duration: N('3–8 min each'), standing: 'casual', standingText: N('Progress saved locally') },
  { id: 'daily', name: N('Daily'), blurb: N('One shared market per UTC day. Same seed for everyone.'), duration: N('~4 min'), standing: 'ranked', standingText: N('Local board · personal best') },
  { id: 'practice', name: N('Practice'), blurb: N('Pick a pace and play freely. Undo is allowed here.'), duration: N('3–5 min'), standing: 'casual', standingText: N('Not ranked · undo on') },
  { id: 'challenge', name: N('Challenge'), blurb: N('Five constrained stages: move limits, speed, altered floors.'), duration: N('2–6 min each'), standing: 'casual', standingText: N('Progress saved locally') },
  { id: 'score', name: N('Score chase'), blurb: N('Play any beaten stage for a higher score on the board.'), duration: N('3–8 min'), standing: 'ranked', standingText: N('Local board · personal best') },
];

const HELP_RULES = [
  { icon: '1', title: N('Restock shelves'), text: N('Guests buy from stocked shelves. Tap a shelf (or its button) to refill it from the stockroom. Refilling costs coins per item.') },
  { icon: '2', title: N('Serve the queue'), text: N('Guests with goods line up at a checkout. Tap the counter to serve the next guest before their patience runs out.') },
  { icon: '3', title: N('Unlock departments'), text: N('Greyed-out shelves belong to locked departments. Pay the unlock cost to open them and raise your goal progress.') },
  { icon: '4', title: N('Upgrade stations'), text: N('Upgraded shelves hold more and sell for more. Upgraded checkouts keep queued guests patient longer.') },
  { icon: '5', title: N('Hire staff'), text: N('A stocker refills the emptiest shelf every few ticks; a cashier serves the longest queue. Staff act on their own.') },
  { icon: '6', title: N('Win the shift'), text: N('Meet every goal — guests served, coins earned, departments unlocked — before the shift timer ends. Fewer angry guests means a better score.') },
];

// Content names (content.js) are English data; they translate at display time.
// "Practice — Relaxed" / "Daily Market — 2026-10-16" are composed here.
export function stageName(name) {
  const s = String(name || '');
  let m = /^Practice — (\w+)$/.exec(s);
  if (m) return T('Practice — {pace}', { pace: T(m[1]) });
  m = /^Daily Market — (.+)$/.exec(s);
  if (m) return T('Daily Market — {date}', { date: m[1] });
  return T(s);
}
export const deptName = (name) => T(name);

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
    playerChip: $('player-chip'),
    journeySummary: $('journey-progress-summary'),
    modeCards: $('mode-cards'),
    stageHeading: $('stage-heading'), stageList: $('stage-list'),
    setupHeading: $('setup-heading'), setupSummary: $('setup-summary'), setupBlurb: $('setup-blurb'),
    setupGoals: $('setup-goals'), setupDuration: $('setup-duration'),
    setupRules: $('setup-rules'), setupRanked: $('setup-ranked'),
    setupBoardLabel: $('setup-board-label'), setupBoard: $('setup-board'),
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
    resultsTiebreak: $('results-tiebreak'), resultsBest: $('results-best'), resultsLb: $('results-lb'),
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
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k in node && k !== 'list' && k !== 'type' && k !== 'for') node[k] = v;
      else node.setAttribute(k, v);
    }
    // Children may be text or nodes (e.g. an actions row of command buttons).
    node.append(...children.filter((c) => c != null));
    return node;
  }

  function goalLines(state) {
    const g = state.config.goals;
    const lines = [];
    if (g.serve) lines.push({ key: 'serve', text: T('Serve {n} guests', { n: g.serve }), cur: state.stats.served, max: g.serve });
    if (g.earn) lines.push({ key: 'earn', text: T('Earn {n} coins', { n: g.earn }), cur: state.stats.revenue, max: g.earn });
    if (g.unlock) {
      const have = state.departments.filter((d) => d.unlocked).length;
      lines.push({ key: 'unlock', text: T('Unlock {n} departments', { n: g.unlock }), cur: have, max: g.unlock });
    }
    if (g.maxAngry !== undefined) lines.push({ key: 'calm', text: T('Keep angry guests at {n} or fewer', { n: g.maxAngry }), cur: state.stats.angry, max: g.maxAngry, soft: true });
    return lines;
  }

  function objectiveText(state) {
    const GOAL_WORDS = { serve: N('serve {cur}/{max}'), earn: N('earn {cur}/{max}'), unlock: N('unlock {cur}/{max}') };
    const parts = goalLines(state).map((l) => {
      if (l.key === 'calm') return T('angry {cur}/{max} max', { cur: l.cur, max: l.max });
      return T(GOAL_WORDS[l.key], { cur: Math.min(l.cur, l.max), max: l.max });
    });
    return parts.length ? T('Goals — {list}', { list: parts.join(' · ') }) : T('Free play');
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
        ? T('Journey: {won} of 40 stages complete · {guests} guests served all time', { won, guests: progress.guestsServedTotal || 0 })
        : T('New around here? Start with Learn, or jump straight into Journey.');
    }
  }

  function showModeSelect(hosted = false) {
    showScreen('mode-select');
    els.modeCards.replaceChildren(...MODES.map((m) => {
      const card = el('button', { class: 'card', type: 'button' });
      const standingText = hosted && (m.id === 'journey' || m.id === 'challenge')
        ? T('Progress synced · posts to the platform leaderboard')
        : hosted && (m.id === 'daily' || m.id === 'score')
          ? T('Personal best · posts to the platform leaderboard')
          : T(m.standingText);
      card.append(
        el('h3', {}, T(m.name)),
        el('p', {}, T(m.blurb)),
        el('p', { class: 'meta' }, T('About {duration}', { duration: T(m.duration) })),
        el('p', { class: 'meta ' + m.standing }, standingText),
      );
      card.addEventListener('click', () => callbacks.onModeChosen(m.id));
      return card;
    }));
  }

  const MODE_HEADINGS = {
    learn: N('Lessons'), journey: N('Journey stages'), daily: N('Daily market'),
    practice: N('Practice pace'), challenge: N('Challenges'), score: N('Score chase — pick a stage'),
  };

  function showStageSelect(mode, items) {
    showScreen('stage-select');
    els.stageHeading.textContent = T(MODE_HEADINGS[mode] || N('Stages'));
    els.stageList.replaceChildren(...items.map((it) => {
      const card = el('button', { class: 'stage-card' + (it.locked ? ' locked' : ''), type: 'button' });
      card.append(
        el('span', { class: 'name' }, stageName(it.name)),
        it.blurb ? el('span', { class: 'sub' }, T(it.blurb)) : el('span', { class: 'sub' }, goalSummary(it.goals)),
        el('span', { class: 'sub' }, it.best
          ? T('Par {time} · best {best}', { time: ticksToClock(it.par?.ticks ?? 0, 500), best: it.best })
          : T('Par {time}', { time: ticksToClock(it.par?.ticks ?? 0, 500) })),
      );
      if (it.locked) {
        card.disabled = true;
        card.title = T('Finish earlier stages to unlock this one');
        card.append(el('span', { class: 'badge' }, T('Locked')));
      } else {
        if (it.won) card.append(el('span', { class: 'badge won' }, T('Cleared')));
        card.addEventListener('click', () => callbacks.onStageChosen(mode, it.id));
      }
      return card;
    }));
  }

  function goalSummary(goals) {
    const parts = [];
    if (goals?.serve) parts.push(T('serve {n}', { n: goals.serve }));
    if (goals?.earn) parts.push(T('earn {n}', { n: goals.earn }));
    if (goals?.unlock) parts.push(T('unlock {n}', { n: goals.unlock }));
    return parts.length ? T('Goals: {list}', { list: parts.join(', ') }) : T('Open play');
  }

  function showSetup(mode, config, hosted = false) {
    showScreen('setup');
    els.setupHeading.textContent = stageName(config.name);
    els.setupSummary.textContent = goalSummary(config.goals) + ' · ' + modeLabel(mode);
    els.setupBlurb.textContent = config.blurb ? T(config.blurb) : '';
    els.setupGoals.replaceChildren(...goalLinesFromConfig(config).map((t) => el('li', {}, t)));
    els.setupDuration.textContent = T('Up to {time}', { time: ticksToClock(config.maxTicks, 500) });
    els.setupRules.textContent = rulesSummary(config);
    els.setupRanked.textContent = hosted
        ? (mode === 'learn' || mode === 'practice'
          ? T('Casual — progress syncs to your account')
          : T('Ranked — your total posts to the platform leaderboard'))
        : T('Casual — result stays on this device');
    // Refilled by showSetupBoard once the board read resolves.
    els.setupBoardLabel.hidden = true;
    els.setupBoard.hidden = true;
    els.setupBoard.replaceChildren();
  }

  function showSetupBoard(entries, label) {
    if (!Array.isArray(entries) || !entries.length) {
      els.setupBoardLabel.hidden = true;
      els.setupBoard.hidden = true;
      return;
    }
    els.setupBoardLabel.hidden = false;
    els.setupBoardLabel.textContent = T(label);
    els.setupBoard.hidden = false;
    els.setupBoard.replaceChildren(...entries.slice(0, 10).map((e, i) => {
      const li = el('li', {});
      li.append(
        el('span', { class: 'board-rank' }, `#${e.rank != null ? e.rank : i + 1}`),
        el('span', {}, ` ${e.name || T('Player')} — `),
        el('strong', {}, String(e.score != null ? e.score : 0)),
      );
      return li;
    }));
  }

  function setPlayerInfo({ nickname, status, hosted } = {}) {
    if (!hosted) { els.playerChip.hidden = true; return; }
    const syncText = {
      synced: N('progress synced to your account'),
      saving: N('saving…'),
      offline: N('offline — will sync later'),
      error: N('sync problem — progress is safe on this device'),
    }[status];
    els.playerChip.hidden = false;
    const who = T('Playing as {name}', { name: nickname || T('Player') });
    els.playerChip.textContent = syncText ? who + ' · ' + T(syncText) : who;
  }

  // StarHermit account buttons on the title screen.
  function wireAccount({ labels, onSignIn, onInvite }) {
    const signIn = $('btn-signin');
    const invite = $('btn-invite');
    labelAccount(labels);
    signIn.addEventListener('click', onSignIn);
    invite.addEventListener('click', onInvite);
  }
  function labelAccount(labels) {
    $('btn-signin').textContent = labels.signIn;
    $('btn-invite').textContent = labels.invite;
  }
  function setAccountButtons({ signIn, invite }) {
    $('btn-signin').hidden = !signIn;
    $('btn-invite').hidden = !invite;
    $('account-row').hidden = !signIn && !invite;
  }

  function goalLinesFromConfig(config) {
    const g = config.goals || {};
    const lines = [];
    if (g.serve) lines.push(T('Serve {n} guests', { n: g.serve }));
    if (g.earn) lines.push(T('Earn {n} coins in sales', { n: g.earn }));
    if (g.unlock) lines.push(T('Have {n} departments open', { n: g.unlock }));
    if (g.maxAngry !== undefined) lines.push(T('No more than {n} guests leave angry', { n: g.maxAngry }));
    return lines.length ? lines : [T('Play freely')];
  }

  function rulesSummary(config) {
    const ACTION_WORDS = { restock: N('restock'), serve: N('serve'), unlock: N('unlock'), upgrade: N('upgrade'), hire: N('hire'), undo: N('undo') };
    const off = Object.entries(config.allowed || {}).filter(([, v]) => !v).map(([k]) => (ACTION_WORDS[k] ? T(ACTION_WORDS[k]) : k));
    const bits = [];
    if (config.moveLimit != null) bits.push(T('only {n} moves', { n: config.moveLimit }));
    if (off.length) bits.push(T('no {list}', { list: off.join(', ') }));
    if (config.initialStocked === false) bits.push(T('shelves start empty'));
    return bits.length ? T('Special rules: {list}', { list: bits.join(' · ') }) : T('Standard rules');
  }

  function modeLabel(mode) {
    const label = { learn: N('Lesson'), journey: N('Journey'), daily: N('Daily'), practice: N('Practice'), challenge: N('Challenge'), score: N('Score chase') }[mode];
    return label ? T(label) : mode;
  }

  // ---------------------------------------------------------------- HUD
  function updateHUD(state, session, config, extras = {}) {
    lastState = state;
    lastConfig = config;
    els.hudObjective.textContent = objectiveText(state);
    els.hudMoney.textContent = String(state.money);
    els.hudTime.textContent = ticksToClock(Math.max(0, config.maxTicks - state.tick), 500);
    els.hudServed.textContent = T('{served} served · {angry} angry', { served: state.stats.served, angry: state.stats.angry });
    els.hudScore.textContent = String(extras.score ?? session.score().total);
    if (config.moveLimit != null) {
      els.hudMoves.hidden = false;
      els.hudMoves.textContent = T('Moves left: {n}', { n: Math.max(0, config.moveLimit - state.commandCount) });
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
    const btn = el('button', { class: 'btn', type: 'button', dataset: { cmd: JSON.stringify(cmd) } }, label);
    if (!verdict.ok) {
      btn.disabled = true;
      btn.title = humanizeReason(verdict.reason);
    } else {
      btn.addEventListener('click', () => callbacks.onCommand(cmd));
    }
    return btn;
  }

  // Panels are rebuilt on every state change (each tick). Without this, a
  // keyboard user focused inside a panel loses focus twice a second.
  function preserveFocus(panel, rebuild) {
    const focusCmd = panel.contains(document.activeElement)
      ? document.activeElement.dataset.cmd
      : null;
    rebuild();
    if (focusCmd) {
      const again = panel.querySelector(`[data-cmd="${CSS.escape(focusCmd)}"]`);
      if (again && !again.disabled) again.focus({ preventScroll: true });
    }
  }

  function showContextPanel(pick, state, config) {
    lastPick = pick;
    lastState = state;
    lastConfig = config;
    preserveFocus(els.contextPanel, () => buildContextPanel(pick, state, config));
  }

  function buildContextPanel(pick, state, config) {
    const panel = els.contextPanel;
    panel.replaceChildren();
    if (!pick) { panel.hidden = true; return; }
    panel.hidden = false;

    if (pick.kind === 'display') {
      const d = state.displays.find((x) => x.id === pick.id);
      if (!d) { panel.hidden = true; return; }
      const dept = state.departments.find((x) => x.id === d.deptId);
      panel.append(
        el('h3', {}, T('{dept} — shelf {n}', { dept: dept ? deptName(dept.name) : T('Shelf'), n: d.id.slice(1) })),
        el('p', { class: 'detail' }, T('Stock {stock}/{cap} · sells for {price} · level {level}', { stock: d.stock, cap: d.capacity, price: d.price, level: d.level })),
        el('div', { class: 'actions' },
          cmdButton(T('Restock (cost {n})', { n: restockCost(d) }), { type: 'restock', displayId: d.id }),
          cmdButton(
            d.level >= 3 ? T('Upgrade (max level)') : T('Upgrade (cost {n})', { n: upgradeCost(state, 'display', d) }),
            { type: 'upgrade', targetKind: 'display', targetId: d.id }),
        ),
      );
    } else if (pick.kind === 'checkout') {
      const c = state.checkouts.find((x) => x.id === pick.id);
      if (!c) { panel.hidden = true; return; }
      panel.append(
        el('h3', {}, T('Checkout {n}', { n: c.id.slice(1) })),
        el('p', { class: 'detail' }, T('{n} waiting · level {level}', { n: c.queue.length, level: c.level })),
        el('div', { class: 'actions' },
          cmdButton(T('Serve next guest ({n} waiting)', { n: c.queue.length }), { type: 'serve', checkoutId: c.id }),
          cmdButton(
            c.level >= 3 ? T('Upgrade (max level)') : T('Upgrade (cost {n})', { n: upgradeCost(state, 'checkout', c) }),
            { type: 'upgrade', targetKind: 'checkout', targetId: c.id }),
        ),
      );
    } else if (pick.kind === 'department') {
      const dept = state.departments.find((x) => x.id === pick.id);
      if (!dept) { panel.hidden = true; return; }
      panel.append(
        el('h3', {}, deptName(dept.name)),
        el('p', { class: 'detail' }, dept.unlocked ? T('Open for business') : T('Locked — shelves are greyed out')),
      );
      if (!dept.unlocked) {
        panel.append(el('div', { class: 'actions' },
          cmdButton(T('Unlock (cost {n})', { n: dept.unlockCost }), { type: 'unlock', deptId: dept.id })));
      }
    } else {
      panel.hidden = true;
      return;
    }
    const close = el('button', { class: 'btn btn-ghost', type: 'button', dataset: { cmd: 'close' } }, T('Close'));
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
    preserveFocus(els.staffPanel, () => buildStaffPanel(state));
  }

  function buildStaffPanel(state) {
    const panel = els.staffPanel;
    panel.replaceChildren(el('h3', {}, T('Staff')));
    const roles = [
      { role: 'stocker', name: N('Stocker'), does: N('Refills the emptiest shelf every few ticks.'), hire: N('Hire stocker (cost {n})') },
      { role: 'cashier', name: N('Cashier'), does: N('Serves the longest queue every few ticks.'), hire: N('Hire cashier (cost {n})') },
    ];
    for (const r of roles) {
      const s = state.staff[r.role];
      const wrap = el('div', { class: 'detail' });
      wrap.append(el('strong', {}, `${T(r.name)} — ${s.hired ? T('on shift') : T('hire for {n}', { n: s.cost })}`), el('p', { class: 'hint-text' }, T(r.does)));
      if (!s.hired) wrap.append(cmdButton(T(r.hire, { n: s.cost }), { type: 'hire', role: r.role }));
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
      els.pauseAwayNote.textContent = T(awayTicks === 1
        ? 'While you were away, {n} tick went by. The market waited — nothing was simulated.'
        : 'While you were away, {n} ticks went by. The market waited — nothing was simulated.', { n: awayTicks });
    } else {
      els.pauseAwayNote.hidden = true;
    }
    showScreen('pause');
  }

  function hidePause() {
    if (currentScreen === 'pause') showScreen('game');
  }

  const TERMINAL_TEXT = {
    'goal-complete': N('Every goal met. The neighborhood noticed.'),
    'shift-ended': N('The shift ended before all goals were met.'),
    'out-of-moves': N('Out of moves — the market could not keep up.'),
  };

  function showResults({ session, config, score, newly, best, next, submitted, rank, lbLine }) {
    showScreen('results');
    const won = session.state.phase === 'won';
    els.resultsHeading.textContent = won ? T('Shift complete') : T('Shift over');
    els.resultsReason.textContent = TERMINAL_TEXT[session.state.terminalReason] ? T(TERMINAL_TEXT[session.state.terminalReason]) : '';
    const rows = [
      [T('Guests served'), score.components.guests],
      [T('Sales revenue'), score.components.revenue],
      [T('Satisfaction'), score.components.satisfaction],
      [T('Departments'), score.components.departments],
      [T('Throughput'), score.components.throughput],
      [T('Coins in reserve'), score.components.reserves],
    ];
    els.resultsTable.replaceChildren(...rows.map(([k, v]) => {
      const tr = el('tr');
      tr.append(el('th', { scope: 'row' }, k), el('td', {}, String(v)));
      return tr;
    }));
    els.resultsTotal.textContent = String(score.total);
    els.resultsTiebreak.textContent = T('Tiebreak: {goals} · {invalid} · {time} elapsed', {
      goals: score.tiebreak.goalComplete ? T('goals met') : T('goals missed'),
      invalid: T(score.tiebreak.invalidCount === 1 ? '{n} invalid action' : '{n} invalid actions', { n: score.tiebreak.invalidCount }),
      time: ticksToClock(score.tiebreak.ticksElapsed, 500),
    });
    const rankText = typeof rank === 'number' && rank > 0 ? ' · ' + T('rank #{rank}', { rank }) : '';
    if (best != null || submitted) {
      els.resultsBest.hidden = false;
      const tag = submitted === 'local' ? ' · ' + T('saved to the local board') + rankText
        : submitted === false ? ' · ' + T('not recorded') : '';
      els.resultsBest.textContent = (best != null ? T('Best on this stage: {best}', { best }) : T('Result recorded')) + tag;
    } else {
      els.resultsBest.hidden = true;
    }
    setLeaderboardLine(lbLine || null);
    els.resultsAchievements.replaceChildren(...(newly || []).filter(Boolean).map((a) => {
      const li = el('li');
      li.append(el('strong', {}, T('Achievement: {name}', { name: T(a.name) }) + ' — '), T(a.desc));
      return li;
    }));
    if (next) {
      els.btnNext.hidden = false;
      els.btnNext.textContent = T('Next: {name}', { name: stageName(next.name) });
      els.btnNext.onclick = () => callbacks.onNext();
    } else {
      els.btnNext.hidden = true;
      els.btnNext.onclick = null;
    }
    announce(els.resultsHeading.textContent + '. ' + els.resultsReason.textContent, 'assertive');
  }

  // Platform leaderboard status on the results screen (hidden when null).
  function setLeaderboardLine(text) {
    els.resultsLb.hidden = !text;
    els.resultsLb.textContent = text || '';
  }

  // ---------------------------------------------------------------- help
  function showHelp(controlMap = []) {
    showScreen('help');
    const cards = HELP_RULES.map((r) => {
      const card = el('div', { class: 'card' });
      card.append(
        el('h3', {}, ''),
        el('p', {}, T(r.text)),
      );
      card.querySelector('h3').append(el('span', { class: 'help-icon', ariaHidden: 'true' }, r.icon), T(r.title));
      return card;
    });
    if (controlMap.length) {
      const card = el('div', { class: 'card' });
      card.append(el('h3', {}, T('Controls')));
      const list = el('ul');
      for (const c of controlMap) list.append(el('li', {}, `${T(c.keys)} — ${T(c.action)}`));
      card.append(list);
      cards.push(card);
    }
    els.helpCards.replaceChildren(...cards);
  }

  // ------------------------------------------------------------- settings
  const SETTING_INPUTS = {
    music: 'set-music', effects: 'set-effects', ambience: 'set-ambience', voice: 'set-voice',
    theme: 'set-theme', camera: 'set-camera', colorblind: 'set-colorblind',
    reducedMotion: 'set-reduced-motion', highContrast: 'set-high-contrast', largeText: 'set-large-text',
    leftHanded: 'set-left-handed', holdToConfirm: 'set-hold-confirm', timingAssist: 'set-timing-assist',
    haptics: 'set-haptics',
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
    for (const t of themes) themeSelect.append(el('option', { value: t.id, dataset: { i18n: t.name } }, T(t.name)));
    els.settingsForm.addEventListener('input', (e) => {
      if (e.target === $('btn-replay-tutorials')) return;
      if (e.target.closest && e.target.closest('#gfx-section')) return; // gfx-panel.js owns these
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
  function announce(key, priority = 'polite', vars) {
    const msg = T(key, vars);
    const region = priority === 'assertive' ? els.alerts : els.live;
    region.textContent = '';
    // reassign on next frame so repeated messages are re-announced
    requestAnimationFrame(() => { region.textContent = msg; });
  }

  function toast(key, kind = 'info', vars) {
    const msg = T(key, vars);
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
    els.boardMirror.textContent = T('Tick {tick}/{max} · {money} coins · {open}/{depts} departments open · {queued} in line · {served} served, {angry} angry', {
      tick: state.tick, max: config.maxTicks, money: state.money, open, depts: state.departments.length,
      queued, served: state.stats.served, angry: state.stats.angry,
    });

    const entries = [];
    for (const d of state.displays) {
      const dept = state.departments.find((x) => x.id === d.deptId);
      entries.push({
        key: 'restock-' + d.id,
        cmd: { type: 'restock', displayId: d.id },
        pick: { kind: 'display', id: d.id },
        label: T('Restock {dept} shelf {n} — {stock}/{cap} stocked, cost {cost}', { dept: dept ? deptName(dept.name) : '', n: d.id.slice(1), stock: d.stock, cap: d.capacity, cost: restockCost(d) }),
      });
    }
    for (const c of state.checkouts) {
      entries.push({
        key: 'serve-' + c.id,
        cmd: { type: 'serve', checkoutId: c.id },
        pick: { kind: 'checkout', id: c.id },
        label: T('Serve checkout {n} — {waiting} waiting', { n: c.id.slice(1), waiting: c.queue.length }),
      });
    }
    // Upgrades are core actions; without mirror entries, keyboard-only
    // players had no path to them (the context panel is pointer-opened).
    for (const d of state.displays) {
      const dept = state.departments.find((x) => x.id === d.deptId);
      entries.push({
        key: 'upgrade-' + d.id,
        cmd: { type: 'upgrade', targetKind: 'display', targetId: d.id },
        pick: { kind: 'display', id: d.id },
        label: d.level >= 3
          ? T('Upgrade {dept} shelf {n} — level {level} (max)', { dept: dept ? deptName(dept.name) : '', n: d.id.slice(1), level: d.level })
          : T('Upgrade {dept} shelf {n} — level {level}, cost {cost}', { dept: dept ? deptName(dept.name) : '', n: d.id.slice(1), level: d.level, cost: upgradeCost(state, 'display', d) }),
      });
    }
    for (const c of state.checkouts) {
      entries.push({
        key: 'upgrade-' + c.id,
        cmd: { type: 'upgrade', targetKind: 'checkout', targetId: c.id },
        pick: { kind: 'checkout', id: c.id },
        label: c.level >= 3
          ? T('Upgrade checkout {n} — level {level} (max)', { n: c.id.slice(1), level: c.level })
          : T('Upgrade checkout {n} — level {level}, cost {cost}', { n: c.id.slice(1), level: c.level, cost: upgradeCost(state, 'checkout', c) }),
      });
    }
    for (const dept of state.departments) {
      if (dept.unlocked) continue;
      entries.push({
        key: 'unlock-' + dept.id,
        cmd: { type: 'unlock', deptId: dept.id },
        pick: { kind: 'department', id: dept.id },
        label: T('Unlock {dept} — cost {cost}', { dept: deptName(dept.name), cost: dept.unlockCost }),
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
    els.countdown.textContent = T(text);
  }
  function hideCountdown() {
    els.countdown.hidden = true;
  }

  let tutorialKey = null;
  function showTutorial(text) {
    tutorialKey = text;
    if (text == null) { els.tutorialBanner.hidden = true; return; }
    els.tutorialBanner.hidden = false;
    els.tutorialBanner.textContent = T(text);
  }
  /** Language changed: re-render the live parts of the game screen in place. */
  function relocalizeGame() {
    if (tutorialKey != null) els.tutorialBanner.textContent = T(tutorialKey);
    mirrorSignature = '';
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
    showSetupBoard,
    setPlayerInfo,
    wireAccount,
    setAccountButtons,
    updateHUD,
    showContextPanel,
    hideContextPanel,
    showStaffPanel,
    toggleStaffPanel,
    showPause,
    hidePause,
    showResults,
    setLeaderboardLine,
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
    relocalizeGame,
    labelAccount,
    setDailyInfo,
    humanizeReason,
    get currentScreen() { return currentScreen; },
  };
}
