// Market Manager — versioned content: departments, themes, tutorials,
// journey stages, challenges, and the daily ruleset. All content is data;
// the rules engine consumes resolved configs from buildStageConfig().

import { hashString } from './rng.js';
import { createGame, step, applyCommand, isTerminal, legalActions, COMMANDS, computeScore } from './rules.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// Department catalog (original names and goods)
// ---------------------------------------------------------------------------

export const DEPARTMENT_TYPES = {
  bakery:  { id: 'bakery',  name: 'Rise & Crumb Bakery', good: 'rolls',    baseCapacity: 4, basePrice: 6,  unitCost: 2 },
  produce: { id: 'produce', name: 'Green Basket',        good: 'greens',   baseCapacity: 5, basePrice: 5,  unitCost: 2 },
  dairy:   { id: 'dairy',   name: 'Cold Corner',         good: 'chilled',  baseCapacity: 4, basePrice: 8,  unitCost: 3 },
  floral:  { id: 'floral',  name: 'Petal & Stem',        good: 'bouquets', baseCapacity: 3, basePrice: 12, unitCost: 5 },
  deli:    { id: 'deli',    name: 'Carvery Counter',     good: 'cuts',     baseCapacity: 3, basePrice: 15, unitCost: 7 },
};

// ---------------------------------------------------------------------------
// Visual themes (presentation consumes these; rules never do)
// ---------------------------------------------------------------------------

export const THEMES = [
  { id: 'sunrise', name: 'Sunrise Row',  sky: 0xffe8c8, fog: 0xffdcb0, ground: 0x8fce7a, tile: 0xf2e3c2, accent: 0xe8743b, key: 0xfff2dd, intensity: 1.15 },
  { id: 'meadow',  name: 'Meadow Fair',  sky: 0xcfeedd, fog: 0xb8e6cc, ground: 0x6fbf6a, tile: 0xdfe8c8, accent: 0x3d9970, key: 0xf4ffe9, intensity: 1.05 },
  { id: 'harbor',  name: 'Harbor Lane',  sky: 0xcfe4f5, fog: 0xb3d4ec, ground: 0x7fb5a3, tile: 0xe6ddc8, accent: 0x2f6f9f, key: 0xeaf6ff, intensity: 1.0 },
  { id: 'dusk',    name: 'Dusk Market',  sky: 0x3b3a5e, fog: 0x2e2d4a, ground: 0x5e7a5a, tile: 0x8f86a8, accent: 0xf0a35e, key: 0xffd9a8, intensity: 0.85 },
  { id: 'frost',   name: 'Frost Square', sky: 0xdfeaf2, fog: 0xccd9e6, ground: 0xa8c8c0, tile: 0xeef2f5, accent: 0x5b8fb9, key: 0xffffff, intensity: 1.1 },
];

// ---------------------------------------------------------------------------
// Map building helpers
// ---------------------------------------------------------------------------

// Border-walled room with door on the left edge.
function room(w, h, inner) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) row += '#';
      else row += inner[y - 1][x - 1];
    }
    rows.push(row);
  }
  return rows.join('\n');
}

const DOOR_Y = 2;
function withDoor(map) {
  const rows = map.split('\n').map((r) => r.split(''));
  rows[DOOR_Y][0] = 'E';
  return rows.map((r) => r.join('')).join('\n');
}

// ---------------------------------------------------------------------------
// Stage definitions
// ---------------------------------------------------------------------------

// Each department entry: key (map letter), type id, unlock cost, startUnlocked.
function dept(key, typeId, opts = {}) {
  const t = DEPARTMENT_TYPES[typeId];
  return {
    id: typeId + '-' + key,
    key,
    name: t.name,
    good: t.good,
    baseCapacity: t.baseCapacity,
    basePrice: t.basePrice,
    unitCost: t.unitCost,
    unlockCost: opts.unlockCost || 0,
    startUnlocked: opts.startUnlocked !== false,
  };
}

const DEFAULTS = {
  spawnJitter: 2,
  browsePatience: 10,
  staff: { stockerCost: 120, cashierCost: 150, stockerEvery: 6, cashierEvery: 4 },
  upgradeCosts: { display: [60, 120], checkout: [80, 160] },
  allowed: { restock: true, serve: true, hire: true, upgrade: true, unlock: true, undo: false },
  initialStocked: true,
};

