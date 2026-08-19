// Market Manager — pure deterministic rules engine.
// No DOM, no rendering, no timers. State is plain JSON and fully serializable.
// All mutations happen through validated commands or the fixed step() tick.

import { createRng, hashState, stableStringify } from './rng.js';

export const RULES_VERSION = 1;
export const TICK_MS = 500; // presentation pacing only; logic is per-tick

export const TILE = { FLOOR: 0, WALL: 1, ENTRANCE: 2, STOCKROOM: 3, DISPLAY: 4, CHECKOUT: 5 };

export const COMMANDS = {
  RESTOCK: 'restock',
  SERVE: 'serve',
  HIRE: 'hire',
  UPGRADE: 'upgrade',
  UNLOCK: 'unlock',
};

export const PHASE = { ACTIVE: 'active', WON: 'won', LOST: 'lost' };

// Fixed neighbor order: pathfinding and adjacency are deterministic.
const DIRS = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

const MAX_UPGRADE_LEVEL = 3;
const DUPLICATE_ID_WINDOW = 64;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

// config: resolved stage config from content.js (see content.js for schema).
export function createGame(config) {
  const grid = parseMap(config.map);
  const departments = config.departments.map((d) => ({
    id: d.id,
    key: d.key,
    name: d.name,
    unlocked: !!d.startUnlocked,
    unlockCost: d.unlockCost || 0,
  }));

  const displays = [];
  const checkouts = [];
  let entrance = null;
  let stockroom = null;
  let nextDisplayNum = 1;
  let nextCheckoutNum = 1;

  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      const cell = grid.cells[y][x];
      if (cell.t === TILE.ENTRANCE) entrance = { x, y };
      else if (cell.t === TILE.STOCKROOM) stockroom = { x, y };
      else if (cell.t === TILE.DISPLAY) {
        const dept = config.departments.find((d) => d.key === cell.dept);
        if (!dept) throw new Error(`map display references unknown department key '${cell.dept}'`);
        displays.push({
          id: 'd' + nextDisplayNum++,
          deptId: dept.id,
          x, y,
          level: 1,
          capacity: dept.baseCapacity,
          stock: dept.startUnlocked ? dept.baseCapacity : 0,
          price: dept.basePrice,
          unitCost: dept.unitCost,
        });
      } else if (cell.t === TILE.CHECKOUT) {
        checkouts.push({ id: 'c' + nextCheckoutNum++, x, y, level: 1, queue: [] });
      }
    }
  }
  if (!entrance) throw new Error('map requires an entrance tile (E)');
  if (!checkouts.length) throw new Error('map requires at least one checkout (C)');

  const state = {
    v: RULES_VERSION,
    configId: config.id,
    contentVersion: config.version,
    seed: config.seed >>> 0,
    rngState: (config.seed >>> 0) || 1,
    tick: 0,
    phase: PHASE.ACTIVE,
    terminalReason: null,
    money: config.startingMoney,
    invalidCount: 0,
    commandCount: 0,
    appliedIds: [],
    grid,
    entrance,
    stockroom,
    departments,
    displays,
    checkouts,
    customers: [],
    staff: {
      stocker: { hired: false, cost: config.staff.stockerCost },
      cashier: { hired: false, cost: config.staff.cashierCost },
    },
    staffTimers: { stocker: 0, cashier: 0 },
    nextCustomerId: 1,
    spawnTimer: config.spawnInterval, // first customer after one interval
    stats: { served: 0, angry: 0, emptyLeft: 0, revenue: 0, restockSpend: 0, spawned: 0 },
    config: {
      maxTicks: config.maxTicks,
      moveLimit: config.moveLimit ?? null,
      goals: { ...config.goals },
      spawnInterval: config.spawnInterval,
      spawnJitter: config.spawnJitter ?? 2,
      patience: config.patience,
      browsePatience: config.browsePatience ?? 10,
      staffEvery: { stocker: config.staff.stockerEvery, cashier: config.staff.cashierEvery },
      upgradeCosts: config.upgradeCosts,
      allowed: { ...config.allowed },
      initialStocked: config.initialStocked !== false,
    },
  };
  if (!state.config.initialStocked) for (const d of state.displays) d.stock = 0;
  return state;
}

