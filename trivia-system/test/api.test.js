import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../src/api.js';
import { invalidateCache } from '../src/db.js';
import { createFakeDb } from './fake-db.js';

const ENV = { ADMIN_TOKEN: 'secret-token-123' };

function req(path, { method = 'GET', body, token, judge } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (judge) { headers['X-Judge-Phone'] = judge.phone; headers['X-Judge-Pin'] = judge.pin || ''; }
  return new Request(`https://x.test/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function call(db, path, opts) {
  const res = await handleApi(req(path, opts), ENV, db);
  return { status: res.status, data: await res.json().catch(() => null) };
}

beforeEach(() => invalidateCache(''));

test('נתיב ניהול בלי טוקן - 401', async () => {
  const db = createFakeDb();
  const { status } = await call(db, '/admin/questions');
  assert.equal(status, 401);
});

test('מחזור חיים מלא של שאלה: יצירה, הפעלה, הצבעה, תוצאות, סגירה', async () => {
  const db = createFakeDb();
  const t = { token: ENV.ADMIN_TOKEN };

  // יצירה
  const created = await call(db, '/admin/questions', {
    method: 'POST', ...t,
    body: {
      title: 'מי ינצח?', kind: 'poll', judges_weight: 0,
      options: [{ digit: 1, label: 'א' }, { digit: 2, label: 'ב' }],
    },
  });
  assert.equal(created.status, 200);
  const qid = created.data.question.id;
  assert.equal(db.tables.options.length, 2);

  // הפעלה עם מגבלת זמן
  const act = await call(db, `/admin/questions/${qid}/activate`, { method: 'POST', ...t, body: { seconds_to_answer: 60 } });
  assert.equal(act.status, 200);
  assert.ok(act.data.closes_at, 'נקבע זמן סגירה');

  // הדמיית הצבעות
  await call(db, `/admin/questions/${qid}/simulate-vote`, { method: 'POST', ...t, body: { option_digit: 1 } });
  await call(db, `/admin/questions/${qid}/simulate-vote`, { method: 'POST', ...t, body: { option_digit: 1 } });
  await call(db, `/admin/questions/${qid}/simulate-vote`, { method: 'POST', ...t, body: { option_digit: 2 } });

  // מצב ציבורי
  invalidateCache('');
  const pub = await call(db, '/public/state');
  assert.equal(pub.status, 200);
  assert.equal(pub.data.question.id, qid);
  assert.equal(pub.data.results.total_votes, 3);
  const opt1 = pub.data.results.options.find((o) => o.digit === 1);
  assert.equal(opt1.final_pct, 66.7);

  // הארכת זמן
  const ext = await call(db, `/admin/questions/${qid}/extend`, { method: 'POST', ...t, body: { seconds: 60 } });
  assert.equal(ext.status, 200);
  const closesAfter = new Date(ext.data.closes_at).getTime();
  assert.ok(closesAfter > new Date(act.data.closes_at).getTime() + 55_000);

  // סגירה
  await call(db, `/admin/questions/${qid}/close`, { method: 'POST', ...t });
  assert.equal(db.tables.questions[0].status, 'closed');
});

test('הפעלת שאלה סוגרת אוטומטית שאלה פעילה אחרת', async () => {
  const db = createFakeDb();
  const t = { token: ENV.ADMIN_TOKEN };
  const a = await call(db, '/admin/questions', { method: 'POST', ...t, body: { title: 'א', options: [{ digit: 1, label: 'x' }] } });
  const b = await call(db, '/admin/questions', { method: 'POST', ...t, body: { title: 'ב', options: [{ digit: 1, label: 'y' }] } });
  await call(db, `/admin/questions/${a.data.question.id}/activate`, { method: 'POST', ...t, body: {} });
  await call(db, `/admin/questions/${b.data.question.id}/activate`, { method: 'POST', ...t, body: {} });
  const qa = db.tables.questions.find((q) => q.id === a.data.question.id);
  const qb = db.tables.questions.find((q) => q.id === b.data.question.id);
  assert.equal(qa.status, 'closed');
  assert.equal(qb.status, 'active');
});

test('הסתרת תוצאות: הציבור רואה hidden בלי אחוזים', async () => {
  const db = createFakeDb();
  const t = { token: ENV.ADMIN_TOKEN };
  const a = await call(db, '/admin/questions', { method: 'POST', ...t, body: { title: 'א', options: [{ digit: 1, label: 'x' }] } });
  await call(db, `/admin/questions/${a.data.question.id}/activate`, { method: 'POST', ...t, body: {} });
  await call(db, `/admin/questions/${a.data.question.id}/simulate-vote`, { method: 'POST', ...t, body: { option_digit: 1 } });
  await call(db, '/admin/settings', { method: 'POST', ...t, body: { results_visible_on_display: false } });

  invalidateCache('');
  const pub = await call(db, '/public/state');
  assert.equal(pub.data.results.hidden, true);
  assert.equal(pub.data.results.options[0].final_pct, null);
  assert.equal(pub.data.results.options[0].votes, null);
});

test('שופט: התחברות, ציון בטווח, דחיית ציון מחוץ לטווח, הארכה', async () => {
  const db = createFakeDb();
  const t = { token: ENV.ADMIN_TOKEN };
  await call(db, '/admin/judges', {
    method: 'POST', ...t,
    body: { name: 'רחל', phone: '0521111111', pin: '4321', min_percent: 40, max_percent: 90, can_extend: true },
  });
  const q = await call(db, '/admin/questions', { method: 'POST', ...t, body: { title: 'מי?', options: [{ digit: 1, label: 'א' }] } });
  await call(db, `/admin/questions/${q.data.question.id}/activate`, { method: 'POST', ...t, body: {} });
  invalidateCache('');

  const judge = { phone: '0521111111', pin: '4321' };

  const badPin = await call(db, '/judge/login', { method: 'POST', judge: { phone: '0521111111', pin: '9999' } });
  assert.equal(badPin.status, 401);

  const login = await call(db, '/judge/login', { method: 'POST', judge });
  assert.equal(login.status, 200);
  assert.equal(login.data.judge.min_percent, 40);

  const tooHigh = await call(db, '/judge/score', {
    method: 'POST', judge, body: { question_id: q.data.question.id, option_digit: 1, score: 95 },
  });
  assert.equal(tooHigh.status, 400);
  assert.match(tooHigh.data.error, /40-90/);

  const ok = await call(db, '/judge/score', {
    method: 'POST', judge, body: { question_id: q.data.question.id, option_digit: 1, score: 88 },
  });
  assert.equal(ok.status, 200);
  assert.equal(db.tables.judge_scores[0].score, 88);

  // עדכון ציון קיים (upsert)
  await call(db, '/judge/score', {
    method: 'POST', judge, body: { question_id: q.data.question.id, option_digit: 1, score: 70 },
  });
  assert.equal(db.tables.judge_scores.length, 1);
  assert.equal(db.tables.judge_scores[0].score, 70);

  const ext = await call(db, '/judge/extend', { method: 'POST', judge, body: { seconds: 45 } });
  assert.equal(ext.status, 200);
  assert.ok(db.tables.questions[0].closes_at);
});

test('שינוי שם משתתף בזמן אמת', async () => {
  const db = createFakeDb();
  const t = { token: ENV.ADMIN_TOKEN };
  await call(db, '/admin/participants', { method: 'POST', ...t, body: { phone: '0501234567', display_name: 'משה' } });
  await call(db, '/admin/participants', { method: 'POST', ...t, body: { phone: '0501234567', display_name: 'משה כהן' } });
  assert.equal(db.tables.participants.length, 1);
  assert.equal(db.tables.participants[0].display_name, 'משה כהן');
});

test('עדכון שאלה מחליף אפשרויות (שינוי שמות בזמן אמת)', async () => {
  const db = createFakeDb();
  const t = { token: ENV.ADMIN_TOKEN };
  const q = await call(db, '/admin/questions', {
    method: 'POST', ...t,
    body: { title: 'מי?', options: [{ digit: 1, label: 'ישן' }] },
  });
  const patch = await call(db, `/admin/questions/${q.data.question.id}`, {
    method: 'PATCH', ...t,
    body: { options: [{ digit: 1, label: 'חדש', color: '#ff0000' }] },
  });
  assert.equal(patch.status, 200);
  assert.equal(db.tables.options.length, 1);
  assert.equal(db.tables.options[0].label, 'חדש');
});
