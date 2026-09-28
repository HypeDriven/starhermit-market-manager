// Market Manager — Settings › Graphics panel. Builds and localizes the
// graphics controls inside #gfx-section, reads/writes the saved graphics
// object through callbacks, and shows the GPU / cost summary. The rest of the
// game's copy is English-only; these strings follow navigator.language.

import { PRESETS, CATEGORIES, presetTier, choosePreset } from './gfx.js';

const EN = {
  legend: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})',
  low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra', medium: 'Medium',
  renderScale: 'Render scale', fromPreset: 'From preset ({tier})',
  shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
  antialias: 'Anti-aliasing', reflections: 'Reflections', detail: 'Surface detail', particles: 'Particles',
  off: 'Off', on: 'On', plain: 'Plain', detailed: 'Detailed', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
  adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postNote: 'Post-processing is unavailable on this device, so effects are drawn without it.',
  noWebgl: 'The 3D view is off in this browser; these settings apply when it is available.',
  unknownGpu: 'Unknown GPU',
  words: { shadows: 'shadows', noShadows: 'no shadows', ao: 'AO', fullAo: 'full AO', bloom: 'bloom', reflections: 'reflections', noAa: 'no AA' },
};

const ES = {
  legend: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})',
  low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Media',
  renderScale: 'Escala de renderizado', fromPreset: 'Según el preajuste ({tier})',
  shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
  antialias: 'Antialiasing', reflections: 'Reflejos', detail: 'Detalle de superficies', particles: 'Partículas',
  off: 'Desactivado', on: 'Activado', plain: 'Simple', detailed: 'Detallado',
  adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
  postNote: 'El posprocesamiento no está disponible en este dispositivo; los efectos se dibujan sin él.',
  noWebgl: 'La vista 3D está desactivada en este navegador; esta configuración se aplicará cuando esté disponible.',
  unknownGpu: 'GPU desconocida',
  words: { shadows: 'sombras', noShadows: 'sin sombras', ao: 'AO', fullAo: 'AO completa', bloom: 'resplandor', reflections: 'reflejos', noAa: 'sin AA' },
};

const FR = {
  legend: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {tier})',
  low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra', medium: 'Moyenne',
  renderScale: 'Échelle de rendu', fromPreset: 'Selon le préréglage ({tier})',
  shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Flou lumineux', grade: 'Étalonnage des couleurs',
  antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détail des surfaces', particles: 'Particules',
  off: 'Désactivé', on: 'Activé', plain: 'Simple', detailed: 'Détaillé',
  adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
  postNote: 'Le post-traitement n’est pas disponible sur cet appareil ; les effets sont affichés sans lui.',
  noWebgl: 'La vue 3D est désactivée dans ce navigateur ; ces réglages s’appliqueront quand elle sera disponible.',
  unknownGpu: 'GPU inconnu',
  words: { shadows: 'ombres', noShadows: 'sans ombres', ao: 'AO', fullAo: 'AO complète', bloom: 'flou lumineux', reflections: 'reflets', noAa: 'sans anticrénelage' },
};