function parseMap(map) {
  const rows = map.trim().split('\n').map((r) => r.replace(/\s+$/g, ''));
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const cells = [];
  for (let y = 0; y < h; y++) {
    const row = [];
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x] || '#';
      if (ch === '#') row.push({ t: TILE.WALL });
      else if (ch === '.') row.push({ t: TILE.FLOOR });
      else if (ch === 'E') row.push({ t: TILE.ENTRANCE });
      else if (ch === 'S') row.push({ t: TILE.STOCKROOM });
      else if (ch === 'C') row.push({ t: TILE.CHECKOUT });
      else if (/[a-z]/.test(ch)) row.push({ t: TILE.DISPLAY, dept: ch });
      else throw new Error(`unknown map character '${ch}'`);
    }
    cells.push(row);
  }
  return { w, h, cells };
}

// ---------------------------------------------------------------------------
// Geometry helpers (deterministic)
// ---------------------------------------------------------------------------

export function tileAt(state, x, y) {
  if (x < 0 || y < 0 || x >= state.grid.w || y >= state.grid.h) return { t: TILE.WALL };
  return state.grid.cells[y][x];
}

function isWalkable(state, x, y) {
  const t = tileAt(state, x, y).t;
  return t === TILE.FLOOR || t === TILE.ENTRANCE || t === TILE.STOCKROOM;
}

// First walkable neighbor in fixed direction order.
function serviceTile(state, x, y) {
  for (const d of DIRS) {
    if (isWalkable(state, x + d.x, y + d.y)) return { x: x + d.x, y: y + d.y };
  }
  return null;
}

// BFS shortest path between walkable tiles. Returns array of {x,y} including
// the destination, excluding the start. Deterministic via fixed DIRS order.
export function findPath(state, from, to) {
  if (from.x === to.x && from.y === to.y) return [];
  if (!isWalkable(state, to.x, to.y)) return null;
  const key = (x, y) => y * state.grid.w + x;
  const prev = new Map();
  const seen = new Set([key(from.x, from.y)]);
  const queue = [{ x: from.x, y: from.y }];
  while (queue.length) {
    const cur = queue.shift();
    for (const d of DIRS) {
      const nx = cur.x + d.x;
      const ny = cur.y + d.y;
      const k = key(nx, ny);
      if (seen.has(k) || !isWalkable(state, nx, ny)) continue;
      seen.add(k);
      prev.set(k, cur);
      if (nx === to.x && ny === to.y) {
        const path = [{ x: nx, y: ny }];
        let p = cur;
        while (p && !(p.x === from.x && p.y === from.y)) {
          path.unshift(p);
          p = prev.get(key(p.x, p.y));
        }
        return path;
      }
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}

export function displayById(state, id) { return state.displays.find((d) => d.id === id) || null; }
export function checkoutById(state, id) { return state.checkouts.find((c) => c.id === id) || null; }
export function departmentById(state, id) { return state.departments.find((d) => d.id === id) || null; }

// ---------------------------------------------------------------------------
// Legality
// ---------------------------------------------------------------------------

// validateCommand(state, cmd) -> { ok:true } | { ok:false, reason }
// Reasons are stable lowercase strings so UI and tests can rely on them.
export function validateCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, reason: 'malformed-command' };
  if (state.phase !== PHASE.ACTIVE) return { ok: false, reason: 'game-over' };
  if (state.config.moveLimit !== null && state.commandCount >= state.config.moveLimit) {
    return { ok: false, reason: 'no-moves-left' };
  }
  switch (cmd.type) {
    case COMMANDS.RESTOCK: {
      if (!state.config.allowed.restock) return { ok: false, reason: 'not-allowed' };
      const d = displayById(state, cmd.displayId);
      if (!d) return { ok: false, reason: 'no-such-display' };
      const dept = departmentById(state, d.deptId);
      if (!dept.unlocked) return { ok: false, reason: 'department-locked' };
      if (d.stock >= d.capacity) return { ok: false, reason: 'display-full' };
      const cost = restockCost(d);
      if (state.money < cost) return { ok: false, reason: 'not-enough-money' };
      return { ok: true };
    }
    case COMMANDS.SERVE: {
      if (!state.config.allowed.serve) return { ok: false, reason: 'not-allowed' };
      const c = checkoutById(state, cmd.checkoutId);
      if (!c) return { ok: false, reason: 'no-such-checkout' };
      if (!c.queue.length) return { ok: false, reason: 'queue-empty' };
      return { ok: true };
    }
    case COMMANDS.HIRE: {
      if (!state.config.allowed.hire) return { ok: false, reason: 'not-allowed' };
      const s = state.staff[cmd.role];
      if (!s) return { ok: false, reason: 'no-such-role' };
      if (s.hired) return { ok: false, reason: 'already-hired' };
      if (state.money < s.cost) return { ok: false, reason: 'not-enough-money' };
      return { ok: true };
    }
    case COMMANDS.UPGRADE: {
      if (!state.config.allowed.upgrade) return { ok: false, reason: 'not-allowed' };
      const target = cmd.targetKind === 'display'
        ? displayById(state, cmd.targetId)
        : cmd.targetKind === 'checkout'
          ? checkoutById(state, cmd.targetId)
          : null;
      if (!target) return { ok: false, reason: 'no-such-target' };
      if (cmd.targetKind === 'display') {
        const dept = departmentById(state, target.deptId);
        if (!dept.unlocked) return { ok: false, reason: 'department-locked' };
      }
      if (target.level >= MAX_UPGRADE_LEVEL) return { ok: false, reason: 'max-level' };
      const cost = upgradeCost(state, cmd.targetKind, target);
      if (state.money < cost) return { ok: false, reason: 'not-enough-money' };
      return { ok: true };
    }
    case COMMANDS.UNLOCK: {
      if (!state.config.allowed.unlock) return { ok: false, reason: 'not-allowed' };
      const dept = departmentById(state, cmd.deptId);
      if (!dept) return { ok: false, reason: 'no-such-department' };
      if (dept.unlocked) return { ok: false, reason: 'already-unlocked' };
      if (state.money < dept.unlockCost) return { ok: false, reason: 'not-enough-money' };
      return { ok: true };
    }
    default:
      return { ok: false, reason: 'unknown-command' };
  }
}

