// The save document (src/store.js) and the records session.js keeps in it:
// the browser build's cloud slot migrates, two devices' copies merge as the
// old saveconflict handler did, and the local boards record ranked runs.
// Run: node --test tests/store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, mergeDocs, readForeign, keyStore, recordLocal, localEntries, mergeBoards } from '../src/store.js';
import { setKeyStore, loadProgress, saveProgress, loadSettings, saveSettings, loadKey, saveKey, DEFAULT_SETTINGS } from '../src/session.js';

test('normalize keeps only the document fields', () => {
  assert.deepEqual(normalize({ v: 1, savedAt: 5, progress: { guestsServedTotal: 3 }, junk: 1, boards: 'x' }), { v: 1, progress: { guestsServedTotal: 3 } });
  assert.deepEqual(normalize(null), { v: 1 });
});

test('the browser build\'s cloud slot reads as a document', () => {
  const text = JSON.stringify({ v: 1, savedAt: 1760000000000, progress: { journey: { j01: { won: true, best: 900 } }, guestsServedTotal: 40 }, boards: { global: { all: [{ name: 'You', score: 900, sessionId: 's1', durationMs: 1 }] } } });
  const doc = readForeign(text);
  assert.equal(doc.progress.journey.j01.best, 900);
  assert.equal(doc.boards.global.all.length, 1);
  assert.equal(readForeign('not json'), null);
  assert.equal(readForeign(null), null);
});

test('session.js records live in the document through keyStore', () => {
  const doc = normalize(null);
  let writes = 0;
  setKeyStore(keyStore(doc, () => { writes++; }));
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
  const p = loadProgress();
  p.guestsServedTotal = 12;
  p.tutorialsDone.push('t01');
  saveProgress(p);
  saveSettings({ ...loadSettings(), camera: 'high' });
  saveKey('lastPlayed.v1', { mode: 'journey', id: 'j02' });
  assert.equal(writes, 3);
  assert.equal(doc.progress.guestsServedTotal, 12);
  assert.equal(doc.settings.camera, 'high');
  assert.deepEqual(loadKey('lastPlayed.v1'), { mode: 'journey', id: 'j02' });
  assert.equal(loadKey('unknown.v1'), null);
  // The store hands out copies: changing what was loaded changes nothing until saved.
  loadProgress().guestsServedTotal = 99;
  assert.equal(doc.progress.guestsServedTotal, 12);
});

test('two devices merge: better records, every lesson and achievement, both boards, this device\'s settings', () => {
  const remote = {
    v: 1,
    progress: { journey: { j01: { won: true, best: 80 }, j02: { won: true, best: 30 } }, tutorialsDone: ['t02'], achievements: { 'first-shift': true }, guestsServedTotal: 25, winStreak: 4, bestStreak: 4 },
    boards: { daily: { '2026-10-27': [{ name: 'A', score: 500, sessionId: 'r1', durationMs: 9 }] } },
    settings: { camera: 'low' },
  };
  const local = {
    v: 1,
    progress: { journey: { j01: { won: true, best: 60 } }, tutorialsDone: ['t01'], achievements: { 'hot-streak': true }, guestsServedTotal: 10, winStreak: 1, bestStreak: 2 },
    boards: { daily: { '2026-10-27': [{ name: 'B', score: 700, sessionId: 'l1', durationMs: 9 }, { name: 'A', score: 500, sessionId: 'r1', durationMs: 9 }] } },
    settings: { camera: 'high' },
    lastPlayed: { mode: 'journey', id: 'j01' },
  };
  const m = mergeDocs(remote, local);
  assert.equal(m.progress.journey.j01.best, 80);
  assert.equal(m.progress.journey.j02.won, true);
  assert.deepEqual(m.progress.tutorialsDone.sort(), ['t01', 't02']);
  assert.ok(m.progress.achievements['first-shift'] && m.progress.achievements['hot-streak']);
  assert.equal(m.progress.guestsServedTotal, 25);
  assert.equal(m.progress.bestStreak, 4);
  assert.deepEqual(m.boards.daily['2026-10-27'].map((e) => e.sessionId), ['l1', 'r1']);
  assert.equal(m.settings.camera, 'high');
  assert.deepEqual(m.lastPlayed, { mode: 'journey', id: 'j01' });
  // A device with no save yet takes the other's.
  assert.equal(mergeDocs(remote, null).settings.camera, 'low');
});

test('local boards: ranked runs best first, capped, by date for the Daily', () => {
  let boards = {};
  let r;
  for (const [score, id] of [[300, 'a'], [900, 'b'], [500, 'c']]) {
    r = recordLocal(boards, { name: 'You', score, date: '2026-10-27', durationMs: 1000, sessionId: id, dailyDate: '2026-10-27' });
    boards = r.boards;
  }
  assert.equal(r.rank, 2);
  assert.deepEqual(localEntries(boards, 'daily', '2026-10-27').map((e) => e.score), [900, 500, 300]);
  assert.deepEqual(localEntries(boards, 'global', null), []);
  for (let i = 0; i < 60; i++) boards = recordLocal(boards, { name: 'You', score: i, date: 'd', durationMs: 1, sessionId: `g${i}` }).boards;
  assert.equal(localEntries(boards, 'global', null).length, 50);
  assert.equal(mergeBoards(boards, boards).global.all.length, 50);
});
