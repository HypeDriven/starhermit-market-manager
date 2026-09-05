/**
 * Market Manager — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the real on-screen UI in headless Chrome (playwright-core + system
 * Chrome). Self-contained: starts its own static file server on an ephemeral
 * port and tears everything down at the end. The repo's server.js is the
 * StarHermit authoritative game script, so it is intentionally NOT used here;
 * the game is fully playable offline (src/platform.js falls back to local
 * behavior when /api/v1/* is absent — the probe 404 is expected and silent).
 *
 * Flow per pass (desktop 1280x800, then a fresh mobile 390x844 + touch):
 *   load → title → help open/close → settings open/close → Play →
 *   mode select → Journey → stage 1 ("First Shift") → shift briefing →
 *   countdown → active play. The market floor is a Three.js canvas, so
 *   gameplay commands go through the game's documented keyboard play path
 *   (Arrow keys move the visible 3D highlight between market actions,
 *   Enter confirms — same handlers as the on-screen/sr-only action buttons);
 *   pointer picking is exercised with a real canvas click, and the HUD
 *   buttons (hint, staff panel, pause) are clicked directly. Play continues
 *   (serve queue > restock shelf) until the results screen, which is
 *   verified for its score breakdown. Pause → settings → resume is covered
 *   mid-round.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// Benign GPU/swiftshader noise (from tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

function serveStatic() {
  const server = http.createServer((req, res) => {
    let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const screenVisible = (page, name) =>
  page.waitForSelector(`[data-screen="${name}"]:not([hidden])`, { timeout: 15000 });

// Read the live market state the way a keyboard player sees it: the action
// list mirrors every legal move as a button (sr-only, focusable, and its
// focus is highlighted on the 3D board). Used for decisions/timing only —
// every action is performed with real key presses.
async function readMarket(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('#mirror-list button')].map((b) => ({
      key: b.dataset.key, disabled: b.disabled, label: b.textContent,
    }));
    return {
      btns,
      results: !document.querySelector('[data-screen="results"]').hidden,
      game: !document.querySelector('[data-screen="game"]').hidden,
      mirror: document.getElementById('board-mirror')?.textContent || '',
      focusedKey: document.activeElement?.dataset?.key || null,
    };
  });
}

// Move the on-screen action cursor with arrow keys until the wanted action
// is focused, then confirm with Enter — the documented keyboard controls.
async function activateAction(page, key) {
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate((k) => {
      const target = document.querySelector(`#mirror-list button[data-key="${k}"]`);
      if (!target || target.disabled) return 'gone';
      return document.activeElement === target ? 'focused' : 'move';
    }, key);
    if (st === 'focused') {
      await page.keyboard.press('Enter');
      return true;
    }
    if (st === 'gone') return false;
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(40);
  }
  return false;
}

async function playShift(page, shot) {
  // Greedy shift manager: serve waiting guests first, restock any shelf at
  // 1 item or less. Journey stage 1 needs 6 serves within 160 ticks (~80 s).
  const deadline = Date.now() + 110000;
  let actions = 0;
  let lastMirror = '';
  while (Date.now() < deadline) {
    const st = await readMarket(page);
    if (st.results) return { mirror: st.mirror, actions };
    if (!st.game) { await page.waitForTimeout(300); continue; }
    if (st.mirror !== lastMirror) { lastMirror = st.mirror; }
    const serve = st.btns.find((b) => !b.disabled && b.key.startsWith('serve-'));
    const restock = st.btns.find((b) => {
      if (b.disabled || !b.key.startsWith('restock-')) return false;
      const m = b.label.match(/(\d+)\/(\d+) stocked/);
      return m && Number(m[1]) <= 1;
    });
    const target = serve || restock;
    if (target) {
      const did = await activateAction(page, target.key);
      if (did) actions++;
    } else {
      await page.waitForTimeout(250);
    }
  }
  throw new Error('results screen never appeared within 110 s of play');
}

async function runPass(browser, { name, viewport, hasTouch }) {
  const context = await browser.newContext({ viewport, hasTouch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const loc = m.location()?.url || '';
    // Benign: the game's one backend probe (/api/v1/time) 404s on this static
    // server; src/platform.js is designed to fall back to offline play.
    if (/Failed to load resource/.test(m.text()) && loc.includes('/api/v1/')) return;
    errors.push(`console: ${m.text()} [${loc}]`);
  });

  const shot = (stage) => page.screenshot({ path: `/tmp/market-manager-e2e-${stage}-${name}.png` });
  const step = async (label, fn) => { await fn(); console.log(`ok - ${name}: ${label}`); };

  try {
    await step('load → title visible', async () => {
      await page.goto(`http://127.0.0.1:${runPass.port}/`, { waitUntil: 'load' });
      // If WebGL is unavailable the compat screen appears; continue without 3D.
      const compat = await page.locator('[data-screen="compat"]:not([hidden])').count();
      if (compat) {
        await page.click('#btn-compat-continue');
        runPass.webgl = false;
      } else {
        runPass.webgl = true;
      }
      await screenVisible(page, 'title');
      await page.waitForSelector('#btn-play');
      await shot('title');
    });

    await step('help opens and closes', async () => {
      await page.click('#btn-help-title');
      await screenVisible(page, 'help');
      const cards = await page.locator('#help-cards .card').count();
      if (cards < 6) throw new Error(`expected help cards, got ${cards}`);
      await page.click('#btn-help-close');
      await screenVisible(page, 'title');
    });

    await step('settings opens, applies, closes', async () => {
      await page.click('#btn-settings-title');
      await screenVisible(page, 'settings');
      await page.check('#set-high-contrast');
      const applied = await page.evaluate(() => document.documentElement.classList.contains('high-contrast'));
      if (!applied) throw new Error('high-contrast setting not applied to <html>');
      await page.uncheck('#set-high-contrast');
      await shot('settings');
      await page.click('#btn-settings-close');
      await screenVisible(page, 'title');
    });

    await step('Play → mode select with 6 modes', async () => {
      await page.click('#btn-play');
      await screenVisible(page, 'mode-select');
      const cards = await page.locator('#mode-cards .card').count();
      if (cards !== 6) throw new Error(`expected 6 mode cards, got ${cards}`);
      await shot('modes');
    });

    await step('Journey → stage select → First Shift briefing', async () => {
      await page.locator('#mode-cards .card', { hasText: 'Journey' }).click();
      await screenVisible(page, 'stage-select');
      const first = page.locator('#stage-list .stage-card').first();
      if (await first.isDisabled()) throw new Error('first journey stage is locked for a new player');
      await first.click();
      await screenVisible(page, 'setup');
      const summary = await page.textContent('#setup-summary');
      if (!/serve 6/i.test(summary)) throw new Error('unexpected stage 1 goals: ' + summary);
      await shot('setup');
    });

    await step('start shift → countdown → active market floor', async () => {
      await page.click('#btn-start');
      await screenVisible(page, 'game');
      await page.waitForSelector('#countdown:not([hidden])', { timeout: 5000 });
      await shot('countdown');
      // countdown ~2.4 s, then the tick loop starts
      await page.waitForFunction(() => /Tick [1-9]/.test(document.getElementById('board-mirror').textContent), null, { timeout: 10000 });
      if (await page.locator('#btn-pause').isHidden()) throw new Error('pause button not visible on the floor');
      await shot('floor');
    });

    await step('pointer picking on the 3D canvas', async () => {
      const canvas = page.locator('#scene-host canvas');
      if (await canvas.count()) {
        const box = await canvas.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(200);
      }
    });

    await step('hint + staff panel via HUD buttons', async () => {
      await page.click('#btn-hint');
      await page.waitForTimeout(200);
      await page.click('#btn-staff-toggle');
      await page.waitForSelector('#staff-panel:not([hidden])');
      const text = await page.textContent('#staff-panel');
      if (!/Stocker/.test(text) || !/Cashier/.test(text)) throw new Error('staff panel missing roles');
      await page.click('#btn-staff-toggle');
      await page.waitForSelector('#staff-panel', { state: 'hidden' });
    });

    await step('pause → settings → resume', async () => {
      await page.click('#btn-pause');
      await screenVisible(page, 'pause');
      await shot('pause');
      await page.click('#btn-pause-settings');
      await screenVisible(page, 'settings');
      await page.click('#btn-settings-close');
      await screenVisible(page, 'pause');
      await page.click('#btn-resume');
      await screenVisible(page, 'game');
    });

    await step('play the shift to the results screen', async () => {
      await shot('play-early');
      const out = await playShift(page, shot);
      console.log(`  ${name}: shift ended after ${out.actions} UI actions · ${out.mirror}`);
      await screenVisible(page, 'results');
    });

    await step('results show score breakdown', async () => {
      const heading = await page.textContent('#results-heading');
      if (!/Shift (complete|over)/.test(heading)) throw new Error('unexpected results heading: ' + heading);
      const rows = await page.locator('#results-table tr').count();
      if (rows !== 6) throw new Error(`expected 6 score rows, got ${rows}`);
      const total = await page.textContent('#results-total');
      console.log(`  ${name}: ${heading} · total ${total}`);
      await shot('results');
    });

    await step('results → mode select → back to title', async () => {
      await page.click('#btn-results-modes');
      await screenVisible(page, 'mode-select');
      await page.locator('[data-screen="mode-select"] [data-back]').click();
      await screenVisible(page, 'title');
    });
  } finally {
    await context.close();
  }
  return errors;
}

const { server, port } = await serveStatic();
runPass.port = port;
let browser = null;
let failed = false;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });

  const desktopErrors = await runPass(browser, { name: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false });
  if (desktopErrors.length) {
    failed = true;
    console.log('DESKTOP PAGE ERRORS:\n' + desktopErrors.join('\n'));
  }

  const mobileErrors = await runPass(browser, { name: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true });
  if (mobileErrors.length) {
    failed = true;
    console.log('MOBILE PAGE ERRORS:\n' + mobileErrors.join('\n'));
  }
} catch (e) {
  failed = true;
  console.error('E2E FAILURE:', e);
} finally {
  if (browser) await browser.close();
  server.close();
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('\nE2E PASS — desktop and mobile playthroughs completed with no page errors');
}