function stage(p) {
  return {
    version: CONTENT_VERSION,
    theme: 'sunrise',
    ...structuredClone(DEFAULTS),
    ...p,
    allowed: { ...DEFAULTS.allowed, ...(p.allowed || {}) },
    staff: { ...DEFAULTS.staff, ...(p.staff || {}) },
    upgradeCosts: structuredClone(p.upgradeCosts || DEFAULTS.upgradeCosts),
  };
}

// --- Journey: 40 authored stages -------------------------------------------
// Concepts introduced in isolation, combined, then tested (mastery stages
// marked mastery: true). Layouts grow; spawn pressure and goals scale.

const M = {
  small1: withDoor(room(9, 8, [
    '..aa.....',
    '..aa.....',
    '.........',
    '....C....',
    '.........',
    '...S.....',
  ])),
  small2: withDoor(room(9, 8, [
    '..aa..bb.',
    '..aa..bb.',
    '.........',
    '....C....',
    '.........',
    '...S.....',
  ])),
  mid2: withDoor(room(11, 9, [
    '..aa...bb..',
    '..aa...bb..',
    '...........',
    '...C...C...',
    '...........',
    '....S......',
    '...........',
  ])),
  mid3: withDoor(room(11, 9, [
    '..aa.bb.cc.',
    '..aa.bb.cc.',
    '...........',
    '...C...C...',
    '...........',
    '....S......',
    '...........',
  ])),
  wide3: withDoor(room(12, 9, [
    '..aa..bb..cc.',
    '..aa..bb..cc.',
    '............',
    '..C......C..',
    '............',
    '.....S......',
    '............',
  ])),
  wide4: withDoor(room(13, 10, [
    '..aa..bb..cc.dd.',
    '..aa..bb..cc.dd.',
    '..............',
    '..C........C..',
    '..............',
    '......S.......',
    '..............',
    '..............',
  ])),
  grand5: withDoor(room(14, 10, [
    '.aa..bb..cc..dd.ee.',
    '.aa..bb..cc..dd.ee.',
    '.................',
    '.C.......C.......C.',
    '.................',
    '........S........',
    '.................',
    '.................',
  ])),
  lanes: withDoor(room(12, 10, [
    '..aa......bb..',
    '..aa..##..bb..',
    '......##......',
    '..C...##...C..',
    '......##......',
    '..cc..##..dd..',
    '..cc..##..dd..',
    '......S.......',
  ])),
};

