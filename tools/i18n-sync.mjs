// Keeps src/locales/*.js in step with the client's keys (tests/i18n-keys.mjs):
// drops rows no source uses any more, and adds missing keys from a sibling
// game's dictionaries (the same English text, already translated there) to the
// primary block of each file (es-419, fr-FR, de-DE, pt-BR, it-IT). Prints keys
// it could not find. Run after adding strings, then npm test.
//   node tools/i18n-sync.mjs [SIBLING_GAME_DIR...]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALL } from '../tests/i18n-keys.mjs';

const root = new URL('..', import.meta.url).pathname;
const siblings = process.argv.slice(2).length ? process.argv.slice(2) : ['../letter-trails'];
const FILES = { 'es.js': ['es-419', 'ES_419'], 'de.js': ['de-DE', 'default'], 'fr.js': ['fr-FR', 'FR_FR'], 'pt.js': ['pt-BR', 'default'], 'it.js': ['it-IT', 'default'] };
const found = [];
for (const dir of siblings) {
  const p = join(resolve(root, dir), 'src', 'i18n.js');
  if (existsSync(p)) found.push((await import(pathToFileURL(p).href)).DICTS);
}
const lookup = (loc, key) => { for (const d of found) if (d[loc] && typeof d[loc][key] === 'string') return d[loc][key]; return null; };
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const unq = (s) => s.slice(1, -1).replace(/\\(['\\])/g, '$1');
for (const f of ['es.js', 'de.js', 'fr.js', 'pt.js', 'it.js', 'en-GB.js']) {
  const p = join(root, 'src/locales', f);
  let src = readFileSync(p, 'utf8');
  src = src.split('\n').filter((line) => {
    const m = line.match(/^\s*('(?:[^'\\]|\\.)*')\s*:/);
    return !m || ALL.has(unq(m[1]));
  }).join('\n');
  if (FILES[f]) {
    const [loc, name] = FILES[f];
    const mod = await import(pathToFileURL(p).href + `?v=${Date.now()}`);
    const have = mod[name];
    const add = [];
    for (const key of ALL) {
      if (Object.prototype.hasOwnProperty.call(have, key)) continue;
      const t = lookup(loc, key);
      if (t == null) { console.log(`missing ${loc}: ${key}`); continue; }
      add.push(`  ${q(key)}: ${q(t)},`);
    }
    if (add.length) {
      const head = name === 'default' ? src.indexOf('export default {') : src.indexOf(`export const ${name} = {`);
      const end = src.indexOf('\n};', head);
      src = src.slice(0, end) + '\n' + add.join('\n') + src.slice(end);
    }
    console.log(`${f}: +${add.length}`);
  }
  writeFileSync(p, src);
}
