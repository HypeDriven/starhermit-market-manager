// Node test runner: rules engine, determinism, replay, content validation.
// Run: node tests/rules.test.mjs

import {
  createGame, step, applyCommand, legalActions, validateCommand, computeScore,
  serialize, deserialize, stateHash, verifyReplay, COMMANDS, PHASE, isTerminal, restockCost,
} from '../src/rules.js';
import {
  journeyStages, tutorialStages, challengeStages, practiceConfig, dailyConfig,
  validateAll, autoPlay, THEMES, CONTENT_VERSION,
} from '../src/content.js';

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; failures.push(name); console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, `${name} (expected ${b}, got ${a})`); }
function section(name) { console.log('\n== ' + name); }

const stage1 = journeyStages()[0];

function freshState() { return createGame(stage1); }

// ---------------------------------------------------------------------------
section('construction & serialization');
{
  const s = freshState();
  eq(s.tick, 0, 'initial tick');
  eq(s.phase, PHASE.ACTIVE, 'initial phase');
  eq(s.money, stage1.startingMoney, 'starting money');
  ok(s.displays.length > 0, 'has displays');
  ok(s.checkouts.length > 0, 'has checkouts');
  ok(s.entrance, 'has entrance');

  const json = serialize(s);
  const s2 = deserialize(json);
  eq(stateHash(s), stateHash(s2), 'serialize/deserialize round-trip hash');
  ok(serialize(s) === serialize(s2), 'round-trip stable equality');
}

// ---------------------------------------------------------------------------
section('legal actions & invalid reasons');
{
  const s = freshState();
  s.displays[0].stock = 0; // shelves start full; make room so restock is legal
  const legal = legalActions(s);
  ok(legal.some((a) => a.type === COMMANDS.RESTOCK), 'restock is legal with shelf space');

  const d = s.displays[0];
  eq(validateCommand(s, { type: COMMANDS.RESTOCK, displayId: 'nope' }).reason, 'no-such-display', 'restock unknown display');
  eq(validateCommand(s, { type: COMMANDS.SERVE, checkoutId: s.checkouts[0].id }).reason, 'queue-empty', 'serve empty queue');
  eq(validateCommand(s, { type: COMMANDS.HIRE, role: 'stocker' }).reason, 'not-allowed', 'hire disabled in stage 1');
  eq(validateCommand(s, { type: 'frobnicate' }).reason, 'unknown-command', 'unknown command type');
  eq(validateCommand(s, null).reason, 'malformed-command', 'malformed command');

  // fill a display then restock must be display-full
  const full = structuredClone(s);
  full.displays[0].stock = full.displays[0].capacity;
  eq(validateCommand(full, { type: COMMANDS.RESTOCK, displayId: d.id }).reason, 'display-full', 'restock full display');

  // empty money
  const poor = structuredClone(s);
  poor.money = 0;
  poor.displays[0].stock = 0;
  eq(validateCommand(poor, { type: COMMANDS.RESTOCK, displayId: d.id }).reason, 'not-enough-money', 'restock without money');
}

// ---------------------------------------------------------------------------
section('command application & economy');
{
  let s = freshState();
  const d = s.displays[0];
  s = structuredClone(s);
  // take stock below capacity so restock is legal
  const before = s.money;
  const disp = s.displays[0];
  disp.stock = 0;
  const cost = restockCost(disp);
  const res = applyCommand(s, { id: 'cmd-1', type: COMMANDS.RESTOCK, displayId: d.id, tick: 0 });
  ok(res.ok, 'restock applies');
  eq(res.state.money, before - cost, 'restock deducts cost');
  eq(res.state.displays[0].stock, res.state.displays[0].capacity, 'restock fills display');
  eq(res.state.commandCount, 1, 'command counted');

  // duplicate id is idempotent
  const dup = applyCommand(res.state, { id: 'cmd-1', type: COMMANDS.RESTOCK, displayId: d.id, tick: 0 });
  ok(dup.duplicate, 'duplicate id flagged');
  eq(dup.state.money, res.state.money, 'duplicate does not re-charge');
  eq(dup.state.invalidCount, 0, 'duplicate not counted invalid');

  // invalid command increments invalidCount only
  const bad = applyCommand(res.state, { id: 'cmd-2', type: COMMANDS.RESTOCK, displayId: d.id, tick: 0 });
  ok(!bad.ok, 'invalid restock rejected');
  eq(bad.reason, 'display-full', 'invalid reason preserved');
  eq(bad.state.invalidCount, 1, 'invalid counted');
  eq(bad.state.money, res.state.money, 'invalid does not change money');
}

