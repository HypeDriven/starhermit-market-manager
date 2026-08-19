// Market Manager — Three.js render layer.
// Bright isometric tabletop market. Procedural geometry only, no assets.
// All gameplay truth comes from rules state snapshots; this module owns
// views, effects, camera, and input, and never mutates game state.

import * as THREE from '../lib/three.module.min.js';
import { TILE, queueSlot } from './rules.js';

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

const QUALITY = {
  low: { shadows: false, shadowMap: 0, pixelRatio: 1, particleCap: 300, propDensity: 0 },
  medium: { shadows: true, shadowMap: 1024, pixelRatio: 1.5, particleCap: 800, propDensity: 4 },
  high: { shadows: true, shadowMap: 2048, pixelRatio: 2, particleCap: 2000, propDensity: 10 },
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
// Renderer factory
// ---------------------------------------------------------------------------

export function createRenderer(container, opts = {}) {
  const options = {
    quality: QUALITY[opts.quality] ? opts.quality : 'medium',
    reducedMotion: !!opts.reducedMotion,
    colorblind: PALETTES[opts.colorblind] ? opts.colorblind : 'none',
    camera: FRAMING.presets[opts.camera] ? opts.camera : FRAMING.defaultPreset,
    onPick: typeof opts.onPick === 'function' ? opts.onPick : () => {},
    onHover: typeof opts.onHover === 'function' ? opts.onHover : () => {},
  };

  // -- renderer / scene ------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: options.quality !== 'low' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
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

  const hemi = new THREE.HemisphereLight(0xffffff, 0x777777, 0.55);
  scene.add(hemi);
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
  keyLight.position.set(6, 10, 4);
  scene.add(keyLight);
  scene.add(keyLight.target);

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
    return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.0, ...extra });
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
    const mat = std(theme ? theme.ground : 0x8fce7a, { roughness: 1 });
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
    const mat = std(0xffffff, { roughness: 0.95 });
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
    const mat = std(base, { roughness: 0.9 });
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
    const mat = std(theme ? theme.accent : 0xe8743b, { roughness: 0.6 });
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
    const crateMat = std(0xb08954, { roughness: 0.9 });
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

    const boardMat = std(0xcbb894);
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
    const awningMat = std(deptColor(deptIndex), { roughness: 0.6 });
    mats.push(awningMat);
    const awning = new THREE.Mesh(boxGeo, awningMat);
    awning.scale.set(0.94, 0.06, 0.56);
    awning.position.y = DIM.shelfBoards[1] + 0.14;
    awning.castShadow = true;
    group.add(awning);

    // goods: one small box per stock unit, spread over the two shelves
    const cap = Math.max(1, d.capacity);
    const goodsMat = std(0xffffff, { roughness: 0.55 });
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

    const counterMat = std(0xd8c9a8);
    const counter = new THREE.Mesh(boxGeo, counterMat);
    counter.scale.set(0.9, DIM.counterH, 0.5);
    counter.position.y = DIM.counterH / 2;
    counter.castShadow = true;
    group.add(counter);
    mats.push(counterMat);

    const beltMat = std(0x3c4048, { roughness: 0.5 });
    const belt = new THREE.Mesh(boxGeo, beltMat);
    belt.scale.set(0.66, 0.04, 0.3);
    belt.position.set(-0.05, DIM.counterH + 0.02, 0);
    group.add(belt);
    mats.push(beltMat);

    const postMat = std(0x8a8f98, { metalness: 0.4, roughness: 0.4 });
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

  // Decorative props outside the walls; density by quality tier.
  function buildProps(deco) {
    const n = QUALITY[options.quality].propDensity;
    if (!n) return;
    const potMat = std(0xb56a4a);
    const leafMat = std(0x4e8f4e);
    for (let i = 0; i < n; i++) {
      const group = new THREE.Group();
      const pot = new THREE.Mesh(boxGeo, potMat);
      pot.scale.set(0.22, 0.18, 0.22);
      pot.position.y = 0.09;
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.34, 6), leafMat);
      leaf.position.y = 0.36;
      group.add(pot, leaf);
      const side = Math.floor(deco() * 4);
      const along = (deco() - 0.5) * Math.max(grid.w, grid.h);
      const out = 1.3 + deco() * 0.8;
      const x = side === 0 ? along : side === 1 ? along : (grid.w / 2 + out) * (side === 2 ? 1 : -1);
      const z = side === 0 ? (grid.h / 2 + out) : side === 1 ? -(grid.h / 2 + out) : along;
      group.position.set(x, 0, z);
      group.rotation.y = deco() * Math.PI;
      marketGroup.add(group);
    }
  }

  // -------------------------------------------------------------------------
  // People (customers + staff)
  // -------------------------------------------------------------------------

  function makePerson(colorHex, wx, wz) {
    const group = new THREE.Group();
    const bodyMat = std(colorHex, { roughness: 0.7 });
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
    size: FX.particleSize, vertexColors: true, transparent: true,
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
    const cap = QUALITY[options.quality].particleCap;
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
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false,
    });
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

  function applyThemeToScene() {
    if (!theme) return;
    scene.background.setHex(theme.sky);
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

  function setQuality(q) {
    if (!QUALITY[q]) return;
    options.quality = q;
    const tier = QUALITY[q];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.pixelRatio));
    keyLight.castShadow = tier.shadows;
    renderer.shadowMap.enabled = tier.shadows;
    if (tier.shadows) {
      keyLight.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
      if (keyLight.shadow.map) {
        keyLight.shadow.map.dispose();
        keyLight.shadow.map = null;
      }
    }
    if (discMesh) discMesh.material.opacity = tier.shadows ? 0.1 : 0.18;
  }

  function setReducedMotion(b) {
    options.reducedMotion = !!b;
    if (options.reducedMotion) {
      shake = 0;
      pendingEffects.length = 0;
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
    baseViewH = Math.max(needH, needW / currentAspect());
    applyOrtho();
    // key light shadow volume covers the room
    const ext = Math.max(w, h) / 2 + 3;
    keyLight.position.set(ext * 0.8, ext * 1.4, ext * 0.6);
    keyLight.target.position.set(0, 0, 0);
    keyLight.shadow.camera.left = -ext;
    keyLight.shadow.camera.right = ext;
    keyLight.shadow.camera.top = ext;
    keyLight.shadow.camera.bottom = -ext;
    keyLight.shadow.camera.far = ext * 4;
    keyLight.shadow.camera.updateProjectionMatrix();
  }

  function currentAspect() {
    const w = container.clientWidth || 1;
    const hgt = container.clientHeight || 1;
    return w / hgt;
  }

  function applyOrtho() {
    const aspect = currentAspect();
    const halfH = baseViewH / 2;
    camera.left = -halfH * aspect;
    camera.right = halfH * aspect;
    camera.top = halfH;
    camera.bottom = -halfH;
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[options.quality].pixelRatio));
    applyOrtho();
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
      // dispatch queued effects
      while (pendingEffects.length) spawnBurst(pendingEffects.shift());
      updateParticles(dt);
    }

    renderer.render(scene, camera);
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
    for (const g of [boxGeo, ringGeo, discGeo, bodyGeo, headGeo, goodGeo, pGeo]) g.dispose();
    pMat.dispose();
    renderer.dispose();
    if (canvas.parentNode === container) container.removeChild(canvas);
  }

  // -------------------------------------------------------------------------
  // Init + public API
  // -------------------------------------------------------------------------

  setQuality(options.quality);
  resize();
  if (options.camera !== FRAMING.defaultPreset) setCamera(options.camera);
  resetCamera();

  return {
    buildMarket,
    syncState,
    setHighlight,
    setQuality,
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
