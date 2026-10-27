// Key extraction for the i18n coverage test (run directly to list the keys).
// Keys are the US-English source strings: literal T('…') / N('…') calls in
// src/*.js and native/*.ts and the content tables' display fields
// (stage, lesson and challenge names and blurbs, lesson steps, departments,
// themes, achievements, practice paces).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { journeyStages, tutorialStages, challengeStages, DEPARTMENT_TYPES, THEMES } from '../src/content.js';
import { ACHIEVEMENTS } from '../src/session.js';

const ROOT = new URL('..', import.meta.url).pathname;
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1');
const SKIP = new Set(['i18n.js', 'sh-strings.js', 'i18n.ts']);

export function sourceKeys() {
  const keys = new Set();
  const call = /(?<![\w.$])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  const ternary = /(?<![\w.$])T\([^'"\n]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g;
  const ternary2 = /(?<![\w.$])T\([^'"\n]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g;
  for (const dir of ['src', 'native']) {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (!/\.(js|ts)$/.test(f) || SKIP.has(f)) continue;
      const src = readFileSync(join(ROOT, dir, f), 'utf8');
      for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
      for (const m of src.matchAll(ternary)) { keys.add(m[1]); keys.add(m[2]); }
      for (const m of src.matchAll(ternary2)) { keys.add(m[1]); keys.add(m[2]); }
    }
  }
  return keys;
}

export function contentKeys() {
  const keys = new Set();
  const add = (...v) => v.forEach((s) => { if (typeof s === 'string' && s) keys.add(s); });
  for (const s of journeyStages()) add(s.name, s.blurb);
  for (const t of tutorialStages()) { add(t.name, t.blurb); for (const st of t.tutorial.steps) add(st.text); }
  for (const c of challengeStages()) add(c.name, c.blurb);
  for (const d of Object.values(DEPARTMENT_TYPES)) add(d.name);
  for (const t of THEMES) add(t.name);
  for (const a of ACHIEVEMENTS) add(a.name, a.desc);
  add('Relaxed', 'Standard', 'Intense'); // practice paces ("Practice — Relaxed")
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);

if (process.argv[1] && process.argv[1].endsWith('i18n-keys.mjs')) console.log(JSON.stringify([...ALL], null, 1));