export function restockCost(display) {
  return (display.capacity - display.stock) * display.unitCost;
}

export function upgradeCost(state, kind, target) {
  const table = kind === 'display' ? state.config.upgradeCosts.display : state.config.upgradeCosts.checkout;
  return table[target.level - 1];
}

// All currently legal commands, without ids. Used by hints, tutorials, and UI.
export function legalActions(state) {
  if (state.phase !== PHASE.ACTIVE) return [];
  const out = [];
  const push = (cmd, label) => {
    const v = validateCommand(state, cmd);
    if (v.ok) out.push({ ...cmd, label });
  };
  for (const d of state.displays) push({ type: COMMANDS.RESTOCK, displayId: d.id }, 'restock');
  for (const c of state.checkouts) push({ type: COMMANDS.SERVE, checkoutId: c.id }, 'serve');
  for (const role of Object.keys(state.staff)) push({ type: COMMANDS.HIRE, role }, 'hire-' + role);
  for (const d of state.displays) push({ type: COMMANDS.UPGRADE, targetKind: 'display', targetId: d.id }, 'upgrade');
  for (const c of state.checkouts) push({ type: COMMANDS.UPGRADE, targetKind: 'checkout', targetId: c.id }, 'upgrade');
  for (const dept of state.departments) push({ type: COMMANDS.UNLOCK, deptId: dept.id }, 'unlock');
  return out;
}

// ---------------------------------------------------------------------------
// Command application
// ---------------------------------------------------------------------------

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

// applyCommand(state, cmd) -> { state, ok, reason?, events }
// Never throws on bad input; malformed commands count as invalid attempts.
// Duplicate command ids are rejected idempotently (no penalty).
export function applyCommand(state, cmd) {
  const next = clone(state);
  const events = [];

  if (cmd && cmd.id && next.appliedIds.includes(cmd.id)) {
    return { state: next, ok: true, duplicate: true, events };
  }

  const v = validateCommand(next, cmd);
  if (!v.ok) {
    next.invalidCount += 1;
    rememberId(next, cmd);
    return { state: next, ok: false, reason: v.reason, events };
  }

  next.commandCount += 1;
  rememberId(next, cmd);

  switch (cmd.type) {
    case COMMANDS.RESTOCK: {
      const d = displayById(next, cmd.displayId);
      const cost = restockCost(d);
      next.money -= cost;
      next.stats.restockSpend += cost;
      d.stock = d.capacity;
      events.push({ kind: 'restock', displayId: d.id, cost });
      break;
    }
    case COMMANDS.SERVE: {
      const c = checkoutById(next, cmd.checkoutId);
      serveFront(next, c, events);
      break;
    }
    case COMMANDS.HIRE: {
      const s = next.staff[cmd.role];
      next.money -= s.cost;
      s.hired = true;
      events.push({ kind: 'hire', role: cmd.role, cost: s.cost });
      break;
    }
    case COMMANDS.UPGRADE: {
      const target = cmd.targetKind === 'display'
        ? displayById(next, cmd.targetId)
        : checkoutById(next, cmd.targetId);
      const cost = upgradeCost(next, cmd.targetKind, target);
      next.money -= cost;
      target.level += 1;
      if (cmd.targetKind === 'display') {
        target.capacity += 2;
        target.price += 1;
        // new shelf space arrives empty; existing stock is kept
      }
      events.push({ kind: 'upgrade', targetKind: cmd.targetKind, targetId: target.id, level: target.level, cost });
      break;
    }
    case COMMANDS.UNLOCK: {
      const dept = departmentById(next, cmd.deptId);
      next.money -= dept.unlockCost;
      dept.unlocked = true;
      for (const d of next.displays) {
        if (d.deptId === dept.id && d.stock === 0 && next.config.initialStocked) d.stock = d.capacity;
      }
      events.push({ kind: 'unlock', deptId: dept.id, cost: dept.unlockCost });
      break;
    }
  }

  checkTerminal(next, events);
  return { state: next, ok: true, events };
}

