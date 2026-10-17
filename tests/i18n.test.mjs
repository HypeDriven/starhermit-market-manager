// Every player-facing string exists in all nine locales (node --test).
// Keys are the US-English source strings (see tests/i18n-keys.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, LOCALES, T, setLocale } from '../src/i18n.js';
import { graphicsStrings, pickLocale } from '../src/gfx-panel.js';
import { shStrings } from '../src/sh-strings.js';
import { ALL } from './i18n-keys.mjs';

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the key set is non-trivial', () => {
  assert.ok(ALL.size > 300, `only ${ALL.size} keys found`);
});

for (const locale of LOCALES.filter((l) => l !== 'en-US' && l !== 'en-GB')) {
  test(`${locale}: every key is translated with the same placeholders`, () => {
    const dict = DICTS[locale];
    const missing = [...ALL].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${missing.length} missing in ${locale}`);
    const bad = [...ALL].filter((k) => placeholders(dict[k]) !== placeholders(k));
    assert.deepEqual(bad, [], `placeholder mismatch in ${locale}`);
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const locale of LOCALES) {
    const stray = Object.keys(DICTS[locale]).filter((k) => !ALL.has(k));
    assert.deepEqual(stray, [], locale);
  }
});

test('Graphics and StarHermit strings exist for all nine locales', () => {
  for (const locale of LOCALES) {
    assert.equal(pickLocale(locale), locale);
    assert.ok(graphicsStrings(locale).legend, locale);
    assert.ok(shStrings([locale]).signIn, locale);
  }
});

test('T falls back to the key and fills placeholders; regional variants inherit', () => {
  setLocale('de-DE');
  assert.equal(T('Not a real key {x}', { x: 1 }), 'Not a real key 1');
  assert.equal(T('Checkout {n}', { n: 2 }), 'Kasse 2');
  setLocale('fr-CA');
  assert.equal(T('Score'), 'Pointage');
  assert.equal(T('Shelf'), 'Rayon'); // inherited from fr-FR
  setLocale('es-ES');
  assert.equal(T('Settings'), 'Ajustes');
  assert.equal(T('Checkout {n}', { n: 1 }), 'Caja 1'); // inherited from es-419
  setLocale('en-GB');
  assert.equal(T('Color vision'), 'Colour vision');
  setLocale('en-US');
  assert.equal(T('Shelf'), 'Shelf');
  assert.equal(graphicsStrings('de-DE').legend, 'Grafik');
});
