/**
 * שרת הדגמה מקומי - מריץ את המערכת המלאה על המחשב בלי Supabase ובלי Cloudflare.
 *   node scripts/demo-server.js
 * ואז לגלוש אל http://localhost:8788
 *
 * טוקן הניהול בדמו: demo
 * שופטת דמו: טלפון 0521111111, קוד 1234, טווח 40-90
 * אפשר גם לדמות שיחת טלפון:
 *   http://localhost:8788/ivr?ApiCallId=test1&ApiPhone=0501234567
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from '../src/api.js';
import { handleIvrCall } from '../src/ivr.js';
import { createFakeDb } from '../test/fake-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 8788;
const ENV = { ADMIN_TOKEN: process.env.ADMIN_TOKEN || 'demo' };

/* ---------- נתוני דמו ---------- */
const db = createFakeDb();
const [q] = await db.insert('questions', [{
  title: 'מי המתמודד הטוב ביותר?',
  tts_text: 'מי לדעתכם המתמודד הטוב ביותר',
  kind: 'poll', status: 'active', judges_weight: 30, sort_order: 1,
  opened_at: new Date().toISOString(),
  closes_at: new Date(Date.now() + 10 * 60_000).toISOString(),
}]);
await db.insert('options', [
  { question_id: q.id, digit: 1, label: 'דוד לוי', color: '#3987e5' },
  { question_id: q.id, digit: 2, label: 'משה כהן', color: '#199e70' },
  { question_id: q.id, digit: 3, label: 'יוסי מזרחי', color: '#c98500' },
]);
await db.insert('questions', [{
  title: 'שאלה הבאה בתור - טריוויה', tts_text: 'באיזו שנה הוקמה ירושלים',
  kind: 'trivia', status: 'draft', correct_digit: 2, seconds_to_answer: 120, sort_order: 2,
}]);
const [q2] = db.tables.questions.slice(-1);
await db.insert('options', [
  { question_id: q2.id, digit: 1, label: 'תשובה א' },
  { question_id: q2.id, digit: 2, label: 'תשובה ב' },
]);
await db.insert('judges', [{
  name: 'רחל השופטת', phone: '0521111111', pin: '1234',
  min_percent: 40, max_percent: 90, can_extend: true, can_control: true,
}]);
// הצבעות פתיחה
const seedVotes = [[1, 12], [2, 9], [3, 5]];
for (const [digit, count] of seedVotes) {
  for (let i = 0; i < count; i++) {
    await db.insert('votes', [{ question_id: q.id, option_digit: digit, phone: `seed:${digit}:${i}` }]);
  }
}
await db.insert('judge_scores', [
  { judge_id: db.tables.judges[0].id, question_id: q.id, option_digit: 1, score: 85 },
  { judge_id: db.tables.judges[0].id, question_id: q.id, option_digit: 2, score: 62 },
]);

// הדמיית מצביעים חיים - הצבעה אקראית כל 3 שניות
setInterval(async () => {
  const active = db.tables.questions.find((x) => x.status === 'active');
  if (!active) return;
  const opts = db.tables.options.filter((o) => o.question_id === active.id);
  if (!opts.length) return;
  const digit = opts[Math.floor(Math.random() * opts.length)].digit;
  await db.insert('votes', [{ question_id: active.id, option_digit: digit, phone: `live:${Date.now()}` }]);
  const { invalidateCache } = await import('../src/db.js');
  invalidateCache('');
}, 3000);

/* ---------- שרת ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/ivr') {
      const params = Object.fromEntries(url.searchParams);
      if (req.method === 'POST') {
        const chunks = []; for await (const c of req) chunks.push(c);
        for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString())) params[k] = v;
      }
      const text = await handleIvrCall(params, { db });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }

    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined,
      });
      const response = await handleApi(request, ENV, db);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }

    // סטטי
    let file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    if (file.includes('..')) { res.writeHead(400); return res.end(); }
    try {
      const data = await readFile(join(PUBLIC, file));
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      return res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('לא נמצא');
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('שגיאה: ' + e.message);
  }
}).listen(PORT, () => {
  console.log(`
🎉 שרת ההדגמה פעיל!  http://localhost:${PORT}
   טוקן ניהול לדמו: ${ENV.ADMIN_TOKEN}
   שופטת דמו: טלפון 0521111111, קוד 1234 (טווח 40-90)
   סימולציית IVR: http://localhost:${PORT}/ivr?ApiCallId=t1&ApiPhone=0501234567
`);
});
