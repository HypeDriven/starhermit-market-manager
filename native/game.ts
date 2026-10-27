// The browser build's pure game modules, imported unchanged in what they
// decide (allowJs) and typed here with the shapes this client reads: the
// deterministic rules (src/rules.js: the market, commands, the 500 ms tick,
// scoring), the versioned content (src/content.js: 40 Journey stages, 4
// lessons, 5 challenges, practice paces, the daily market, themes), the
// session (src/session.js: command ids, undo, replay envelopes, progress,
// achievements, the game's settings) and the save document (src/store.js).
import * as RulesJs from "../src/rules.js";
import * as ContentJs from "../src/content.js";
import * as SessionJs from "../src/session.js";
import * as StoreJs from "../src/store.js";

export interface Cell { t: number; dept?: string }
export interface Display { id: string; deptId: string; x: number; y: number; level: number; capacity: number; stock: number; price: number; unitCost: number }
export interface Checkout { id: string; x: number; y: number; level: number; queue: string[] }
export interface Department { id: string; key: string; name: string; unlocked: boolean; unlockCost: number }
export interface Customer {
  id: string; x: number; y: number; status: string; targetDisplayId: string | null; checkoutId: string | null;
  patience: number; patienceMax: number;
}
export interface Goals { serve?: number; earn?: number; unlock?: number; maxAngry?: number }
export interface Allowed { restock: boolean; serve: boolean; hire: boolean; upgrade: boolean; unlock: boolean; undo: boolean; [k: string]: boolean }
export interface State {
  tick: number; phase: "active" | "won" | "lost"; terminalReason: string | null; seed: number;
  money: number; invalidCount: number; commandCount: number;
  grid: { w: number; h: number; cells: Cell[][] };
  entrance: { x: number; y: number } | null; stockroom: { x: number; y: number } | null;
  departments: Department[]; displays: Display[]; checkouts: Checkout[]; customers: Customer[];
  staff: Record<"stocker" | "cashier", { hired: boolean; cost: number }>;
  stats: { served: number; angry: number; emptyLeft: number; revenue: number; restockSpend: number; spawned: number };
  config: { maxTicks: number; moveLimit: number | null; goals: Goals; allowed: Allowed; initialStocked: boolean };
}
export interface GameEvent { kind: string; result?: string; displayId?: string; checkoutId?: string; deptId?: string; amount?: number; customerId?: string }
export interface Config {
  id: string; name: string; seed: number; map: string; goals: Goals; par?: { ticks: number }; theme: string; blurb?: string;
  tutorial?: { steps: { text: string; require?: Require }[] }; mastery?: boolean; maxTicks: number; moveLimit?: number | null;
  allowed: Allowed; initialStocked?: boolean; dailyDate?: string;
}
export interface Require { type: string; role?: string; targetKind?: string }
export interface Command { type: string; displayId?: string; checkoutId?: string; deptId?: string; role?: string; targetKind?: string; targetId?: string }
export interface Action extends Command { label: string }
export interface Verdict { ok: boolean; reason?: string }
export interface Score {
  components: { guests: number; revenue: number; satisfaction: number; departments: number; throughput: number; reserves: number };
  total: number; tiebreak: { goalComplete: boolean; invalidCount: number; ticksElapsed: number };
}
export interface Theme { id: string; name: string; sky: number; fog: number; ground: number; tile: number; accent: number; key: number; intensity: number }
export interface Achievement { key: string; name: string; desc: string }
export interface Progress {
  journey: Record<string, { won: boolean; best: number }>; challenges: Record<string, { won: boolean; best: number }>;
  daily: Record<string, { score: number; phase: string }>; tutorialsDone: string[]; achievements: Record<string, boolean>;
  guestsServedTotal: number; winStreak: number; bestStreak: number;
}
export interface Settings { theme: string | null; colorblind: string; leftHanded: boolean; haptics: boolean; camera: string; tutorialsDone: string[] }
export interface Session {
  readonly id: string; readonly mode: string; readonly config: Config; readonly state: State; readonly isOver: boolean; readonly allowUndo: boolean;
  on(kind: "terminal", cb: (e: { state: State; score: Score }) => void): Session;
  legalActions(): Action[];
  explain(cmd: Command): Verdict;
  issue(cmd: Command): { ok: boolean; reason?: string; events: GameEvent[] };
  stepTick(): GameEvent[];
  canUndo(): boolean;
  undo(): boolean;
  score(): Score;
  replayEnvelope(): { sessionId: string; durationMs: number; config: Config; result: { total: number } };
}
export type Doc = Record<string, unknown>;
export interface LocalEntry { name: string; score: number; date?: string; durationMs?: number; sessionId?: string; rank?: number }

interface RulesApi {
  TILE: Record<"FLOOR" | "WALL" | "ENTRANCE" | "STOCKROOM" | "DISPLAY" | "CHECKOUT", number>;
  TICK_MS: number;
  restockCost(d: Display): number;
  upgradeCost(s: State, kind: "display" | "checkout", target: Display | Checkout): number;
  queueSlot(s: State, c: Checkout, index: number): { x: number; y: number };
}
interface ContentApi {
  THEMES: Theme[];
  journeyStages(): Config[];
  tutorialStages(): Config[];
  challengeStages(): Config[];
  practiceConfig(pace: string): Config;
  dailyConfig(dateIso: string): Config;
  dailyDateUtc(now?: Date): string;
  themeById(id: string): Theme;
}
interface SessionApi {
  setKeyStore(s: { load(key: string): unknown; save(key: string, data: unknown): void }): void;
  saveKey(key: string, data: unknown): boolean;
  loadKey(key: string): unknown;
  loadSettings(): Settings;
  saveSettings(s: Settings): void;
  loadProgress(): Progress;
  saveProgress(p: Progress): void;
  recordResult(p: Progress, s: Session): Achievement[];
  createSession(o: { config: Config; mode: string; allowUndo: boolean }): Session;
  ACHIEVEMENTS: Achievement[];
}
interface StoreApi {
  normalize(raw: unknown): Doc;
  mergeDocs(remote: unknown, local: unknown): Doc;
  readForeign(text: string | null): Doc | null;
  keyStore(doc: Doc, onWrite: () => void): { load(key: string): unknown; save(key: string, data: unknown): void };
  recordLocal(boards: unknown, e: { name: string; score: number; date: string; durationMs: number; sessionId: string; dailyDate?: string }): { boards: Doc; rank: number };
  localEntries(boards: unknown, board: string, date: string | null): LocalEntry[];
}

export const Rules = RulesJs as unknown as RulesApi;
export const Content = ContentJs as unknown as ContentApi;
export const Sess = SessionJs as unknown as SessionApi;
export const Store = StoreJs as unknown as StoreApi;