function rememberId(state, cmd) {
  if (cmd && cmd.id) {
    state.appliedIds.push(cmd.id);
    if (state.appliedIds.length > DUPLICATE_ID_WINDOW) state.appliedIds.shift();
  }
}

// ---------------------------------------------------------------------------
// Simulation tick
// ---------------------------------------------------------------------------

export function step(state) {
  if (state.phase !== PHASE.ACTIVE) return state;
  const next = clone(state);
  const events = [];
  next.tick += 1;

  const rng = createRng(1);
  rng.state = next.rngState;

  // 1. Spawn customers
  next.spawnTimer -= 1;
  if (next.spawnTimer <= 0) {
    spawnCustomer(next, rng, events);
    next.spawnTimer = Math.max(3, next.config.spawnInterval + rng.int(-next.config.spawnJitter, next.config.spawnJitter));
  }

  // 2. Customers act
  for (const cust of next.customers) stepCustomer(next, cust, rng, events);
  next.customers = next.customers.filter((c) => c.status !== 'gone');

  // 3. Staff automation
  if (next.staff.stocker.hired) {
    next.staffTimers.stocker += 1;
    if (next.staffTimers.stocker >= next.config.staffEvery.stocker) {
      next.staffTimers.stocker = 0;
      autoRestock(next, events);
    }
  }
  if (next.staff.cashier.hired) {
    next.staffTimers.cashier += 1;
    if (next.staffTimers.cashier >= next.config.staffEvery.cashier) {
      next.staffTimers.cashier = 0;
      autoServe(next, events);
    }
  }

  next.rngState = rng.state;
  checkTerminal(next, events);
  next.lastEvents = events;
  return next;
}

function spawnCustomer(state, rng, events) {
  const candidates = state.displays.filter((d) => departmentById(state, d.deptId).unlocked);
  if (!candidates.length) return;
  const stocked = candidates.filter((d) => d.stock > 0);
  const pool = stocked.length ? stocked : candidates;
  const target = rng.pick(pool);
  const stand = serviceTile(state, target.x, target.y);
  if (!stand) return;
  const path = findPath(state, state.entrance, stand);
  if (!path) return;
  const id = 'g' + state.nextCustomerId++;
  const patienceMax = state.config.patience;
  state.customers.push({
    id,
    x: state.entrance.x,
    y: state.entrance.y,
    status: 'to-display',
    targetDisplayId: target.id,
    checkoutId: null,
    path,
    pathIndex: 0,
    dwell: 1,
    browseWait: state.config.browsePatience,
    patience: patienceMax,
    patienceMax,
    carry: 0,
  });
  state.stats.spawned += 1;
  events.push({ kind: 'spawn', customerId: id, x: state.entrance.x, y: state.entrance.y });
}

