// StarHermit adapter (src/platform.js) over the real shared SDK with a stubbed
// fetch and launch fragment. Run: node --test tests/platform.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPlatform } from '../src/platform.js';
import { saveKey, loadKey } from '../src/session.js';

const SDK_SRC = fs.readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8');
function loadSdk() {
  const mod = { exports: {} };
  new Function('module', 'exports', 'self', SDK_SRC)(mod, mod.exports, globalThis);
  return mod.exports;
}

const USER = 'a1b2c3d4-0000-4000-8000-000000000001';
const SLUG = 'market-manager';

function fixture(href, store = { slot: null, etag: null, version: 0 }) {
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64url({ alg: 'none' })}.${b64url({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  const u = new URL(href.replace('{jwt}', jwt));
  const win = {
    location: { href: u.href, hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash, origin: u.origin, assign() {} },
    history: { state: null, replaceState(_s, _t, url) { win.replaced = url; } },
  };
  const calls = [];
  const kv = { music: 0.3 };
  const res = (status, body, bytes) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (body == null ? '' : JSON.stringify(body)),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = init.headers || {};
    calls.push({ url, method, body, auth: headers.Authorization });
    if (url === `/api/v1/users/${USER}/profile`) return res(200, { nickname: 'Shopkeep', username: 'hidden' });
    const saveUrl = `/api/v1/me/cloud-saves/${encodeURIComponent('game:' + SLUG)}`;
    if (url === saveUrl + '/info') return res(200, store.slot ? { exists: true, etag: store.etag } : { exists: false });
    if (url === saveUrl) {
      // Conditional writes like the platform: a stale If-Match or an
      // If-None-Match: * over an existing slot is rejected with 412.
      if (method === 'PUT') {
        if ((headers['If-Match'] && headers['If-Match'] !== store.etag) || (headers['If-None-Match'] === '*' && store.slot)) {
          return res(412, { error: 'precondition_failed', etag: store.etag });
        }
        store.slot = new Uint8Array(Buffer.from(body.dataBase64, 'base64'));
        store.etag = `"v${++store.version}"`;
        return res(200, { etag: store.etag });
      }
      return store.slot ? res(200, null, store.slot) : res(404);
    }
    if (url === `/api/v1/games/${SLUG}/settings`) {
      if (method === 'PATCH') Object.assign(kv, body.settings);
      return res(200, { settings: kv });
    }
    if (url === `/api/v1/games/${SLUG}/controls`) return res(200, { actions: [{ action: 'hint', codes: ['KeyJ'] }] });
    return res(404);
  };
  // Unref'd timers so the SDK's renewal timer never keeps the process alive.
  const setTimeout = (fn, ms) => { const t = globalThis.setTimeout(fn, ms); t.unref(); return t; };
  const sh = loadSdk().create({ window: win, fetch, setTimeout, clearTimeout });
  return { sh, win, calls, kv, store };
}
const tick = () => new Promise((r) => setImmediate(r));

test('hosted: token read + stripped, nickname, cloud save at game:<slug>', async () => {
  const { sh, win, calls } = fixture('https://market-manager.starhermit.com/#game_token={jwt}');
  const p = createPlatform({ sh });
  assert.equal(p.hosted, true);
  assert.ok(!String(win.replaced).includes('game_token'));
  saveKey('progress.v1', { guestsServedTotal: 77 });
  const info = await p.init();
  assert.equal(info.hosted, true);
  await tick(); await tick();
  assert.equal(p.nickname, 'Shopkeep');
  assert.match(calls[0].auth, /^Bearer /);
  // Platform clock is read only with a launch token, authenticated.
  assert.match(calls.find((c) => c.url === '/api/v1/time').auth, /^Bearer /);
  // No remote save yet → the local cache seeds the slot.
  await sh.flushSave();
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/api/v1/me/cloud-saves/game%3Amarket-manager');
  saveKey('progress.v1', { guestsServedTotal: 0 });
  assert.equal((await p.init()).remoteLoaded, true);
  assert.deepEqual(loadKey('progress.v1'), { guestsServedTotal: 77 });
});

test('hosted: settings KV load + changed-key patch, bindings, invite link', async () => {
  const { sh, calls, kv } = fixture('https://x.example/#game_token={jwt}');
  const p = createPlatform({ sh });
  assert.deepEqual(await p.loadSettings(), { music: 0.3 });
  p.primeSettings({ music: 0.3, haptics: true });
  p.pushSettings({ music: 0.3, haptics: false });
  await p.flushSettings();
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, `/api/v1/games/${SLUG}/settings`);
  assert.deepEqual(patch.body, { settings: { haptics: false } });
  assert.equal(kv.haptics, false);
  assert.deepEqual(await p.loadBindings({ hint: ['KeyH'], pause: ['KeyP'] }), { hint: ['KeyJ'], pause: ['KeyP'] });
  assert.equal(p.inviteLink(), `https://dashboard.starhermit.com/game-invite/${USER}/${SLUG}`);
});

