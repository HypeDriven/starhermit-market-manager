// The market on starhermit:scene, as the browser build's src/render.js drew
// it with three.js r160: a bright isometric tabletop market from procedural
// geometry only — the tiled floor (seeded per-tile tints), plaster walls, the
// entrance arch, stockroom crates, shelf units with awnings in their
// department's colour and goods that fill with stock, tarps over locked
// departments, checkout counters, customers walking their paths and queueing
// at the checkout slots with shrinking patience rings, the hired stocker and
// cashier, planters outside the walls, ambient motes, coin / pop / puff /
// confetti bursts, shelf flashes, the hover ring and lift, the pulsing
// legal-target rings, the win shake, and the orthographic camera framed into
// the band the HUD leaves (setViewOffset), with its isometric / high / low
// presets, spring transitions, drag to pan and the wheel to zoom.
//
// From three.js r160 (engine.minor 26): light intensities and the fitted shadow box as
// the page set them; the post chain (GTAOPass, UnrealBloomPass, the
// GradeShader before the output, SMAA / FXAA / MSAA) is renderer.ao / bloom /
// grade (linear) / antialias. The
// render loop, pixel ratio, adaptive resolution and the frame-rate readout
// are the runtime's. The procedural canvas textures are painted with
// starhermit:canvas exactly as before. Gameplay truth comes only from the
// rules' snapshots; this module never changes game state. Picks are
// returned to main.ts, which turns them into commands as main.js onPick did.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CapsuleGeometry, CircleGeometry,
  Color, ConeGeometry, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, OrthographicCamera, PlaneGeometry, PMREMGenerator, Points, PointsMaterial,
  Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace, SphereGeometry, Vector3, pointerToNdc, renderer, scene,
  type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { Rules, type Config, type GameEvent, type State, type Theme } from "./game.ts";
import { PARTICLE_CAP, type Look } from "./quality.ts";

const PI = Math.PI;
// ---------------------------------------------------------------------------------------------
// Authored constants (render.js; no magic numbers inline below)
// ---------------------------------------------------------------------------------------------
const FRAMING = {
  // camera presets: dir = offset direction from focus, dist = dolly distance
  presets: {
    isometric: { dir: [1, 0.9, 1], dist: 26 },
    high: { dir: [0.35, 1.65, 0.35], dist: 28 },
    low: { dir: [1, 0.45, 1], dist: 24 },
  } as Record<string, { dir: [number, number, number]; dist: number }>,
  defaultPreset: "isometric",
  fitWidthPerTile: 0.707, // |dot(tile axis, screen right)|
  fitHeightPerTile: 0.38, // vertical compression at iso tilt
  fitPadX: 2.0,
  fitPadY: 2.4,
  zoomMin: 0.65,
  zoomMax: 2.4,
  panMargin: 3.0,
  springFreq: 1.6,
  near: 0.1,
  far: 120,
};
// Lighting / look. `env*` apply only with reflections on; the hemisphere fill is lowered then.
const LOOK = {
  hemiIntensity: 0.55,
  hemiIntensityWithEnv: 0.3,
  envIntensity: 0.32,
  keyDir: [-0.55, 1.45, 0.95] as [number, number, number],
  propCount: 10,
  motes: 70,
  bloom: { strength: 0.3, radius: 0.35, threshold: 0.92 },
  hdrBoost: 2.4,
  vignette: 0.2,
  idleBob: 0.028,
};
// Gameplay accent palettes per colour-vision mode: `dept` cycles over departments; `patience` is [ok, warn, low].
const PALETTES: Record<string, { dept: number[]; patience: [number, number, number] }> = {
  none: { dept: [0xe8743b, 0x53a548, 0x4a90d9, 0xd96ab0, 0x9a6ad9], patience: [0x53d769, 0xf7c948, 0xe23e3e] },
  deuteranopia: { dept: [0xd9822b, 0x3aa0c9, 0x2f6fd0, 0xd9c53a, 0x8a7bd8], patience: [0x2fa8d8, 0xf0c93a, 0xd95f02] },
  protanopia: { dept: [0xc9a227, 0x3aa0c9, 0x2f6fd0, 0x6fbf9a, 0x8a7bd8], patience: [0x2fa8d8, 0xf0c93a, 0xc9722b] },
  tritanopia: { dept: [0xd94f3d, 0x2fb5c9, 0x35c4b5, 0xd98aa0, 0x7a7ad9], patience: [0x35c4b5, 0xf2e13a, 0xd94f3d] },
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
  flashTime: 0.45,
  customerLerpMs: 150,
  shakeAmp: 0.14,
  shakeDecay: 2.6,
  hoverLift: 0.09,
  hoverEmissive: 0.35,
  ringY: 0.62,
  tapMaxDistPx: 8,
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

export interface Pick { kind: "display" | "checkout" | "department" | "floor"; id?: string; x?: number; y?: number }
export interface Target { kind: string; id?: string; x?: number; y?: number }

// ---------------------------------------------------------------------------------------------
// Small helpers (mulberry32 so decoration matches config.seed replays)
// ---------------------------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashId(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** Critically damped spring step (semi-implicit Euler), scalar. */
function springStep(cur: number, vel: number, target: number, freqHz: number, dt: number): [number, number] {
  const w = 2 * PI * freqHz;
  const accel = w * w * (target - cur) - 2 * w * vel;
  const nv = vel + accel * dt;
  return [cur + nv * dt, nv];
}
function disposeObject(root: Object3D): void {
  root.traverse((obj) => {
    const m = obj as Mesh;
    if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
    if (m.material) for (const x of Array.isArray(m.material) ? m.material : [m.material]) x.dispose();
  });
}

// ---------------------------------------------------------------------------------------------
// Procedural textures (canvas-drawn once, near-white so they multiply the material colours)
// ---------------------------------------------------------------------------------------------
type Paint = (g: OffscreenCanvasRenderingContext2D, n: number, rnd: () => number) => void;
function canvasTexture(size: number, draw: Paint, repeat = 1): Texture {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext("2d");
  draw(g, size, mulberry32(size * 7919 + repeat));
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}
function speckle(g: OffscreenCanvasRenderingContext2D, size: number, rnd: () => number, n: number, lo: number, hi: number, r = 1.5): void {
  for (let i = 0; i < n; i++) {
    const v = Math.round(lo + rnd() * (hi - lo));
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rnd() * size, rnd() * size, r, r);
  }
}
/** A texture at the budget's size factor, drawn in its 1× pixel units (the same look at every size). */
function scaled(base: number, k: number, draw: Paint): Paint {
  const size = Math.max(16, Math.round(base * k));
  return (g, _n, rnd) => { g.scale(size / base, size / base); draw(g, base, rnd); };
}
interface Textures { tile: Texture; grass: Texture; wall: Texture; wood: Texture; awning: Texture; dot: Texture }
function makeTextures(k: number, dot: Texture | null): Textures {
  const sz = (base: number): number => Math.max(16, Math.round(base * k));
  return {
    tile: canvasTexture(sz(128), scaled(128, k, (g, n, rnd) => {
      g.fillStyle = "#f7f7f7"; g.fillRect(0, 0, n, n);
      speckle(g, n, rnd, 900, 225, 255);
      const grad = g.createLinearGradient(0, 0, n, n);
      grad.addColorStop(0, "rgba(255,255,255,0.55)");
      grad.addColorStop(0.5, "rgba(255,255,255,0)");
      grad.addColorStop(1, "rgba(0,0,0,0.08)");
      g.fillStyle = grad; g.fillRect(0, 0, n, n);
      g.fillStyle = "rgba(255,255,255,0.7)";
      g.fillRect(4, 4, n - 8, 3); g.fillRect(4, 4, 3, n - 8);
      g.fillStyle = "rgba(90,70,50,0.22)";
      g.fillRect(4, n - 7, n - 8, 3); g.fillRect(n - 7, 4, 3, n - 8);
      g.strokeStyle = "#b9ad9c"; g.lineWidth = 5; g.strokeRect(0, 0, n, n);
    })),
    grass: canvasTexture(sz(256), scaled(256, k, (g, n, rnd) => {
      g.fillStyle = "#eaeaea"; g.fillRect(0, 0, n, n);
      for (let i = 0; i < 90; i++) {
        const v = Math.round(205 + rnd() * 50);
        g.fillStyle = `rgba(${v},${v},${v},0.5)`;
        g.beginPath(); g.arc(rnd() * n, rnd() * n, 6 + rnd() * 18, 0, PI * 2); g.fill();
      }
      g.lineWidth = 1.4;
      for (let i = 0; i < 1600; i++) {
        const x = rnd() * n, y = rnd() * n, v = Math.round(170 + rnd() * 85);
        g.strokeStyle = `rgb(${v},${v},${v})`;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y - 2 - rnd() * 4); g.stroke();
      }
    })),
    wall: canvasTexture(sz(128), scaled(128, k, (g, n, rnd) => {
      g.fillStyle = "#f2f2f2"; g.fillRect(0, 0, n, n);
      speckle(g, n, rnd, 1400, 215, 255, 2);
      g.fillStyle = "rgba(80,60,40,0.12)";
      for (let y = 0; y < n; y += 32) g.fillRect(0, y, n, 2);
      g.fillStyle = "rgba(255,255,255,0.6)";
      g.fillRect(0, 0, n, 4);
    })),
    wood: canvasTexture(sz(128), scaled(128, k, (g, n, rnd) => {
      g.fillStyle = "#f0f0f0"; g.fillRect(0, 0, n, n);
      for (let y = 0; y < n; y += 2) {
        const v = Math.round(215 + Math.sin(y * 0.35 + rnd() * 2) * 18 + rnd() * 12);
        g.fillStyle = `rgba(${v},${v},${v},0.8)`;
        g.fillRect(0, y, n, 2);
      }
      g.fillStyle = "rgba(70,45,25,0.35)";
      for (let y = 0; y < n; y += 32) g.fillRect(0, y, n, 2);
    })),
    awning: canvasTexture(sz(64), scaled(64, k, (g, n) => {
      for (let x = 0; x < n; x += 16) {
        g.fillStyle = (x / 16) % 2 ? "#b8b8b8" : "#ffffff";
        g.fillRect(x, 0, 16, n);
      }
      g.fillStyle = "rgba(0,0,0,0.12)"; g.fillRect(0, n - 6, n, 6);
    })),
    // Soft round sprite for particles and motes.
    dot: dot ?? canvasTexture(64, (g, n) => {
      const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.55, "rgba(255,255,255,0.9)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad; g.fillRect(0, 0, n, n);
    }),
  };
}
/** Vertical sky gradient for the backdrop (detailed looks). */
function skyTexture(top: Color, bottom: Color): Texture {
  const c = new OffscreenCanvas(4, 256);
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, `#${top.getHex().toString(16).padStart(6, "0")}`);
  grad.addColorStop(1, `#${bottom.getHex().toString(16).padStart(6, "0")}`);
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------------------------
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
scene.background = new Color(0xfdf3e3); // the page colour behind the menus before a market exists