const JOURNEY = [
  // -- Block 1: restock & serve basics (bakery only)
  stage({ id: 'j01', name: 'First Shift', map: M.small1, departments: [dept('a', 'bakery')], seed: 101,
    startingMoney: 40, maxTicks: 160, spawnInterval: 14, patience: 40, goals: { serve: 6 }, par: { ticks: 120 },
    allowed: { hire: false, upgrade: false, unlock: false }, theme: 'sunrise' }),
  stage({ id: 'j02', name: 'Morning Rush', map: M.small1, departments: [dept('a', 'bakery')], seed: 102,
    startingMoney: 40, maxTicks: 170, spawnInterval: 11, patience: 38, goals: { serve: 10 }, par: { ticks: 140 },
    allowed: { hire: false, upgrade: false, unlock: false }, theme: 'sunrise' }),
  stage({ id: 'j03', name: 'Full Shelves', map: M.small1, departments: [dept('a', 'bakery')], seed: 103,
    startingMoney: 30, maxTicks: 180, spawnInterval: 10, patience: 36, goals: { serve: 12, earn: 60 }, par: { ticks: 150 },
    allowed: { hire: false, upgrade: false, unlock: false }, theme: 'sunrise' }),
  stage({ id: 'j04', name: 'Mastery: Bakery', map: M.small1, departments: [dept('a', 'bakery')], seed: 104,
    startingMoney: 30, maxTicks: 170, spawnInterval: 9, patience: 34, goals: { serve: 14, maxAngry: 3 }, par: { ticks: 150 },
    allowed: { hire: false, upgrade: false, unlock: false }, theme: 'sunrise', mastery: true }),

  // -- Block 2: second department + unlock
  stage({ id: 'j05', name: 'Green Expansion', map: M.small2, departments: [dept('a', 'bakery'), dept('b', 'produce', { startUnlocked: false, unlockCost: 80 })], seed: 105,
    startingMoney: 90, maxTicks: 190, spawnInterval: 11, patience: 38, goals: { serve: 12, unlock: 2 }, par: { ticks: 160 }, theme: 'meadow' }),
  stage({ id: 'j06', name: 'Two Aisles', map: M.small2, departments: [dept('a', 'bakery'), dept('b', 'produce', { startUnlocked: false, unlockCost: 70 })], seed: 106,
    startingMoney: 60, maxTicks: 200, spawnInterval: 10, patience: 36, goals: { serve: 16, unlock: 2 }, par: { ticks: 170 }, theme: 'meadow' }),
  stage({ id: 'j07', name: 'Split Attention', map: M.mid2, departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 107,
    startingMoney: 50, maxTicks: 200, spawnInterval: 9, patience: 36, goals: { serve: 18 }, par: { ticks: 170 }, theme: 'meadow' }),
  stage({ id: 'j08', name: 'Mastery: Two Aisles', map: M.mid2, departments: [dept('a', 'bakery'), dept('b', 'produce', { startUnlocked: false, unlockCost: 90 })], seed: 108,
    startingMoney: 60, maxTicks: 200, spawnInterval: 8, patience: 34, goals: { serve: 20, unlock: 2, maxAngry: 4 }, par: { ticks: 175 }, theme: 'meadow', mastery: true }),

  // -- Block 3: upgrades
  stage({ id: 'j09', name: 'Bigger Baskets', map: M.small2, departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 109,
    startingMoney: 70, maxTicks: 200, spawnInterval: 9, patience: 36, goals: { serve: 18, earn: 100 }, par: { ticks: 170 }, theme: 'meadow' }),
  stage({ id: 'j10', name: 'Premium Shelves', map: M.mid2, departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 110,
    startingMoney: 80, maxTicks: 210, spawnInterval: 8, patience: 34, goals: { serve: 20, earn: 120 }, par: { ticks: 180 }, theme: 'meadow' }),
  stage({ id: 'j11', name: 'Quick Counters', map: M.mid2, departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 111,
    startingMoney: 90, maxTicks: 210, spawnInterval: 8, patience: 32, goals: { serve: 22, earn: 115 }, par: { ticks: 185 }, theme: 'meadow' }),
  stage({ id: 'j12', name: 'Mastery: Upgrades', map: M.mid2, departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 112,
    startingMoney: 70, maxTicks: 200, spawnInterval: 7, patience: 32, goals: { serve: 24, maxAngry: 4 }, par: { ticks: 180 }, theme: 'meadow', mastery: true }),

  // -- Block 4: hiring staff
  stage({ id: 'j13', name: 'First Hire', map: M.mid2, departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 113,
    startingMoney: 160, maxTicks: 210, spawnInterval: 8, patience: 34, goals: { serve: 20 }, par: { ticks: 175 }, theme: 'harbor' }),
  stage({ id: 'j14', name: 'Delegation', map: M.mid2, departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 114,
    startingMoney: 180, maxTicks: 220, spawnInterval: 7, patience: 32, goals: { serve: 24 }, par: { ticks: 185 }, theme: 'harbor' }),
  stage({ id: 'j15', name: 'Hands Off', map: M.mid3, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy', { startUnlocked: false, unlockCost: 150 })], seed: 115,
    startingMoney: 200, maxTicks: 230, spawnInterval: 8, patience: 34, goals: { serve: 26, unlock: 3 }, par: { ticks: 195 }, theme: 'harbor' }),
  stage({ id: 'j16', name: 'Mastery: Staffing', map: M.mid3, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy', { startUnlocked: false, unlockCost: 130 })], seed: 116,
    startingMoney: 170, maxTicks: 230, spawnInterval: 7, patience: 32, goals: { serve: 30, unlock: 3, maxAngry: 5 }, par: { ticks: 200 }, theme: 'harbor', mastery: true }),

  // -- Block 5: three departments, dairy pressure
  stage({ id: 'j17', name: 'Cold Goods', map: M.mid3, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy')], seed: 117,
    startingMoney: 90, maxTicks: 230, spawnInterval: 8, patience: 34, goals: { serve: 26, earn: 140 }, par: { ticks: 195 }, theme: 'harbor' }),
  stage({ id: 'j18', name: 'Chilled Rush', map: M.wide3, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy')], seed: 118,
    startingMoney: 100, maxTicks: 240, spawnInterval: 7, patience: 32, goals: { serve: 30 }, par: { ticks: 205 }, theme: 'harbor' }),
  stage({ id: 'j19', name: 'Three-Way Split', map: M.wide3, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy')], seed: 119,
    startingMoney: 120, maxTicks: 240, spawnInterval: 6, patience: 32, goals: { serve: 32, earn: 200 }, par: { ticks: 210 }, theme: 'harbor' }),
  stage({ id: 'j20', name: 'Mastery: Trio', map: M.wide3, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy')], seed: 120,
    startingMoney: 100, maxTicks: 230, spawnInterval: 6, patience: 30, goals: { serve: 34, maxAngry: 5 }, par: { ticks: 205 }, theme: 'harbor', mastery: true }),

  // -- Block 6: florist, premium margins
  stage({ id: 'j21', name: 'Flower Corner', map: M.wide4, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral', { startUnlocked: false, unlockCost: 220 })], seed: 121,
    startingMoney: 240, maxTicks: 250, spawnInterval: 7, patience: 32, goals: { serve: 30, unlock: 4 }, par: { ticks: 215 }, theme: 'dusk' }),
  stage({ id: 'j22', name: 'Bouquet Boom', map: M.wide4, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral')], seed: 122,
    startingMoney: 110, maxTicks: 250, spawnInterval: 7, patience: 32, goals: { serve: 34, earn: 200 }, par: { ticks: 220 }, theme: 'dusk' }),
  stage({ id: 'j23', name: 'Petal Pressure', map: M.wide4, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral')], seed: 123,
    startingMoney: 130, maxTicks: 250, spawnInterval: 6, patience: 30, goals: { serve: 36, earn: 220 }, par: { ticks: 220 }, theme: 'dusk' }),
  stage({ id: 'j24', name: 'Mastery: Florist', map: M.wide4, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral', { startUnlocked: false, unlockCost: 200 })], seed: 124,
    startingMoney: 220, maxTicks: 240, spawnInterval: 6, patience: 30, goals: { serve: 38, unlock: 4, maxAngry: 6 }, par: { ticks: 215 }, theme: 'dusk', mastery: true }),

  // -- Block 7: deli, high stakes
  stage({ id: 'j25', name: 'Carvery Opening', map: M.grand5, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral'), dept('e', 'deli', { startUnlocked: false, unlockCost: 320 })], seed: 125,
    startingMoney: 340, maxTicks: 260, spawnInterval: 7, patience: 32, goals: { serve: 34, unlock: 5 }, par: { ticks: 225 }, theme: 'dusk' }),
  stage({ id: 'j26', name: 'Prime Cuts', map: M.grand5, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral'), dept('e', 'deli')], seed: 126,
    startingMoney: 140, maxTicks: 260, spawnInterval: 6, patience: 30, goals: { serve: 40, earn: 230 }, par: { ticks: 230 }, theme: 'dusk' }),
  stage({ id: 'j27', name: 'Full House', map: M.grand5, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral'), dept('e', 'deli')], seed: 127,
    startingMoney: 160, maxTicks: 260, spawnInterval: 6, patience: 30, goals: { serve: 38, earn: 230 }, par: { ticks: 230 }, theme: 'dusk' }),
  stage({ id: 'j28', name: 'Mastery: Grand Market', map: M.grand5, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral'), dept('e', 'deli', { startUnlocked: false, unlockCost: 280 })], seed: 128,
    startingMoney: 300, maxTicks: 250, spawnInterval: 5, patience: 30, goals: { serve: 44, unlock: 5, maxAngry: 6 }, par: { ticks: 225 }, theme: 'dusk', mastery: true }),

  // -- Block 8: altered layouts, endurance
  stage({ id: 'j29', name: 'Divided Aisles', map: M.lanes, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral')], seed: 129,
    startingMoney: 150, maxTicks: 260, spawnInterval: 6, patience: 32, goals: { serve: 36 }, par: { ticks: 230 }, theme: 'frost' }),
  stage({ id: 'j30', name: 'Split Queues', map: M.lanes, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral')], seed: 130,
    startingMoney: 170, maxTicks: 270, spawnInterval: 6, patience: 30, goals: { serve: 40, earn: 300 }, par: { ticks: 235 }, theme: 'frost' }),
  stage({ id: 'j31', name: 'Long Shift', map: M.grand5, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral'), dept('e', 'deli')], seed: 131,
    startingMoney: 180, maxTicks: 320, spawnInterval: 6, patience: 30, goals: { serve: 50 }, par: { ticks: 280 }, theme: 'frost' }),
  stage({ id: 'j32', name: 'Mastery: Endurance', map: M.lanes, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral')], seed: 132,
    startingMoney: 150, maxTicks: 280, spawnInterval: 5, patience: 30, goals: { serve: 44, maxAngry: 6 }, par: { ticks: 245 }, theme: 'frost', mastery: true }),

  // -- Block 9: tight economy
  stage({ id: 'j33', name: 'Lean Ledger', map: M.mid3, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy')], seed: 133,
    startingMoney: 50, maxTicks: 240, spawnInterval: 7, patience: 32, goals: { serve: 28, earn: 180 }, par: { ticks: 210 }, theme: 'frost' }),
  stage({ id: 'j34', name: 'Penny Pinch', map: M.wide3, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy')], seed: 134,
    startingMoney: 45, maxTicks: 250, spawnInterval: 6, patience: 30, goals: { serve: 32, earn: 180 }, par: { ticks: 220 }, theme: 'frost' }),
  stage({ id: 'j35', name: 'Thin Margins', map: M.wide4, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral')], seed: 135,
    startingMoney: 60, maxTicks: 260, spawnInterval: 6, patience: 30, goals: { serve: 36, earn: 220 }, par: { ticks: 230 }, theme: 'frost' }),
  stage({ id: 'j36', name: 'Mastery: Economy', map: M.wide4, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral')], seed: 136,
    startingMoney: 40, maxTicks: 260, spawnInterval: 6, patience: 28, goals: { serve: 38, earn: 230, maxAngry: 6 }, par: { ticks: 230 }, theme: 'frost', mastery: true }),

  // -- Block 10: final rush
  stage({ id: 'j37', name: 'Festival Eve', map: M.grand5, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral'), dept('e', 'deli')], seed: 137,
    startingMoney: 200, maxTicks: 280, spawnInterval: 5, patience: 30, goals: { serve: 50 }, par: { ticks: 245 }, theme: 'sunrise' }),
  stage({ id: 'j38', name: 'Festival Day', map: M.grand5, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral'), dept('e', 'deli')], seed: 138,
    startingMoney: 220, maxTicks: 300, spawnInterval: 5, patience: 28, goals: { serve: 55, earn: 330 }, par: { ticks: 260 }, theme: 'sunrise' }),
  stage({ id: 'j39', name: 'Grand Gala', map: M.grand5, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral'), dept('e', 'deli')], seed: 139,
    startingMoney: 250, maxTicks: 320, spawnInterval: 4, patience: 28, goals: { serve: 60, earn: 450 }, par: { ticks: 280 }, theme: 'sunrise' }),
  stage({ id: 'j40', name: 'Mastery: Market Legend', map: M.grand5, departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy'), dept('d', 'floral'), dept('e', 'deli')], seed: 140,
    startingMoney: 200, maxTicks: 320, spawnInterval: 4, patience: 28, goals: { serve: 64, earn: 440, maxAngry: 8 }, par: { ticks: 285 }, theme: 'sunrise', mastery: true }),
];

