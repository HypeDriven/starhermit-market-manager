// Market Manager — pure WebAudio synthesis. No audio assets.
// Short original transients for game events, a quiet filtered-noise
// ambience loop, and a two-layer adaptive music loop (calm base plus a
// busier layer that fades in with intensity). Pitch variants are seeded so
// a replayed session sounds identical.

import { createRng } from './rng.js';

const EVENT_MAP = {
  spawn: 'spawn',
  take: 'take',
  restock: 'restock',
  served: 'served',
  'left-angry': 'left-angry',
  'left-empty': 'left-empty',
  hire: 'confirm',
  upgrade: 'confirm',
  unlock: 'confirm',
};

export function createAudio(settings = {}) {
  let ctx = null;
  let buses = null;
  let noiseBuffer = null;
  let rng = createRng(1);
  let volumes = {
    music: num(settings.music, 0.6),
    effects: num(settings.effects, 0.8),
    ambience: num(settings.ambience, 0.5),
    voice: num(settings.voice, 0.7),
  };
  let unlocked = false;
  let paused = false;
  let ducked = false;
  let musicTimer = null;
  let musicStep = 0;
  let musicIntensity = 0;
  let ambienceNodes = null;
  let onVisChange = null;

  function num(v, d) { return typeof v === 'number' ? Math.min(1, Math.max(0, v)) : d; }

  // ------------------------------------------------------------ lifecycle
  function ensureContext() {
    if (ctx) return ctx;
    const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    buses = {};
    for (const name of ['music', 'effects', 'ambience', 'voice']) {
      const g = ctx.createGain();
      g.gain.value = volumes[name];
      g.connect(master);
      buses[name] = g;
    }
    noiseBuffer = makeNoise(ctx);
    if (typeof document !== 'undefined') {
      onVisChange = () => {
        if (!ctx) return;
        if (document.hidden) ctx.suspend().catch(() => {});
        else if (unlocked && !paused) ctx.resume().catch(() => {});
      };
      document.addEventListener('visibilitychange', onVisChange);
    }
    return ctx;
  }

  function makeNoise(c) {
    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    let s = 22222; // fixed seed: identical noise everywhere
    for (let i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      data[i] = (s / 4294967296) * 2 - 1;
    }
    return buf;
  }

  function unlock() {
    if (!ensureContext()) return;
    unlocked = true;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    startAmbience();
  }

  function dispose() {
    stopMusic();
    stopAmbience();
    if (onVisChange && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisChange);
    }
    if (ctx) ctx.close().catch(() => {});
    ctx = null;
    buses = null;
  }

  // ------------------------------------------------------------- volumes
  function setVolumes(next = {}) {
    for (const k of ['music', 'effects', 'ambience', 'voice']) {
      if (typeof next[k] === 'number') volumes[k] = num(next[k], volumes[k]);
    }
    if (!buses) return;
    for (const k of Object.keys(buses)) buses[k].gain.value = volumes[k];
  }

  // ---------------------------------------------------------- primitives
  // One enveloped oscillator note.
  function tone(bus, { freq = 440, dur = 0.15, type = 'sine', gain = 0.2, attack = 0.005, slide = 0, when = 0 }) {
    if (!ctx || !buses) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(buses[bus]);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // Short filtered noise burst.
  function noise(bus, { dur = 0.1, gain = 0.15, freq = 1200, q = 1, type = 'bandpass', when = 0 }) {
    if (!ctx || !buses) return;
    const t0 = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(buses[bus]);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  // Seeded pitch variant in a narrow band, so replays sound identical.
  function variant(base) {
    return base * (0.96 + rng.next() * 0.08);
  }

  // -------------------------------------------------------------- events
  function playEvent(name) {
    if (!ctx || !unlocked) return;
    switch (name) {
      case 'spawn': // soft blip
        tone('effects', { freq: variant(520), dur: 0.09, type: 'sine', gain: 0.08 });
        break;
      case 'take': // pick pop
        tone('effects', { freq: variant(700), dur: 0.06, type: 'triangle', gain: 0.14, slide: 220 });
        break;
      case 'restock': // crate thud
        noise('effects', { dur: 0.12, gain: 0.2, freq: 240, type: 'lowpass' });
        tone('effects', { freq: variant(130), dur: 0.12, type: 'sine', gain: 0.2, slide: -40 });
        break;
      case 'served': { // coin chime
        const f = variant(880);
        tone('effects', { freq: f, dur: 0.1, type: 'square', gain: 0.08 });
        tone('effects', { freq: f * 1.5, dur: 0.16, type: 'square', gain: 0.08, when: 0.07 });
        break;
      }
      case 'left-angry': // low buzz
        tone('effects', { freq: variant(110), dur: 0.3, type: 'sawtooth', gain: 0.12, slide: -30 });
        noise('effects', { dur: 0.25, gain: 0.06, freq: 300, type: 'lowpass' });
        break;
      case 'left-empty': // sad tick
        tone('effects', { freq: variant(320), dur: 0.12, type: 'sine', gain: 0.1, slide: -120 });
        break;
      case 'confirm': { // hire / upgrade / unlock arpeggio
        const root = variant(440);
        [1, 1.25, 1.5].forEach((m, i) =>
          tone('effects', { freq: root * m, dur: 0.12, type: 'triangle', gain: 0.12, when: i * 0.07 }));
        break;
      }
      case 'won': { // fanfare
        const root = 523;
        [1, 1.25, 1.5, 2].forEach((m, i) =>
          tone('music', { freq: root * m, dur: 0.35, type: 'triangle', gain: 0.16, when: i * 0.12 }));
        break;
      }
      case 'lost': // soft low phrase
        [392, 330, 262].forEach((f, i) =>
          tone('music', { freq: f, dur: 0.4, type: 'sine', gain: 0.12, when: i * 0.18 }));
        break;
      case 'error':
        tone('effects', { freq: 180, dur: 0.12, type: 'square', gain: 0.08 });
        break;
    }
  }

  function mapEvents(events) {
    if (!events) return;
    for (const ev of events) {
      if (ev.kind === 'terminal') {
        playEvent(ev.result === 'won' ? 'won' : 'lost');
      } else if (EVENT_MAP[ev.kind]) {
        playEvent(EVENT_MAP[ev.kind]);
      }
    }
  }

  function uiClick() {
    if (!ctx || !unlocked) return;
    tone('effects', { freq: 660, dur: 0.05, type: 'triangle', gain: 0.1 });
  }

  // ------------------------------------------------------------- ambience
  function startAmbience() {
    if (!ctx || ambienceNodes) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(f).connect(g).connect(buses.ambience);
    src.start();
    ambienceNodes = { src, g };
  }

  function stopAmbience() {
    if (!ambienceNodes) return;
    try { ambienceNodes.src.stop(); } catch { /* already stopped */ }
    ambienceNodes = null;
  }

  // ---------------------------------------------------------------- music
  // Calm layer: slow pentatonic arpeggio. Busy layer: light percussion +
  // quicker notes, faded in by intensity (0..1). duck() scales both.
  const SCALE = [262, 294, 330, 392, 440, 523];
  const CALM_PATTERN = [0, 2, 4, 3, 5, 4, 2, 1];

  function scheduleStep() {
    if (!ctx) return;
    const i = musicStep++;
    const duckMul = ducked ? 0.25 : 1;
    const calm = SCALE[CALM_PATTERN[i % CALM_PATTERN.length]];
    const v = variant(1); // keep the seeded stream moving deterministically
    tone('music', { freq: calm * v, dur: 0.5, type: 'sine', gain: 0.09 * duckMul });
    if (musicIntensity > 0.05) {
      const busy = musicIntensity * duckMul;
      if (i % 2 === 0) noise('music', { dur: 0.05, gain: 0.06 * busy, freq: 6000, type: 'highpass' });
      tone('music', { freq: calm * 2 * v, dur: 0.2, type: 'triangle', gain: 0.07 * busy, when: 0.25 });
    }
  }

  function startMusic(intensity = 0) {
    musicIntensity = Math.min(1, Math.max(0, intensity));
    if (!ensureContext() || !unlocked) return;
    if (musicTimer == null) musicTimer = setInterval(scheduleStep, 500);
  }

  function stopMusic() {
    if (musicTimer != null) { clearInterval(musicTimer); musicTimer = null; }
  }

  function setPaused(b) {
    paused = b;
    if (!ctx) return;
    if (b) ctx.suspend().catch(() => {});
    else if (unlocked && !(typeof document !== 'undefined' && document.hidden)) {
      ctx.resume().catch(() => {});
    }
  }

  function duck(b) {
    ducked = b;
  }

  function setSeed(seed) {
    rng = createRng((seed >>> 0) || 1);
  }

  return {
    setVolumes,
    playEvent,
    mapEvents,
    uiClick,
    startMusic,
    stopMusic,
    setPaused,
    duck,
    unlock,
    setSeed,
    dispose,
  };
}
