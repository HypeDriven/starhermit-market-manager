// Seeded random streams. Pure, serializable, deterministic.
// mulberry32: small, fast, good-enough distribution for gameplay.

export function hashString(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createRng(seed) {
  let state = (seed >>> 0) || 1;
  return {
    get state() { return state >>> 0; },
    set state(v) { state = (v >>> 0) || 1; },
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(min, max) { // inclusive both ends
      return min + Math.floor(this.next() * (max - min + 1));
    },
    pick(arr) {
      return arr[Math.floor(this.next() * arr.length)];
    },
    chance(p) {
      return this.next() < p;
    },
  };
}

// Stable stringify for hashing: sorts object keys recursively.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function hashState(value) {
  return hashString(stableStringify(value)).toString(16).padStart(8, '0');
}