// --- Tutorials (Learn mode) -------------------------------------------------

export const TUTORIALS = [
  stage({
    id: 't01', name: 'Lesson 1: Stock the Shelves', map: M.small1,
    departments: [dept('a', 'bakery')], seed: 11,
    startingMoney: 40, maxTicks: 120, spawnInterval: 12, patience: 60,
    goals: { serve: 3 }, par: { ticks: 90 },
    allowed: { hire: false, upgrade: false, unlock: false },
    theme: 'sunrise',
    tutorial: {
      steps: [
        { text: 'Guests want fresh rolls. Tap a glowing shelf to restock it from the stockroom.', require: { type: COMMANDS.RESTOCK } },
        { text: 'A guest is heading to the checkout. Tap the checkout counter to serve them.', require: { type: COMMANDS.SERVE } },
        { text: 'Great! Keep shelves stocked and queues short. Serve 3 guests to finish the lesson.', require: null },
      ],
    },
  }),
  stage({
    id: 't02', name: 'Lesson 2: Grow the Market', map: M.small2,
    departments: [dept('a', 'bakery'), dept('b', 'produce', { startUnlocked: false, unlockCost: 60 })], seed: 12,
    startingMoney: 80, maxTicks: 150, spawnInterval: 11, patience: 60,
    goals: { serve: 5, unlock: 2 }, par: { ticks: 120 },
    allowed: { hire: false, upgrade: false },
    theme: 'meadow',
    tutorial: {
      steps: [
        { text: 'You can afford a new department! Tap the greyed-out Green Basket shelves to unlock them.', require: { type: COMMANDS.UNLOCK } },
        { text: 'New shelves need stock. Restock them, then serve guests from both departments.', require: { type: COMMANDS.RESTOCK } },
        { text: 'Serve 5 guests total to finish the lesson.', require: null },
      ],
    },
  }),
  stage({
    id: 't03', name: 'Lesson 3: Hire Help', map: M.mid2,
    departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 13,
    startingMoney: 200, maxTicks: 170, spawnInterval: 9, patience: 55,
    goals: { serve: 10 }, par: { ticks: 140 },
    allowed: { upgrade: false, unlock: false },
    theme: 'harbor',
    tutorial: {
      steps: [
        { text: 'The market is getting busy. Open the Staff panel and hire a stocker — they restock shelves for you.', require: { type: COMMANDS.HIRE, role: 'stocker' } },
        { text: 'Now hire a cashier to serve queues automatically.', require: { type: COMMANDS.HIRE, role: 'cashier' } },
        { text: 'With a full team, the market nearly runs itself. Serve 10 guests to finish.', require: null },
      ],
    },
  }),
  stage({
    id: 't04', name: 'Lesson 4: Upgrade Everything', map: M.mid2,
    departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 14,
    startingMoney: 150, maxTicks: 180, spawnInterval: 8, patience: 50,
    goals: { serve: 12, earn: 80 }, par: { ticks: 150 },
    allowed: { unlock: false },
    theme: 'dusk',
    tutorial: {
      steps: [
        { text: 'Upgraded shelves hold more and sell for more. Select a shelf and choose Upgrade.', require: { type: COMMANDS.UPGRADE, targetKind: 'display' } },
        { text: 'Upgraded checkouts keep queued guests patient longer. Upgrade a checkout.', require: { type: COMMANDS.UPGRADE, targetKind: 'checkout' } },
        { text: 'Now put it all together: serve 12 guests and earn 90 coins.', require: null },
      ],
    },
  }),
];

