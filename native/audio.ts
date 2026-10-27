// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event (a guest arriving,
// taking goods, a restock, a sale, a guest leaving angry or empty-handed,
// hire, upgrade, unlock, the win and loss stings, an invalid action, the
// UI click, the countdown beat, an achievement), the quiet ambience (noise
// lowpassed at 420 Hz, as the old looping noise buffer) and the two-layer
// adaptive music of a shift: the calm pentatonic sine arpeggio, one note
// every 500 ms over an 8-note pattern, and the busier layer (a hi-hat tick
// every other step and a triangle note an octave up) faded in with the
// shift's intensity (queues and time pressure, 0..1). The browser build
// synthesized those live with oscillators every 500 ms; here each layer is
// rendered once into a seamless 4 s loop (createClip, a slice a frame) and
// both loop together on the music bus, the busy layer's gain following the
// intensity (the seeded ±4 % pitch wobble of each note is not kept). The
// runtime has no ambience bus: the ambience plays on the music bus with the
// old ambience slider's default folded into its gain. The runtime's Options
// own the volumes, the mute and the voice limit; the UI click plays on the
// "interface" bus, the rest on "effects". The oscillator fallbacks the
// browser build played while a sample decoded are not ported (a live
// synthesis graph makes clip loads fail on the engine's web runtime), so a
// clip still loading is silent. Clips load once the mixer runs (natively at
// once, in a browser after the first press), one at a time. Pausing a shift
// silences the music and ambience, as the old context suspend did.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

/** Event and UI sound → sfx/<file>.opus (src/audio.js SFX_MAP). */
const SFX: Record<string, string> = {
  spawn: "spawn", take: "take", restock: "restock", served: "served", "left-angry": "left-angry", "left-empty": "left-empty",
  hire: "hire", upgrade: "upgrade", unlock: "unlock", won: "won", lost: "lost", error: "error", uiClick: "ui-click",
  countdown: "countdown", achievement: "achievement",
};
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }

/** src/audio.js playEvent(): one sound (a still-loading one is silent). */
export function play(name: string): void {
  const file = SFX[name];
  if (!file) return;
  const clip = clips.get(file);
  if (!clip) return;
  try { playClip(clip, { bus: name === "uiClick" ? "interface" : "effects" }); }
  catch { clips.delete(file); if (!queue.includes(file)) queue.push(file); } // a clip the mixer lost: load it again
}
export function uiClick(): void { play("uiClick"); }

/** src/audio.js mapEvents(): the rules' events of a tick or command. */
export function mapEvents(events: readonly { kind: string; result?: string }[]): void {
  for (const ev of events) {
    if (ev.kind === "terminal") play(ev.result === "won" ? "won" : "lost");
    else if (SFX[ev.kind]) play(ev.kind);
  }
}

