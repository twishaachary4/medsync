const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const MAX_DOC = 256 * 1024;
const PATH_RE = /^[A-Za-z0-9_\-.:@+~ ]+(\/[A-Za-z0-9_\-.:@+~ ]+)*$/;

// ---- database (SQLite file next to server.js) ----
const db = new Database(path.join(__dirname, 'medsync.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS docs (
    path TEXT PRIMARY KEY,
    coll TEXT NOT NULL,
    id   TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS docs_coll ON docs(coll);
`);
const stGet = db.prepare('SELECT data FROM docs WHERE path = ?');
const stSet = db.prepare(`INSERT INTO docs (path, coll, id, data) VALUES (?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET data = excluded.data`);
const stDel = db.prepare('DELETE FROM docs WHERE path = ?');
const stList = db.prepare('SELECT id, data FROM docs WHERE coll = ? ORDER BY id');

// ---- app ----
const app = express();
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const fail = (res, status, code, error) => res.status(status).json({ code, error });

// Document path: docs have an even number of segments, collections an odd number.
function validPath(p, even) {
  if (typeof p !== 'string' || p.length > 1000 || !PATH_RE.test(p)) return false;
  const n = p.split('/').length;
  return even ? n % 2 === 0 : n % 2 === 1;
}
const parentOf = p => p.split('/').slice(0, -1).join('/');
const idOf = p => p.split('/').pop();

function matches(value, op, target) {
  switch (op) {
    case '==': return value === target;
    case '!=': return value !== target;
    case 'in': return Array.isArray(target) && target.includes(value);
    case 'not-in': return Array.isArray(target) && !target.includes(value);
    case 'array-contains': return Array.isArray(value) && value.includes(target);
    default: return false;
  }
}

app.post('/api/doc/get', (req, res) => {
  const { path: p } = req.body;
  if (!validPath(p, true)) return fail(res, 400, 'invalid_argument', 'Bad document path');
  const row = stGet.get(p);
  res.json(row ? { exists: true, data: JSON.parse(row.data) } : { exists: false });
});

app.post('/api/doc/set', (req, res) => {
  const { path: p, data } = req.body;
  if (!validPath(p, true)) return fail(res, 400, 'invalid_argument', 'Bad document path');
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(res, 400, 'invalid_argument', 'Data must be an object');
  const s = JSON.stringify(data);
  if (s.length > MAX_DOC) return fail(res, 413, 'resource_exhausted', 'Document is larger than 256 KB');
  stSet.run(p, parentOf(p), idOf(p), s);
  res.json({ ok: true });
});

app.post('/api/doc/update', (req, res) => {
  const { path: p, data } = req.body;
  if (!validPath(p, true)) return fail(res, 400, 'invalid_argument', 'Bad document path');
  const cur = stGet.get(p);
  if (!cur) return fail(res, 400, 'invalid_argument', 'Document does not exist');
  const merged = { ...JSON.parse(cur.data), ...(data || {}) };
  const s = JSON.stringify(merged);
  if (s.length > MAX_DOC) return fail(res, 413, 'resource_exhausted', 'Document is larger than 256 KB');
  stSet.run(p, parentOf(p), idOf(p), s);
  res.json({ ok: true });
});

app.post('/api/doc/delete', (req, res) => {
  const { path: p } = req.body;
  if (!validPath(p, true)) return fail(res, 400, 'invalid_argument', 'Bad document path');
  stDel.run(p);
  res.json({ ok: true });
});

app.post('/api/query', (req, res) => {
  const { collection, where } = req.body;
  if (!validPath(collection, false)) return fail(res, 400, 'invalid_argument', 'Bad collection path');
  const wheres = Array.isArray(where) ? where : [];
  const docs = stList.all(collection)
    .map(r => ({ id: r.id, data: JSON.parse(r.data) }))
    .filter(d => wheres.every(([f, op, v]) => matches(d.data[f], op, v)));
  res.json({ docs });
});

// Summaries via the Claude API. Needs ANTHROPIC_API_KEY in the environment.
app.post('/api/summarize', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fail(res, 503, 'sampling_disabled', 'Set ANTHROPIC_API_KEY on the server to enable summaries.');
  const prompt = String(req.body.prompt || '').slice(0, 20000);
  const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 4) : [];
  const content = [];
  for (const d of images) {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(d || '');
    if (!m) return fail(res, 400, 'image_rejected', 'Unsupported image type');
    content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  content.push({ type: 'text', text: prompt });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1000, messages: [{ role: 'user', content }] })
    });
    const j = await r.json();
    if (!r.ok) return fail(res, 502, 'upstream_error', (j.error && j.error.message) || 'Claude API error');
    res.json({ text: j.content.filter(c => c.type === 'text').map(c => c.text).join('') });
  } catch (e) {
    fail(res, 502, 'upstream_error', 'Could not reach the Claude API');
  }
});

app.use((req, res) => res.status(404).json({ code: 'not_found', error: 'Not found' }));

app.listen(PORT, () => console.log(`MedSync running at http://localhost:${PORT}`));