const camera = new OrthographicCamera(-1, 1, 1, -1, FRAMING.near, FRAMING.far);
camera.layers.enable(1); // layer 1 = particles (never raycast)
scene.add(camera);
const marketGroup = new Group();
scene.add(marketGroup);
const fxGroup = new Group();
scene.add(fxGroup);

const hemi = new HemisphereLight(0xffffff, 0x777777, LOOK.hemiIntensity);
scene.add(hemi);
const keyLight = new DirectionalLight(0xffffff, 1.0);
keyLight.position.set(6, 10, 4);
keyLight.shadow.bias = -0.0006;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);
scene.add(keyLight.target);

const options = { reducedMotion: false, colorblind: "none", camera: FRAMING.defaultPreset };
let look: Look | null = null;
let envTexture: Texture | null = null;
let tex: Textures | null = null;
let skyTex: Texture | null = null;
const skyColor = new Color(0xffffff);

let theme: Theme | null = null;
let grid = { w: 0, h: 0 };
let built = false;
let paused = false;

interface View {
  group: Group; mats: (MeshStandardMaterial | MeshLambertMaterial)[]; level: number; lift: number; liftTarget?: number; baseY: number; flash: number;
  goods?: InstancedMesh; goodsMat?: MeshStandardMaterial | MeshLambertMaterial; awningMat?: MeshStandardMaterial | MeshLambertMaterial;
  tarp?: Mesh; hit?: Mesh; deptId?: string; deptIndex?: number; capacity?: number; headMat?: MeshStandardMaterial | MeshLambertMaterial;
}
interface Person { group: Group; bodyMat: Material; headMat: Material }
interface CustomerView extends Person { ring: Mesh; ringMat: MeshBasicMaterial; fromX: number; fromZ: number; toX: number; toZ: number; lerpT: number }

const displayViews = new Map<string, View>();
const checkoutViews = new Map<string, View>();
const deptTarps = new Map<string, Mesh[]>();
const customerViews = new Map<string, CustomerView>();
const staffViews: Record<string, Person> = {};
let interactive: Object3D[] = [];
let floorIndexToXY: { x: number; y: number }[] = [];
let tileVariations: [number, number, number][] = [];
let floorMesh: InstancedMesh | null = null;
let wallMesh: InstancedMesh | null = null;
let groundMesh: Mesh | null = null;
let archMats: (MeshStandardMaterial | MeshLambertMaterial)[] = [];
let discMesh: InstancedMesh | null = null;
let propsGroup: Group | null = null;

let lastState: State | null = null;
let lastConfig: Config | null = null;
const pendingEffects: { type: string; x: number; z: number; color?: number }[] = [];
let shake = 0;
const shakeOffset = new Vector3();
let elapsed = 0;

// camera spring state
const camFocus = { x: 0, z: 0, vx: 0, vz: 0, tx: 0, tz: 0 };
const camPos = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
let zoomCur = 1, zoomVel = 0, zoomTarget = 1;
let baseViewH = 10;
/** The window and the HUD bands over it (window pixels): the room is framed between them. */
const viewport = { w: 1, h: 1, top: 0, bottom: 0 };

// hover / highlight
let hoveredPick: Pick | null = null;
let hoverView: View | null = null;
const highlightMarkers: Mesh[] = [];
let highlightTargets: Target[] | null = null;

// shared geometries (never disposed during market rebuilds); the round ones follow the budget's LOD.
const seg = (n: number, min = 3): number => Math.max(min, Math.round(n * (look ? look.budget.segments : 1)));
const boxGeo = new BoxGeometry(1, 1, 1);
const goodGeo = new BoxGeometry(0.16, 0.16, 0.16);
let ringGeo: BufferGeometry, discGeo: BufferGeometry, bodyGeo: BufferGeometry, headGeo: BufferGeometry;
function buildRoundGeometry(): void {
  for (const g of [ringGeo, discGeo, bodyGeo, headGeo]) if (g) g.dispose();
  ringGeo = new RingGeometry(0.3, 0.42, seg(32, 12));
  discGeo = new CircleGeometry(0.42, seg(24, 10));
  bodyGeo = new CapsuleGeometry(DIM.personR, DIM.personH, seg(4, 2), seg(10, 6));
  headGeo = new SphereGeometry(DIM.headR, seg(10, 6), seg(8, 5));
  for (const g of [ringGeo, discGeo, bodyGeo, headGeo]) g.userData.shared = true;
}
buildRoundGeometry();
for (const g of [boxGeo, goodGeo]) g.userData.shared = true;

const hoverMarker = makeRingMarker(0xffffff);
fxGroup.add(hoverMarker);

// -- palette / colour helpers ----------------------------------------------------------------
const palette = () => PALETTES[options.colorblind] ?? PALETTES.none!;
function deptColor(index: number): number { const cols = palette().dept; return cols[index % cols.length]!; }
function patienceColor(frac: number): number {
  const [ok, warn, low] = palette().patience;
  return frac > 0.5 ? ok : frac > 0.25 ? warn : low;
}
function worldFromTile(x: number, y: number): { wx: number; wz: number } {
  return { wx: x - (grid.w - 1) / 2, wz: y - (grid.h - 1) / 2 };
}