test('standalone: no token means zero platform fetches', async () => {
  const { sh, calls } = fixture('http://localhost:8080/index.html');
  const p = createPlatform({ sh });
  assert.equal(p.hosted, false);
  assert.deepEqual(await p.loadSettings(), {});
  assert.deepEqual(await p.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });
  p.queueCloudSave();
  p.primeSettings({});
  p.pushSettings({ haptics: false });
  assert.equal(p.canSignIn(), false);
  assert.equal(p.inviteLink(), null);
  assert.equal(calls.length, 0);
});

test('standalone: init, boards and score submit make zero own-server requests', async () => {
  const { sh, calls } = fixture('http://localhost:8080/index.html');
  const seen = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { seen.push(String(url)); throw new Error('no network'); };
  try {
    const p = createPlatform({ sh });
    const info = await p.init();
    assert.equal(info.hosted, false);
    const before = Date.now();
    assert.ok(Math.abs(p.serverNow() - before) < 1000); // local clock
    const res = await p.submitScore({ sessionId: 's1', config: { dailyDate: '2026-10-04' }, result: { total: 42 }, durationMs: 1000 });
    assert.equal(res.ok, true);
    assert.equal(res.local, true);
    const board = await p.getLeaderboard({ board: 'daily', date: '2026-10-04' });
    assert.ok(board.some((e) => e.score === 42));
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert.deepEqual(seen, []);
  assert.equal(calls.length, 0);
});

test('signed-out platform host offers sign-in without fetching', () => {
  // Hosted builds are served from <game uuid>.starhermit.com.
  const { sh, calls } = fixture('https://0f6c2a9e-1b2c-4d5e-8f90-123456789abc.starhermit.com/');
  const p = createPlatform({ sh });
  assert.equal(p.canSignIn(), true);
  assert.equal(calls.length, 0);
});

test('save conflict: a write that lost to another device reloads, merges both sides and saves again', async () => {
  const { sh, store, calls } = fixture('https://x.example/#game_token={jwt}');
  const p = createPlatform({ sh });
  saveKey('progress.v1', { journey: { 1: { won: true, best: 50 } }, tutorialsDone: ['learn-1'], guestsServedTotal: 10 });
  await p.init();
  for (let i = 0; i < 20 && !store.slot; i++) { await tick(); await sh.flushSave(); } // seeds the empty slot
  assert.ok(store.slot);
  // Another device (same account) loads the slot and writes a newer version.
  const dev2 = fixture('https://x.example/#game_token={jwt}', store);
  createPlatform({ sh: dev2.sh }); // reads the launch token (no init: local cache stays device 1's)
  await dev2.sh.loadJSON();
  dev2.sh.saveJSON({ progress: { journey: { 1: { won: true, best: 80 }, 2: { won: true, best: 30 } }, tutorialsDone: ['learn-2'], guestsServedTotal: 25 }, boards: {} });
  await dev2.sh.flushSave();
  dev2.sh.signOut();
  let merged = false;
  p.onMerged = () => { merged = true; };
  let conflicted = false;
  sh.on('saveconflict', () => { conflicted = true; });
  saveKey('progress.v1', { ...loadKey('progress.v1'), journey: { 1: { won: true, best: 60 } }, achievements: { first_shift: true } });
  p.queueCloudSave();
  await sh.flushSave();
  assert.ok(conflicted, 'the stale write was rejected');
  for (let i = 0; i < 40 && !merged; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(merged, 'the conflict handler merged');
  await sh.flushSave();
  const local = loadKey('progress.v1');
  assert.equal(local.journey[1].best, 80);
  assert.equal(local.journey[2].won, true);
  assert.deepEqual(local.tutorialsDone.sort(), ['learn-1', 'learn-2']);
  assert.equal(local.guestsServedTotal, 25);
  assert.ok(local.achievements.first_shift);
  const dev3 = fixture('https://x.example/#game_token={jwt}', store);
  createPlatform({ sh: dev3.sh });
  const cloud = await dev3.sh.loadJSON();
  dev3.sh.signOut();
  assert.equal(cloud.progress.journey[1].best, 80);
  assert.ok(cloud.progress.achievements.first_shift, 'the merged document reached the cloud');
  sh.signOut();
});