export const STRINGS = {
  'en-US': EN,
  'en-GB': { ...EN, grade: 'Colour grade' },
  'es-419': ES,
  'es-ES': {
    ...ES, fromPreset: 'Del ajuste predefinido ({tier})', antialias: 'Suavizado de bordes',
    postNote: 'El posprocesado no está disponible en este dispositivo; los efectos se dibujan sin él.',
    noWebgl: 'La vista 3D está desactivada en este navegador; estos ajustes se aplicarán cuando esté disponible.',
  },
  'de-DE': {
    legend: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})',
    low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra', medium: 'Mittel',
    renderScale: 'Renderskalierung', fromPreset: 'Wie Voreinstellung ({tier})',
    shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur',
    antialias: 'Kantenglättung', reflections: 'Reflexionen', detail: 'Oberflächendetails', particles: 'Partikel',
    off: 'Aus', on: 'An', plain: 'Schlicht', detailed: 'Detailliert',
    adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postNote: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; Effekte werden ohne sie dargestellt.',
    noWebgl: 'Die 3D-Ansicht ist in diesem Browser aus; diese Einstellungen gelten, sobald sie verfügbar ist.',
    unknownGpu: 'Unbekannte GPU',
    words: { shadows: 'Schatten', noShadows: 'keine Schatten', ao: 'AO', fullAo: 'volle AO', bloom: 'Bloom', reflections: 'Reflexionen', noAa: 'keine Kantenglättung' },
  },
  'fr-FR': FR,
  'fr-CA': {
    ...FR, bloom: 'Halo lumineux', showFps: 'Afficher les images par seconde', unknownGpu: 'Processeur graphique inconnu',
    words: { ...FR.words, bloom: 'halo lumineux' },
  },
  'pt-BR': {
    legend: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})',
    low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Média',
    renderScale: 'Escala de renderização', fromPreset: 'Da predefinição ({tier})',
    shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor',
    antialias: 'Suavização de serrilhado', reflections: 'Reflexos', detail: 'Detalhe das superfícies', particles: 'Partículas',
    off: 'Desligado', on: 'Ligado', plain: 'Simples', detailed: 'Detalhado',
    adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
    postNote: 'O pós-processamento não está disponível neste dispositivo; os efeitos são desenhados sem ele.',
    noWebgl: 'A visão 3D está desligada neste navegador; estas configurações valem quando ela estiver disponível.',
    unknownGpu: 'GPU desconhecida',
    words: { shadows: 'sombras', noShadows: 'sem sombras', ao: 'AO', fullAo: 'AO completa', bloom: 'brilho', reflections: 'reflexos', noAa: 'sem suavização' },
  },
  'it-IT': {
    legend: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})',
    low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra', medium: 'Media',
    renderScale: 'Scala di rendering', fromPreset: 'Dal preset ({tier})',
    shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
    antialias: 'Anti-aliasing', reflections: 'Riflessi', detail: 'Dettaglio superfici', particles: 'Particelle',
    off: 'Disattivato', on: 'Attivo', plain: 'Semplice', detailed: 'Dettagliato',
    adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
    postNote: 'La post-elaborazione non è disponibile su questo dispositivo; gli effetti sono disegnati senza.',
    noWebgl: 'La vista 3D è disattivata in questo browser; queste impostazioni si applicano quando è disponibile.',
    unknownGpu: 'GPU sconosciuta',
    words: { shadows: 'ombre', noShadows: 'senza ombre', ao: 'AO', fullAo: 'AO completa', bloom: 'bagliore', reflections: 'riflessi', noAa: 'senza AA' },
  },
};