// ---------------------------------------------------------------------------
section('simulation: customers, queues, serving');
{
  let s = freshState();
  let sawSpawn = false;
  let sawTake = false;
  for (let i = 0; i < 120 && s.phase === PHASE.ACTIVE; i++) {
    s = step(s);
    const ev = s.lastEvents || [];
    if (ev.some((e) => e.kind === 'spawn')) sawSpawn = true;
    if (ev.some((e) => e.kind === 'take')) sawTake = true;
  }
  ok(sawSpawn, 'customers spawn');
  ok(sawTake, 'customers take goods');
  ok(s.stats.spawned > 0, 'spawn stats tracked');

  // serve whoever queues
  let served = 0;
  for (let i = 0; i < 400 && s.phase === PHASE.ACTIVE; i++) {
    for (const c of s.checkouts) {
      if (c.queue.length) {
        const r = applyCommand(s, { id: `srv-${i}-${c.id}`, type: COMMANDS.SERVE, checkoutId: c.id, tick: s.tick });
        if (r.ok) { s = r.state; served++; }
      }
    }
    s = step(s);
  }
  ok(served > 0, 'manual serving works');
  ok(s.stats.revenue > 0, 'revenue earned');
  ok(s.money > stage1.startingMoney - 999, 'money tracked');
}

// ---------------------------------------------------------------------------
section('terminal states & scoring');
{
  const run = autoPlay(stage1);
  eq(run.state.phase, PHASE.WON, 'stage 1 auto-play wins');
  eq(run.state.terminalReason, 'goal-complete', 'terminal reason goal-complete');
  const score = computeScore(run.state);
  ok(score.total > 0, 'score total positive');
  ok(score.components.guests === run.state.stats.served * 100, 'guests component');
  eq(score.tiebreak.goalComplete, 1, 'tiebreak goal complete');

  // a hopeless setup must lose at maxTicks
  const hopeless = structuredClone(stage1);
  hopeless.goals = { serve: 99999 };
  hopeless.maxTicks = 40;
  const run2 = autoPlay(hopeless);
  eq(run2.state.phase, PHASE.LOST, 'impossible goal loses');
  eq(run2.state.terminalReason, 'shift-ended', 'terminal reason shift-ended');

  // stepping a terminal state is a no-op
  const t1 = run.state;
  const t2 = step(t1);
  eq(stateHash(t1), stateHash(t2), 'terminal state frozen');
}

