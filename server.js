// Market Manager — authoritative StarHermit game script.
// Serves the static distribution and the /api/v1 endpoints used for seeded
// daily sessions, replay-validated leaderboards, and presence heartbeats.
// No dependencies: node server.js [port]  (default 8080)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { verifyReplay, computeScore, isTerminal } from './src/rules.js';
import { dailyConfig, dailyDateUtc, journeyStage, practiceConfig, challengeStages, CONTENT_VERSION } from './src/content.js';
import { hashString } from './src/rng.js';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MM_DATA_DIR || path.join(ROOT, '.mm-data');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.opus': 'audio/ogg; codecs=opus',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
};

// ---------------------------------------------------------------------------
// Tiny persistent store (JSON file, atomic-ish writes)
// ---------------------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'boards.json');

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { scores: [] }; }
}
function saveDb(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

// ---------------------------------------------------------------------------
// Rate limiting (per-IP token bucket; structured, recoverable)
// ---------------------------------------------------------------------------

const buckets = new Map();
function rateLimited(ip, cost = 1, perMinute = 60) {
  const now = Date.now();
  // Sweep stale buckets once the map grows so unique source addresses cannot
  // accumulate for the process lifetime.
  if (buckets.size > 1000) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart > 120000) buckets.delete(k);
    }
  }
  let b = buckets.get(ip);
  if (!b || now - b.windowStart > 60000) { b = { windowStart: now, used: 0 }; buckets.set(ip, b); }
  if (b.used + cost > perMinute) return true;
  b.used += cost;
  return false;
}

// ---------------------------------------------------------------------------
// Score validation
// ---------------------------------------------------------------------------

const KNOWN_STAGE_IDS = new Set([
  ...challengeStages().map((c) => c.id),
]);

