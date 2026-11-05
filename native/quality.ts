// The look per graphics level. The engine-owned effects (shadows and their
// map size, ambient occlusion, bloom, the grade, anti-aliasing) are the
// level's own (levelSettings(): the same table every StarHermit game reads).
// The game's art (materials, procedural textures, geometry LOD, planters,
// motes, burst sparks, reflections, detail) is the browser build's four
// presets and budgets (src/gfx.js TABLE / BUDGETS) keyed by the level's
// quality tier, with the burst sparks scaled within the tier by the level's
// particle budget against the tier's anchor level (quantum, molecular,
// terrestrial, galactic), at most 2×. The runtime owns the rest of what the
// old Graphics panel did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and readout. The
// old panel's per-effect overrides are not offered (the runtime's Options
// choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Market surfaces, fixtures, goods and people: Lambert (Low), standard (Balanced), clear-coated physical (High/Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Multiplies the procedural tile / grass / plaster / wood / awning texture sizes (128 / 256 / 128 / 128 / 64 px at 1). */
  textures: number;
  /** Geometry LOD: multiplies the people (capsule, head), rings, contact discs and planter cones. */
  segments: number;
  /** Multiplies the decorative planters outside the walls (detail on). */
  props: number;
  /** Ambient floating motes (particles high). */
  motes: number;
  /** Multiplies coin / pop / puff / confetti burst counts and the particle cap. */
  sparks: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's key-light shadow map size, 0 when the level draws no shadows. */
  shadows: number;
  /** The level's ambient occlusion (null: off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based lighting from a neutral room. */
  reflections: boolean;
  /** Procedural surface textures, glossy goods, the sky gradient, planters. */
  detailed: boolean;
  /** Burst cap + ambient floating motes. */
  particles: "low" | "high";
  budget: Budget;
}

const ART: Record<QualityTier, Pick<Look, "reflections" | "detailed" | "particles">> = {
  low: { reflections: false, detailed: false, particles: "low" },
  balanced: { reflections: true, detailed: true, particles: "high" },
  high: { reflections: true, detailed: true, particles: "high" },
  ultra: { reflections: true, detailed: true, particles: "high" },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", textures: 0.5, segments: 0.5, props: 0.5, motes: 35, sparks: 0.5 },
  balanced: { material: "standard", textures: 1, segments: 0.75, props: 0.75, motes: 50, sparks: 0.75 },
  high: { material: "physical", textures: 1, segments: 1, props: 1, motes: 70, sparks: 1 },
  ultra: { material: "physical", textures: 2, segments: 1.5, props: 1.5, motes: 120, sparks: 1.5 },
};
/** The level whose settings are each tier's preset. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
/** src/gfx.js PARTICLE_CAP: the burst particle cap per particles tier. */
export const PARTICLE_CAP = { low: 300, high: 2000 };

/** The look for a graphics level (the frame's by default). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // The sparks grow with the level's particle budget above the tier's anchor, at most 2× the tier's budget.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