// -- rendered loops ---------------------------------------------------------------------------
const RATE = 22050;
/** A loop rendered a slice at a time. */
interface Loop { data: Float32Array; pos: number; render: (from: number, to: number) => void; clip: AudioClip | null; voice: Sound | null }
function loop(seconds: number, render: (data: Float32Array, from: number, to: number) => void): Loop {
  const data = new Float32Array(Math.round(RATE * seconds));
  return { data, pos: 0, render: (a, b) => render(data, a, b), clip: null, voice: null };
}
/** src/audio.js tone(): an exponential attack and decay (0.0001 floor), as its gain automation. */
function env(t: number, gain: number, attack: number, dur: number): number {
  if (t < 0 || t > dur) return 0;
  if (t < attack) return 0.0001 * Math.pow(gain / 0.0001, t / attack);
  return gain * Math.pow(0.0001 / gain, (t - attack) / (dur - attack));
}
const SCALE = [262, 294, 330, 392, 440, 523];
const CALM_PATTERN = [0, 2, 4, 3, 5, 4, 2, 1];
const STEP = 0.5;
const BAR = STEP * CALM_PATTERN.length;
/** Each step's notes wrap around the loop's end so the loop joins without a gap. */
function stepsAt(t: number, fn: (step: number, local: number) => number): number {
  let v = 0;
  for (const shift of [0, BAR]) {
    const tt = t + shift;
    const i = Math.floor(tt / STEP);
    for (const s of [i, i - 1]) if (s >= 0 && s < CALM_PATTERN.length) v += fn(s, tt - s * STEP);
  }
  return v;
}
// The calm layer: a sine note per step, 0.5 s, gain 0.09.
const calm = loop(BAR, (d, a, b) => {
  for (let n = a; n < b; n++) {
    const t = n / RATE;
    d[n] = stepsAt(t, (s, lt) => {
      const f = SCALE[CALM_PATTERN[s]!]!;
      return Math.sin(2 * Math.PI * f * lt) * env(lt, 0.09, 0.005, 0.5);
    });
  }
});
// The busy layer at full intensity: a highpassed noise tick (0.05 s, gain 0.06) on even steps and a
// triangle an octave up (0.2 s, gain 0.07) a quarter-step in.
let hatSeed = 7;
const hat = new Float32Array(Math.round(RATE * 0.06));
{
  let prev = 0, y = 0;
  const k = Math.exp((-2 * Math.PI * 6000) / RATE);
  for (let i = 0; i < hat.length; i++) {
    hatSeed = (hatSeed * 1664525 + 1013904223) >>> 0;
    const x = (hatSeed / 4294967296) * 2 - 1;
    y = k * (y + x - prev); // one-pole highpass at 6 kHz
    prev = x;
    hat[i] = y;
  }
}
const tri = (p: number): number => 1 - 4 * Math.abs(Math.round(p - 0.25) - (p - 0.25));
const busy = loop(BAR, (d, a, b) => {
  for (let n = a; n < b; n++) {
    const t = n / RATE;
    d[n] = stepsAt(t, (s, lt) => {
      let v = 0;
      if (s % 2 === 0 && lt < 0.05) v += (hat[Math.floor(lt * RATE)] ?? 0) * env(lt, 0.06, 0.008, 0.05);
      const lt2 = lt - 0.25;
      if (lt2 >= 0) v += tri(SCALE[CALM_PATTERN[s]!]! * 2 * lt2) * env(lt2, 0.07, 0.005, 0.2);
      return v;
    });
  }
});
// The ambience: 2 s of noise (the old buffer's LCG, seed 22222) lowpassed at 420 Hz, run twice so the loop joins.
let ambSeed = 22222;
let ambY = 0;
const ambNoise = new Float32Array(RATE * 2);
const ambience = loop(2, (d, a, b) => {
  const k = 1 - Math.exp((-2 * Math.PI * 420) / RATE);
  const N = d.length;
  // a and b run over 0 .. 2N: the first pass fills the noise and warms the filter, the second writes.
  for (let n = a; n < b; n++) {
    const i = n % N;
    if (n < N) { ambSeed = (ambSeed * 1664525 + 1013904223) >>> 0; ambNoise[i] = (ambSeed / 4294967296) * 2 - 1; }
    ambY += k * (ambNoise[i]! - ambY);
    if (n >= N) d[i] = ambY * 0.05 * 2.2;
  }
});
const LOOPS: [Loop, number][] = [[ambience, ambience.data.length * 2], [calm, calm.data.length], [busy, busy.data.length]];

let wantMusic = false;
let paused = false;
let intensity = 0;
/** src/audio.js startMusic(intensity) / setting the intensity while it plays. */
export function startMusic(level: number): void {
  wantMusic = true;
  intensity = Math.min(1, Math.max(0, level));
  if (busy.voice) busy.voice.fade(intensity > 0.05 ? intensity : 0, 0.3);
}
export function stopMusic(): void {
  wantMusic = false;
  for (const l of [calm, busy]) stopVoice(l);
}
/** A paused shift: music and ambience silent until it resumes. */
export function setPaused(on: boolean): void {
  paused = on;
  if (on) for (const l of [ambience, calm, busy]) stopVoice(l);
}
function stopVoice(l: Loop): void {
  if (l.voice) { try { l.voice.stop(); } catch { /* already gone */ } l.voice = null; }
}

/** Each frame: the clips once the mixer runs (one at a time), the loops rendered, then playing. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of Object.values(SFX)) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading) return;
  for (const [l, total] of LOOPS) {
    if (l.clip) continue;
    if (l.pos < total) {
      const to = Math.min(total, l.pos + 6000);
      l.render(l.pos, to);
      l.pos = to;
      return;
    }
    try { l.clip = createClip([l.data], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); l.pos = 0; }
    return;
  }
  if (paused) return;
  // The ambience at the old ambience bus's default (0.5) over the music bus's (0.6).
  if (!ambience.voice && ambience.clip) {
    try { ambience.voice = playClip(ambience.clip, { bus: "music", gain: 0.5 / 0.6, loop: true }); } catch { ambience.voice = null; }
    return;
  }
  // Both music layers start in one frame so they stay in step.
  if (wantMusic && !calm.voice && calm.clip && busy.clip) {
    try {
      calm.voice = playClip(calm.clip, { bus: "music", loop: true });
      busy.voice = playClip(busy.clip, { bus: "music", loop: true, gain: intensity > 0.05 ? intensity : 0 });
    } catch { stopVoice(calm); stopVoice(busy); }
  }
}