// --- Challenges -------------------------------------------------------------

export const CHALLENGES = [
  stage({
    id: 'c01', name: 'Ten Moves Only', map: M.small2,
    departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 501,
    startingMoney: 300, maxTicks: 200, spawnInterval: 9, patience: 45,
    goals: { serve: 12 }, moveLimit: 10, par: { ticks: 160 },
    allowed: { unlock: false }, theme: 'dusk',
    blurb: 'Every action counts — only 10 moves. Hire staff and let them work.',
  }),
  stage({
    id: 'c02', name: 'Speed Shift', map: M.mid2,
    departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 502,
    startingMoney: 120, maxTicks: 110, spawnInterval: 7, patience: 30,
    goals: { serve: 10 }, par: { ticks: 95 },
    allowed: { unlock: false }, theme: 'sunrise',
    blurb: 'A very short shift with a big queue. Move fast.',
  }),
  stage({
    id: 'c03', name: 'Empty Shelves', map: M.mid3,
    departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy')], seed: 503,
    startingMoney: 90, maxTicks: 220, spawnInterval: 8, patience: 34,
    goals: { serve: 22 }, initialStocked: false, par: { ticks: 190 }, theme: 'frost',
    blurb: 'The delivery never came. Every shelf starts empty.',
  }),
  stage({
    id: 'c04', name: 'One Counter', map: M.small2,
    departments: [dept('a', 'bakery'), dept('b', 'produce')], seed: 504,
    startingMoney: 100, maxTicks: 200, spawnInterval: 6, patience: 34,
    goals: { serve: 20, maxAngry: 6 }, par: { ticks: 175 }, theme: 'harbor',
    blurb: 'One checkout, endless guests. Keep the line moving.',
  }),
  stage({
    id: 'c05', name: 'No Help Wanted', map: M.wide3,
    departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy')], seed: 505,
    startingMoney: 110, maxTicks: 240, spawnInterval: 6, patience: 30,
    goals: { serve: 30 }, allowed: { hire: false }, par: { ticks: 210 }, theme: 'meadow',
    blurb: 'Staff is on holiday. Run the whole floor yourself.',
  }),
];

