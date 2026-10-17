// Market Manager — graphics quality model: presets, per-category overrides,
// hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js, no DOM), so the
// settings panel, the renderer and the unit tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],   // image-based lighting (room environment map)
  detail: ['plain', 'detailed'], // procedural surface textures, glossy goods, sky, props
  particles: ['low', 'high'],    // burst cap + ambient floating motes
};

// Each preset is a row of tiers, a render scale (multiplies the capped device
// pixel ratio) and the device-pixel-ratio cap itself.
const TABLE = {
  low: { scale: 1, maxRatio: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', reflections: 'off', detail: 'plain', particles: 'low' },
  balanced: { scale: 1, maxRatio: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'high' },
  high: { scale: 1, maxRatio: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high' },
  ultra: { scale: 1.25, maxRatio: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_CAP = { low: 300, high: 2000 };

// StarHermit hardware level (0–20, src/gpu-level.js → window.StarHermitGpu) at which Auto starts choosing
// each preset. 0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX 5090; phones, tablets and ≤ 4 GB machines
// are capped at level 9 (Balanced); software renderers are level 0 (Low).
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

/*
 * Per-preset asset and effect budgets, each tuned to hold 60 FPS on the weakest GPU Auto gives the preset
 * (Low: level 0 phones / Intel UHD; Balanced: level 4 Iris Xe; High: level 10 GTX 1070; Ultra: level 17
 * RTX 4080; measured with tests/gfx-bench.mjs). Gameplay is identical on every preset.
 *   material  market surfaces, fixtures, goods and people: 'lambert' (Low) | 'standard' (Balanced) |
 *             'physical' (clearcoated arch, counters, goods, pots and clothing with detail on; High/Ultra)
 *   textures  multiplies the procedural tile / grass / plaster / wood / awning texture sizes
 *             (128 / 256 / 128 / 128 / 64 px at 1)
 *   segments  geometry LOD: multiplies the people (capsule, head), rings, contact discs and planter cones
 *   props     multiplies the decorative planters outside the walls (detail on)
 *   motes     ambient floating motes (particles high)
 *   sparks    multiplies coin / pop / puff / confetti burst counts and the particle cap, then scaled by
 *             the hardware level within the preset (≤ 2×)
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', textures: 0.5, segments: 0.5, props: 0.5, motes: 35, sparks: 0.5, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', textures: 1, segments: 0.75, props: 0.75, motes: 50, sparks: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', textures: 1, segments: 1, props: 1, motes: 70, sparks: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', textures: 2, segments: 1.5, props: 1.5, motes: 120, sparks: 1.5, bloomRes: 1, aoRes: 1 },
};

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system = {}) {
  const G = gpuApi();
  if (!G) return LEVELS.balanced;
  return G.detectLevel({ webgl: true, webgl2: true, ...system, gpu: String(gpu || '') });
}

/** Auto preset for a hardware level: Low 0, Balanced 4, High 10, Ultra 17. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, LEVELS);
  return PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/**
 * Best preset for this GPU; phones and tablets are capped at Balanced by the hardware level.
 * `system` is a StarHermitGpu.detectSystem() result (or `true` for a touch/mobile device).
 */
export function detectPreset(gpu, system = {}) {
  return presetForLevel(detectLevel(gpu, typeof system === 'boolean' ? { mobile: system } : system || {}));
}

/** A preset's concrete budget for a hardware level (sparks scale within the preset, ≤ 2×). */
export function budget(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] ?? 0;
  const k = G ? Math.min(2, G.scaleBudget(1, Number.isFinite(level) ? level : floor, floor)) : 1;
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return b;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset,
    auto,
    renderScale: clamp(Number(s.render_scale) || 1, 0.5, 2),
    maxRatio: row.maxRatio,
  };
  out.scale = row.scale * out.renderScale;
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budget(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The post chain runs only when something needs it (MSAA is done on the
  // chain's render target, so the canvas context never pays for it).
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias !== 'off';
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset] ? TABLE[preset][cat] : undefined;
}

/** Saved settings after choosing a preset: overrides are cleared, scale/toggles kept. */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const out = { preset: PRESETS.includes(preset) ? preset : 'auto' };
  if (s.render_scale !== undefined) out.render_scale = s.render_scale;
  if (s.adaptive !== undefined) out.adaptive = s.adaptive;
  if (s.show_fps !== undefined) out.show_fps = s.show_fps;
  return out;
}

/** Legacy `settings.quality` (auto|low|medium|high) → graphics preset. */
export function legacyPreset(quality) {
  if (quality === 'medium') return 'balanced';
  return PRESETS.includes(quality) ? quality : 'auto';
}

export const SUMMARY_WORDS = {
  shadows: 'shadows', noShadows: 'no shadows', ao: 'AO', fullAo: 'full AO',
  bloom: 'bloom', reflections: 'reflections', noAa: 'no AA',
};

/** Cost summary; `words` lets the settings panel pass localized terms. */
export function describe(r, pixels, words = SUMMARY_WORDS) {
  const w = { ...SUMMARY_WORDS, ...(words || {}) };
  const parts = [
    r.shadows === 'off' ? w.noShadows : `${SHADOW_MAP[r.shadows]}² ${w.shadows}`,
    r.ao === 'off' ? null : r.ao === 'high' ? w.fullAo : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    r.antialias === 'off' ? w.noAa : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/**
 * Unmasked GPU name from a WebGL context (WEBGL_debug_renderer_info). Firefox
 * already reports it through RENDERER and warns on the extension, so it is
 * skipped there.
 */
export function gpuName(gl, userAgent = '') {
  try {
    if (!gl) return '';
    if (!/firefox/i.test(userAgent)) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    }
    return String(gl.getParameter(gl.RENDERER) || '');
  } catch (_) {
    return '';
  }
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