function stepCustomer(state, cust, rng, events) {
  switch (cust.status) {
    case 'to-display':
    case 'to-checkout':
    case 'leaving': {
      if (cust.pathIndex < cust.path.length) {
        const stepTo = cust.path[cust.pathIndex++];
        cust.x = stepTo.x;
        cust.y = stepTo.y;
      }
      if (cust.pathIndex >= cust.path.length) {
        if (cust.status === 'to-display') cust.status = 'shopping';
        else if (cust.status === 'to-checkout') cust.status = 'queued';
        else if (cust.status === 'leaving') cust.status = 'gone';
      }
      break;
    }
    case 'shopping': {
      const d = displayById(state, cust.targetDisplayId);
      if (d && d.stock > 0) {
        if (cust.dwell > 0) { cust.dwell -= 1; break; }
        d.stock -= 1;
        cust.carry = d.price;
        events.push({ kind: 'take', customerId: cust.id, displayId: d.id, stockLeft: d.stock });
        // join shortest queue
        let best = null;
        for (const c of state.checkouts) {
          if (!best || c.queue.length < best.queue.length) best = c;
        }
        cust.checkoutId = best.id;
        const stand = queueSlot(state, best, best.queue.length);
        const path = findPath(state, { x: cust.x, y: cust.y }, stand) || [];
        best.queue.push(cust.id);
        cust.path = path;
        cust.pathIndex = 0;
        cust.status = 'to-checkout';
      } else {
        cust.browseWait -= 1;
        if (cust.browseWait <= 0) {
          state.stats.emptyLeft += 1;
          events.push({ kind: 'left-empty', customerId: cust.id });
          sendHome(state, cust);
        }
      }
      break;
    }
    case 'queued': {
      const c = checkoutById(state, cust.checkoutId);
      const patienceBonus = c ? (c.level - 1) * 6 : 0;
      cust.patience -= 1;
      if (cust.patience + patienceBonus <= 0) {
        if (c) c.queue = c.queue.filter((id) => id !== cust.id);
        state.stats.angry += 1;
        events.push({ kind: 'left-angry', customerId: cust.id, checkoutId: cust.checkoutId });
        sendHome(state, cust);
      }
      break;
    }
  }
}

function sendHome(state, cust) {
  cust.path = findPath(state, { x: cust.x, y: cust.y }, state.entrance) || [];
  cust.pathIndex = 0;
  cust.status = 'leaving';
  cust.carry = 0;
}

// Queue stand position: service tile of the checkout, then continuing in the
// same direction away from the counter. Render uses the same helper.
export function queueSlot(state, checkout, index) {
  const svc = serviceTile(state, checkout.x, checkout.y);
  if (!svc) return { x: checkout.x, y: checkout.y };
  const dx = svc.x - checkout.x;
  const dy = svc.y - checkout.y;
  for (let i = 0; i <= index; i++) {
    const x = svc.x + dx * i;
    const y = svc.y + dy * i;
    if (!isWalkable(state, x, y)) {
      // fallback: clamp to last walkable slot (render may stack; rules unaffected)
      return { x: svc.x + dx * (i - 1), y: svc.y + dy * (i - 1) };
    }
    if (i === index) return { x, y };
  }
  return svc;
}

function serveFront(state, checkout, events) {
  if (!checkout.queue.length) return;
  const custId = checkout.queue.shift();
  const cust = state.customers.find((c) => c.id === custId);
  if (!cust) return;
  state.money += cust.carry;
  state.stats.revenue += cust.carry;
  state.stats.served += 1;
  events.push({ kind: 'served', customerId: cust.id, checkoutId: checkout.id, amount: cust.carry });
  sendHome(state, cust);
}

function autoRestock(state, events) {
  // restock the emptiest unlocked display the market can afford
  let best = null;
  for (const d of state.displays) {
    if (!departmentById(state, d.deptId).unlocked) continue;
    if (d.stock >= d.capacity) continue;
    if (state.money < restockCost(d)) continue;
    if (!best || d.stock / d.capacity < best.stock / best.capacity) best = d;
  }
  if (best) {
    const cost = restockCost(best);
    state.money -= cost;
    state.stats.restockSpend += cost;
    best.stock = best.capacity;
    events.push({ kind: 'restock', displayId: best.id, cost, by: 'stocker' });
  }
}

function autoServe(state, events) {
  let best = null;
  for (const c of state.checkouts) {
    if (!c.queue.length) continue;
    if (!best || c.queue.length > best.queue.length) best = c;
  }
  if (best) {
    serveFront(state, best, events);
    const ev = events[events.length - 1];
    if (ev && ev.kind === 'served') ev.by = 'cashier';
  }
}

// ---------------------------------------------------------------------------
// Terminal state and scoring
// ---------------------------------------------------------------------------

function goalsMet(state) {
  const g = state.config.goals;
  if (g.serve && state.stats.served < g.serve) return false;
  if (g.earn && state.stats.revenue < g.earn) return false;
  if (g.unlock && state.departments.filter((d) => d.unlocked).length < g.unlock) return false;
  if (g.maxAngry !== undefined && state.stats.angry > g.maxAngry) return false;
  return true;
}

