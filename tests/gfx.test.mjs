// Unit tests for the pure graphics quality model (src/gfx.js) and the
// Graphics panel locale picker. Run: node --test tests/gfx.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, CATEGORIES, SHADOW_MAP, LEVELS, BUDGETS, budget, detectLevel, presetForLevel, detectPreset, resolve,
  presetTier, choosePreset, legacyPreset, describe, gpuName,
} from '../src/gfx.js';

// src/gpu-level.js is a classic script in the page; imported here it sets globalThis.StarHermitGpu.
await import('../src/gpu-level.js');
import { pickLocale, graphicsStrings, STRINGS } from '../src/gfx-panel.js';

test('hardware level picks the Auto preset (StarHermit gpu-level.js)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('Microsoft Basic Render Driver'), 'low');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)'), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)'), 'ultra');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)'), 'ultra');
  assert.equal(detectLevel('NVIDIA GeForce RTX 5090'), 20);
  assert.equal(detectLevel('SwiftShader'), 0);
  assert.equal(detectLevel('', { webgl: false }), 0, 'no WebGL');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(9), 'balanced');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets cap Auto at Balanced', () => {
  assert.ok(['low', 'balanced'].includes(detectPreset('Adreno (TM) 740', { mobile: true })), 'mobile Adreno 740 is Balanced at most');
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', true), 'balanced');
  assert.equal(detectPreset('SwiftShader', true), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'textures', 'segments', 'props', 'motes', 'sparks', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(k in BUDGETS[p], `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) {
    const a = BUDGETS[PRESETS[i - 1]], b = BUDGETS[PRESETS[i]];
    for (const k of keys.slice(1)) assert.ok(b[k] >= a[k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(budget('high', 10), BUDGETS.high, 'floor level = table');
  assert.ok(budget('high', 14).sparks > BUDGETS.high.sparks, 'sparks grow above the floor');
  assert.ok(budget('ultra', 20).sparks <= BUDGETS.ultra.sparks * 2, 'at most 2x');
  assert.ok(budget('ultra', 2).sparks < BUDGETS.ultra.sparks, 'fewer below the floor');
  assert.deepEqual(resolve({ preset: 'low' }, 'low', 0).budget, BUDGETS.low);
  assert.equal(resolve({}, 'ultra', 20).level, 20);
});

test('resolve: auto uses the detected preset; explicit preset wins', () => {
  const auto = resolve({}, 'low');
  assert.equal(auto.preset, 'low');
  assert.equal(auto.auto, true);
  assert.equal(auto.post, false, 'Low renders without a post chain');
  assert.equal(auto.shadows, 'off');
  assert.equal(auto.maxRatio, 1);
  const hi = resolve({ preset: 'high' }, 'low');
  assert.equal(hi.preset, 'high');
  assert.equal(hi.auto, false);
  assert.equal(hi.shadows, 'medium');
  assert.equal(hi.antialias, 'smaa');
  assert.equal(hi.post, true);
  assert.equal(resolve({ preset: 'bogus' }, 'nonsense').preset, 'balanced');
});

test('resolve: per-category overrides and invalid tiers', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'high', ao: 'extreme' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'high');
  assert.equal(r.ao, 'off', 'invalid tier falls back to the preset');
  assert.equal(r.post, true, 'an override that needs post turns the chain on');
  assert.equal(resolve({ preset: 'low', antialias: 'msaa' }, 'low').post, true);
});

test('resolve: render scale is clamped to 50–200% and multiplies the preset scale', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(resolve({ preset: 'high', render_scale: 1.5 }).scale, 1.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 2 }).scale, 2.5);
  assert.equal(resolve({ preset: 'high' }).renderScale, 1);
});

test('resolve: adaptive defaults on, frame rate readout defaults off', () => {
  const r = resolve({});
  assert.equal(r.adaptive, true);
  assert.equal(r.showFps, false);
  const s = resolve({ adaptive: false, show_fps: true });
  assert.equal(s.adaptive, false);
  assert.equal(s.showFps, true);
});

test('choosing a preset clears overrides but keeps scale and toggles', () => {
  const saved = { preset: 'low', bloom: 'on', shadows: 'high', render_scale: 1.5, adaptive: false, show_fps: true };
  const next = choosePreset(saved, 'high');
  assert.deepEqual(next, { preset: 'high', render_scale: 1.5, adaptive: false, show_fps: true });
  const r = resolve(next, 'low');
  assert.equal(r.bloom, 'on', 'High’s own bloom');
  assert.equal(r.shadows, 'medium', 'override cleared back to High’s tier');
  assert.equal(choosePreset(saved, 'auto').preset, 'auto');
});

test('every preset defines every category with a valid tier', () => {
  for (const p of PRESETS) {
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
    }
  }
  assert.equal(presetTier('nope', 'bloom'), undefined);
  // presets never get cheaper going up
  const cost = (p) => Object.entries(CATEGORIES).reduce((n, [c, t]) => n + t.indexOf(presetTier(p, c)), 0);
  for (let i = 1; i < PRESETS.length; i++) assert.ok(cost(PRESETS[i]) >= cost(PRESETS[i - 1]));
});

test('legacy quality setting maps onto presets', () => {
  assert.equal(legacyPreset('medium'), 'balanced');
  assert.equal(legacyPreset('high'), 'high');
  assert.equal(legacyPreset('auto'), 'auto');
  assert.equal(legacyPreset(undefined), 'auto');
});

test('describe summarizes cost with optional localized words', () => {
  const r = resolve({ preset: 'high' });
  assert.equal(describe(r, [1280, 800]), `${SHADOW_MAP.medium}² shadows · AO · bloom · reflections · SMAA · 1280×800 px`);
  assert.equal(describe(resolve({ preset: 'low' })), 'no shadows · no AA');
  assert.match(describe(r, null, { shadows: 'Schatten' }), /2048² Schatten/);
});

test('gpuName reads the unmasked renderer, falling back to RENDERER', () => {
  const gl = {
    RENDERER: 1,
    getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 2 } : null),
    getParameter: (p) => (p === 2 ? 'Real GPU' : 'Masked'),
  };
  assert.equal(gpuName(gl, 'Chrome'), 'Real GPU');
  assert.equal(gpuName(gl, 'Mozilla/5.0 Firefox/130.0'), 'Masked');
  assert.equal(gpuName(null), '');
});

test('graphics panel strings exist for every shipped locale', () => {
  const locales = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const keys = Object.keys(STRINGS['en-US']);
  for (const loc of locales) {
    assert.ok(STRINGS[loc], loc);
    const s = graphicsStrings(loc);
    for (const k of keys) assert.ok(s[k] !== undefined && s[k] !== '', `${loc}.${k}`);
    for (const cat of Object.keys(CATEGORIES)) assert.ok(s[cat], `${loc} category ${cat}`);
    for (const tiers of Object.values(CATEGORIES)) for (const t of tiers) assert.ok(s[t], `${loc} tier ${t}`);
    assert.match(s.auto, /\{tier\}/);
    assert.match(s.fromPreset, /\{tier\}/);
  }
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('es-ES'), 'es-ES');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('fr-BE'), 'fr-FR');
  assert.equal(pickLocale('en-AU'), 'en-GB');
  assert.equal(pickLocale('pt-PT'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
  assert.equal(graphicsStrings('de-DE').legend, 'Grafik');
});
