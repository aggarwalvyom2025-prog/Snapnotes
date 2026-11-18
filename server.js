require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const KEY = process.env.GEMINI_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Registration storage (a simple file, no database needed) ----------
const FILE = path.join(__dirname, 'registrations.json');
const STANDARDS = [
  'Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6',
  'Class 7', 'Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12', 'College',
];

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function requireStudent(req, res, next) {
  const id = req.get('x-student-id');
  const student = load().find((s) => s.id === id);
  if (!student) return res.status(401).json({ error: 'Please register first.' });
  req.student = student;
  next();
}

app.use(express.static('public'));

// Register a student
app.post('/register', express.json(), (req, res) => {
  const name = clean(req.body.name, 60);
  const school = clean(req.body.school, 100);
  const email = clean(req.body.email, 100).toLowerCase();
  const standard = String(req.body.standard || '');
  if (name.length < 2 || school.length < 2 || !STANDARDS.includes(standard)) {
    return res.status(400).json({ error: 'Please fill in your name, standard and school.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  const list = load();
  let student = list.find((s) => s.email === email);
  if (student) {
    Object.assign(student, { name, standard, school }); // same email = same student
  } else {
    student = { id: crypto.randomUUID(), name, email, standard, school, registered: new Date().toISOString() };
    list.push(student);
  }
  save(list);
  console.log(`Registration: ${name}, ${email}, ${standard}, ${school}`);
  res.json({ id: student.id, name: student.name });
});

// Check that a saved registration is still valid
app.get('/me', requireStudent, (req, res) => {
  res.json({ name: req.student.name, standard: req.student.standard, school: req.student.school });
});

// ---------- Admin pages (only you): /admin?key=YOUR_PASSWORD ----------
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(req.query.key || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const csvCell = (v) => {
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // stops spreadsheet formulas
  return '"' + s.replace(/"/g, '""') + '"';
};

app.get('/admin', (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Access denied. Add ADMIN_PASSWORD to .env, then open /admin?key=YOUR_PASSWORD');
  const list = load();
  const rows = list.map((s, i) =>
    `<tr><td>${i + 1}</td><td>${esc(s.name)}</td><td>${esc(s.email || '')}</td><td>${esc(s.standard)}</td><td>${esc(s.school)}</td><td>${esc(new Date(s.registered).toLocaleString())}</td></tr>`).join('');
  res.send(`<!DOCTYPE html><meta charset="UTF-8"><title>Registrations</title>
  <style>body{font-family:Arial;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px 12px;text-align:left}th{background:#2b59ff;color:#fff}</style>
  <h1>Registered students (${list.length})</h1>
  <p><a href="/admin.csv?key=${encodeURIComponent(req.query.key)}">Download as CSV (opens in Excel)</a></p>
  <table><tr><th>#</th><th>Name</th><th>Email</th><th>Standard</th><th>School</th><th>Registered</th></tr>${rows}</table>`);
});

app.get('/admin.csv', (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Access denied.');
  const lines = [['Name', 'Email', 'Standard', 'School', 'Registered'].map(csvCell).join(',')];
  load().forEach((s) => lines.push([s.name, s.email || '', s.standard, s.school, s.registered].map(csvCell).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="registrations.csv"');
  res.send('\ufeff' + lines.join('\r\n'));
});

// ---------- Notes (Gemini) ----------
async function listModels() {
  const r = await fetch(`${BASE}/models?pageSize=100`, {
    headers: { 'x-goog-api-key': KEY },
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || 'Could not list models');
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''));
}

function pickModels(all) {
  const skip = /(tts|image|live|audio|embed|robotics|computer|thinking|deep-research|native)/i;
  const flash = all.filter((n) => /flash/i.test(n) && !skip.test(n));
  flash.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return flash.slice(0, 5);
}

async function askGemini(parts) {
  const models = pickModels(await listModels());
  console.log('Models to try:', models.join(', '));
  let last = { ok: false, status: 0, data: { error: { message: 'No model answered.' } } };

  for (let round = 1; round <= 2; round++) {
    for (const model of models) {
      try {
        console.log(`Round ${round}: asking ${model}...`);
        const response = await fetch(`${BASE}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
          body: JSON.stringify({ contents: [{ parts }] }),
          signal: AbortSignal.timeout(45000),
        });
        const data = await response.json();
        if (response.ok) {
          console.log(`Success with ${model}!`);
          return { ok: true, data };
        }
        console.log(`  ${model} said ${response.status}`);
        last = { ok: false, status: response.status, data };
      } catch (err) {
        console.log(`  ${model} problem: ${err.name}`);
        last = {
          ok: false,
          status: 504,
          data: { error: { message: 'Google did not answer in time. Try fewer or smaller photos.' } },
        };
      }
    }
    if (round === 1) await sleep(5000);
  }
  return last;
}

app.post('/notes', requireStudent, upload.array('pages', 10), async (req, res) => {
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'Choose at least one photo first.' });
    }
    console.log(`Notes requested by ${req.student.name} (${req.student.standard}, ${req.student.school})`);

    const parts = req.files.map((f) => ({
      inline_data: { mime_type: f.mimetype, data: f.buffer.toString('base64') },
    }));
    parts.push({
      text: `These are pages from a textbook chapter. The student is in ${req.student.standard}. Write clear study notes in Markdown at that level: a title (one # heading), then sections with ## headings, bullet points, and bold key terms. Use only what is on the pages.`,
    });

    const result = await askGemini(parts);
    if (!result.ok) {
      console.error(result.data);
      const reason = (result.data.error && result.data.error.message) || 'Unknown error';
      return res.status(500).json({ error: `Google says (${result.status}): ${reason}` });
    }

    const notes = result.data.candidates[0].content.parts.map((p) => p.text || '').join('\n');
    res.json({ notes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Something went wrong: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NoteSnap running on port ${PORT}`));