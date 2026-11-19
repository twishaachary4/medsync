const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

// Load variables from a .env file in this folder (Node 20.12+ / 21.7+ built-in).
// Real environment variables still take priority over the file.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (e) { /* no .env file, that's fine */ }

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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

// Summaries via the Gemini API. Needs GEMINI_API_KEY (in .env or the environment).
app.post('/api/summarize', async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fail(res, 503, 'sampling_disabled', 'GEMINI_API_KEY is not set. Add it to the .env file and restart the server.');
  const INSTRUCTIONS = `You are helping a patient understand their own medical report. Using only the report text above, write a clear summary in plain language. Formatting rules (these override any earlier formatting instructions): use no markdown symbols at all (no #, no *, no bold). Use exactly these sections, each heading in capital letters on its own line:

OVERVIEW
Two sentences: what kind of report this is, the date, and the main reason for the visit.

KEY FINDINGS
Short lines for the diagnosis and any results outside the normal range, explained in simple words.

MEDICINES AND ADVICE
Each medicine with dose and duration, then the doctor's advice.

FOLLOW-UP
When to return or what to watch for.

Do not diagnose, add information that is not in the report, or give medical advice. If a section has nothing in the report, write "Not mentioned."`;
const prompt = (String(req.body.prompt || '').slice(0, 20000) + '\n\n' + INSTRUCTIONS);
  const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 4) : [];
  const parts = [];
  for (const d of images) {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(d || '');
    if (!m) return fail(res, 400, 'image_rejected', 'Unsupported image type');
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  parts.push({ text: prompt });
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { maxOutputTokens: 2000 } })
    });
    const j = await r.json();
    if (!r.ok) return fail(res, 502, 'upstream_error', (j.error && j.error.message) || 'Gemini API error');
    const text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [])
      .map(p => p.text || '').join('');
    if (!text) return fail(res, 502, 'upstream_error', 'No summary was returned (the response may have been blocked).');
    res.json({ text });
  } catch (e) {
    fail(res, 502, 'upstream_error', 'Could not reach the Gemini API');
  }
});

app.use((req, res) => res.status(404).json({ code: 'not_found', error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`MedSync running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('Warning: GEMINI_API_KEY is not set. Summaries are disabled. Add it to a .env file in this folder.');
  } else {
    console.log('Summaries enabled (GEMINI_API_KEY found).');
  }
});
