// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the burst sparks scaled within the tier by the level
// (frame().levelIndex, at most 2×), as the browser build scaled them by its
// hardware level. The runtime owns the rest of what the old Graphics panel
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old panel's
// per-effect overrides are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, detailed: false, particles: "low" },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "high" },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high" },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high" },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", textures: 0.5, segments: 0.5, props: 0.5, motes: 35, sparks: 0.5, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", textures: 1, segments: 0.75, props: 0.75, motes: 50, sparks: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", textures: 1, segments: 1, props: 1, motes: 70, sparks: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", textures: 2, segments: 1.5, props: 1.5, motes: 120, sparks: 1.5, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
/** src/gfx.js PARTICLE_CAP: the burst particle cap per particles tier. */
export const PARTICLE_CAP = { low: 300, high: 2000 };

/** The look for a quality tier at a level index (0 quantum … 9 infinite). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: sparks grow with the
  // level above the tier's first, at most 2× the tier's budget.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return { preset, ...TABLE[preset], budget: b };
}