function validateSubmission(envelope) {
  if (!envelope || typeof envelope !== 'object') return { error: 'malformed-envelope' };
  if (JSON.stringify(envelope).length > 512 * 1024) return { error: 'payload-too-large' };
  if (envelope.schemaVersion !== 1) return { error: 'stale-version' };
  if (envelope.contentVersion !== CONTENT_VERSION) return { error: 'stale-version' };
  const cfg = envelope.config;
  if (!cfg || typeof cfg.id !== 'string') return { error: 'missing-config' };

  // Resolve the authoritative published config for this content. The client
  // config is attacker-controlled, so the replay and the duration plausibility
  // ceiling must both be validated against the server-built config
  // (spec.md §2/§5), not the submitted one.
  let authoritative;
  if (cfg.dailyDate) {
    authoritative = dailyConfig(cfg.dailyDate);
    if (cfg.id !== authoritative.id || envelope.seed !== authoritative.seed) {
      return { error: 'seed-mismatch' };
    }
  } else if (cfg.id.startsWith('j')) {
    authoritative = journeyStage(cfg.id);
    if (!authoritative) return { error: 'unknown-content' };
    if (envelope.seed !== authoritative.seed) return { error: 'seed-mismatch' };
  } else if (cfg.id.startsWith('practice-')) {
    try { authoritative = practiceConfig(cfg.id.slice('practice-'.length)); }
    catch { return { error: 'unknown-content' }; }
    if (envelope.seed !== authoritative.seed) return { error: 'seed-mismatch' };
  } else if (KNOWN_STAGE_IDS.has(cfg.id)) {
    authoritative = challengeStages().find((c) => c.id === cfg.id);
    if (envelope.seed !== authoritative.seed) return { error: 'seed-mismatch' };
  } else {
    return { error: 'unknown-content' };
  }

  // Re-simulate the replay deterministically against the authoritative config.
  const replayed = { ...envelope, config: authoritative };
  let verdict;
  try {
    verdict = verifyReplay(replayed);
  } catch {
    return { error: 'replay-unverifiable' };
  }
  if (!verdict.ok) return { error: 'replay-mismatch', detail: verdict.failures.slice(0, 3) };
  if (!isTerminal({ phase: verdict.phase })) return { error: 'not-terminal' };

  // Plausibility: duration within an order of magnitude of published ticks.
  const ticks = authoritative.maxTicks;
  const ms = Number(envelope.durationMs);
  if (!Number.isFinite(ms) || ms < 1000 || ms > ticks * 500 * 20) return { error: 'implausible-duration' };

  return { ok: true, score: verdict.score.total, phase: verdict.phase, durationMs: ms };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res, code, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname, query, ip) {
  if (rateLimited(ip)) return send(res, 429, { error: 'rate-limited' });

  if (pathname === '/api/v1/time' && req.method === 'GET') {
    return send(res, 200, { now: Date.now() });
  }

  if (pathname === '/api/v1/daily' && req.method === 'GET') {
    const date = query.get('date') || dailyDateUtc(new Date(Date.now()));
    const cfg = dailyConfig(date);
    // Days are immutable once published; a defective day would be excluded
    // from ranking here rather than silently replaced.
    return send(res, 200, { date, seed: cfg.seed, excluded: false, contentVersion: CONTENT_VERSION });
  }

  if (pathname === '/api/v1/scores' && req.method === 'POST') {
    if (rateLimited(ip, 5, 60)) return send(res, 429, { error: 'rate-limited' });
    let envelope;
    try { envelope = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad-json' }); }
    const verdict = validateSubmission(envelope);
    if (verdict.error) return send(res, 422, verdict);

    const db = loadDb();
    const entry = {
      name: String(envelope.playerName || 'Guest').slice(0, 24),
      score: verdict.score,
      phase: verdict.phase,
      configId: envelope.config.id,
      date: envelope.config.dailyDate || null,
      seed: envelope.seed,
      contentVersion: envelope.contentVersion,
      assists: envelope.assists || {},
      durationMs: verdict.durationMs,
      sessionId: String(envelope.sessionId || '').slice(0, 64),
      at: Date.now(),
    };
    // Idempotent by sessionId: duplicate submissions update in place.
    const existing = db.scores.findIndex((s) => s.sessionId === entry.sessionId && s.configId === entry.configId);
    if (existing >= 0) db.scores[existing] = entry;
    else db.scores.push(entry);
    if (db.scores.length > 5000) db.scores = db.scores.slice(-5000);
    saveDb(db);

    const board = db.scores
      .filter((s) => (entry.date ? s.date === entry.date : s.configId === entry.configId))
      .sort((a, b) => b.score - a.score);
    return send(res, 200, { ok: true, rank: board.findIndex((s) => s.sessionId === entry.sessionId) + 1 });
  }

  if (pathname === '/api/v1/leaderboard' && req.method === 'GET') {
    const board = query.get('board') || 'daily';
    const date = query.get('date') || dailyDateUtc(new Date(Date.now()));
    const configId = query.get('configId') || null;
    const db = loadDb();
    let entries = db.scores;
    if (board === 'daily') entries = entries.filter((s) => s.date === date);
    else if (configId) entries = entries.filter((s) => s.configId === configId);
    entries = entries
      .sort((a, b) => b.score - a.score || a.durationMs - b.durationMs || String(a.sessionId).localeCompare(String(b.sessionId)))
      .slice(0, 50)
      .map(({ name, score, date: d, configId: c, durationMs, seed, contentVersion }) =>
        ({ name, score, date: d, configId: c, durationMs, seed, contentVersion }));
    return send(res, 200, { entries });
  }

  if (pathname === '/api/v1/heartbeat' && req.method === 'POST') {
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not-found' });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  // Never serve the data dir, dev-only trees, dotfiles, or source maps.
  const rel = path.relative(ROOT, file);
  const top = rel.split(path.sep)[0];
  if (top === '.mm-data' || top === 'tests' || top === 'tools' || top === 'node_modules'
      || path.basename(file).startsWith('.') || rel.endsWith('.map')) {
    res.writeHead(404); return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const immutable = rel.startsWith('lib/');
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, 'http://localhost');
    const pathname = parsed.pathname;
    const ip = req.socket.remoteAddress || 'unknown';
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, parsed.searchParams, ip);
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  } catch (e) {
    return send(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, () => {
  console.log(`Market Manager server on http://localhost:${PORT}`);
});