type Lit = MeshStandardMaterial | MeshLambertMaterial;
interface MatParams { color?: Color | number; roughness?: number; metalness?: number; envMapIntensity?: number }
/** Material class per budget: Lambert (Low), Standard (Balanced), Physical for the clear-coated pieces (High/Ultra). */
function lambert(params: MatParams): MeshLambertMaterial {
  const { roughness: _r, metalness: _m, envMapIntensity: _e, ...rest } = params;
  return new MeshLambertMaterial(rest);
}
function std(color: Color | number, extra: MatParams = {}): Lit {
  const params = { color, roughness: 0.85, metalness: 0.0, envMapIntensity: LOOK.envIntensity, ...extra };
  return look?.budget.material === "lambert" ? lambert(params) : new MeshStandardMaterial(params);
}
function phys(color: Color | number, extra: MatParams = {}): Lit {
  const params = { color, roughness: 0.5, metalness: 0.0, envMapIntensity: LOOK.envIntensity, ...extra };
  if (look?.budget.material === "lambert") return lambert(params);
  if (look?.budget.material === "standard") return new MeshStandardMaterial(params);
  return new MeshPhysicalMaterial({ clearcoatRoughness: 0.25, ...params });
}
/** Detail: surface texture and clear coat ride on the material and follow the look. */
function withDetail(mat: Lit, map: Texture | null, clearcoat = 0): Lit {
  mat.userData.detail = { map, clearcoat };
  applyDetailTo(mat);
  return mat;
}
function applyDetailTo(mat: Material): void {
  const d = mat.userData.detail as { map: Texture | null; clearcoat: number } | undefined;
  if (!d) return;
  const on = !!look?.detailed;
  const m = mat as Lit;
  const map = on ? d.map : null;
  if (m.map !== map) m.map = map;
  if (m instanceof MeshPhysicalMaterial) {
    const cc = on ? d.clearcoat : 0;
    if (m.clearcoat !== cc) m.clearcoat = cc;
  }
}
/** Marker / highlight colours glow a little while bloom is on. */
function hdrColor<M extends MeshBasicMaterial>(mat: M, hex: number): M {
  mat.userData.hdrHex = hex;
  mat.color.setHex(hex);
  if (look?.bloom) mat.color.multiplyScalar(1.6);
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Market construction
// ---------------------------------------------------------------------------------------------
function clearMarket(): void {
  disposeObject(marketGroup);
  marketGroup.clear();
  displayViews.clear();
  checkoutViews.clear();
  deptTarps.clear();
  customerViews.clear();
  for (const k of Object.keys(staffViews)) delete staffViews[k];
  interactive = [];
  floorIndexToXY = [];
  tileVariations = [];
  floorMesh = wallMesh = discMesh = null;
  archMats = [];
  propsGroup = null;
  hoverView = null;
  hoveredPick = null;
  hoverMarker.visible = false;
  setHighlight(null);
}

/** render.js buildMarket: a full (re)build from a snapshot, the stage config and a theme. */
export function buildMarket(state: State, config: Config | null, themeObj: Theme | null): void {
  if (!state || !state.grid || !look) return;
  lastConfig = config;
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
  const discSpots: [number, number, number][] = [];
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
  applyEnv();
  built = true;
}

function buildGround(): void {
  if (groundMesh) { scene.remove(groundMesh); disposeObject(groundMesh); }
  const size = Math.max(grid.w, grid.h) * 4 + 20;
  const mat = withDetail(std(theme ? theme.ground : 0x8fce7a, { roughness: 1 }), tex!.grass);
  tex!.grass.repeat.set(size / 4, size / 4);
  groundMesh = new Mesh(new PlaneGeometry(size, size), mat);
  groundMesh.rotation.x = -PI / 2;
  groundMesh.position.y = -DIM.floorH - 0.01;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
}

function buildFloor(state: State, deco: () => number): void {
  const spots: { x: number; y: number }[] = [];
  for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) if (state.grid.cells[y]![x]!.t !== Rules.TILE.WALL) spots.push({ x, y });
  const mat = withDetail(std(0xffffff, { roughness: 0.78 }), tex!.tile);
  floorMesh = new InstancedMesh(boxGeo, mat, spots.length);
  floorMesh.receiveShadow = true;
  const m = new Matrix4();
  const base = new Color(theme ? theme.tile : 0xf2e3c2);
  spots.forEach((s, i) => {
    const { wx, wz } = worldFromTile(s.x, s.y);
    m.makeScale(1, DIM.floorH, 1);
    m.setPosition(wx, -DIM.floorH / 2, wz);
    floorMesh!.setMatrixAt(i, m);
    // slight per-tile hue variation, seeded so replays match
    const v: [number, number, number] = [(deco() - 0.5) * 0.02, (deco() - 0.5) * 0.06, (deco() - 0.5) * 0.07];
    tileVariations.push(v);
    floorMesh!.setColorAt(i, base.clone().offsetHSL(v[0], v[1], v[2]));
    floorIndexToXY.push(s);
  });
  if (floorMesh.instanceColor) floorMesh.instanceColor.needsUpdate = true;
  floorMesh.userData.pick = { kind: "floor" };
  marketGroup.add(floorMesh);
  interactive.push(floorMesh);
}

function buildWalls(state: State): void {
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) if (state.grid.cells[y]![x]!.t === Rules.TILE.WALL) cells.push({ x, y });
  const base = new Color(theme ? theme.tile : 0xf2e3c2).multiplyScalar(0.72);
  const mat = withDetail(std(base, { roughness: 0.9 }), tex!.wall);
  wallMesh = new InstancedMesh(boxGeo, mat, Math.max(1, cells.length));
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  const m = new Matrix4();
  cells.forEach((s, i) => {
    const { wx, wz } = worldFromTile(s.x, s.y);
    m.makeScale(1, DIM.wallH, 1);
    m.setPosition(wx, DIM.wallH / 2, wz);
    wallMesh!.setMatrixAt(i, m);
  });
  wallMesh.count = cells.length;
  marketGroup.add(wallMesh);
}

function buildEntranceArch(state: State): void {
  const e = state.entrance;
  if (!e) return;
  // the wall neighbour tells which way the doorway faces
  let facing: [number, number] = [1, 0];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
    const nx = e.x + dx, ny = e.y + dy;
    const inGrid = nx >= 0 && ny >= 0 && nx < grid.w && ny < grid.h;
    if (inGrid && state.grid.cells[ny]![nx]!.t === Rules.TILE.WALL) { facing = [-dx, -dy]; break; }
  }
  const { wx, wz } = worldFromTile(e.x, e.y);
  const mat = withDetail(phys(theme ? theme.accent : 0xe8743b, { roughness: 0.55 }), null, 0.6);
  archMats.push(mat);
  const group = new Group();
  const postGeo = new BoxGeometry(0.12, 0.85, 0.12);
  const beamGeo = new BoxGeometry(0.12, 0.12, 0.8);
  const p1 = new Mesh(postGeo, mat), p2 = new Mesh(postGeo, mat), beam = new Mesh(beamGeo, mat);
  const off = 0.34;
  if (Math.abs(facing[0]) > 0) { // posts flank the walkway
    p1.position.set(0, 0.425, -off);
    p2.position.set(0, 0.425, off);
    beam.position.set(0, 0.85, 0);
  } else {
    p1.position.set(-off, 0.425, 0);
    p2.position.set(off, 0.425, 0);
    beam.rotation.y = PI / 2;
    beam.position.set(0, 0.85, 0);
  }
  for (const p of [p1, p2, beam]) { p.castShadow = true; group.add(p); }
  group.position.set(wx + facing[0] * 0.3, 0, wz + facing[1] * 0.3);
  marketGroup.add(group);
}

