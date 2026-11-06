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
// rendered offline once at start (OfflineAudioContext, one context a stem)
// into a seamless 4 s loop and both loop together on the music bus, the busy layer's gain following the
// intensity (the seeded ±4 % pitch wobble of each note is not kept). The
// runtime has no ambience bus: the ambience plays on the music bus with the
// old ambience slider's default folded into its gain. The runtime's Options
// own the volumes, the mute and the voice limit; the UI click plays on the
// "interface" bus, the rest on "effects". The oscillator fallbacks the
// browser build played while a sample decoded are not ported (a live
// synthesis graph makes clip loads fail on the engine's web runtime), so a
// clip still loading is silent. Every clip loads at once in onStart (the
// engine hands each loaded clip to the mixer, natively and in a browser);
// the loops play once the mixer runs (in a browser, the first press). Pausing a shift
// silences the music and ambience, as the old context suspend did.
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

/** Event and UI sound → sfx/<file>.opus (src/audio.js SFX_MAP). */
const SFX: Record<string, string> = {
  spawn: "spawn", take: "take", restock: "restock", served: "served", "left-angry": "left-angry", "left-empty": "left-empty",
  hire: "hire", upgrade: "upgrade", unlock: "unlock", won: "won", lost: "lost", error: "error", uiClick: "ui-click",
  countdown: "countdown", achievement: "achievement",
};
const clips = new Map<string, AudioClip>();

/** Loads every clip and renders the loops at once (onStart); a sound whose clip is still loading is silent. */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SFX))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${String(e)}`));
  }
  renderLoops();
}

/** src/audio.js playEvent(): one sound (a still-loading one is silent). */
export function play(name: string): void {
  const file = SFX[name];
  if (!file) return;
  const clip = clips.get(file);
  if (!clip) return;
  try { playClip(clip, { bus: name === "uiClick" ? "interface" : "effects" }); }
  catch { /* the mixer is full this frame: skip it */ }
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
const SCALE = [262, 294, 330, 392, 440, 523];
const CALM_PATTERN = [0, 2, 4, 3, 5, 4, 2, 1];
const STEP = 0.5;
const BAR = STEP * CALM_PATTERN.length;
/** src/audio.js tone(): an exponential attack and decay (0.0001 floor), as its gain automation. */
function envelope(off: OfflineAudioContext, at: number, gain: number, attack: number, dur: number) {
  const g = off.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  g.connect(off.destination);
  return g;
}
function note(off: OfflineAudioContext, type: "sine" | "triangle", freq: number, at: number, gain: number, attack: number, dur: number): void {
  const osc = off.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(envelope(off, at, gain, attack, dur));
  osc.start(at);
  osc.stop(at + dur);
}
function barContext(): OfflineAudioContext { return new OfflineAudioContext(1, Math.round(BAR * RATE), RATE); }
/** The calm layer: a sine note per step, 0.5 s, gain 0.09. */
async function renderCalm(): Promise<AudioClip> {
  const off = barContext();
  CALM_PATTERN.forEach((p, s) => note(off, "sine", SCALE[p]!, s * STEP, 0.09, 0.005, 0.5));
  return createClip(await off.startRendering());
}
/** The busy layer at full intensity: a highpassed noise tick (0.05 s, gain 0.06) on even steps and a
 * triangle an octave up (0.2 s, gain 0.07) a quarter-step in. HAT_TRIM: the biquad's full passband
 * against the old one-pole's weak one (same tick level, measured). */
const HAT_TRIM = 0.33;
async function renderBusy(): Promise<AudioClip> {
  const off = barContext();
  const noise = off.createNoiseBuffer(0.06, "white", { seed: 7 });
  CALM_PATTERN.forEach((p, s) => {
    const at = s * STEP;
    if (s % 2 === 0) {
      const src = off.createBufferSource();
      src.buffer = noise;
      const hp = off.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 6000;
      src.connect(hp).connect(envelope(off, at, 0.06 * HAT_TRIM, 0.008, 0.05));
      src.start(at, 0, 0.05);
    }
    note(off, "triangle", SCALE[p]! * 2, at + 0.25, 0.07, 0.005, 0.2);
  });
  return createClip(await off.startRendering());
}
/** The ambience: 2 s of looping noise lowpassed at 420 Hz; periodic once the filter settles, so it joins. */
async function renderAmbience(): Promise<AudioClip> {
  const n = 2 * RATE, settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ seed: 22222, seconds: 2 });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 420;
  const g = off.createGain();
  g.gain.value = 0.05 * 2.2;
  noise.connect(lp).connect(g).connect(off.destination);
  noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
/** A rendered loop: its clip once ready and its playing voice. */
interface Loop { clip: AudioClip | null; voice: Sound | null }
const ambience: Loop = { clip: null, voice: null }, calm: Loop = { clip: null, voice: null }, busy: Loop = { clip: null, voice: null };
function renderLoops(): void {
  const start = (l: Loop, render: () => Promise<AudioClip>): void => {
    render().then((c) => { l.clip = c; }, (e: unknown) => console.warn(`audio: ${String(e)}`));
  };
  start(ambience, renderAmbience);
  start(calm, renderCalm);
  start(busy, renderBusy);
}

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

/** Each frame once the mixer runs: the rendered loops playing. */
export function update(): void {
  if (context.state !== "running") return;
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
