// Market Manager — Three.js render layer.
// Bright isometric tabletop market. Procedural geometry only, no assets.
// All gameplay truth comes from rules state snapshots; this module owns
// views, effects, camera, and input, and never mutates game state.

import * as THREE from '../lib/three.module.min.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { TILE, queueSlot } from './rules.js';
import {
  resolve as resolveGraphics, describe as describeGraphics, legacyPreset,
  SHADOW_MAP, PARTICLE_CAP,
} from './gfx.js';

// ---------------------------------------------------------------------------
// Authored constants (no magic numbers inline below)
// ---------------------------------------------------------------------------

const FRAMING = {
  // camera presets: dir = offset direction from focus, dist = dolly distance
  presets: {
    isometric: { dir: [1, 0.9, 1], dist: 26 },
    high: { dir: [0.35, 1.65, 0.35], dist: 28 },
    low: { dir: [1, 0.45, 1], dist: 24 },
  },
  defaultPreset: 'isometric',
  // ortho fit coefficients for an isometric-projected w×h room
  fitWidthPerTile: 0.707,   // |dot(tile axis, screen right)|
  fitHeightPerTile: 0.38,   // vertical compression at iso tilt
  fitPadX: 2.0,             // world units of breathing room
  fitPadY: 2.4,
  zoomMin: 0.65,
  zoomMax: 2.4,
  panMargin: 3.0,           // how far past the room edge the focus may drift
  springFreq: 1.6,          // critically damped spring frequency (Hz)
  near: 0.1,
  far: 120,
};

// Lighting / look constants. `env*` apply only while image-based lighting
// (the `reflections` graphics category) is on; the hemisphere fill is lowered
// then so the room environment does not wash the scene out.
const LOOK = {
  hemiIntensity: 0.55,
  hemiIntensityWithEnv: 0.3,
  envIntensity: 0.32,
  keyDir: [-0.55, 1.45, 0.95],   // key light from front-left so shadows fall where the camera sees them
  propCount: 10,                 // decorative planters outside the walls (detail: detailed)
  motes: 70,                     // ambient floating motes (particles: high)
  bloom: { strength: 0.3, radius: 0.35, threshold: 0.92 },
  hdrBoost: 2.4,                 // particle / marker colour multiplier while bloom is on
  vignette: 0.2,
  idleBob: 0.028,                // world units of gentle idle bounce for waiting people
};

// Adaptive resolution thresholds (ms per frame, averaged over ADAPT.frames).
const ADAPT = { frames: 90, slowMs: 26, fastMs: 14, down: 0.1, up: 0.05, min: 0.6 };

// Colour grade + vignette. Works on linear HDR input before OutputPass.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: LOOK.vignette } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      vec3 lc = clamp(c, 0.0, 1.0);
      // gentle S-curve, a little more saturation, warm highlights / cool shadows
      vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.22);
      float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.985, 1.04), vec3(1.035, 1.0, 0.965), smoothstep(0.15, 0.75, l));
      c = mix(c, s + max(c - 1.0, 0.0), uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.85));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

// Gameplay accent palettes per colorblind mode. `dept` cycles over
// departments by index; `patience` is [ok, warn, low] for the queue ring.
const PALETTES = {
  none: {
    dept: [0xe8743b, 0x53a548, 0x4a90d9, 0xd96ab0, 0x9a6ad9],
    patience: [0x53d769, 0xf7c948, 0xe23e3e],
  },
  deuteranopia: {
    dept: [0xd9822b, 0x3aa0c9, 0x2f6fd0, 0xd9c53a, 0x8a7bd8],
    patience: [0x2fa8d8, 0xf0c93a, 0xd95f02],
  },
  protanopia: {
    dept: [0xc9a227, 0x3aa0c9, 0x2f6fd0, 0x6fbf9a, 0x8a7bd8],
    patience: [0x2fa8d8, 0xf0c93a, 0xc9722b],
  },
  tritanopia: {
    dept: [0xd94f3d, 0x2fb5c9, 0x35c4b5, 0xd98aa0, 0x7a7ad9],
    patience: [0x35c4b5, 0xf2e13a, 0xd94f3d],
  },
};

const FX = {
  maxParticles: 2000,
  particleSize: 0.11,
  gravity: -3.2,
  coinCount: 14,
  coinColor: 0xffd24a,
  popCount: 8,
  puffCount: 12,
  puffColor: 0x9a9a9a,
  confettiCount: 90,
  burstLife: 0.9,
  flashTime: 0.45,          // shelf emissive flash on restock/unlock
  customerLerpMs: 150,      // logical-position interpolation window
  shakeAmp: 0.14,           // terminal-tier camera shake amplitude
  shakeDecay: 2.6,
  hoverLift: 0.09,
  hoverEmissive: 0.35,
  ringY: 0.62,              // patience ring height above a queued customer
  tapMaxDistPx: 8,          // tap vs camera-drag thresholds
  tapMaxMs: 350,
};

const DIM = {
  floorH: 0.1,
  wallH: 0.55,
  shelfBaseH: 0.32,
  shelfBoards: [0.44, 0.68],
  counterH: 0.42,
  crate: 0.3,
  personR: 0.15,
  personH: 0.3,
  headR: 0.11,
};

// ---------------------------------------------------------------------------
// Small local helpers (mulberry32 so decoration matches config.seed replays)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashId(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Critically damped spring step (semi-implicit Euler), scalar.
function springStep(cur, vel, target, freqHz, dt) {
  const w = 2 * Math.PI * freqHz;
  const accel = w * w * (target - cur) - 2 * w * vel;
  const nv = vel + accel * dt;
  return [cur + nv * dt, nv];
}

function disposeObject(root) {
  root.traverse((obj) => {
    if (obj.geometry && !(obj.geometry.userData && obj.geometry.userData.shared)) {
      obj.geometry.dispose();
    }
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) m.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Procedural textures (canvas-drawn once, shared, near-white so they multiply
// the authored material / instance colours instead of replacing them)
// ---------------------------------------------------------------------------

function canvasTexture(size, draw, { repeat = 1, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size, mulberry32(size * 7919 + repeat));
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

function speckle(g, size, rnd, n, lo, hi, r = 1.5) {
  for (let i = 0; i < n; i++) {
    const v = Math.round(lo + rnd() * (hi - lo));
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rnd() * size, rnd() * size, r, r);
  }
}

function makeTextures() {
  return {
    // Floor tile: soft bevel highlight top-left, grout shadow bottom-right, speckle.
    tile: canvasTexture(128, (g, n, rnd) => {
      g.fillStyle = '#f7f7f7'; g.fillRect(0, 0, n, n);
      speckle(g, n, rnd, 900, 225, 255);
      const grad = g.createLinearGradient(0, 0, n, n);
      grad.addColorStop(0, 'rgba(255,255,255,0.55)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.08)');
      g.fillStyle = grad; g.fillRect(0, 0, n, n);
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.fillRect(4, 4, n - 8, 3); g.fillRect(4, 4, 3, n - 8);
      g.fillStyle = 'rgba(90,70,50,0.22)';
      g.fillRect(4, n - 7, n - 8, 3); g.fillRect(n - 7, 4, 3, n - 8);
      g.strokeStyle = '#b9ad9c'; g.lineWidth = 5; g.strokeRect(0, 0, n, n);
    }),
    // Grass: layered speckle and blades, tiled across the lawn.
    grass: canvasTexture(256, (g, n, rnd) => {
      g.fillStyle = '#eaeaea'; g.fillRect(0, 0, n, n);
      for (let i = 0; i < 90; i++) {
        const v = Math.round(205 + rnd() * 50);
        g.fillStyle = `rgba(${v},${v},${v},0.5)`;
        g.beginPath(); g.arc(rnd() * n, rnd() * n, 6 + rnd() * 18, 0, Math.PI * 2); g.fill();
      }
      g.lineWidth = 1.4;
      for (let i = 0; i < 1600; i++) {
        const x = rnd() * n, y = rnd() * n, v = Math.round(170 + rnd() * 85);
        g.strokeStyle = `rgb(${v},${v},${v})`;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y - 2 - rnd() * 4); g.stroke();
      }
    }, { repeat: 1 }),
    // Plaster wall with faint courses.
    wall: canvasTexture(128, (g, n, rnd) => {
      g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, n, n);
      speckle(g, n, rnd, 1400, 215, 255, 2);
      g.fillStyle = 'rgba(80,60,40,0.12)';
      for (let y = 0; y < n; y += 32) g.fillRect(0, y, n, 2);
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillRect(0, 0, n, 4);
    }),
    // Wood planks for crates and shelf boards.
    wood: canvasTexture(128, (g, n, rnd) => {
      g.fillStyle = '#f0f0f0'; g.fillRect(0, 0, n, n);
      for (let y = 0; y < n; y += 2) {
        const v = Math.round(215 + Math.sin(y * 0.35 + rnd() * 2) * 18 + rnd() * 12);
        g.fillStyle = `rgba(${v},${v},${v},0.8)`;
        g.fillRect(0, y, n, 2);
      }
      g.fillStyle = 'rgba(70,45,25,0.35)';
      for (let y = 0; y < n; y += 32) g.fillRect(0, y, n, 2);
    }),
    // Market awning stripes: full colour / deeper tone.
    awning: canvasTexture(64, (g, n) => {
      for (let x = 0; x < n; x += 16) {
        g.fillStyle = (x / 16) % 2 ? '#b8b8b8' : '#ffffff';
        g.fillRect(x, 0, 16, n);
      }
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, n - 6, n, 6);
    }),
    // Soft round sprite for particles and motes.
    dot: canvasTexture(64, (g, n) => {
      const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.9)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.fillRect(0, 0, n, n);
    }),
  };
}