function buildStockroom(state: State, deco: () => number): void {
  const s = state.stockroom;
  if (!s) return;
  const { wx, wz } = worldFromTile(s.x, s.y);
  const group = new Group();
  const crateMat = withDetail(std(0xb08954, { roughness: 0.9 }), tex!.wood);
  for (const [ox, oy, oz] of [[-0.16, 0, -0.12], [0.18, 0, 0.1], [0.02, DIM.crate, -0.02]] as [number, number, number][]) {
    const crate = new Mesh(boxGeo, crateMat);
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

/** One display: counter base, two shelf boards, side posts, the awning strip and instanced goods. */
function buildDisplayView(state: State, d: State["displays"][number], deco?: () => number): View {
  const rng = deco || mulberry32(1);
  const deptIndex = Math.max(0, state.departments.findIndex((p) => p.id === d.deptId));
  const { wx, wz } = worldFromTile(d.x, d.y);
  const group = new Group();
  group.position.set(wx, 0, wz);
  const mats: Lit[] = [];
  const baseMat = std(0xe8dcc8);
  const base = new Mesh(boxGeo, baseMat);
  base.scale.set(0.86, DIM.shelfBaseH, 0.6);
  base.position.y = DIM.shelfBaseH / 2;
  base.castShadow = true;
  group.add(base);
  mats.push(baseMat);
  const boardMat = withDetail(std(0xcbb894), tex!.wood);
  mats.push(boardMat);
  for (const h of DIM.shelfBoards) {
    const board = new Mesh(boxGeo, boardMat);
    board.scale.set(0.9, 0.04, 0.5);
    board.position.y = h;
    board.castShadow = true;
    group.add(board);
  }
  for (const sx of [-0.42, 0.42]) {
    const post = new Mesh(boxGeo, boardMat);
    post.scale.set(0.05, DIM.shelfBoards[1]! + 0.12, 0.5);
    post.position.set(sx, (DIM.shelfBoards[1]! + 0.12) / 2, 0);
    group.add(post);
  }
  // awning strip in the department colour (recoloured on palette change)
  const awningMat = withDetail(std(deptColor(deptIndex), { roughness: 0.6 }), tex!.awning);
  mats.push(awningMat);
  const awning = new Mesh(boxGeo, awningMat);
  awning.scale.set(0.94, 0.06, 0.56);
  awning.position.y = DIM.shelfBoards[1]! + 0.14;
  awning.castShadow = true;
  group.add(awning);
  // goods: one small box per stock unit, spread over the two shelves
  const cap = Math.max(1, d.capacity);
  const goodsMat = withDetail(phys(0xffffff, { roughness: 0.45 }), null, 0.9);
  const goods = new InstancedMesh(goodGeo, goodsMat, cap);
  goods.castShadow = true;
  const m = new Matrix4();
  const goodColor = new Color(deptColor(deptIndex));
  const perShelf = Math.ceil(cap / DIM.shelfBoards.length);
  for (let i = 0; i < cap; i++) {
    const shelf = Math.floor(i / perShelf);
    const slot = i % perShelf;
    const x = -0.32 + (perShelf > 1 ? (slot / (perShelf - 1)) * 0.64 : 0);
    const z = (rng() - 0.5) * 0.24;
    m.identity();
    m.setPosition(x, DIM.shelfBoards[shelf]! + 0.1, z);
    goods.setMatrixAt(i, m);
    goods.setColorAt(i, goodColor.clone().offsetHSL((rng() - 0.5) * 0.05, 0, (rng() - 0.5) * 0.25));
  }
  if (goods.instanceColor) goods.instanceColor.needsUpdate = true;
  group.add(goods);
  // tarp for locked departments (also the department pick target)
  const tarp = new Mesh(boxGeo, std(0x8f9094, { roughness: 1 }));
  tarp.scale.set(0.98, 0.7, 0.7);
  tarp.position.y = 0.35;
  tarp.rotation.y = 0.06;
  tarp.castShadow = true;
  tarp.userData.pick = { kind: "department", id: d.deptId, x: d.x, y: d.y };
  group.add(tarp);
  // hidden hit box covering the whole shelf unit (raycast, never drawn)
  const hit = new Mesh(boxGeo, new MeshBasicMaterial({ color: 0xffffff }));
  hit.visible = false;
  hit.scale.set(1, 0.9, 0.8);
  hit.position.y = 0.45;
  hit.userData.pick = { kind: "display", id: d.id, x: d.x, y: d.y };
  hit.userData.hitbox = true;
  group.add(hit);
  interactive.push(hit, tarp);
  if (!deptTarps.has(d.deptId)) deptTarps.set(d.deptId, []);
  deptTarps.get(d.deptId)!.push(tarp);
  return { group, mats, goods, goodsMat, awningMat, tarp, hit, deptId: d.deptId, deptIndex, level: d.level, capacity: d.capacity, flash: 0, lift: 0, baseY: 0 };
}

function rebuildDisplayView(state: State, d: State["displays"][number]): void {
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
  if (hoverView === old) { hoverView = view; setViewHover(view, true); }
  updateDepartments(state);
  applyEnv();
}

function buildCheckoutView(c: State["checkouts"][number]): View {
  const { wx, wz } = worldFromTile(c.x, c.y);
  const group = new Group();
  group.position.set(wx, 0, wz);
  const mats: Lit[] = [];
  const counterMat = withDetail(phys(0xd8c9a8, { roughness: 0.7 }), null, 0.5);
  const counter = new Mesh(boxGeo, counterMat);
  counter.scale.set(0.9, DIM.counterH, 0.5);
  counter.position.y = DIM.counterH / 2;
  counter.castShadow = true;
  group.add(counter);
  mats.push(counterMat);
  const beltMat = withDetail(phys(0x3c4048, { roughness: 0.45 }), null, 0.4);
  const belt = new Mesh(boxGeo, beltMat);
  belt.scale.set(0.66, 0.04, 0.3);
  belt.position.set(-0.05, DIM.counterH + 0.02, 0);
  group.add(belt);
  mats.push(beltMat);
  const postMat = std(0x8a8f98, { metalness: 0.7, roughness: 0.3 });
  const post = new Mesh(boxGeo, postMat);
  post.scale.set(0.06, 0.34, 0.06);
  post.position.set(0.32, DIM.counterH + 0.17, -0.14);
  group.add(post);
  const headMat = std(theme ? theme.accent : 0xe8743b, { roughness: 0.5 });
  const head = new Mesh(boxGeo, headMat);
  head.scale.set(0.14, 0.1, 0.14);
  head.position.set(0.32, DIM.counterH + 0.38, -0.14);
  head.castShadow = true;
  group.add(head);
  mats.push(postMat, headMat);
  const hit = new Mesh(boxGeo, new MeshBasicMaterial({ color: 0xffffff }));
  hit.visible = false;
  hit.scale.set(1, 0.9, 0.8);
  hit.position.y = 0.45;
  hit.userData.pick = { kind: "checkout", id: c.id, x: c.x, y: c.y };
  hit.userData.hitbox = true;
  group.add(hit);
  interactive.push(hit);
  return { group, mats, headMat, level: c.level, lift: 0, baseY: 0, flash: 0 };
}

/** Subtle dark discs under furniture for grounding when shadows are off. */
function buildContactDiscs(spots: [number, number, number][]): void {
  if (!spots.length) return;
  const mat = new MeshBasicMaterial({ color: 0x1a1a22, transparent: true, opacity: 0.16, depthWrite: false });
  discMesh = new InstancedMesh(discGeo, mat, spots.length);
  const m = new Matrix4();
  const rot = new Matrix4().makeRotationX(-PI / 2);
  spots.forEach(([x, z, s], i) => {
    m.makeScale(s, s, s).premultiply(rot);
    m.setPosition(x, 0.012, z);
    discMesh!.setMatrixAt(i, m);
  });
  discMesh.material.opacity = look && look.shadows > 0 ? 0.1 : 0.18;
  marketGroup.add(discMesh);
}

function buildStaffFigures(state: State): void {
  if (state.stockroom) {
    const { wx, wz } = worldFromTile(state.stockroom.x, state.stockroom.y);
    staffViews.stocker = makePerson(0x2b7a78, wx + 0.55, wz + 0.15);
  }
  const c0 = state.checkouts[0];
  if (c0) {
    const { wx, wz } = worldFromTile(c0.x, c0.y);
    staffViews.cashier = makePerson(0x6a4a9a, wx, wz - 0.62);
  }
  for (const role of Object.keys(staffViews)) {
    staffViews[role]!.group.visible = false;
    marketGroup.add(staffViews[role]!.group);
  }
}

/** Decorative planters outside the walls (detailed looks). */
function buildProps(deco: () => number): void {
  propsGroup = new Group();
  propsGroup.visible = !!look?.detailed;
  marketGroup.add(propsGroup);
  const potMat = withDetail(phys(0xb56a4a, { roughness: 0.6 }), null, 0.4);
  const leafMat = std(0x4e8f4e, { roughness: 0.8 });
  const leafMat2 = std(0x62a85a, { roughness: 0.8 });
  const leafGeo = new ConeGeometry(0.18, 0.34, seg(7, 5));
  const topGeo = new ConeGeometry(0.13, 0.26, seg(7, 5));
  const count = Math.round(LOOK.propCount * (look ? look.budget.props : 1));
  for (let i = 0; i < count; i++) {
    const group = new Group();
    const pot = new Mesh(boxGeo, potMat);
    pot.scale.set(0.22, 0.18, 0.22);
    pot.position.y = 0.09;
    const leaf = new Mesh(leafGeo, leafMat);
    leaf.position.y = 0.36;
    const top = new Mesh(topGeo, leafMat2);
    top.position.y = 0.52;
    for (const m of [pot, leaf, top]) m.castShadow = true;
    group.add(pot, leaf, top);
    const side = Math.floor(deco() * 4);
    const along = (deco() - 0.5) * Math.max(grid.w, grid.h);
    const out = 1.3 + deco() * 0.8;
    const x = side === 0 ? along : side === 1 ? along : (grid.w / 2 + out) * (side === 2 ? 1 : -1);
    const z = side === 0 ? (grid.h / 2 + out) : side === 1 ? -(grid.h / 2 + out) : along;
    group.position.set(x, 0, z);
    group.rotation.y = deco() * PI;
    propsGroup.add(group);
  }
}

// -- people -----------------------------------------------------------------------------------
function makePerson(colorHex: number, wx: number, wz: number): Person {
  const group = new Group();
  const bodyMat = withDetail(phys(colorHex, { roughness: 0.6 }), null, 0.35);
  const body = new Mesh(bodyGeo, bodyMat);
  body.position.y = DIM.personH / 2 + DIM.personR;
  body.castShadow = true;
  const headMat = std(0xf2d3b3, { roughness: 0.8 });
  const head = new Mesh(headGeo, headMat);
  head.position.y = DIM.personH + DIM.personR * 2 + DIM.headR * 0.8;
  head.castShadow = true;
  group.add(body, head);
  group.position.set(wx, 0, wz);
  return { group, bodyMat, headMat };
}
function makeCustomerView(cust: State["customers"][number]): CustomerView {
  const hue = (hashId(cust.id) % 360) / 360;
  const color = new Color().setHSL(hue, 0.55, 0.55);
  const { wx, wz } = worldFromTile(cust.x, cust.y);
  const person = makePerson(color.getHex(), wx, wz);
  // patience ring, shown only while queued
  const ringMat = new MeshBasicMaterial({ color: patienceColor(1), transparent: true, opacity: 0.9, side: DoubleSide, depthWrite: false });
  const ring = new Mesh(new RingGeometry(0.16, 0.24, seg(24, 10)), ringMat);
  ring.rotation.x = -PI / 2;
  ring.position.y = FX.ringY;
  ring.visible = false;
  person.group.add(ring);
  marketGroup.add(person.group);
  applyEnvTo(person.group);
  return { ...person, ring, ringMat, fromX: wx, fromZ: wz, toX: wx, toZ: wz, lerpT: 1 };
}
function removeCustomerView(view: CustomerView): void {
  marketGroup.remove(view.group);
  disposeObject(view.group);
}

// ---------------------------------------------------------------------------------------------
// State reconciliation
// ---------------------------------------------------------------------------------------------
/** render.js syncState: reconcile the views to the latest snapshot; `events` since the last sync. */
export function syncState(state: State, events: readonly GameEvent[]): void {
  if (!state || !state.grid || !built && displayViews.size === 0 && !lastState) return;
  const first = !lastState;
  lastState = state;
  for (const d of state.displays) {
    let view = displayViews.get(d.id);
    if (!view) continue;
    if (view.level !== d.level || view.capacity !== d.capacity) {
      rebuildDisplayView(state, d);
      view = displayViews.get(d.id)!;
    }
    const dept = state.departments.find((p) => p.id === d.deptId);
    view.goods!.count = dept && dept.unlocked ? Math.max(0, Math.min(d.stock, d.capacity)) : 0;
  }
  updateDepartments(state);
  for (const role of Object.keys(staffViews)) {
    const s = state.staff[role as "stocker" | "cashier"];
    staffViews[role]!.group.visible = !!(s && s.hired);
  }
  // customers: create / update / remove, keyed by id
  const seen = new Set<string>();
  for (const cust of state.customers) {
    seen.add(cust.id);
    let view = customerViews.get(cust.id);
    if (!view) { view = makeCustomerView(cust); customerViews.set(cust.id, view); }
    // logical target: queued customers stand at queueSlot positions
    let lx = cust.x, ly = cust.y;
    if (cust.status === "queued") {
      const co = state.checkouts.find((c) => c.id === cust.checkoutId);
      if (co) {
        const slot = Rules.queueSlot(state, co, Math.max(0, co.queue.indexOf(cust.id)));
        lx = slot.x; ly = slot.y;
      }
    }
    const { wx, wz } = worldFromTile(lx, ly);
    if (wx !== view.toX || wz !== view.toZ) {
      if (options.reducedMotion) {
        view.fromX = view.toX = wx;
        view.fromZ = view.toZ = wz;
        view.lerpT = 1;
        view.group.position.x = wx;
        view.group.position.z = wz;
      } else {
        view.fromX = view.group.position.x;
        view.fromZ = view.group.position.z;
        view.toX = wx; view.toZ = wz;
        view.lerpT = 0;
      }
    }
    // patience ring: shrinks and reddens as patience drains
    const queued = cust.status === "queued";
    view.ring.visible = queued;
    if (queued) {
      const frac = Math.max(0, Math.min(1, cust.patienceMax > 0 ? cust.patience / cust.patienceMax : 0));
      view.ring.scale.setScalar(Math.max(0.15, frac));
      view.ringMat.color.setHex(patienceColor(frac));
    }
  }
  for (const [id, view] of customerViews) {
    if (!seen.has(id)) { removeCustomerView(view); customerViews.delete(id); }
  }
  for (const ev of events || []) queueEffect(state, ev, first);
}

function updateDepartments(state: State | null): void {
  for (const dept of state?.departments ?? []) for (const tarp of deptTarps.get(dept.id) || []) tarp.visible = !dept.unlocked;
  for (const view of displayViews.values()) view.awningMat!.color.setHex(deptColor(view.deptIndex!));
}

// -- effects ----------------------------------------------------------------------------------
function tileOf(state: State, kind: string, id: string | undefined): { wx: number; wz: number } | null {
  if (kind === "display") { const d = state.displays.find((x) => x.id === id); return d ? worldFromTile(d.x, d.y) : null; }
  if (kind === "checkout") { const c = state.checkouts.find((x) => x.id === id); return c ? worldFromTile(c.x, c.y) : null; }
  return null;
}
function queueEffect(state: State, ev: GameEvent, isBulkRebuild: boolean): void {
  switch (ev.kind) {
    case "served": { const p = tileOf(state, "checkout", ev.checkoutId); if (p) pendingEffects.push({ type: "coin", x: p.wx, z: p.wz }); break; }
    case "take": { const p = tileOf(state, "display", ev.displayId); if (p) pendingEffects.push({ type: "pop", x: p.wx, z: p.wz }); break; }
    case "restock": { const v = displayViews.get(ev.displayId!); if (v) v.flash = 1; break; }
    case "left-angry": { const p = tileOf(state, "checkout", ev.checkoutId); if (p) pendingEffects.push({ type: "puff", x: p.wx, z: p.wz }); break; }
    case "unlock":
      for (const d of state.displays) {
        if (d.deptId !== ev.deptId) continue;
        const v = displayViews.get(d.id);
        if (v) v.flash = 1;
        const p = worldFromTile(d.x, d.y);
        pendingEffects.push({ type: "puff", x: p.wx, z: p.wz, color: 0xfff2c8 });
      }
      break;
    case "terminal":
      if (ev.result === "won" && !isBulkRebuild) {
        pendingEffects.push({ type: "confetti", x: 0, z: 0 });
        if (!options.reducedMotion) shake = FX.shakeAmp;
      }
      break;
  }
}

// -- pooled particles -------------------------------------------------------------------------
const PMAX = FX.maxParticles * 3; // budget sparks ≤ 1.5 × level scaling ≤ 2
const pGeo = new BufferGeometry();
const pPos = new Float32Array(PMAX * 3).fill(-999);
const pCol = new Float32Array(PMAX * 3);
pGeo.setAttribute("position", new BufferAttribute(pPos, 3));
pGeo.setAttribute("color", new BufferAttribute(pCol, 3));
let pMat: PointsMaterial | null = null;
let points: Points | null = null;
interface Particle { alive: boolean; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; ttl: number; r: number; g: number; b: number }
const particles: Particle[] = [];
for (let i = 0; i < PMAX; i++) particles.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, ttl: 1, r: 1, g: 1, b: 1 });
let pNext = 0;
let pActive = 0;
const tmpColor = new Color();
// Ambient motes: slow warm specks drifting up through the market light (particles high; frozen out by reduced motion).
const MOTES = LOOK.motes * 2;
const mGeo = new BufferGeometry();
const mPos = new Float32Array(MOTES * 3);
const mSeed: [number, number, number, number][] = [];
{ const r = mulberry32(4242); for (let i = 0; i < MOTES; i++) mSeed.push([r(), r(), r(), r()]); }
mGeo.setAttribute("position", new BufferAttribute(mPos, 3));
let mMat: PointsMaterial | null = null;
let motes: Points | null = null;
function buildPoints(): void {
  pMat = new PointsMaterial({ size: FX.particleSize * 1.4, vertexColors: true, transparent: true, map: tex!.dot, opacity: 0.95, depthWrite: false, sizeAttenuation: true });
  points = new Points(pGeo, pMat);
  points.layers.set(1);
  points.frustumCulled = false;
  fxGroup.add(points);
  mMat = new PointsMaterial({ size: 0.07, color: 0xfff1c9, map: tex!.dot, transparent: true, opacity: 0.55, depthWrite: false, sizeAttenuation: true, blending: AdditiveBlending });
  motes = new Points(mGeo, mMat);
  motes.layers.set(1);
  motes.frustumCulled = false;
  motes.visible = false;
  fxGroup.add(motes);
}
function updateMotes(): void {
  if (!motes) return;
  motes.visible = look?.particles === "high" && !options.reducedMotion && grid.w > 0;
  if (!motes.visible) return;
  const hw = grid.w / 2, hh = grid.h / 2;
  const n = Math.min(MOTES, look!.budget.motes);
  mGeo.setDrawRange(0, n);
  for (let i = 0; i < n; i++) {
    const [a, b, c, d] = mSeed[i]!;
    const t = elapsed * (0.05 + c * 0.06) + d;
    mPos[i * 3] = (a - 0.5) * 2 * hw + Math.sin(elapsed * 0.6 + d * 9) * 0.25;
    mPos[i * 3 + 1] = (t % 1) * 1.6 + 0.1;
    mPos[i * 3 + 2] = (b - 0.5) * 2 * hh + Math.cos(elapsed * 0.5 + c * 9) * 0.25;
  }
  mGeo.getAttribute("position")!.needsUpdate = true;
}
function spawnParticle(x: number, y: number, z: number, vx: number, vy: number, vz: number, ttl: number, colorHex: number): void {
  const p = particles[pNext]!;
  pNext = (pNext + 1) % PMAX;
  if (!p.alive) pActive++;
  p.alive = true;
  p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
  p.life = 0; p.ttl = ttl;
  tmpColor.setHex(colorHex);
  p.r = tmpColor.r; p.g = tmpColor.g; p.b = tmpColor.b;
}
function spawnBurst(fx: { type: string; x: number; z: number; color?: number }): void {
  const k = look!.budget.sparks;
  const cap = Math.min(PMAX, Math.round(PARTICLE_CAP[look!.particles] * k));
  if (options.reducedMotion || pActive >= cap) return;
  const rand = Math.random;
  const emit = (count: number, colorFn: (i: number) => number, speed: number, up: number, ttl: number): void => {
    count = Math.max(1, Math.round(count * k));
    for (let i = 0; i < count && pActive < cap; i++) {
      const a = rand() * PI * 2;
      const s = speed * (0.4 + rand() * 0.6);
      spawnParticle(fx.x, 0.5, fx.z, Math.cos(a) * s, up * (0.6 + rand() * 0.8), Math.sin(a) * s, ttl * (0.7 + rand() * 0.6), colorFn(i));
    }
  };
  if (fx.type === "coin") emit(FX.coinCount, () => FX.coinColor, 0.7, 2.4, FX.burstLife);
  else if (fx.type === "pop") emit(FX.popCount, () => 0xffffff, 1.0, 1.4, FX.burstLife * 0.6);
  else if (fx.type === "puff") emit(FX.puffCount, () => fx.color || FX.puffColor, 0.8, 0.8, FX.burstLife);
  else if (fx.type === "confetti") emit(FX.confettiCount, (i) => palette().dept[i % palette().dept.length]!, 2.6, 4.2, FX.burstLife * 2.2);
}
function updateParticles(dt: number): void {
  if (pActive === 0 && !pendingEffects.length) return;
  for (let i = 0; i < PMAX; i++) {
    const p = particles[i]!;
    if (!p.alive) continue;
    p.life += dt;
    if (p.life >= p.ttl) { p.alive = false; pActive--; pPos[i * 3 + 1] = -999; continue; }
    p.vy += FX.gravity * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.y < 0.02) { p.y = 0.02; p.vy *= -0.3; p.vx *= 0.7; p.vz *= 0.7; }
    pPos[i * 3] = p.x; pPos[i * 3 + 1] = p.y; pPos[i * 3 + 2] = p.z;
    const fade = 1 - p.life / p.ttl;
    pCol[i * 3] = p.r * fade; pCol[i * 3 + 1] = p.g * fade; pCol[i * 3 + 2] = p.b * fade;
  }
  pGeo.getAttribute("position")!.needsUpdate = true;
  pGeo.getAttribute("color")!.needsUpdate = true;
}

