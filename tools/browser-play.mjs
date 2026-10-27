// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3). Each plays Journey stage 1
// (First Shift) to the results through the page's accessibility mirror of the
// UI (Playwright's getByRole): All modes, Journey, First Shift, Start shift,
// then the checkout and the shelves by mouse clicks on the desktop (with the
// action list opened by the arrow keys and a hint by H) and by finger taps on
// the phones (with the staff drawer opened and closed). Screenshots of each
// step go to --shots. Fails on console errors or warnings, the runtime's
// error screen, or a view that never reaches the results.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
// Serves GAME_DIR on loopback (never tests/, tools/ or dot-names), the engine
// itself from wiki.starhermit.com as the loader pins it. playwright-core is
// resolved from GAME_DIR's node_modules or any sibling game's.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  // The platform's clock (platform.serverTime / serverNow), as the game host answers it.
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1366, height: 768 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];
const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (n) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${n}.png`) }); } };
  /** A button of the UI (or a named area of the market) by its accessible name: clicked, or tapped on touch views. */
  const press = async (name, { exact = true, timeout = 15000 } = {}) => {
    const el = page.getByRole('button', { name, exact }).first();
    await el.waitFor({ state: 'attached', timeout });
    if (v.hasTouch) await el.tap({ force: true, timeout }); else await el.click({ force: true, timeout });
    await page.waitForTimeout(400);
  };
  const seen = (re) => page.getByText(re).count().then((n) => n > 0, () => false);
  let done = false;
  try {
    await shot('title');
    // Play opens the mode list for a new player (as All modes does); on the short landscape panel All modes is below the fold.
    await press('Play');
    await press('Journey');
    await shot('stages');
    await press('First Shift');
    await shot('setup');
    // The briefing focuses Start shift (below the fold on the landscape panel): Enter starts.
    await page.waitForTimeout(800);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.waitForTimeout(3500);
    await shot('play');
    if (!v.hasTouch) {
      await page.keyboard.press('ArrowDown'); await page.waitForTimeout(600);
      await shot('action-list');
      await page.keyboard.press('KeyH'); await page.waitForTimeout(500);
      await shot('hint');
    } else {
      await press('Toggle staff panel');
      await shot('staff');
      await press('Toggle staff panel');
    }
    const shelves = ['Rise & Crumb Bakery — shelf 1', 'Rise & Crumb Bakery — shelf 2', 'Rise & Crumb Bakery — shelf 3', 'Rise & Crumb Bakery — shelf 4'];
    for (let i = 0; i < 160 && !done; i++) {
      await press('Checkout 1', { timeout: 5000 }).catch(() => undefined);
      if (i % 3 === 0) await press(shelves[(i / 3) % 4], { timeout: 5000 }).catch(() => undefined);
      if (i % 3 === 0) await press('Close', { timeout: 500 }).catch(() => undefined);
      if (i === 12) await shot('mid');
      done = await seen(/Shift complete/);
    }
    await page.waitForTimeout(1500);
    await shot('results');
  } catch (e) { problems.push(`step: ${e.message.split('\n')[0]}`); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && done;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} results=${done}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