function checkTerminal(state, events) {
  if (state.phase !== PHASE.ACTIVE) return;
  if (goalsMet(state)) {
    state.phase = PHASE.WON;
    state.terminalReason = 'goal-complete';
    events.push({ kind: 'terminal', result: 'won', reason: state.terminalReason });
    return;
  }
  if (state.config.moveLimit !== null && state.commandCount >= state.config.moveLimit && !canStillProgress(state)) {
    state.phase = PHASE.LOST;
    state.terminalReason = 'out-of-moves';
    events.push({ kind: 'terminal', result: 'lost', reason: state.terminalReason });
    return;
  }
  if (state.tick >= state.config.maxTicks) {
    const met = goalsMet(state);
    state.phase = met ? PHASE.WON : PHASE.LOST;
    state.terminalReason = met ? 'goal-complete' : 'shift-ended';
    events.push({ kind: 'terminal', result: state.phase, reason: state.terminalReason });
  }
}

// With a move limit, the player may still win via hired staff automation.
function canStillProgress(state) {
  return state.staff.cashier.hired && state.staff.stocker.hired;
}

export function isTerminal(state) {
  return state.phase !== PHASE.ACTIVE;
}

// Integer component breakdown. Presentation formats; nothing here is rounded
// for display only.
export function computeScore(state) {
  const served = state.stats.served;
  const ticks = Math.max(1, state.tick);
  const components = {
    guests: served * 100,
    revenue: state.stats.revenue,
    satisfaction: served * 10 - state.stats.angry * 30 - state.stats.emptyLeft * 15,
    departments: state.departments.filter((d) => d.unlocked).length * 250,
    throughput: Math.floor((served * 1000) / ticks),
    reserves: state.money,
  };
  const total = Math.max(0,
    components.guests + components.revenue + components.satisfaction +
    components.departments + components.throughput + components.reserves);
  return {
    components,
    total,
    tiebreak: {
      goalComplete: state.phase === PHASE.WON ? 1 : 0,
      invalidCount: state.invalidCount,
      ticksElapsed: state.tick,
    },
  };
}

// ---------------------------------------------------------------------------
// Serialization / replay helpers
// ---------------------------------------------------------------------------

export function serialize(state) {
  return stableStringify(state);
}

export function deserialize(json) {
  const state = JSON.parse(json);
  if (state.v !== RULES_VERSION) throw new Error(`unsupported rules version ${state.v}`);
  return state;
}

export function stateHash(state) {
  const copy = clone(state);
  delete copy.lastEvents; // presentation-only, not part of logical truth
  return hashState(copy);
}

// Re-simulate a replay envelope and verify terminal result + periodic hashes.
// Hash semantics: envelope.hashes[i] = { tick: T, hash } is the state hash on
// ARRIVAL at tick T (before any commands issued at tick T). finalHash is the
// terminal state after everything.
// envelope: { seed, config, commands: [{id, tick, type, ...}], hashes: [{tick, hash}], result }
export function verifyReplay(envelope) {
  let state = createGame(envelope.config);
  const failures = [];
  const byTick = new Map();
  for (const cmd of envelope.commands) {
    if (!byTick.has(cmd.tick)) byTick.set(cmd.tick, []);
    byTick.get(cmd.tick).push(cmd);
  }
  const maxIter = envelope.config.maxTicks + envelope.commands.length + 100;
  for (let i = 0; i < maxIter; i++) {
    const hashEntry = envelope.hashes.find((h) => h.tick === state.tick);
    if (hashEntry && stateHash(state) !== hashEntry.hash) {
      failures.push(`hash mismatch at tick ${state.tick}`);
    }
    if (isTerminal(state)) break;
    const cmds = byTick.get(state.tick) || [];
    for (const cmd of cmds) {
      const res = applyCommand(state, cmd);
      state = res.state;
    }
    if (isTerminal(state)) break;
    state = step(state);
  }
  const finalHash = stateHash(state);
  if (envelope.finalHash && envelope.finalHash !== finalHash) failures.push('final hash mismatch');
  const score = computeScore(state);
  if (envelope.result) {
    if (envelope.result.phase !== state.phase) failures.push('phase mismatch');
    if (envelope.result.total !== score.total) failures.push('score mismatch');
  }
  return { ok: failures.length === 0, failures, finalHash, score, phase: state.phase };
}