// -- markers (the hover ring and the legal-target rings) ----------------------------------------
function makeRingMarker(colorHex: number): Mesh {
  const mat = hdrColor(new MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.85, side: DoubleSide, depthWrite: false }), colorHex);
  const mesh = new Mesh(ringGeo, mat);
  mesh.rotation.x = -PI / 2;
  mesh.position.y = 0.02;
  mesh.visible = false;
  return mesh;
}
/** null to clear, else [{kind, id}] targets to mark with pulsing rings (render.js setHighlight). */
export function setHighlight(targets: Target[] | null): void {
  highlightTargets = Array.isArray(targets) ? targets : null;
  for (const m of highlightMarkers) { fxGroup.remove(m); (m.material as Material).dispose(); }
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
function positionForTarget(t: Target): { x: number; z: number } | null {
  if (t.kind === "display") { const v = displayViews.get(t.id!); return v ? { x: v.group.position.x, z: v.group.position.z } : null; }
  if (t.kind === "checkout") { const v = checkoutViews.get(t.id!); return v ? { x: v.group.position.x, z: v.group.position.z } : null; }
  if (t.kind === "department") {
    const tarp = (deptTarps.get(t.id!) || []).find((x) => x.visible);
    if (!tarp) return null;
    const p = new Vector3();
    tarp.getWorldPosition(p);
    return { x: p.x, z: p.z };
  }
  if (t.kind === "floor" && typeof t.x === "number") { const { wx, wz } = worldFromTile(t.x, t.y!); return { x: wx, z: wz }; }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Theme / palette / look
// ---------------------------------------------------------------------------------------------
/** Backdrop: the flat sky colour, or (detailed looks) a sky-to-haze gradient. */
function applyBackground(): void {
  const sky = theme ? theme.sky : 0xffffff;
  const haze = theme ? theme.fog : 0xffffff;
  if (skyTex) { skyTex.dispose(); skyTex = null; }
  if (look?.detailed) {
    skyTex = skyTexture(new Color(sky).lerp(new Color(0xffffff), 0.25), new Color(haze));
    scene.background = skyTex;
  } else {
    scene.background = skyColor.setHex(sky);
  }
}
function applyThemeToScene(): void {
  if (!theme) return;
  applyBackground();
  scene.fog = new Fog(theme.fog, 34, 78);
  hemi.color.setHex(theme.sky);
  hemi.groundColor.setHex(theme.ground);
  keyLight.color.setHex(theme.key);
  keyLight.intensity = theme.intensity;
  if (groundMesh) (groundMesh.material as Lit).color.setHex(theme.ground);
  if (wallMesh) (wallMesh.material as Lit).color.setHex(theme.tile).multiplyScalar(0.72);
  for (const m of archMats) m.color.setHex(theme.accent);
  for (const v of checkoutViews.values()) v.headMat!.color.setHex(theme.accent);
}
/** render.js setTheme: the theme's sky, fog, lights and colours, the tiles re-tinted with their seeded variations. */
export function setTheme(themeObj: Theme | null): void {
  if (!themeObj) return;
  theme = themeObj;
  applyThemeToScene();
  if (floorMesh && floorMesh.instanceColor) {
    const base = new Color(theme.tile);
    for (let i = 0; i < tileVariations.length; i++) {
      const v = tileVariations[i]!;
      floorMesh.setColorAt(i, base.clone().offsetHSL(v[0], v[1], v[2]));
    }
    floorMesh.instanceColor.needsUpdate = true;
  }
}

function envMap(): Texture | null {
  if (!envTexture) {
    try { envTexture = new PMREMGenerator(renderer).fromScene((() => { const room = new RoomEnvironment(renderer); room.position.y = 0 /* pre-r183 page: room at origin (minor 32 default is -3.5) */; return room; })(), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTexture;
}
/** Reflections: the room environment for the whole scene (render.js scene.environment), per-material intensities kept. */
function applyEnv(): void {
  scene.environment = look?.reflections ? envMap() : null;
  // three r160 scaled scene.environment by each material's envMapIntensity (0.32 on every lit material
  // here); at engine.minor 20 (three r163+) the scene's environmentIntensity does it.
  scene.environmentIntensity = LOOK.envIntensity;
}
function applyEnvTo(_root: Object3D): void { /* scene.environment covers new objects */ }

/** render.js setGraphics: a new look applied live (textures, LOD, material class and props rebuild the market). */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  const pb = prev?.budget, b = next.budget;
  if (!tex || pb?.textures !== b.textures) {
    const dot = tex ? tex.dot : null;
    if (tex) for (const k of ["tile", "grass", "wall", "wood", "awning"] as const) tex[k].dispose();
    tex = makeTextures(b.textures, dot);
  }
  if (!points) buildPoints();
  if (pb && pb.segments !== b.segments) {
    buildRoundGeometry();
    for (const m of [hoverMarker, ...highlightMarkers]) m.geometry = ringGeo;
  }
  if (built && lastState && pb && (pb.textures !== b.textures || pb.segments !== b.segments || pb.material !== b.material || pb.props !== b.props)) {
    const targets = highlightTargets;
    buildMarket(lastState, lastConfig, theme);
    setHighlight(targets);
  }
  // shadows
  renderer.shadowMap.enabled = next.shadows > 0;
  keyLight.castShadow = next.shadows > 0;
  if (next.shadows > 0) keyLight.shadow.mapSize = next.shadows;
  if (discMesh) discMesh.material.opacity = next.shadows > 0 ? 0.1 : 0.18;
  // reflections (image-based lighting); the hemisphere fill backs off to compensate
  applyEnv();
  hemi.intensity = next.reflections ? LOOK.hemiIntensityWithEnv : LOOK.hemiIntensity;
  // detail, bloom-dependent colours, particle look
  scene.traverse((o) => {
    const m = (o as Mesh).material;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) {
      applyDetailTo(x);
      if (x.userData.hdrHex !== undefined) hdrColor(x as MeshBasicMaterial, x.userData.hdrHex as number);
    }
  });
  if (propsGroup) propsGroup.visible = next.detailed;
  applyBackground();
  pMat!.color.setScalar(next.bloom ? LOOK.hdrBoost : 1);
  mMat!.opacity = next.bloom ? 0.75 : 0.55;
  // the post chain (render.js buildPost)
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.85, radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: next.ao === "high" ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // r160 page: the r160 bloom model with the page's own strength (minor 30).
  renderer.bloom = next.bloom ? { model: "r160", strength: LOOK.bloom.strength, radius: LOOK.bloom.radius, threshold: LOOK.bloom.threshold, resolution: b.bloomRes } : null;
  // render.js GradeShader (linear, before the output): a 0.22 S-curve, +10 % saturation, warm highlights and
  // cool shadows split by a 0.15–0.75 smoothstep, the 0.2 vignette (0.38–0.9, y × 0.85).
  renderer.grade = next.grade ? {
    space: "linear", contrastCurve: "s", contrast: 0.22, saturation: 1.1, split: [0.15, 0.75], shadows: [0.97, 0.985, 1.04], highlights: [1.035, 1.0, 0.965], overRange: "keep",
    vignette: { amount: LOOK.vignette, inner: 0.38, outer: 0.9, scale: [1, 0.85] },
  } : null;
  renderer.antialias = next.antialias;
}

export function setReducedMotion(b: boolean): void {
  options.reducedMotion = b;
  if (b) {
    shake = 0;
    pendingEffects.length = 0;
    for (const v of customerViews.values()) v.group.position.y = 0;
    for (const v of Object.values(staffViews)) v.group.position.y = 0;
  }
}
export function setColorblind(mode: string): void {
  if (!PALETTES[mode] || mode === options.colorblind) return;
  options.colorblind = mode;
  updateDepartments(lastState);
  if (lastState) syncState(lastState, []); // refresh ring colours
}

// ---------------------------------------------------------------------------------------------
// Camera: presets, spring transitions, pan/zoom, shake, reset
// ---------------------------------------------------------------------------------------------
/** The HUD bands (window pixels) over the scene: the room is framed between them (render.js hudInsets). */
function updateFraming(): void {
  const w = Math.max(1, grid.w), h = Math.max(1, grid.h);
  const needW = (w + h) * FRAMING.fitWidthPerTile + FRAMING.fitPadX;
  const needH = (w + h) * FRAMING.fitHeightPerTile + FRAMING.fitPadY;
  const safeAspect = viewport.w / Math.max(120, viewport.h - viewport.top - viewport.bottom);
  baseViewH = Math.max(needH, needW / safeAspect);
  applyOrtho();
  // the key light over the room's bounding circle; its shadows reach past the planters just outside the walls
  const ext = Math.hypot(w, h) / 2 + 1.2;
  const dir = new Vector3(...LOOK.keyDir).normalize();
  const dist = ext * 2.5;
  keyLight.position.set(dir.x * dist, dir.y * dist, dir.z * dist);
  keyLight.target.position.set(0, 0, 0);
  const cam = keyLight.shadow.camera as OrthographicCamera;
  cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
  cam.near = Math.max(0.1, dist - ext * 1.6); cam.far = dist + ext * 1.6;
  cam.updateProjectionMatrix();
}
function applyOrtho(): void {
  const w = viewport.w, h = viewport.h;
  const safeH = Math.max(120, h - viewport.top - viewport.bottom);
  const aspect = w / safeH;
  const halfH = baseViewH / 2;
  camera.left = -halfH * aspect;
  camera.right = halfH * aspect;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.setViewOffset(w, safeH, 0, -viewport.top, w, h);
  camera.updateProjectionMatrix();
}
function presetTarget(): Vector3 {
  const p = FRAMING.presets[options.camera] ?? FRAMING.presets.isometric!;
  return new Vector3(...p.dir).normalize().multiplyScalar(p.dist);
}
export function setCamera(mode: string): void {
  if (!FRAMING.presets[mode] || mode === options.camera) return;
  options.camera = mode; // the spring picks the new target up
  updateFraming();
}
export function resetCamera(): void {
  camFocus.tx = 0; camFocus.tz = 0;
  zoomTarget = 1;
  const t = presetTarget();
  if (!built || options.reducedMotion) {
    camFocus.x = camFocus.tx; camFocus.z = camFocus.tz;
    camFocus.vx = camFocus.vz = 0;
    camPos.x = t.x; camPos.y = t.y; camPos.z = t.z;
    camPos.vx = camPos.vy = camPos.vz = 0;
    zoomCur = 1; zoomVel = 0;
  }
}
function updateCamera(dt: number): void {
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
  // win shake only, a translation of the camera (never of the picking ray)
  if (shake > 0.001 && !options.reducedMotion) {
    shakeOffset.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake * 0.6, (Math.random() - 0.5) * shake);
    shake *= Math.exp(-FX.shakeDecay * dt);
  } else {
    shakeOffset.set(0, 0, 0);
    shake = 0;
  }
  camera.position.add(shakeOffset);
}

// ---------------------------------------------------------------------------------------------
// Input: picks, hover, tap vs drag, wheel zoom (main.ts routes presses the UI did not take)
// ---------------------------------------------------------------------------------------------
const raycaster = new Raycaster();
raycaster.layers.set(0);
function effectivelyVisible(obj: Object3D | null): boolean {
  for (let o = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}
/** Window pixels → what is under them (render.js pickAt), the shake left out. */
export function pickAt(x: number, y: number): Pick | null {
  if (!built) return null;
  camera.position.sub(shakeOffset);
  camera.updateMatrixWorld();
  raycaster.setFromCamera(pointerToNdc(x, y), camera);
  const hits = raycaster.intersectObjects(interactive, false);
  camera.position.add(shakeOffset);
  camera.updateMatrixWorld();
  for (const hit of hits) {
    const o = hit.object;
    if (!effectivelyVisible(o.parent) || (!o.visible && !o.userData.hitbox)) continue; // hidden tarps etc.
    const data = o.userData.pick as Pick | undefined;
    if (!data) continue;
    if (data.kind === "floor") {
      const tile = floorIndexToXY[hit.instanceId ?? -1];
      if (!tile) continue;
      return { kind: "floor", x: tile.x, y: tile.y };
    }
    return { ...data };
  }
  return null;
}
/** A target's centre in window pixels (play scripts and the browser check tap there), or null. */
export function screenOf(t: Target): { x: number; y: number } | null {
  const pos = positionForTarget(t);
  if (!pos) return null;
  const v = new Vector3(pos.x, 0.4, pos.z).project(camera);
  return { x: (v.x + 1) / 2 * viewport.w, y: (1 - v.y) / 2 * viewport.h };
}
/** Each shelf unit's, checkout's and covered department's box on screen (window pixels), for ui.target:
 * screen readers name them and play scripts click them by name; the click itself is picked as any. */
export function targetRects(): { kind: string; id: string; x: number; y: number; width: number; height: number }[] {
  const out: { kind: string; id: string; x: number; y: number; width: number; height: number }[] = [];
  if (!built) return out;
  camera.updateMatrixWorld();
  const v = new Vector3();
  const box = (kind: string, id: string, cx: number, cz: number, hw: number, hd: number, h: number): void => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const dx of [-hw, hw]) for (const dz of [-hd, hd]) for (const y of [0, h]) {
      v.set(cx + dx, y, cz + dz).project(camera);
      const sx = (v.x + 1) / 2 * viewport.w, sy = (1 - v.y) / 2 * viewport.h;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    // the middle half of the box's outline: where a click surely lands on it
    const w = x1 - x0, hh = y1 - y0;
    out.push({ kind, id, x: x0 + w * 0.25, y: y0 + hh * 0.25, width: w * 0.5, height: hh * 0.5 });
  };
  const locked = new Set<string>();
  for (const [deptId, tarps] of deptTarps) if (tarps.some((t) => t.visible)) locked.add(deptId);
  for (const [id, view] of displayViews) {
    const p = view.group.position;
    if (locked.has(view.deptId!)) { if (!out.some((o) => o.kind === "department" && o.id === view.deptId)) box("department", view.deptId!, p.x, p.z, 0.49, 0.35, 0.7); }
    else box("display", id, p.x, p.z, 0.5, 0.4, 0.9);
  }
  for (const [id, view] of checkoutViews) box("checkout", id, view.group.position.x, view.group.position.z, 0.5, 0.4, 0.9);
  return out;
}
function samePick(a: Pick | null, b: Pick | null): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.id === b.id && a.x === b.x && a.y === b.y;
}
function viewForPick(pick: Pick | null): View | null {
  if (!pick) return null;
  if (pick.kind === "display") return displayViews.get(pick.id!) || null;
  if (pick.kind === "checkout") return checkoutViews.get(pick.id!) || null;
  return null;
}
function applyHover(pick: Pick | null): void {
  if (samePick(pick, hoveredPick)) return;
  if (hoverView) setViewHover(hoverView, false);
  hoveredPick = pick;
  hoverView = viewForPick(pick);
  if (hoverView) setViewHover(hoverView, true);
  const pos = pick ? positionForTarget(pick) : null;
  hoverMarker.visible = !!pos;
  if (pos) hoverMarker.position.set(pos.x, 0.02, pos.z);
}
function setViewHover(view: View, on: boolean): void {
  for (const m of view.mats) {
    m.emissive.setHex(on ? 0xffffff : 0x000000);
    m.emissiveIntensity = on ? FX.hoverEmissive : 0;
  }
  view.liftTarget = on ? FX.hoverLift : 0;
}
let pDown: { x: number; y: number; t: number; lastDx: number; lastDy: number } | null = null;
let dragging = false;
let lastHover: { x: number; y: number } | null = null;
/** A press on the scene (render.js onPointerDown); `now` in seconds. */
export function pointerDown(x: number, y: number, now: number): void {
  pDown = { x, y, t: now, lastDx: 0, lastDy: 0 };
  dragging = false;
}
/** Movement (render.js onPointerMove): drags pan, otherwise the hover follows. `hover` false for touch. */
export function pointerMove(x: number, y: number, now: number, hover = true): void {
  if (pDown) {
    const dx = x - pDown.x, dy = y - pDown.y;
    if (!dragging && (Math.hypot(dx, dy) > FX.tapMaxDistPx * scalePx || now - pDown.t > FX.tapMaxMs / 1000)) dragging = true;
    if (dragging) {
      panBy(dx - pDown.lastDx, dy - pDown.lastDy);
      pDown.lastDx = dx;
      pDown.lastDy = dy;
      applyHover(null);
      return;
    }
  }
  if (!hover) return;
  if (lastHover && lastHover.x === x && lastHover.y === y) return;
  lastHover = { x, y };
  applyHover(pickAt(x, y));
}
/** A release (render.js onPointerUp): the pick of a tap, else undefined. */
export function pointerUp(x: number, y: number, now: number): Pick | null | undefined {
  if (!pDown) return undefined;
  const wasDrag = dragging;
  const dx = x - pDown.x, dy = y - pDown.y;
  const held = now - pDown.t;
  pDown = null;
  dragging = false;
  if (!wasDrag && Math.hypot(dx, dy) <= FX.tapMaxDistPx * scalePx && held <= (FX.tapMaxMs + 500) / 1000) return pickAt(x, y);
  return undefined;
}
export function pointerCancel(): void { pDown = null; dragging = false; }
export function pointerLeave(): void { lastHover = null; applyHover(null); }
export function dragActive(): boolean { return !!pDown; }
function panBy(dxPx: number, dyPx: number): void {
  if (!viewport.h) return;
  const wpp = (baseViewH / zoomCur) / viewport.h; // world units per pixel
  const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  right.y = 0;
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
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
/** The wheel (render.js onWheel): zoom about the focus. */
export function wheel(deltaY: number): void {
  const factor = Math.exp(-deltaY * 0.0012);
  zoomTarget = Math.max(FRAMING.zoomMin, Math.min(FRAMING.zoomMax, zoomTarget * factor));
}

// ---------------------------------------------------------------------------------------------
// Per frame
// ---------------------------------------------------------------------------------------------
let scalePx = 1;
export function setPaused(b: boolean): void { paused = b; }
/** Whether the market draws (the menus show the page colour). */
export function setActive(on: boolean): void {
  renderer.camera = on ? camera : null;
  if (!on) { applyHover(null); setHighlight(null); }
}
/** Each frame: the window and its HUD bands (window pixels), then the camera, motion and effects (render.js frame). */
export function update(dt: number, width: number, height: number, top: number, bottom: number, scale: number): void {
  scalePx = scale;
  if (width > 0 && height > 0 && (viewport.w !== width || viewport.h !== height || Math.abs(viewport.top - top) > 0.5 || Math.abs(viewport.bottom - bottom) > 0.5)) {
    viewport.w = width; viewport.h = height; viewport.top = top; viewport.bottom = bottom;
    if (grid.w) updateFraming(); else applyOrtho();
  }
  const step = Math.min(0.05, Math.max(0.0001, dt));
  elapsed += step;
  updateCamera(step);
  if (paused) return;
  // customer logical-position interpolation
  const lerpWindow = FX.customerLerpMs / 1000;
  for (const view of customerViews.values()) {
    if (view.lerpT < 1) {
      view.lerpT = Math.min(1, view.lerpT + step / lerpWindow);
      const t = view.lerpT * view.lerpT * (3 - 2 * view.lerpT); // smoothstep
      view.group.position.x = view.fromX + (view.toX - view.fromX) * t;
      view.group.position.z = view.fromZ + (view.toZ - view.fromZ) * t;
    }
  }
  for (const view of displayViews.values()) updateLiftFlash(view, step);
  for (const view of checkoutViews.values()) updateLiftFlash(view, step);
  // highlight rings pulse; the hover ring stays steady
  const pulse = 1 + Math.sin(elapsed * 5) * 0.07;
  for (const m of highlightMarkers) {
    m.scale.setScalar(pulse);
    (m.material as MeshBasicMaterial).opacity = 0.6 + Math.sin(elapsed * 5) * 0.25;
  }
  // gentle idle bob for guests standing still and for staff
  if (!options.reducedMotion) {
    for (const [id, view] of customerViews) {
      const phase = (hashId(id) % 628) / 100;
      const target = view.lerpT >= 1 ? Math.abs(Math.sin(elapsed * 2.2 + phase)) * LOOK.idleBob : 0;
      view.group.position.y += (target - view.group.position.y) * Math.min(1, step * 10);
    }
    for (const [role, view] of Object.entries(staffViews)) view.group.position.y = Math.abs(Math.sin(elapsed * 1.6 + role.length)) * LOOK.idleBob * 0.6;
  }
  while (pendingEffects.length) spawnBurst(pendingEffects.shift()!);
  updateParticles(step);
  updateMotes();
}
function updateLiftFlash(view: View, dt: number): void {
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
/** Drops the market (back to the menus). */
export function clear(): void {
  clearMarket();
  if (groundMesh) { scene.remove(groundMesh); disposeObject(groundMesh); groundMesh = null; }
  lastState = null;
  built = false;
  grid = { w: 0, h: 0 };
  for (const p of particles) p.alive = false;
  pActive = 0;
  pPos.fill(-999);
  pendingEffects.length = 0;
}