const FALLBACK = { en: 'en-US', es: 'es-419', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', it: 'it-IT' };

/** Best supported locale for a BCP 47 tag (exact, then language fallback, else en-US). */
export function pickLocale(tag) {
  const t = String(tag || '').replace('_', '-');
  const exact = Object.keys(STRINGS).find((k) => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split('-')[0].toLowerCase();
  if (lang === 'en' && /^en-(au|nz|ie|in|za)$/i.test(t)) return 'en-GB';
  return FALLBACK[lang] || 'en-US';
}

/** Strings for a locale; missing keys fall back to en-US. */
export function graphicsStrings(locale) {
  const s = STRINGS[pickLocale(locale)] || EN;
  return { ...EN, ...s, words: { ...EN.words, ...(s.words || {}) } };
}

/**
 * Build the panel inside `root`.
 * - getSaved(): current saved graphics object
 * - onChange(saved): persist + apply a new saved object
 * - getInfo(words): { gpu, detected, resolved, summary, postFailed, webgl }
 */
export function createGraphicsPanel(root, { getSaved, onChange, getInfo, locale }) {
  const L = graphicsStrings(locale);
  const lang = pickLocale(locale);
  root.setAttribute('lang', lang);
  const legend = root.querySelector('legend');
  if (legend) legend.textContent = L.legend;

  const make = (tag, attrs = {}, text) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const labelled = (text, control, extra) => {
    const lab = make('label', { class: 'gfx-row' });
    lab.append(make('span', { class: 'gfx-label' }, text), control);
    if (extra) lab.append(extra);
    return lab;
  };

  // Quality preset (keeps the historical #set-quality id)
  const preset = make('select', { id: 'set-quality', 'data-gfx': 'preset' });
  preset.append(make('option', { value: 'auto' }, L.auto.replace('{tier}', L.balanced)));
  for (const p of PRESETS) preset.append(make('option', { value: p }, L[p]));

  // Render scale
  const scale = make('input', { id: 'gfx-render-scale', 'data-gfx': 'render_scale', type: 'range', min: '50', max: '200', step: '10' });
  const scaleOut = make('output', { id: 'gfx-render-scale-value', class: 'gfx-value', for: 'gfx-render-scale' }, '100%');
  const scaleRow = labelled(L.renderScale, scale, scaleOut);
  scaleRow.classList.add('gfx-range');

  // One select per category
  const grid = make('div', { class: 'gfx-grid' });
  const catSelects = {};
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    const sel = make('select', { id: `gfx-${cat}`, 'data-gfx': cat });
    sel.append(make('option', { value: 'preset' }, L.fromPreset));
    for (const t of tiers) sel.append(make('option', { value: t }, L[t] || t));
    catSelects[cat] = sel;
    grid.append(labelled(L[cat], sel));
  }

  const adaptive = make('input', { id: 'gfx-adaptive', 'data-gfx': 'adaptive', type: 'checkbox' });
  const showFps = make('input', { id: 'gfx-show-fps', 'data-gfx': 'show_fps', type: 'checkbox' });
  const adaptiveRow = make('label', { class: 'check' });
  adaptiveRow.append(adaptive, document.createTextNode(' ' + L.adaptive));
  const fpsRow = make('label', { class: 'check' });
  fpsRow.append(showFps, document.createTextNode(' ' + L.showFps));

  const summary = make('p', { id: 'gfx-summary', class: 'gfx-summary muted', 'aria-live': 'polite' });
  const note = make('p', { id: 'gfx-post-note', class: 'gfx-note', role: 'status' });
  note.hidden = true;

  root.append(labelled(L.quality, preset), scaleRow, grid, adaptiveRow, fpsRow, summary, note);

  function commit(next) {
    onChange(next);
    refresh();
  }

  preset.addEventListener('change', () => commit(choosePreset(getSaved(), preset.value)));
  scale.addEventListener('input', () => {
    scaleOut.textContent = `${scale.value}%`;
    commit({ ...getSaved(), render_scale: Number(scale.value) / 100 });
  });
  for (const [cat, sel] of Object.entries(catSelects)) {
    sel.addEventListener('change', () => {
      const next = { ...getSaved() };
      if (sel.value === 'preset') delete next[cat];
      else next[cat] = sel.value;
      commit(next);
    });
  }
  adaptive.addEventListener('change', () => commit({ ...getSaved(), adaptive: adaptive.checked }));
  showFps.addEventListener('change', () => commit({ ...getSaved(), show_fps: showFps.checked }));

  function refresh() {
    const saved = getSaved() || {};
    const info = getInfo(L.words);
    const r = info.resolved;
    preset.options[0].textContent = L.auto.replace('{tier}', L[info.detected] || info.detected);
    preset.value = PRESETS.includes(saved.preset) ? saved.preset : 'auto';
    const pct = Math.round((r.renderScale || 1) * 100);
    scale.value = String(pct);
    scaleOut.textContent = `${pct}%`;
    for (const [cat, sel] of Object.entries(catSelects)) {
      const own = presetTier(r.preset, cat);
      sel.options[0].textContent = L.fromPreset.replace('{tier}', L[own] || own);
      sel.value = CATEGORIES[cat].includes(saved[cat]) ? saved[cat] : 'preset';
    }
    adaptive.checked = r.adaptive;
    showFps.checked = r.showFps;
    summary.textContent = `${info.gpu || L.unknownGpu} · ${info.summary}`;
    note.hidden = !(info.postFailed || info.webgl === false);
    note.textContent = info.webgl === false ? L.noWebgl : L.postNote;
    root.dataset.gfxPreset = r.preset;
  }

  return { refresh, strings: L, locale: lang };
}