// ---------------------------------------------------------------------------
section('determinism & replay');
{
  function scriptedRun(seedOffset) {
    let s = createGame({ ...stage1, seed: stage1.seed + seedOffset });
    const hashes = [{ tick: 0, hash: stateHash(s) }];
    const commands = [];
    for (let i = 0; i < 250 && !isTerminal(s); i++) {
      // record arrival hash (pre-command) for this tick
      if (s.tick % 25 === 0 && !hashes.some((h) => h.tick === s.tick)) {
        hashes.push({ tick: s.tick, hash: stateHash(s) });
      }
      const legal = legalActions(s);
      const serve = legal.find((a) => a.type === COMMANDS.SERVE);
      const restock = legal.find((a) => a.type === COMMANDS.RESTOCK);
      const pick = serve || (i % 3 === 0 ? restock : null);
      if (pick) {
        const cmd = { ...pick, id: 'r' + i, tick: s.tick };
        commands.push(cmd);
        s = applyCommand(s, cmd).state;
      }
      if (!isTerminal(s)) s = step(s);
    }
    return { state: s, commands, hashes };
  }

  const a = scriptedRun(0);
  const b = scriptedRun(0);
  eq(stateHash(a.state), stateHash(b.state), 'same seed + commands => identical hash');

  const c = scriptedRun(77);
  ok(stateHash(a.state) !== stateHash(c.state), 'different seed diverges');

  const envelope = {
    schemaVersion: 1, buildVersion: 1, contentVersion: CONTENT_VERSION,
    seed: stage1.seed, config: stage1, initialHash: null,
    commands: a.commands, hashes: a.hashes,
    finalHash: stateHash(a.state),
    result: { phase: a.state.phase, total: computeScore(a.state).total },
  };
  const v = verifyReplay(envelope);
  ok(v.ok, 'replay verifies: ' + v.failures.join('; '));

  const tampered = structuredClone(envelope);
  tampered.commands = tampered.commands.slice(1);
  const v2 = verifyReplay(tampered);
  ok(!v2.ok, 'tampered replay rejected');
}

// ---------------------------------------------------------------------------
section('fuzz: malformed commands never hang or corrupt');
{
  let s = freshState();
  const junk = [
    undefined, null, 42, 'restock', {}, { type: 5 }, { type: 'restock' },
    { type: 'restock', displayId: {} }, { type: 'serve' }, { type: 'hire', role: [1] },
    { type: 'upgrade', targetKind: 'x', targetId: NaN }, { type: 'unlock', deptId: '' },
    { type: 'restock', displayId: 'd1'.repeat(500) },
  ];
  for (let i = 0; i < junk.length; i++) {
    const r = applyCommand(s, { ...(typeof junk[i] === 'object' && junk[i] ? junk[i] : { junk: true }), id: 'fz' + i, tick: 0 });
    s = r.state;
    ok(Number.isFinite(s.money), 'money stays finite after junk #' + i);
  }
  for (let i = 0; i < 300; i++) {
    s = step(s);
    if (!Number.isFinite(s.money) || !Number.isFinite(s.tick)) { ok(false, 'finite state during fuzz ticks'); break; }
  }
  ok(true, 'fuzz ticks completed');
}

// ---------------------------------------------------------------------------
section('content validation (all stages solvable by greedy bot)');
{
  const report = validateAll();
  const bad = report.filter((r) => !r.ok);
  for (const r of bad) console.error('  invalid:', r.id, r.problems.join('; '));
  eq(bad.length, 0, `all ${report.length} configs validate and are winnable`);
  ok(journeyStages().length >= 40, 'at least 40 journey stages');
  eq(tutorialStages().length, 4, 'tutorial lessons present');
  ok(challengeStages().length >= 5, 'challenge stages present');
  eq(THEMES.length, 5, 'five themes');
}

// ---------------------------------------------------------------------------
section('move limit & challenge rules');
{
  const ch = challengeStages().find((c) => c.moveLimit);
  let s = createGame(ch);
  s.commandCount = ch.moveLimit; // simulate having spent every move
  eq(validateCommand(s, { type: COMMANDS.RESTOCK, displayId: s.displays[0].id }).reason, 'no-moves-left', 'commands blocked after limit');
}

// ---------------------------------------------------------------------------
section('daily determinism');
{
  const d1 = dailyConfig('2026-08-19');
  const d2 = dailyConfig('2026-08-19');
  const d3 = dailyConfig('2026-08-20');
  eq(JSON.stringify(d1), JSON.stringify(d2), 'same day => same config');
  ok(d1.seed !== d3.seed, 'different day => different seed');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('Failures:', failures); process.exit(1); }