// Vertical sky gradient for the backdrop (detail: detailed).
function skyTexture(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#' + new THREE.Color(top).getHexString());
  grad.addColorStop(1, '#' + new THREE.Color(bottom).getHexString());
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Renderer factory
// ---------------------------------------------------------------------------

export function createRenderer(container, opts = {}) {
  const options = {
    graphics: opts.graphics || { preset: legacyPreset(opts.quality) },
    detected: opts.detected || 'balanced',
    gpu: opts.gpu || '',
    reducedMotion: !!opts.reducedMotion,
    colorblind: PALETTES[opts.colorblind] ? opts.colorblind : 'none',
    camera: FRAMING.presets[opts.camera] ? opts.camera : FRAMING.defaultPreset,
    onPick: typeof opts.onPick === 'function' ? opts.onPick : () => {},
    onHover: typeof opts.onHover === 'function' ? opts.onHover : () => {},
  };

  // -- renderer / scene ------------------------------------------------------
  // Canvas MSAA stays off: anti-aliasing is chosen live by the graphics
  // settings (FXAA/SMAA passes, or MSAA on the post chain's render target).
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, FRAMING.near, FRAMING.far);
  // Shake rig: camera lives inside; raycasts zero the rig first so pointer
  // truth is never affected by shake.
  const shakeRig = new THREE.Group();
  shakeRig.add(camera);
  scene.add(shakeRig);
  camera.layers.enable(1); // layer 1 = particles (never raycast)

  const marketGroup = new THREE.Group();
  scene.add(marketGroup);
  const fxGroup = new THREE.Group();
  scene.add(fxGroup);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x777777, LOOK.hemiIntensity);
  scene.add(hemi);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(6, 10, 4);
  keyLight.shadow.bias = -0.0006;
  keyLight.shadow.normalBias = 0.02;
  scene.add(keyLight);
  scene.add(keyLight.target);

  // Image-based lighting: a PMREM-filtered RoomEnvironment, generated lazily
  // the first time reflections are enabled.
  let envTexture = null;
  const tex = makeTextures();
  let skyTex = null;
  const skyColor = new THREE.Color(0xffffff);

  // Graphics state (see gfx.js): resolved tiers, post chain, adaptive scale.
  let gq = resolveGraphics(options.graphics, options.detected);
  let gfxJson = '';
  let composer = null;
  let postKey = null;
  let postFailed = false;
  let pixelRatio = 0;
  let adaptiveScale = 1;
  let adaptFrames = [];
  let fps = 0;

  // -- module state ----------------------------------------------------------
  let theme = null;
  let grid = { w: 0, h: 0 };
  let built = false;
  let paused = false;
  let running = false;
  let rafId = 0;
  let disposed = false;

  const displayViews = new Map();   // id -> view
  const checkoutViews = new Map();  // id -> view
  const deptTarps = new Map();      // deptId -> [tarp meshes]
  const customerViews = new Map();  // id -> view
  const staffViews = {};            // role -> view
  let interactive = [];             // explicit raycast targets
  let floorIndexToXY = [];          // instanced floor instanceId -> {x,y}
  let tileVariations = [];          // per-tile HSL offsets, reapplied on theme change
  let floorMesh = null;
  let wallMesh = null;
  let groundMesh = null;
  let archMats = [];
  let discMesh = null;
  let propsGroup = null;

  let lastState = null;
  const pendingEffects = [];
  let shake = 0;
  let elapsed = 0;
  let lastTime = 0;

  // camera spring state
  const camFocus = { x: 0, z: 0, vx: 0, vz: 0, tx: 0, tz: 0 };
  const camPos = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  let zoomCur = 1, zoomVel = 0, zoomTarget = 1;
  let baseViewH = 10;

  // hover / highlight
  let hoveredPick = null;
  let hoverView = null;
  let hoverMarker = null;
  const highlightMarkers = [];
  let highlightTargets = null;

  // shared geometries (never disposed during market rebuilds)
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const ringGeo = new THREE.RingGeometry(0.3, 0.42, 32);
  const discGeo = new THREE.CircleGeometry(0.42, 24);
  const bodyGeo = new THREE.CapsuleGeometry(DIM.personR, DIM.personH, 4, 10);
  const headGeo = new THREE.SphereGeometry(DIM.headR, 10, 8);
  const goodGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  for (const g of [boxGeo, ringGeo, discGeo, bodyGeo, headGeo, goodGeo]) {
    g.userData.shared = true;
  }

  hoverMarker = makeRingMarker(0xffffff);
  fxGroup.add(hoverMarker);

  // -------------------------------------------------------------------------
  // Palette / color helpers
  // -------------------------------------------------------------------------

  function palette() {
    return PALETTES[options.colorblind] || PALETTES.none;
  }

  function deptColor(index) {
    const cols = palette().dept;
    return cols[index % cols.length];
  }

  function patienceColor(frac) {
    const [ok, warn, low] = palette().patience;
    return frac > 0.5 ? ok : frac > 0.25 ? warn : low;
  }

  function worldFromTile(x, y) {
    return { wx: x - (grid.w - 1) / 2, wz: y - (grid.h - 1) / 2 };
  }

  function std(color, extra = {}) {
    return new THREE.MeshStandardMaterial({
      color, roughness: 0.85, metalness: 0.0, envMapIntensity: LOOK.envIntensity, ...extra,
    });
  }

  function phys(color, extra = {}) {
    return new THREE.MeshPhysicalMaterial({
      color, roughness: 0.5, metalness: 0.0, envMapIntensity: LOOK.envIntensity, clearcoatRoughness: 0.25, ...extra,
    });
  }

  // `detail` category: surface texture and clearcoat are attached to the
  // material and toggled live (three recompiles when the map/clearcoat change).
  function withDetail(mat, map, clearcoat = 0) {
    mat.userData.detail = { map, clearcoat };
    applyDetailTo(mat);
    return mat;
  }

  function applyDetailTo(mat) {
    const d = mat.userData.detail;
    if (!d) return;
    const on = gq.detail === 'detailed';
    const map = on ? d.map || null : null;
    const cc = on ? d.clearcoat : 0;
    if (mat.map !== map || (mat.isMeshPhysicalMaterial && mat.clearcoat !== cc)) {
      mat.map = map;
      if (mat.isMeshPhysicalMaterial) mat.clearcoat = cc;
      mat.needsUpdate = true;
    }
  }

  // Marker / highlight colours glow a little while bloom is on.
  function hdrColor(mat, hex) {
    mat.userData.hdrHex = hex;
    mat.color.setHex(hex);
    if (gq.bloom === 'on') mat.color.multiplyScalar(1.6);
    return mat;
  }

  // -------------------------------------------------------------------------
  // Market construction
  // -------------------------------------------------------------------------

  function clearMarket() {
    disposeObject(marketGroup);
    marketGroup.clear();
    displayViews.clear();
    checkoutViews.clear();
    deptTarps.clear();
    for (const v of customerViews.values()) removeCustomerView(v);
    customerViews.clear();
    for (const k of Object.keys(staffViews)) delete staffViews[k];
    interactive = [];
    floorIndexToXY = [];
    tileVariations = [];
    floorMesh = null;
    wallMesh = null;
    archMats = [];
    discMesh = null;
    propsGroup = null;
    hoverView = null;
    hoveredPick = null;
    hoverMarker.visible = false;
    setHighlight(null);
  }

  function buildMarket(state, config, themeObj) {
    if (!state || !state.grid) return;
    clearMarket();
    theme = themeObj || theme;
    grid = { w: state.grid.w, h: state.grid.h };
    lastState = state;

    const deco = mulberry32((config && config.seed) || state.seed || 1);
    applyThemeToScene();

    buildGround();
    buildFloor(state, deco);
    buildWalls(state);
    buildEntranceArch(state);
    buildStockroom(state, deco);

    const discSpots = [];
    for (const d of state.displays) {
      const view = buildDisplayView(state, d, deco);
      displayViews.set(d.id, view);
      marketGroup.add(view.group);
      discSpots.push([view.group.position.x, view.group.position.z, 0.55]);
    }
    for (const c of state.checkouts) {
      const view = buildCheckoutView(c);
      checkoutViews.set(c.id, view);
      marketGroup.add(view.group);
      discSpots.push([view.group.position.x, view.group.position.z, 0.55]);
    }
    buildContactDiscs(discSpots);
    buildStaffFigures(state);
    buildProps(deco);
    updateDepartments(state);
    updateFraming();
    resetCamera();
    syncState(state, []);
    built = true;
  }

  function buildGround() {
    if (groundMesh) { scene.remove(groundMesh); disposeObject(groundMesh); }
    const size = Math.max(grid.w, grid.h) * 4 + 20;
    const mat = withDetail(std(theme ? theme.ground : 0x8fce7a, { roughness: 1 }), tex.grass);
    tex.grass.repeat.set(size / 4, size / 4);
    groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.y = -DIM.floorH - 0.01;
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);
  }

  function buildFloor(state, deco) {
    const spots = [];
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        if (state.grid.cells[y][x].t === TILE.WALL) continue;
        spots.push({ x, y });
      }
    }
    const mat = withDetail(std(0xffffff, { roughness: 0.78 }), tex.tile);
    floorMesh = new THREE.InstancedMesh(boxGeo, mat, spots.length);
    floorMesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const base = new THREE.Color(theme ? theme.tile : 0xf2e3c2);
    spots.forEach((s, i) => {
      const { wx, wz } = worldFromTile(s.x, s.y);
      m.makeScale(1, DIM.floorH, 1);
      m.setPosition(wx, -DIM.floorH / 2, wz);
      floorMesh.setMatrixAt(i, m);
      // slight per-tile hue variation, seeded so replays match
      const v = [(deco() - 0.5) * 0.02, (deco() - 0.5) * 0.06, (deco() - 0.5) * 0.07];
      tileVariations.push(v);
      const c = base.clone().offsetHSL(v[0], v[1], v[2]);
      floorMesh.setColorAt(i, c);
      floorIndexToXY.push(s);
    });
    floorMesh.instanceColor.needsUpdate = true;
    floorMesh.userData.pick = { kind: 'floor' };
    marketGroup.add(floorMesh);
    interactive.push(floorMesh);
  }

  function buildWalls(state) {
    const cells = [];
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        if (state.grid.cells[y][x].t === TILE.WALL) cells.push({ x, y });
      }
    }
    const base = new THREE.Color(theme ? theme.tile : 0xf2e3c2).multiplyScalar(0.72);
    const mat = withDetail(std(base, { roughness: 0.9 }), tex.wall);
    wallMesh = new THREE.InstancedMesh(boxGeo, mat, Math.max(1, cells.length));
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    cells.forEach((s, i) => {
      const { wx, wz } = worldFromTile(s.x, s.y);
      m.makeScale(1, DIM.wallH, 1);
      m.setPosition(wx, DIM.wallH / 2, wz);
      wallMesh.setMatrixAt(i, m);
    });
    wallMesh.count = cells.length;
    marketGroup.add(wallMesh);
  }

  function buildEntranceArch(state) {
    const e = state.entrance;
    if (!e) return;
    // wall neighbor direction tells us which way the doorway faces
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let facing = [1, 0];
    for (const [dx, dy] of dirs) {
      const nx = e.x + dx, ny = e.y + dy;
      const inGrid = nx >= 0 && ny >= 0 && nx < grid.w && ny < grid.h;
      if (inGrid && state.grid.cells[ny][nx].t === TILE.WALL) { facing = [-dx, -dy]; break; }
    }
    const { wx, wz } = worldFromTile(e.x, e.y);
    const mat = withDetail(phys(theme ? theme.accent : 0xe8743b, { roughness: 0.55 }), null, 0.6);
    archMats.push(mat);
    const group = new THREE.Group();
    const postGeo = new THREE.BoxGeometry(0.12, 0.85, 0.12);
    const beamGeo = new THREE.BoxGeometry(0.12, 0.12, 0.8);
    const p1 = new THREE.Mesh(postGeo, mat);
    const p2 = new THREE.Mesh(postGeo, mat);
    const beam = new THREE.Mesh(beamGeo, mat);
    const along = Math.abs(facing[0]) > 0 ? 'z' : 'x'; // posts flank the walkway
    const off = 0.34;
    if (along === 'z') {
      p1.position.set(0, 0.425, -off);
      p2.position.set(0, 0.425, off);
      beam.position.set(0, 0.85, 0);
    } else {
      p1.position.set(-off, 0.425, 0);
      p2.position.set(off, 0.425, 0);
      beam.rotation.y = Math.PI / 2;
      beam.position.set(0, 0.85, 0);
    }
    for (const p of [p1, p2, beam]) { p.castShadow = true; group.add(p); }
    group.position.set(wx + facing[0] * 0.3, 0, wz + facing[1] * 0.3);
    marketGroup.add(group);
  }

  function buildStockroom(state, deco) {
    const s = state.stockroom;
    if (!s) return;
    const { wx, wz } = worldFromTile(s.x, s.y);
    const group = new THREE.Group();
    const crateMat = withDetail(std(0xb08954, { roughness: 0.9 }), tex.wood);
    const offsets = [[-0.16, 0, -0.12], [0.18, 0, 0.1], [0.02, DIM.crate, -0.02]];
    for (const [ox, oy, oz] of offsets) {
      const crate = new THREE.Mesh(boxGeo, crateMat);
      const s0 = DIM.crate * (0.9 + deco() * 0.2);
      crate.scale.set(s0, s0, s0);
      crate.position.set(ox, oy + s0 / 2, oz);
      crate.rotation.y = (deco() - 0.5) * 0.5;
      crate.castShadow = true;
      group.add(crate);
    }
    group.position.set(wx, 0, wz);
    marketGroup.add(group);
  }

  // One display: counter base + 2 shelf boards + awning strip + instanced goods.
  function buildDisplayView(state, d, deco) {
    const rng = deco || mulberry32(1);
    const deptIndex = Math.max(0, (state.departments || []).findIndex((p) => p.id === d.deptId));
    const { wx, wz } = worldFromTile(d.x, d.y);
    const group = new THREE.Group();
    group.position.set(wx, 0, wz);
    const mats = [];

    const baseMat = std(0xe8dcc8);
    const base = new THREE.Mesh(boxGeo, baseMat);
    base.scale.set(0.86, DIM.shelfBaseH, 0.6);
    base.position.y = DIM.shelfBaseH / 2;
    base.castShadow = true;
    group.add(base);
    mats.push(baseMat);

    const boardMat = withDetail(std(0xcbb894), tex.wood);
    mats.push(boardMat);
    for (const h of DIM.shelfBoards) {
      const board = new THREE.Mesh(boxGeo, boardMat);
      board.scale.set(0.9, 0.04, 0.5);
      board.position.y = h;
      board.castShadow = true;
      group.add(board);
    }
    // side posts
    for (const sx of [-0.42, 0.42]) {
      const post = new THREE.Mesh(boxGeo, boardMat);
      post.scale.set(0.05, DIM.shelfBoards[1] + 0.12, 0.5);
      post.position.set(sx, (DIM.shelfBoards[1] + 0.12) / 2, 0);
      group.add(post);
    }
    // awning strip in the department color (recolored on palette change)
    const awningMat = withDetail(std(deptColor(deptIndex), { roughness: 0.6 }), tex.awning);
    mats.push(awningMat);
    const awning = new THREE.Mesh(boxGeo, awningMat);
    awning.scale.set(0.94, 0.06, 0.56);
    awning.position.y = DIM.shelfBoards[1] + 0.14;
    awning.castShadow = true;
    group.add(awning);

    // goods: one small box per stock unit, spread over the two shelves
    const cap = Math.max(1, d.capacity);
    const goodsMat = withDetail(phys(0xffffff, { roughness: 0.45 }), null, 0.9);
    const goods = new THREE.InstancedMesh(goodGeo, goodsMat, cap);
    goods.castShadow = true;
    const m = new THREE.Matrix4();
    const goodColor = new THREE.Color(deptColor(deptIndex));
    const perShelf = Math.ceil(cap / DIM.shelfBoards.length);
    for (let i = 0; i < cap; i++) {
      const shelf = Math.floor(i / perShelf);
      const slot = i % perShelf;
      const x = -0.32 + (perShelf > 1 ? (slot / (perShelf - 1)) * 0.64 : 0);
      const z = (rng() - 0.5) * 0.24;
      m.identity();
      m.setPosition(x, DIM.shelfBoards[shelf] + 0.1, z);
      goods.setMatrixAt(i, m);
      const c = goodColor.clone().offsetHSL((rng() - 0.5) * 0.05, 0, (rng() - 0.5) * 0.25);
      goods.setColorAt(i, c);
    }
    goods.instanceColor.needsUpdate = true;
    group.add(goods);

    // tarp for locked departments (also the department pick target)
    const tarpMat = std(0x8f9094, { roughness: 1 });
    const tarp = new THREE.Mesh(boxGeo, tarpMat);
    tarp.scale.set(0.98, 0.7, 0.7);
    tarp.position.y = 0.35;
    tarp.rotation.y = 0.06;
    tarp.castShadow = true;
    tarp.userData.pick = { kind: 'department', id: d.deptId, x: d.x, y: d.y };
    group.add(tarp);

    // invisible hit box covering the whole shelf unit
    const hit = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ visible: false }));
    hit.scale.set(1, 0.9, 0.8);
    hit.position.y = 0.45;
    hit.userData.pick = { kind: 'display', id: d.id, x: d.x, y: d.y };
    group.add(hit);
    interactive.push(hit, tarp);

    if (!deptTarps.has(d.deptId)) deptTarps.set(d.deptId, []);
    deptTarps.get(d.deptId).push(tarp);

    const view = {
      group, mats, goods, goodsMat, awningMat, tarp, hit,
      deptId: d.deptId, deptIndex, level: d.level, capacity: d.capacity,
      flash: 0, lift: 0, baseY: 0,
    };
    return view;
  }

  function rebuildDisplayView(state, d) {
    const old = displayViews.get(d.id);
    if (!old) return;
    interactive = interactive.filter((m) => m !== old.hit && m !== old.tarp);
    const tarps = deptTarps.get(d.deptId) || [];
    deptTarps.set(d.deptId, tarps.filter((t) => t !== old.tarp));
    marketGroup.remove(old.group);
    disposeObject(old.group);
    const view = buildDisplayView(state, d, mulberry32(hashId(d.id)));
    displayViews.set(d.id, view);
    marketGroup.add(view.group);
    updateDepartments(state);
  }

  function buildCheckoutView(c) {
    const { wx, wz } = worldFromTile(c.x, c.y);
    const group = new THREE.Group();
    group.position.set(wx, 0, wz);
    const mats = [];

    const counterMat = withDetail(phys(0xd8c9a8, { roughness: 0.7 }), null, 0.5);
    const counter = new THREE.Mesh(boxGeo, counterMat);
    counter.scale.set(0.9, DIM.counterH, 0.5);
    counter.position.y = DIM.counterH / 2;
    counter.castShadow = true;
    group.add(counter);
    mats.push(counterMat);

    const beltMat = withDetail(phys(0x3c4048, { roughness: 0.45 }), null, 0.4);
    const belt = new THREE.Mesh(boxGeo, beltMat);
    belt.scale.set(0.66, 0.04, 0.3);
    belt.position.set(-0.05, DIM.counterH + 0.02, 0);
    group.add(belt);
    mats.push(beltMat);

    const postMat = std(0x8a8f98, { metalness: 0.7, roughness: 0.3 });
    const post = new THREE.Mesh(boxGeo, postMat);
    post.scale.set(0.06, 0.34, 0.06);
    post.position.set(0.32, DIM.counterH + 0.17, -0.14);
    group.add(post);
    const headMat = std(theme ? theme.accent : 0xe8743b, { roughness: 0.5 });
    const head = new THREE.Mesh(boxGeo, headMat);
    head.scale.set(0.14, 0.1, 0.14);
    head.position.set(0.32, DIM.counterH + 0.38, -0.14);
    head.castShadow = true;
    group.add(head);
    mats.push(postMat, headMat);

    const hit = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({ visible: false }));
    hit.scale.set(1, 0.9, 0.8);
    hit.position.y = 0.45;
    hit.userData.pick = { kind: 'checkout', id: c.id, x: c.x, y: c.y };
    group.add(hit);
    interactive.push(hit);

    return { group, mats, headMat, level: c.level, lift: 0, baseY: 0 };
  }

  // Subtle dark discs under furniture for grounding when shadows are off.
  function buildContactDiscs(spots) {
    if (!spots.length) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x1a1a22, transparent: true, opacity: 0.16, depthWrite: false,
    });
    discMesh = new THREE.InstancedMesh(discGeo, mat, spots.length);
    const m = new THREE.Matrix4();
    const rot = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    spots.forEach(([x, z, s], i) => {
      m.makeScale(s, s, s).premultiply(rot);
      m.setPosition(x, 0.012, z);
      discMesh.setMatrixAt(i, m);
    });
    marketGroup.add(discMesh);
  }

  function buildStaffFigures(state) {
    if (state.stockroom) {
      const { wx, wz } = worldFromTile(state.stockroom.x, state.stockroom.y);
      staffViews.stocker = makePerson(0x2b7a78, wx + 0.55, wz + 0.15);
    }
    const c0 = state.checkouts && state.checkouts[0];
    if (c0) {
      const { wx, wz } = worldFromTile(c0.x, c0.y);
      staffViews.cashier = makePerson(0x6a4a9a, wx, wz - 0.62);
    }
    for (const role of Object.keys(staffViews)) {
      staffViews[role].group.visible = false;
      marketGroup.add(staffViews[role].group);
    }
  }

  // Decorative planters outside the walls; shown when `detail` is detailed.
  function buildProps(deco) {
    propsGroup = new THREE.Group();
    propsGroup.visible = gq.detail === 'detailed';
    marketGroup.add(propsGroup);
    const potMat = withDetail(phys(0xb56a4a, { roughness: 0.6 }), null, 0.4);
    const leafMat = std(0x4e8f4e, { roughness: 0.8 });
    const leafMat2 = std(0x62a85a, { roughness: 0.8 });
    const leafGeo = new THREE.ConeGeometry(0.18, 0.34, 7);
    const topGeo = new THREE.ConeGeometry(0.13, 0.26, 7);
    for (let i = 0; i < LOOK.propCount; i++) {
      const group = new THREE.Group();
      const pot = new THREE.Mesh(boxGeo, potMat);
      pot.scale.set(0.22, 0.18, 0.22);
      pot.position.y = 0.09;
      const leaf = new THREE.Mesh(leafGeo, leafMat);
      leaf.position.y = 0.36;
      const top = new THREE.Mesh(topGeo, leafMat2);
      top.position.y = 0.52;
      for (const m of [pot, leaf, top]) m.castShadow = true;
      group.add(pot, leaf, top);
      const side = Math.floor(deco() * 4);
      const along = (deco() - 0.5) * Math.max(grid.w, grid.h);
      const out = 1.3 + deco() * 0.8;
      const x = side === 0 ? along : side === 1 ? along : (grid.w / 2 + out) * (side === 2 ? 1 : -1);
      const z = side === 0 ? (grid.h / 2 + out) : side === 1 ? -(grid.h / 2 + out) : along;
      group.position.set(x, 0, z);
      group.rotation.y = deco() * Math.PI;
      propsGroup.add(group);
    }
  }

  // -------------------------------------------------------------------------
  // People (customers + staff)
  // -------------------------------------------------------------------------

  function makePerson(colorHex, wx, wz) {
    const group = new THREE.Group();
    const bodyMat = withDetail(phys(colorHex, { roughness: 0.6 }), null, 0.35);
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = DIM.personH / 2 + DIM.personR;
    body.castShadow = true;
    const headMat = std(0xf2d3b3, { roughness: 0.8 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = DIM.personH + DIM.personR * 2 + DIM.headR * 0.8;
    head.castShadow = true;
    group.add(body, head);
    group.position.set(wx, 0, wz);
    return { group, bodyMat, headMat };
  }

  function makeCustomerView(cust) {
    const hue = (hashId(cust.id) % 360) / 360;
    const color = new THREE.Color().setHSL(hue, 0.55, 0.55);
    const { wx, wz } = worldFromTile(cust.x, cust.y);
    const person = makePerson(color.getHex(), wx, wz);
    // patience ring, shown only while queued
    const ringMat = new THREE.MeshBasicMaterial({
      color: patienceColor(1), transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.24, 24), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = FX.ringY;
    ring.visible = false;
    person.group.add(ring);
    marketGroup.add(person.group);
    return {
      ...person, ring, ringMat,
      fromX: wx, fromZ: wz, toX: wx, toZ: wz, lerpT: 1,
    };
  }

  function removeCustomerView(view) {
    marketGroup.remove(view.group);
    disposeObject(view.group);
  }

  // -------------------------------------------------------------------------
  // State reconciliation
  // -------------------------------------------------------------------------

  function syncState(state, events) {
    if (!state || !state.grid) return;
    const first = !lastState;
    lastState = state;

    // displays: stock counts, level rebuilds
    for (const d of state.displays || []) {
      let view = displayViews.get(d.id);
      if (!view) continue;
      if (view.level !== d.level || view.capacity !== d.capacity) {
        rebuildDisplayView(state, d);
        view = displayViews.get(d.id);
      }
      const dept = (state.departments || []).find((p) => p.id === d.deptId);
      view.goods.count = dept && dept.unlocked ? Math.max(0, Math.min(d.stock, d.capacity)) : 0;
    }
    updateDepartments(state);

    // staff visibility
    for (const role of Object.keys(staffViews)) {
      const s = state.staff && state.staff[role];
      staffViews[role].group.visible = !!(s && s.hired);
    }

    // customers: create / update / remove, keyed by id
    const seen = new Set();
    for (const cust of state.customers || []) {
      seen.add(cust.id);
      let view = customerViews.get(cust.id);
      if (!view) {
        view = makeCustomerView(cust);
        customerViews.set(cust.id, view);
      }
      // logical target: queued customers stand at queueSlot positions
      let lx = cust.x, ly = cust.y;
      if (cust.status === 'queued') {
        const co = (state.checkouts || []).find((c) => c.id === cust.checkoutId);
        if (co) {
          const idx = Math.max(0, co.queue.indexOf(cust.id));
          const slot = queueSlot(state, co, idx);
          lx = slot.x; ly = slot.y;
        }
      }
      const { wx, wz } = worldFromTile(lx, ly);
      if (wx !== view.toX || wz !== view.toZ) {
        if (options.reducedMotion) {
          view.fromX = view.toX = wx;
          view.fromZ = view.toZ = wz;
          view.lerpT = 1;
        } else {
          view.fromX = view.group.position.x;
          view.fromZ = view.group.position.z;
          view.toX = wx; view.toZ = wz;
          view.lerpT = 0;
        }
      }
      // patience ring: shrinks and reddens as patience drains
      const queued = cust.status === 'queued';
      view.ring.visible = queued;
      if (queued) {
        const frac = Math.max(0, Math.min(1, cust.patienceMax > 0 ? cust.patience / cust.patienceMax : 0));
        view.ring.scale.setScalar(Math.max(0.15, frac));
        view.ringMat.color.setHex(patienceColor(frac));
      }
    }
    for (const [id, view] of customerViews) {
      if (!seen.has(id)) {
        removeCustomerView(view);
        customerViews.delete(id);
      }
    }

    // queue event effects (processed by the render loop)
    for (const ev of events || []) queueEffect(state, ev, first);
  }

  function updateDepartments(state) {
    for (const dept of (state && state.departments) || []) {
      const tarps = deptTarps.get(dept.id) || [];
      for (const tarp of tarps) {
        tarp.visible = !dept.unlocked;
      }
    }
    // recolor awnings (palette may have changed)
    for (const view of displayViews.values()) {
      view.awningMat.color.setHex(deptColor(view.deptIndex));
    }
  }

  // -------------------------------------------------------------------------
  // Effects: map events to particle bursts, flashes, shake
  // -------------------------------------------------------------------------

  function tileOf(state, kind, id) {
    if (kind === 'display') {
      const d = (state.displays || []).find((x) => x.id === id);
      return d ? worldFromTile(d.x, d.y) : null;
    }
    if (kind === 'checkout') {
      const c = (state.checkouts || []).find((x) => x.id === id);
      return c ? worldFromTile(c.x, c.y) : null;
    }
    return null;
  }

  function queueEffect(state, ev, isBulkRebuild) {
    if (!ev || !ev.kind) return;
    switch (ev.kind) {
      case 'served': {
        const p = tileOf(state, 'checkout', ev.checkoutId);
        if (p) pendingEffects.push({ type: 'coin', x: p.wx, z: p.wz });
        break;
      }
      case 'take': {
        const p = tileOf(state, 'display', ev.displayId);
        if (p) pendingEffects.push({ type: 'pop', x: p.wx, z: p.wz });
        break;
      }
      case 'restock': {
        const view = displayViews.get(ev.displayId);
        if (view) view.flash = 1;
        break;
      }
      case 'left-angry': {
        // customer may already be gone from state; puff at the checkout
        const p = tileOf(state, 'checkout', ev.checkoutId);
        if (p) pendingEffects.push({ type: 'puff', x: p.wx, z: p.wz });
        break;
      }
      case 'unlock': {
        for (const d of state.displays || []) {
          if (d.deptId !== ev.deptId) continue;
          const view = displayViews.get(d.id);
          if (view) view.flash = 1;
          const p = worldFromTile(d.x, d.y);
          pendingEffects.push({ type: 'puff', x: p.wx, z: p.wz, color: 0xfff2c8 });
        }
        break;
      }
      case 'terminal': {
        if (ev.result === 'won' && !isBulkRebuild) {
          pendingEffects.push({ type: 'confetti', x: 0, z: 0 });
          if (!options.reducedMotion) shake = FX.shakeAmp;
        }
        break;
      }
      default:
        break;
    }
  }

  // -- pooled particle system -------------------------------------------------
  const PMAX = FX.maxParticles;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(PMAX * 3).fill(-999);
  const pCol = new Float32Array(PMAX * 3);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const pMat = new THREE.PointsMaterial({
    size: FX.particleSize * 1.4, vertexColors: true, transparent: true, map: tex.dot,
    opacity: 0.95, depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(pGeo, pMat);
  points.layers.set(1); // particle layer: visible to camera, never raycast
  points.frustumCulled = false;
  fxGroup.add(points);
  const particles = [];
  for (let i = 0; i < PMAX; i++) {
    particles.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, ttl: 1, r: 1, g: 1, b: 1 });
  }
  let pNext = 0;
  let pActive = 0;
  const tmpColor = new THREE.Color();

  // Ambient motes: slow warm specks drifting up through the market light
  // (particles: high; frozen away under reduced motion).
  const MOTES = LOOK.motes;
  const mGeo = new THREE.BufferGeometry();
  const mPos = new Float32Array(MOTES * 3);
  const mSeed = [];
  const moteRnd = mulberry32(4242);
  for (let i = 0; i < MOTES; i++) mSeed.push([moteRnd(), moteRnd(), moteRnd(), moteRnd()]);
  mGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
  const mMat = new THREE.PointsMaterial({
    size: 0.07, color: 0xfff1c9, map: tex.dot, transparent: true, opacity: 0.55,
    depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending,
  });
  const motes = new THREE.Points(mGeo, mMat);
  motes.layers.set(1);
  motes.frustumCulled = false;
  motes.visible = false;
  fxGroup.add(motes);

  function updateMotes() {
    motes.visible = gq.particles === 'high' && !options.reducedMotion && grid.w > 0;
    if (!motes.visible) return;
    const hw = grid.w / 2, hh = grid.h / 2;
    for (let i = 0; i < MOTES; i++) {
      const [a, b, c, d] = mSeed[i];
      const t = elapsed * (0.05 + c * 0.06) + d;
      const y = (t % 1) * 1.6 + 0.1;
      mPos[i * 3] = (a - 0.5) * 2 * hw + Math.sin(elapsed * 0.6 + d * 9) * 0.25;
      mPos[i * 3 + 1] = y;
      mPos[i * 3 + 2] = (b - 0.5) * 2 * hh + Math.cos(elapsed * 0.5 + c * 9) * 0.25;
    }
    mGeo.attributes.position.needsUpdate = true;
  }

  function spawnParticle(x, y, z, vx, vy, vz, ttl, colorHex) {
    const p = particles[pNext];
    pNext = (pNext + 1) % PMAX;
    if (!p.alive) pActive++;
    p.alive = true;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = 0; p.ttl = ttl;
    tmpColor.setHex(colorHex);
    p.r = tmpColor.r; p.g = tmpColor.g; p.b = tmpColor.b;
  }

  function spawnBurst(fx) {
    const cap = PARTICLE_CAP[gq.particles] || PARTICLE_CAP.low;
    if (options.reducedMotion || pActive >= cap) return;
    const rand = Math.random;
    const emit = (count, colorFn, speed, up, ttl) => {
      for (let i = 0; i < count && pActive < cap; i++) {
        const a = rand() * Math.PI * 2;
        const s = speed * (0.4 + rand() * 0.6);
        spawnParticle(
          fx.x, 0.5, fx.z,
          Math.cos(a) * s, up * (0.6 + rand() * 0.8), Math.sin(a) * s,
          ttl * (0.7 + rand() * 0.6), colorFn(i),
        );
      }
    };
    if (fx.type === 'coin') emit(FX.coinCount, () => FX.coinColor, 0.7, 2.4, FX.burstLife);
    else if (fx.type === 'pop') emit(FX.popCount, () => 0xffffff, 1.0, 1.4, FX.burstLife * 0.6);
    else if (fx.type === 'puff') emit(FX.puffCount, () => (fx.color || FX.puffColor), 0.8, 0.8, FX.burstLife);
    else if (fx.type === 'confetti') {
      emit(FX.confettiCount, (i) => palette().dept[i % palette().dept.length], 2.6, 4.2, FX.burstLife * 2.2);
    }
  }

  function updateParticles(dt) {
    if (pActive === 0 && !pendingEffects.length) return;
    for (let i = 0; i < PMAX; i++) {
      const p = particles[i];
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.ttl) {
        p.alive = false;
        pActive--;
        pPos[i * 3 + 1] = -999;
        continue;
      }
      p.vy += FX.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.02) { p.y = 0.02; p.vy *= -0.3; p.vx *= 0.7; p.vz *= 0.7; }
      pPos[i * 3] = p.x;
      pPos[i * 3 + 1] = p.y;
      pPos[i * 3 + 2] = p.z;
      const fade = 1 - p.life / p.ttl;
      pCol[i * 3] = p.r * fade;
      pCol[i * 3 + 1] = p.g * fade;
      pCol[i * 3 + 2] = p.b * fade;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Markers (hover ring + legal-target highlight rings)
  // -------------------------------------------------------------------------

  function makeRingMarker(colorHex) {
    const mat = hdrColor(new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
    }), colorHex);
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.02;
    mesh.visible = false;
    return mesh;
  }

  function setHighlight(targets) {
    highlightTargets = Array.isArray(targets) ? targets : null;
    for (const m of highlightMarkers) { fxGroup.remove(m); disposeObject(m); }
    highlightMarkers.length = 0;
    if (!highlightTargets) return;
    for (const t of highlightTargets) {
      const pos = positionForTarget(t);
      if (!pos) continue;
      const marker = makeRingMarker(theme ? theme.accent : 0xe8743b);
      marker.position.set(pos.x, 0.025, pos.z);
      marker.visible = true;
      fxGroup.add(marker);
      highlightMarkers.push(marker);
    }
  }

  function positionForTarget(t) {
    if (!t) return null;
    if (t.kind === 'display') {
      const v = displayViews.get(t.id);
      return v ? { x: v.group.position.x, z: v.group.position.z } : null;
    }
    if (t.kind === 'checkout') {
      const v = checkoutViews.get(t.id);
      return v ? { x: v.group.position.x, z: v.group.position.z } : null;
    }
    if (t.kind === 'department') {
      const tarps = deptTarps.get(t.id) || [];
      const tarp = tarps.find((x) => x.visible);
      if (!tarp) return null;
      const p = new THREE.Vector3();
      tarp.getWorldPosition(p);
      return { x: p.x, z: p.z };
    }
    if (t.kind === 'floor' && typeof t.x === 'number') {
      const { wx, wz } = worldFromTile(t.x, t.y);
      return { x: wx, z: wz };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Theme / palette / quality setters
  // -------------------------------------------------------------------------

  // Backdrop: flat sky colour, or (detail: detailed) a sky-to-haze gradient.
  function applyBackground() {
    const sky = theme ? theme.sky : 0xffffff;
    const haze = theme ? theme.fog : 0xffffff;
    if (skyTex) { skyTex.dispose(); skyTex = null; }
    if (gq.detail === 'detailed') {
      const top = new THREE.Color(sky).lerp(new THREE.Color(0xffffff), 0.25);
      skyTex = skyTexture(top.getHex(), haze);
      scene.background = skyTex;
    } else {
      scene.background = skyColor.setHex(sky);
    }
  }

  function applyThemeToScene() {
    if (!theme) return;
    applyBackground();
    scene.fog = new THREE.Fog(theme.fog, 34, 78);
    hemi.color.setHex(theme.sky);
    hemi.groundColor.setHex(theme.ground);
    keyLight.color.setHex(theme.key);
    keyLight.intensity = theme.intensity;
    if (groundMesh) groundMesh.material.color.setHex(theme.ground);
    if (wallMesh) wallMesh.material.color.setHex(theme.tile).multiplyScalar(0.72);
    for (const m of archMats) m.color.setHex(theme.accent);
    for (const v of checkoutViews.values()) v.headMat.color.setHex(theme.accent);
  }

  function setTheme(themeObj) {
    if (!themeObj) return;
    theme = themeObj;
    applyThemeToScene();
    if (floorMesh && floorMesh.instanceColor) {
      // recolor tiles from the new base, replaying the seeded variations
      const base = new THREE.Color(theme.tile);
      for (let i = 0; i < tileVariations.length; i++) {
        const v = tileVariations[i];
        floorMesh.setColorAt(i, base.clone().offsetHSL(v[0], v[1], v[2]));
      }
      floorMesh.instanceColor.needsUpdate = true;
    }
  }

  // Apply saved graphics settings live (see gfx.js). Idempotent.
  function setGraphics(saved) {
    const json = JSON.stringify(saved || {});
    if (json === gfxJson) return;
    gfxJson = json;
    options.graphics = saved || {};
    const prev = gq;
    gq = resolveGraphics(options.graphics, options.detected);

    // shadows
    const size = SHADOW_MAP[gq.shadows];
    const shadowsChanged = renderer.shadowMap.enabled !== size > 0;
    renderer.shadowMap.enabled = size > 0;
    keyLight.castShadow = size > 0;
    if (size > 0 && keyLight.shadow.mapSize.x !== size) {
      keyLight.shadow.mapSize.set(size, size);
      if (keyLight.shadow.map) { keyLight.shadow.map.dispose(); keyLight.shadow.map = null; }
    }
    if (discMesh) discMesh.material.opacity = size > 0 ? 0.1 : 0.18;

    // reflections (image-based lighting)
    if (gq.reflections === 'on') {
      if (!envTexture) {
        const pmrem = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment(renderer);
        envTexture = pmrem.fromScene(room, 0.04).texture;
        room.dispose();
        pmrem.dispose();
      }
      scene.environment = envTexture;
      hemi.intensity = LOOK.hemiIntensityWithEnv;
    } else {
      scene.environment = null;
      hemi.intensity = LOOK.hemiIntensity;
    }

    // detail, bloom-dependent colours, particle look
    const detailChanged = !prev || prev.detail !== gq.detail;
    scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (detailChanged) applyDetailTo(m);
        if (m.userData.hdrHex !== undefined) hdrColor(m, m.userData.hdrHex);
        if (shadowsChanged) m.needsUpdate = true;
      }
    });
    if (propsGroup) propsGroup.visible = gq.detail === 'detailed';
    if (detailChanged) applyBackground();
    pMat.color.setScalar(gq.bloom === 'on' ? LOOK.hdrBoost : 1);
    mMat.opacity = gq.bloom === 'on' ? 0.75 : 0.55;

    adaptiveScale = 1;
    adaptFrames = [];
    postKey = null; // rebuild the post chain on the next frame
    postFailed = false;
    fpsVisible(gq.showFps);
    if (typeof document !== 'undefined') canvas.dataset.gfxPreset = gq.preset;
  }

  // Legacy API: quality tier names map onto graphics presets.
  function setQuality(q) {
    setGraphics({ ...(options.graphics || {}), preset: legacyPreset(q) });
  }

  function fpsVisible(on) {
    if (typeof document === 'undefined') return;
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.className = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  // What the Graphics panel shows: GPU, auto choice, resolved tiers, cost.
  function graphicsInfo(words) {
    // the drawing buffer is the true render size (the host may be hidden
    // behind the settings screen while this is read)
    let px = [canvas.width, canvas.height];
    if (px[0] <= 1 || px[1] <= 1) {
      const ratio = Math.min(window.devicePixelRatio || 1, gq.maxRatio) * gq.scale;
      px = [Math.round(window.innerWidth * ratio), Math.round(window.innerHeight * ratio)];
    }
    return {
      gpu: options.gpu || '',
      detected: options.detected,
      resolved: { ...gq },
      pixels: px,
      summary: describeGraphics(gq, px, words),
      fps: Math.round(fps),
      adaptiveScale: Math.round(adaptiveScale * 100) / 100,
      postFailed,
    };
  }

  // -------------------------------------------------------------------------
  // Post-processing chain (RenderPass → GTAO → bloom → grade → output → AA)
  // -------------------------------------------------------------------------

  function makePostKey(w, h) {
    return gq.post ? [gq.ao, gq.bloom, gq.grade, gq.antialias, w, h, pixelRatio].join('|') : 'none';
  }

  // GTAO tuning for this scene (r160 GTAOPass):
  // - its constructor mistypes the PERSPECTIVE_CAMERA define, so set it for the
  //   orthographic market camera, and use a constant view direction (ortho
  //   pixels all look down -Z; the shader assumes a perspective eye point);
  // - reconstruct normals from depth instead of the pass's normal buffer, which
  //   left a dark screen-centred block on the floor with this camera.
  function tuneGtao(ao) {
    const ortho = !camera.isPerspectiveCamera;
    for (const m of [ao.gtaoMaterial, ao.depthRenderMaterial, ao.pdMaterial]) {
      if (!m || !m.defines) continue;
      if (ortho && m.defines.PERSPECTIVE_CAMERA !== undefined) m.defines.PERSPECTIVE_CAMERA = 0;
      if (m.defines.NORMAL_VECTOR_TYPE !== undefined) m.defines.NORMAL_VECTOR_TYPE = 0;
      m.needsUpdate = true;
    }
    const m = ao.gtaoMaterial;
    const from = 'vec3 viewDir = normalize(-viewPos.xyz);';
    if (ortho && m && m.fragmentShader.includes(from)) {
      m.fragmentShader = m.fragmentShader.replace(from, 'vec3 viewDir = vec3(0.0, 0.0, 1.0);');
    }
  }

  function disposePost() {
    if (!composer) return;
    for (const p of composer.passes) if (typeof p.dispose === 'function') p.dispose();
    composer.dispose();
    composer = null;
  }

  function buildPost(w, h) {
    disposePost();
    if (!gq.post || postFailed) return;
    const pw = Math.max(1, Math.round(w * pixelRatio));
    const ph = Math.max(1, Math.round(h * pixelRatio));
    try {
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType,
        samples: gq.antialias === 'msaa' && renderer.capabilities.isWebGL2 ? 4 : 0,
      });
      const c = new EffectComposer(renderer, target);
      c.setPixelRatio(pixelRatio);
      c.setSize(w, h);
      c.addPass(new RenderPass(scene, camera));
      if (gq.ao !== 'off') {
        const high = gq.ao === 'high';
        const ao = new GTAOPass(scene, camera, pw, ph);
        tuneGtao(ao);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.85;
        ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: high ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: high ? 6 : 4, rings: 2, samples: high ? 16 : 8 });
        c.addPass(ao);
      }
      if (gq.bloom === 'on') {
        const b = LOOK.bloom;
        c.addPass(new UnrealBloomPass(new THREE.Vector2(pw, ph), b.strength, b.radius, b.threshold));
      }
      if (gq.grade === 'on') c.addPass(new ShaderPass(GradeShader));
      c.addPass(new OutputPass());
      if (gq.antialias === 'smaa') c.addPass(new SMAAPass(pw, ph));
      if (gq.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        c.addPass(fxaa);
      }
      composer = c;
    } catch (_) {
      // Post-processing is an enhancement: render directly and let the
      // Graphics panel say so (no console output, by design).
      postFailed = true;
      disposePost();
    }
  }

  // Adaptive resolution: step the scale down when frames are slow, back up when fast.
  function adapt(dtMs) {
    adaptFrames.push(dtMs);
    if (adaptFrames.length < ADAPT.frames) return false;
    const avg = adaptFrames.reduce((a, b) => a + b, 0) / adaptFrames.length;
    adaptFrames = [];
    fps = 1000 / avg;
    const el = typeof document !== 'undefined' ? document.getElementById('fps-meter') : null;
    if (el && !el.hidden) el.textContent = `${Math.round(fps)} fps · ${Math.round(pixelRatio * 100) / 100}×`;
    if (!gq.adaptive) return false;
    const before = adaptiveScale;
    if (avg > ADAPT.slowMs) adaptiveScale = Math.max(ADAPT.min, adaptiveScale - ADAPT.down);
    else if (avg < ADAPT.fastMs && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale + ADAPT.up);
    return before !== adaptiveScale;
  }

  function setReducedMotion(b) {
    options.reducedMotion = !!b;
    if (options.reducedMotion) {
      shake = 0;
      pendingEffects.length = 0;
      for (const v of customerViews.values()) v.group.position.y = 0;
      for (const v of Object.values(staffViews)) v.group.position.y = 0;
    }
  }

  function setColorblind(mode) {
    if (!PALETTES[mode]) return;
    options.colorblind = mode;
    updateDepartments(lastState || { departments: [] });
    if (lastState) syncState(lastState, []); // refresh ring colors
  }

  // -------------------------------------------------------------------------
  // Camera: presets, spring transitions, pan/zoom, shake, reset
  // -------------------------------------------------------------------------

  function updateFraming() {
    const w = Math.max(1, grid.w), h = Math.max(1, grid.h);
    const needW = (w + h) * FRAMING.fitWidthPerTile + FRAMING.fitPadX;
    const needH = (w + h) * FRAMING.fitHeightPerTile + FRAMING.fitPadY;
    const insTop = hudInsets();
    const hh = container.clientHeight || 1;
    const safeAspect = (container.clientWidth || 1) / Math.max(120, hh - insTop.top - insTop.bottom);
    baseViewH = Math.max(needH, needW / safeAspect);
    applyOrtho();
    // key light shadow volume fitted tightly to the room (plus the planters
    // just outside the walls): the room's bounding circle, seen from the light.
    const ext = Math.hypot(w, h) / 2 + 1.2;
    const dir = new THREE.Vector3(...LOOK.keyDir).normalize();
    const dist = ext * 2.5;
    keyLight.position.set(dir.x * dist, dir.y * dist, dir.z * dist);
    keyLight.target.position.set(0, 0, 0);
    keyLight.shadow.camera.left = -ext;
    keyLight.shadow.camera.right = ext;
    keyLight.shadow.camera.top = ext;
    keyLight.shadow.camera.bottom = -ext;
    keyLight.shadow.camera.near = Math.max(0.1, dist - ext * 1.6);
    keyLight.shadow.camera.far = dist + ext * 1.6;
    keyLight.shadow.camera.updateProjectionMatrix();
  }

  function currentAspect() {
    const w = container.clientWidth || 1;
    const hgt = container.clientHeight || 1;
    return w / hgt;
  }

  // HUD bands covering the canvas (top HUD + banner, bottom mirror/summary).
  // The room is framed inside the uncovered band via a view offset.
  function hudInsets() {
    const ins = { top: 0, bottom: 0 };
    if (typeof document === 'undefined') return ins;
    const cr = container.getBoundingClientRect();
    const H = cr.height || 1;
    const band = (sel) => {
      const el = document.querySelector(sel);
      if (!el || el.hidden || !el.offsetParent) return null;
      const r = el.getBoundingClientRect();
      return r.height ? { t: r.top - cr.top, b: r.bottom - cr.top, w: r.width } : null;
    };
    const top = band('.hud-top'); if (top && top.b < H * 0.45) ins.top = Math.max(ins.top, top.b);
    const tut = band('#tutorial-banner'); if (tut && tut.b < H * 0.5) ins.top = Math.max(ins.top, tut.b);
    const mirror = band('#board-mirror'); if (mirror && mirror.t > H * 0.55 && mirror.w > cr.width * 0.5) ins.bottom = Math.max(ins.bottom, H - mirror.t);
    return ins;
  }

  function applyOrtho() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    const ins = hudInsets();
    const safeH = Math.max(120, h - ins.top - ins.bottom);
    const aspect = w / safeH;
    const halfH = baseViewH / 2;
    camera.left = -halfH * aspect;
    camera.right = halfH * aspect;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.setViewOffset(w, safeH, 0, -ins.top, w, h);
    camera.updateProjectionMatrix();
  }

  function presetTarget() {
    const p = FRAMING.presets[options.camera] || FRAMING.presets.isometric;
    const dir = new THREE.Vector3(...p.dir).normalize();
    return dir.multiplyScalar(p.dist);
  }

  function setCamera(mode) {
    if (!FRAMING.presets[mode]) return;
    options.camera = mode;
    // spring picks the new target up automatically in the render loop
  }

  function resetCamera() {
    camFocus.tx = 0; camFocus.tz = 0;
    zoomTarget = 1;
    const t = presetTarget();
    if (!built || options.reducedMotion) {
      // snap directly when there is nothing worth animating from
      camFocus.x = camFocus.tx; camFocus.z = camFocus.tz;
      camFocus.vx = camFocus.vz = 0;
      camPos.x = t.x; camPos.y = t.y; camPos.z = t.z;
      camPos.vx = camPos.vy = camPos.vz = 0;
      zoomCur = 1; zoomVel = 0;
    }
  }

  function updateCamera(dt) {
    const f = FRAMING.springFreq;
    const t = presetTarget();
    [camFocus.x, camFocus.vx] = springStep(camFocus.x, camFocus.vx, camFocus.tx, f, dt);
    [camFocus.z, camFocus.vz] = springStep(camFocus.z, camFocus.vz, camFocus.tz, f, dt);
    [camPos.x, camPos.vx] = springStep(camPos.x, camPos.vx, t.x + camFocus.x, f, dt);
    [camPos.y, camPos.vy] = springStep(camPos.y, camPos.vy, t.y, f, dt);
    [camPos.z, camPos.vz] = springStep(camPos.z, camPos.vz, t.z + camFocus.z, f, dt);
    [zoomCur, zoomVel] = springStep(zoomCur, zoomVel, zoomTarget, f, dt);

    camera.position.set(camPos.x, camPos.y, camPos.z);
    camera.lookAt(camFocus.x, 0, camFocus.z);
    camera.zoom = zoomCur;
    camera.updateProjectionMatrix();

    // terminal-tier shake only, applied to the rig (never to raycast truth)
    if (shake > 0.001 && !options.reducedMotion) {
      shakeRig.position.set(
        (Math.random() - 0.5) * shake,
        (Math.random() - 0.5) * shake * 0.6,
        (Math.random() - 0.5) * shake,
      );
      shake *= Math.exp(-FX.shakeDecay * dt);
    } else {
      shakeRig.position.set(0, 0, 0);
      shake = Math.max(0, shake);
    }
  }

  // -------------------------------------------------------------------------
  // Input: tap vs drag, wheel zoom, hover, pointer capture
  // -------------------------------------------------------------------------

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pDown = null;       // {x, y, t, id}
  let dragging = false;
  let lastHoverXY = null;

  function isEffectivelyVisible(obj) {
    for (let o = obj; o; o = o.parent) {
      if (!o.visible) return false;
    }
    return true;
  }

  function pickAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    // zero the shake rig so raycast truth is unaffected by terminal shake
    const sx = shakeRig.position.x, sy = shakeRig.position.y, sz = shakeRig.position.z;
    shakeRig.position.set(0, 0, 0);
    shakeRig.updateMatrixWorld(true);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(interactive, false);
    shakeRig.position.set(sx, sy, sz);
    shakeRig.updateMatrixWorld(true);
    for (const hit of hits) {
      if (!isEffectivelyVisible(hit.object)) continue; // hidden tarps etc.
      const data = hit.object.userData.pick;
      if (!data) continue;
      if (data.kind === 'floor') {
        const tile = floorIndexToXY[hit.instanceId];
        if (!tile) continue;
        return { kind: 'floor', x: tile.x, y: tile.y };
      }
      return { ...data };
    }
    return null;
  }

  function samePick(a, b) {
    if (!a || !b) return a === b;
    return a.kind === b.kind && a.id === b.id && a.x === b.x && a.y === b.y;
  }

  function viewForPick(pick) {
    if (!pick) return null;
    if (pick.kind === 'display') return displayViews.get(pick.id) || null;
    if (pick.kind === 'checkout') return checkoutViews.get(pick.id) || null;
    return null;
  }

  function applyHover(pick) {
    if (samePick(pick, hoveredPick)) return;
    if (hoverView) setViewHover(hoverView, false);
    hoveredPick = pick;
    hoverView = viewForPick(pick);
    if (hoverView) setViewHover(hoverView, true);
    const pos = pick ? positionForTarget(pick) : null;
    hoverMarker.visible = !!pos;
    if (pos) hoverMarker.position.set(pos.x, 0.02, pos.z);
    options.onHover(pick);
  }

  function setViewHover(view, on) {
    for (const m of view.mats) {
      m.emissive.setHex(on ? 0xffffff : 0x000000);
      m.emissiveIntensity = on ? FX.hoverEmissive : 0;
    }
    view.liftTarget = on ? FX.hoverLift : 0;
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    pDown = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    dragging = false;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* capture is best-effort */ }
  }

  function onPointerMove(e) {
    if (pDown) {
      const dx = e.clientX - pDown.x;
      const dy = e.clientY - pDown.y;
      const dist = Math.hypot(dx, dy);
      const held = performance.now() - pDown.t;
      if (!dragging && (dist > FX.tapMaxDistPx || held > FX.tapMaxMs)) dragging = true;
      if (dragging) {
        panBy(dx - (pDown.lastDx || 0), dy - (pDown.lastDy || 0));
        pDown.lastDx = dx;
        pDown.lastDy = dy;
        applyHover(null);
        return;
      }
    }
    // hover: raycast only when the pointer actually moved
    if (lastHoverXY && lastHoverXY.x === e.clientX && lastHoverXY.y === e.clientY) return;
    lastHoverXY = { x: e.clientX, y: e.clientY };
    applyHover(pickAt(e.clientX, e.clientY));
  }

  function onPointerUp(e) {
    if (!pDown) return;
    const wasDrag = dragging;
    const dx = e.clientX - pDown.x;
    const dy = e.clientY - pDown.y;
    const held = performance.now() - pDown.t;
    releaseCapture(e.pointerId);
    pDown = null;
    dragging = false;
    if (!wasDrag && Math.hypot(dx, dy) <= FX.tapMaxDistPx && held <= FX.tapMaxMs + 500) {
      options.onPick(pickAt(e.clientX, e.clientY));
    }
  }

  function onPointerCancel(e) {
    releaseCapture(e.pointerId);
    pDown = null;
    dragging = false;
  }

  function onPointerLeave() {
    lastHoverXY = null;
    applyHover(null);
  }

  function releaseCapture(pointerId) {
    try {
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId);
      }
    } catch (_) { /* safe cancel */ }
  }

  function panBy(dxPx, dyPx) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.height) return;
    const wpp = (baseViewH / zoomCur) / rect.height; // world units per pixel
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    right.y = 0;
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    up.y = 0;
    const upLen = up.length();
    if (upLen < 1e-3) return;
    up.divideScalar(upLen);
    const upScale = 1 / upLen; // compensate vertical foreshortening
    camFocus.tx -= right.x * dxPx * wpp - up.x * dyPx * wpp * upScale;
    camFocus.tz -= right.z * dxPx * wpp - up.z * dyPx * wpp * upScale;
    const bx = grid.w / 2 + FRAMING.panMargin;
    const bz = grid.h / 2 + FRAMING.panMargin;
    camFocus.tx = Math.max(-bx, Math.min(bx, camFocus.tx));
    camFocus.tz = Math.max(-bz, Math.min(bz, camFocus.tz));
  }

  function onWheel(e) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0012);
    zoomTarget = Math.max(FRAMING.zoomMin, Math.min(FRAMING.zoomMax, zoomTarget * factor));
  }

  const listeners = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerCancel],
    ['lostpointercapture', onPointerCancel],
    ['pointerleave', onPointerLeave],
    ['wheel', onWheel, { passive: false }],
  ];
  for (const [type, fn, opt] of listeners) canvas.addEventListener(type, fn, opt);

  // -------------------------------------------------------------------------
  // Resize
  // -------------------------------------------------------------------------

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    if (grid.w) updateFraming(); else applyOrtho();
  }

  // Pixel ratio = min(dpr, preset cap) × render scale × adaptive scale.
  function syncPixelRatio(force) {
    const ratio = Math.min(window.devicePixelRatio || 1, gq.maxRatio) * gq.scale * adaptiveScale;
    if (force || Math.abs(ratio - pixelRatio) > 1e-4) {
      pixelRatio = ratio;
      renderer.setPixelRatio(ratio);
      renderer.setSize(container.clientWidth || 1, container.clientHeight || 1, false);
    }
  }

  // HUD bands change without a resize (banner shows, mirror grows): refit.
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    const mo = new MutationObserver(() => { if (grid.w) updateFraming(); });
    for (const sel of ['#tutorial-banner', '#board-mirror', '.hud-top']) {
      const el = document.querySelector(sel);
      if (el) mo.observe(el, { attributes: true, childList: true, subtree: true, attributeFilter: ['hidden', 'class', 'style'] });
    }
  }

  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(container);
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  function frame(now) {
    if (!running || disposed) return;
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0.0001, (now - lastTime) / 1000));
    lastTime = now;
    elapsed += dt;

    updateCamera(dt);

    if (!paused) {
      // customer logical-position interpolation
      const lerpWindow = FX.customerLerpMs / 1000;
      for (const view of customerViews.values()) {
        if (view.lerpT < 1) {
          view.lerpT = Math.min(1, view.lerpT + dt / lerpWindow);
          const t = view.lerpT * view.lerpT * (3 - 2 * view.lerpT); // smoothstep
          view.group.position.x = view.fromX + (view.toX - view.fromX) * t;
          view.group.position.z = view.fromZ + (view.toZ - view.fromZ) * t;
        }
      }
      // hover lift + shelf flashes
      for (const view of displayViews.values()) {
        updateLiftFlash(view, dt);
      }
      for (const view of checkoutViews.values()) {
        updateLiftFlash(view, dt);
      }
      // marker pulses (highlight rings pulse; hover ring steady)
      const pulse = 1 + Math.sin(elapsed * 5) * 0.07;
      for (const m of highlightMarkers) {
        m.scale.setScalar(pulse);
        m.material.opacity = 0.6 + Math.sin(elapsed * 5) * 0.25;
      }
      // gentle idle bob for guests standing still and for staff
      if (!options.reducedMotion) {
        for (const [id, view] of customerViews) {
          const phase = (hashId(id) % 628) / 100;
          const still = view.lerpT >= 1;
          const target = still ? Math.abs(Math.sin(elapsed * 2.2 + phase)) * LOOK.idleBob : 0;
          view.group.position.y += (target - view.group.position.y) * Math.min(1, dt * 10);
        }
        for (const [role, view] of Object.entries(staffViews)) {
          view.group.position.y = Math.abs(Math.sin(elapsed * 1.6 + role.length)) * LOOK.idleBob * 0.6;
        }
      }
      // dispatch queued effects
      while (pendingEffects.length) spawnBurst(pendingEffects.shift());
      updateParticles(dt);
      updateMotes();
    }

    const rescale = adapt(dt * 1000);
    syncPixelRatio(rescale);
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    const key = makePostKey(w, h);
    if (key !== postKey) {
      postKey = key;
      buildPost(w, h);
    }
    if (composer) composer.render(dt);
    else renderer.render(scene, camera);
  }

  function updateLiftFlash(view, dt) {
    const target = view.liftTarget || 0;
    if (Math.abs(view.lift - target) > 0.001) {
      view.lift += (target - view.lift) * Math.min(1, dt * 12);
      view.group.position.y = view.baseY + view.lift;
    }
    if (view.flash > 0) {
      view.flash = Math.max(0, view.flash - dt / FX.flashTime);
      if (view.goodsMat) view.goodsMat.emissive.setScalar(view.flash * 0.6);
    }
  }

  function start() {
    if (running || disposed) return;
    running = true;
    lastTime = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function setPaused(b) {
    paused = !!b;
  }

  // -------------------------------------------------------------------------
  // Stats / disposal
  // -------------------------------------------------------------------------

  function getDrawStats() {
    return {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    if (resizeObserver) resizeObserver.disconnect();
    for (const [type, fn] of listeners) canvas.removeEventListener(type, fn);
    clearMarket();
    disposeObject(fxGroup);
    fxGroup.clear();
    scene.remove(fxGroup);
    if (groundMesh) { scene.remove(groundMesh); disposeObject(groundMesh); groundMesh = null; }
    disposeObject(scene);
    for (const g of [boxGeo, ringGeo, discGeo, bodyGeo, headGeo, goodGeo, pGeo, mGeo]) g.dispose();
    pMat.dispose();
    mMat.dispose();
    disposePost();
    for (const t of Object.values(tex)) t.dispose();
    if (skyTex) skyTex.dispose();
    if (envTexture) envTexture.dispose();
    fpsVisible(false);
    renderer.dispose();
    if (canvas.parentNode === container) container.removeChild(canvas);
  }

  // -------------------------------------------------------------------------
  // Init + public API
  // -------------------------------------------------------------------------

  { const initial = options.graphics; options.graphics = null; setGraphics(initial); }
  syncPixelRatio(true);
  resize();
  if (options.camera !== FRAMING.defaultPreset) setCamera(options.camera);
  resetCamera();

  return {
    buildMarket,
    syncState,
    setHighlight,
    setQuality,
    setGraphics,
    graphicsInfo,
    setReducedMotion,
    setColorblind,
    setTheme,
    setCamera,
    resetCamera,
    setPaused,
    start,
    stop,
    resize,
    getDrawStats,
    dispose,
  };
}