// --- Practice difficulties --------------------------------------------------

export function practiceConfig(difficulty) {
  const base = {
    relaxed: { spawnInterval: 12, patience: 48, maxTicks: 240, goals: { serve: 15 }, startingMoney: 120 },
    standard: { spawnInterval: 8, patience: 36, maxTicks: 220, goals: { serve: 22 }, startingMoney: 100 },
    intense: { spawnInterval: 5, patience: 28, maxTicks: 220, goals: { serve: 32 }, startingMoney: 90 },
  }[difficulty] || null;
  if (!base) throw new Error('unknown difficulty ' + difficulty);
  return stage({
    id: 'practice-' + difficulty,
    name: 'Practice — ' + difficulty[0].toUpperCase() + difficulty.slice(1),
    map: M.mid3,
    departments: [dept('a', 'bakery'), dept('b', 'produce'), dept('c', 'dairy', { startUnlocked: false, unlockCost: 150 })],
    seed: 9000 + hashString(difficulty) % 1000,
    allowed: { undo: true },
    theme: 'meadow',
    ...base,
  });
}

// --- Daily ------------------------------------------------------------------

// One shared seed and ruleset per UTC day. Immutable once published.
export function dailyConfig(dateIso) {
  // dateIso: 'YYYY-MM-DD' in UTC
  const daySeed = hashString('market-manager-daily-' + dateIso);
  const deptCount = 2 + (daySeed % 3); // 2..4
  const mapsByCount = { 2: [M.small2, M.mid2], 3: [M.mid3, M.wide3], 4: [M.wide4, M.lanes] };
  const mapPool = mapsByCount[deptCount];
  const map = mapPool[daySeed % mapPool.length];
  const keys = ['a', 'b', 'c', 'd'];
  const types = ['bakery', 'produce', 'dairy', 'floral'];
  const departments = keys.slice(0, deptCount).map((k, i) => dept(k, types[i]));
  return stage({
    id: 'daily-' + dateIso,
    name: 'Daily Market — ' + dateIso,
    map,
    departments,
    seed: daySeed,
    startingMoney: 80 + (daySeed % 60),
    maxTicks: 240,
    spawnInterval: 6 + (daySeed % 3),
    patience: 30 + (daySeed % 8),
    goals: { serve: 18 + (daySeed % 8) },
    par: { ticks: 210 },
    theme: THEMES[daySeed % THEMES.length].id,
    dailyDate: dateIso,
  });
}

