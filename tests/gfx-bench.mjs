// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Journey stage 1 (First Shift) and lets the market run — customers walk, queue and pay with
// coin and puff bursts — while the visible Hint button and canvas picking are used. A finished shift is
// replayed with Retry.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

const screen = (page, name) => page.waitForSelector(`[data-screen="${name}"]:not([hidden])`, { timeout: 15000 });

export async function setPreset(page, preset) {
  await page.waitForSelector('#btn-play', { state: 'visible', timeout: 20000 });
  await page.click('#btn-settings-title');
  await screen(page, 'settings');
  await page.selectOption('#set-quality', preset);
  await page.waitForFunction((p) => document.documentElement.dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
  await screen(page, 'title');
}

export async function start(page) {
  await page.click('#btn-play');
  await screen(page, 'mode-select');
  await page.locator('#mode-cards .card', { hasText: 'Journey' }).click();
  await screen(page, 'stage-select');
  await page.locator('#stage-list .stage-card').first().click();
  await screen(page, 'setup');
  await page.click('#btn-start');
  await screen(page, 'game');
  await page.waitForFunction(() => /Tick [1-9]/.test(document.getElementById('board-mirror').textContent), null, { timeout: 15000 });
  let stopped = false, n = 0;
  page.once('close', () => { stopped = true; });
  (async () => {
    while (!stopped) {
      try {
        if (await page.locator('[data-screen="results"]:not([hidden])').count()) {
          await page.click('#btn-retry', { timeout: 5000 });
        } else if (n % 3 === 0) {
          await page.click('#btn-hint', { timeout: 5000 });
        } else {
          const box = await page.locator('#scene-host canvas').boundingBox();
          if (box) await page.mouse.click(box.x + box.width * (0.35 + (n % 5) * 0.07), box.y + box.height * 0.5);
        }
      } catch { /* screen changing */ }
      n++;
      await new Promise((r) => setTimeout(r, 900));
    }
  })();
  await page.waitForTimeout(1000);
}