export function dailyDateUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Catalog access
// ---------------------------------------------------------------------------

export function journeyStages() { return JOURNEY; }
export function journeyStage(id) { return JOURNEY.find((s) => s.id === id) || null; }
export function tutorialStages() { return TUTORIALS; }
export function challengeStages() { return CHALLENGES; }
export function themeById(id) { return THEMES.find((t) => t.id === id) || THEMES[0]; }

export function buildStageConfig(configOrId) {
  if (typeof configOrId === 'string') {
    const found = journeyStage(configOrId) || TUTORIALS.find((t) => t.id === configOrId) || CHALLENGES.find((c) => c.id === configOrId);
    if (!found) throw new Error('unknown stage ' + configOrId);
    return structuredClone(found);
  }
  return structuredClone(configOrId);
}

// ---------------------------------------------------------------------------
// Offline validators
// ---------------------------------------------------------------------------

// Greedy auto-player used by validators and tests to prove goals are reachable
// and stages cannot soft-lock. Uses only the public legal-action API.
export function autoPlay(config, { maxTicks = 4000 } = {}) {
  let state = createGame(config);
  const log = [];
  let n = 0;
  while (!isTerminal(state) && n < maxTicks) {
    n++;
    const legal = legalActions(state);
    // Priority: serve > restock > unlock > hire cashier > hire stocker > upgrade.
    // With a move limit, hire staff first and let automation do the work.
    const limited = config.moveLimit != null;
    const unlockPending = config.goals.unlock &&
      state.departments.filter((d) => d.unlocked).length < config.goals.unlock;
    const pick = limited
      ? (legal.find((a) => a.type === COMMANDS.HIRE && a.role === 'cashier') ||
         legal.find((a) => a.type === COMMANDS.HIRE && a.role === 'stocker') ||
         (state.staff.cashier.hired ? null : legal.find((a) => a.type === COMMANDS.SERVE)) ||
         (state.staff.stocker.hired ? null : legal.find((a) => a.type === COMMANDS.RESTOCK)))
      : (legal.find((a) => a.type === COMMANDS.SERVE) ||
         // pursue an unlock goal ahead of routine restocking
         (unlockPending ? legal.find((a) => a.type === COMMANDS.UNLOCK) : null) ||
         legal.find((a) => a.type === COMMANDS.RESTOCK) ||
         legal.find((a) => a.type === COMMANDS.UNLOCK) ||
         legal.find((a) => a.type === COMMANDS.HIRE && a.role === 'cashier') ||
         legal.find((a) => a.type === COMMANDS.HIRE && a.role === 'stocker') ||
         // never sink savings into upgrades while an unlock goal is pending
         (unlockPending ? null : legal.find((a) => a.type === COMMANDS.UPGRADE)));
    if (pick && (state.tick % 2 === 0 || pick.type === COMMANDS.SERVE)) {
      // act at most every other tick (except serving) to keep play realistic
      const res = applyCommand(state, { ...pick, id: 'auto-' + n, tick: state.tick });
      state = res.state;
      log.push(pick.type);
      if (state.tick >= config.maxTicks) break;
    }
    if (!isTerminal(state)) state = step(state);
  }
  return { state, actions: log, score: computeScore(state) };
}

export function validateStage(config) {
  const problems = [];
  try {
    const state = createGame(config);
    if (!config.goals || (!config.goals.serve && !config.goals.earn && !config.goals.unlock)) {
      problems.push('stage has no goals');
    }
    if (!(config.maxTicks > 0 && config.maxTicks <= 4000)) problems.push('maxTicks out of bounds');
    if (!(config.startingMoney >= 0)) problems.push('negative starting money');
    if (!state.displays.length) problems.push('no displays');
    const unlocked = state.departments.filter((d) => d.unlocked);
    if (!unlocked.length) problems.push('no starting department');
  } catch (e) {
    problems.push('construction failed: ' + e.message);
    return { ok: false, problems };
  }
  const run = autoPlay(config);
  if (run.state.phase !== 'won') {
    problems.push(`auto-play could not reach goals (phase=${run.state.phase}, served=${run.state.stats.served}, revenue=${run.state.stats.revenue})`);
  }
  return { ok: problems.length === 0, problems };
}

export function validateAll() {
  const report = [];
  for (const s of [...TUTORIALS, ...JOURNEY, ...CHALLENGES]) {
    report.push({ id: s.id, ...validateStage(s) });
  }
  for (const d of ['relaxed', 'standard', 'intense']) {
    report.push({ id: 'practice-' + d, ...validateStage(practiceConfig(d)) });
  }
  for (let i = 0; i < 5; i++) {
    const date = `2026-01-0${i + 1}`;
    report.push({ id: 'daily-' + date, ...validateStage(dailyConfig(date)) });
  }
  return report;
}
