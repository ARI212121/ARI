import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleIvrCall } from '../src/ivr.js';
import { invalidateCache } from '../src/db.js';
import { createFakeDb } from './fake-db.js';

const NOW = new Date('2026-01-01T20:00:00Z');
const now = () => NOW;

const baseCall = { ApiCallId: 'call-1', ApiPhone: '0501234567', ApiDID: '036166666', ApiExtension: '1' };

function seedQuestion(db, over = {}) {
  const q = {
    id: 'q1111111-0000-4000-8000-000000000001',
    title: 'מי ינצח?',
    tts_text: 'מי לדעתכם ינצח בתחרות',
    kind: 'poll',
    status: 'active',
    correct_digit: null,
    seconds_to_answer: null,
    closes_at: null,
    show_results_live: true,
    allow_vote_change: null,
    judges_weight: 0,
    survey_group: null,
    sort_order: 1,
    announce_time_left: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
  db.tables.questions.push(q);
  db.tables.options.push(
    { id: 'o1', question_id: q.id, digit: 1, label: 'דני', tts_text: null, color: null },
    { id: 'o2', question_id: q.id, digit: 2, label: 'יוסי', tts_text: null, color: null },
  );
  return q;
}

beforeEach(() => invalidateCache(''));

test('ניתוק שיחה מחזיר אישור בלבד', async () => {
  const db = createFakeDb();
  assert.equal(await handleIvrCall({ ...baseCall, hangup: 'yes' }, { db, now }), 'ok');
});

test('אין שאלה פעילה - ברכה, הודעה וניתוק', async () => {
  const db = createFakeDb();
  const res = await handleIvrCall(baseCall, { db, now });
  assert.match(res, /^id_list_message=t-שלום וברוכים הבאים למערכת ההצבעות\.t-אין כרגע הצבעה פעילה/);
  assert.match(res, /g-hangup&$/);
});

test('שאלה פעילה - הקראת שאלה ואפשרויות עם ספרות מותרות בלבד', async () => {
  const db = createFakeDb();
  seedQuestion(db);
  const res = await handleIvrCall(baseCall, { db, now });
  assert.match(res, /^read=t-שלום וברוכים הבאים למערכת ההצבעות\.t-מי לדעתכם ינצח בתחרות\.t-דני, הקישו 1\.t-יוסי, הקישו 2=v_q1111111,/);
  assert.match(res, /,1\.2,3,,,$/); // digits_allowed=1.2, שלושה נסיונות
});

test('קליטת הצבעה - שמירה, אישור, תוצאות באחוזים וניתוק', async () => {
  const db = createFakeDb();
  const q = seedQuestion(db);
  db.tables.votes.push({ id: 900, question_id: q.id, option_digit: 2, phone: '0500000009', weight: 1 });

  const res = await handleIvrCall({ ...baseCall, v_q1111111: '1' }, { db, now });
  assert.equal(db.tables.votes.length, 2);
  const myVote = db.tables.votes.find((v) => v.phone === '0501234567');
  assert.equal(myVote.option_digit, 1);
  assert.match(res, /^id_list_message=t-הצבעתכם נקלטה בהצלחה\.t-ואלו התוצאות נכון לעכשיו\.t-דני, 50 אחוז\.t-יוסי, 50 אחוז\.t-תודה ולהתראות\.g-hangup&$/);
});

test('הצבעה כפולה כשאסור שינוי - הודעה מתאימה', async () => {
  const db = createFakeDb();
  const q = seedQuestion(db);
  db.tables.votes.push({ id: 901, question_id: q.id, option_digit: 2, phone: '0501234567', weight: 1 });
  const res = await handleIvrCall({ ...baseCall, v_q1111111: '1' }, { db, now });
  assert.match(res, /^id_list_message=t-כבר הצבעתם בשאלה זו/);
  assert.equal(db.tables.votes.find((v) => v.phone === '0501234567').option_digit, 2, 'ההצבעה המקורית נשמרת');
});

test('שינוי הצבעה מותר ברמת השאלה - ההצבעה מתעדכנת', async () => {
  const db = createFakeDb();
  const q = seedQuestion(db, { allow_vote_change: true });
  db.tables.votes.push({ id: 902, question_id: q.id, option_digit: 2, phone: '0501234567', weight: 1 });
  const res = await handleIvrCall({ ...baseCall, v_q1111111: '1' }, { db, now });
  assert.equal(db.tables.votes.find((v) => v.phone === '0501234567').option_digit, 1);
  assert.match(res, /הצבעתכם נקלטה בהצלחה/);
});

test('שאלה שנסגרה בזמן - הודעת סיום עם תוצאות', async () => {
  const db = createFakeDb();
  const q = seedQuestion(db, { closes_at: '2026-01-01T19:59:00Z' }); // דקה לפני "עכשיו"
  db.tables.votes.push({ id: 903, question_id: q.id, option_digit: 1, phone: '0500000001', weight: 1 });
  const res = await handleIvrCall(baseCall, { db, now });
  assert.match(res, /^id_list_message=t-ההצבעה הסתיימה\.t-ואלו התוצאות נכון לעכשיו\.t-דני, 100 אחוז/);
});

test('מחייג אנונימי - זיהוי לפי מזהה שיחה', async () => {
  const db = createFakeDb();
  seedQuestion(db);
  await handleIvrCall({ ...baseCall, ApiPhone: 'Anonymous', v_q1111111: '2' }, { db, now });
  assert.equal(db.tables.votes[0].phone, 'anon:call-1');
});

test('שקלול שופטים: 30 אחוז שופטים 70 אחוז קהל', async () => {
  const db = createFakeDb();
  const q = seedQuestion(db, { judges_weight: 30 });
  // קהל: 3 מול 1 (75%/25%), שופט נתן 100 לדני ו-40 ליוסי
  db.tables.votes.push(
    { id: 1, question_id: q.id, option_digit: 1, phone: 'a', weight: 1 },
    { id: 2, question_id: q.id, option_digit: 1, phone: 'b', weight: 1 },
    { id: 3, question_id: q.id, option_digit: 1, phone: 'c', weight: 1 },
    { id: 4, question_id: q.id, option_digit: 2, phone: 'd', weight: 1 },
  );
  db.tables.judges.push({ id: 'j1', name: 'השופט', phone: '0529999999', min_percent: 0, max_percent: 100, can_extend: true, can_control: false, active: true });
  db.tables.judge_scores.push(
    { id: 1, judge_id: 'j1', question_id: q.id, option_digit: 1, score: 100 },
    { id: 2, judge_id: 'j1', question_id: q.id, option_digit: 2, score: 40 },
  );
  const res = await handleIvrCall({ ...baseCall, ApiPhone: '0501111111', v_q1111111: '1' }, { db, now });
  // דני: 4 מתוך 5 קולות = 80% קהל => 80*0.7 + 100*0.3 = 86
  assert.match(res, /t-דני, 86 אחוז/);
});

/* ---------------- שופטים בטלפון ---------------- */

const judgeCall = { ...baseCall, ApiPhone: '0529999999' };

function seedJudge(db, over = {}) {
  const j = {
    id: 'jjjjjjjj-0000-4000-8000-000000000001',
    name: 'רחל',
    phone: '0529999999',
    pin: null,
    min_percent: 40,
    max_percent: 90,
    can_extend: true,
    can_control: false,
    active: true,
    ...over,
  };
  db.tables.judges.push(j);
  return j;
}

test('שופט מזוהה לפי טלפון ומקבל תפריט שופט', async () => {
  const db = createFakeDb();
  seedQuestion(db);
  seedJudge(db);
  const res = await handleIvrCall(judgeCall, { db, now });
  assert.match(res, /^read=t-זוהיתם כשופט רחל\.t-להצבעה רגילה הקישו 1\.t-למתן ציון שופט הקישו 2\.t-להארכת זמן ההצבעה הקישו 3=jm,/);
  assert.match(res, /,1\.2\.3,/); // ללא 4 - אין הרשאת ניהול
});

test('שופט בוחר הצבעה רגילה - עובר למסלול הצבעה', async () => {
  const db = createFakeDb();
  seedQuestion(db);
  seedJudge(db);
  const res = await handleIvrCall({ ...judgeCall, jm: '1' }, { db, now });
  assert.match(res, /^read=.*מי לדעתכם ינצח בתחרות/);
});

test('מסלול ציון שופט: בחירת מתמודד ואז ציון בטווח האישי', async () => {
  const db = createFakeDb();
  seedQuestion(db);
  seedJudge(db);

  const step1 = await handleIvrCall({ ...judgeCall, jm: '2' }, { db, now });
  assert.match(step1, /^read=t-למי מהמתמודדים תרצו לתת ציון\.t-דני, הקישו 1\.t-יוסי, הקישו 2=jso,/);

  const step2 = await handleIvrCall({ ...judgeCall, jm: '2', jso: '1' }, { db, now });
  assert.match(step2, /^read=t-הקישו ציון בין 40 ל 90, ולסיום הקישו סולמית=jsc,/);

  const step3 = await handleIvrCall({ ...judgeCall, jm: '2', jso: '1', jsc: '85' }, { db, now });
  assert.match(step3, /t-הציון 85 עבור דני נשמר בהצלחה/);
  assert.equal(db.tables.judge_scores[0].score, 85);
});

test('ציון שופט מחוץ לטווח - בקשה חוזרת עם דריסת הערך', async () => {
  const db = createFakeDb();
  seedQuestion(db);
  seedJudge(db);
  const res = await handleIvrCall({ ...judgeCall, jm: '2', jso: '1', jsc: '95' }, { db, now });
  assert.match(res, /^read=t-ציון לא בטווח, הקישו ציון בין 40 ל 90=jsc,yes,/);
  assert.equal(db.tables.judge_scores.length, 0);
});

test('הארכת זמן טלפונית - מוסיפה שניות לזמן הסגירה לכלל המשתמשים', async () => {
  const db = createFakeDb();
  const q = seedQuestion(db, { closes_at: '2026-01-01T20:01:00Z' }); // עוד דקה
  seedJudge(db);
  const res = await handleIvrCall({ ...judgeCall, jm: '3', jext: '120' }, { db, now });
  assert.match(res, /t-זמן ההצבעה הוארך ב 120 שניות לכלל המשתמשים/);
  assert.equal(db.tables.questions.find((x) => x.id === q.id).closes_at, '2026-01-01T20:03:00.000Z');
});

test('שופט ללא הרשאת הארכה - האפשרות לא מוצעת והבחירה נופלת להצבעה', async () => {
  const db = createFakeDb();
  seedQuestion(db);
  seedJudge(db, { can_extend: false });
  const menu = await handleIvrCall(judgeCall, { db, now });
  assert.doesNotMatch(menu, /הארכת זמן/);
  const res = await handleIvrCall({ ...judgeCall, jm: '3' }, { db, now });
  assert.match(res, /מי לדעתכם ינצח בתחרות/, 'בחירה לא מורשית מתנהגת כהצבעה רגילה');
});

test('שופט-מנהל: סגירת שאלה והפעלת הבאה בתור', async () => {
  const db = createFakeDb();
  const q1 = seedQuestion(db);
  db.tables.questions.push({
    id: 'q2222222-0000-4000-8000-000000000002',
    title: 'שאלה שנייה', tts_text: null, kind: 'poll', status: 'draft',
    seconds_to_answer: 300, closes_at: null, show_results_live: true,
    judges_weight: 0, survey_group: null, sort_order: 2, created_at: '2026-01-01T00:00:01Z',
  });
  seedJudge(db, { can_control: true });

  const res = await handleIvrCall({ ...judgeCall, jm: '4', jadm: '2' }, { db, now });
  assert.match(res, /t-השאלה שאלה שנייה הופעלה/);
  assert.equal(db.tables.questions.find((x) => x.id === q1.id).status, 'closed');
  const q2 = db.tables.questions.find((x) => x.title === 'שאלה שנייה');
  assert.equal(q2.status, 'active');
  assert.equal(q2.closes_at, '2026-01-01T20:05:00.000Z', 'סגירה אוטומטית לפי seconds_to_answer');
});

/* ---------------- סקר רב-שאלות ---------------- */

test('סקר: אחרי תשובה לשאלה ראשונה נשאלת השנייה, ובסוף סיכום', async () => {
  const db = createFakeDb();
  seedQuestion(db, { survey_group: 'poll-night', kind: 'survey', show_results_live: false });
  db.tables.questions.push({
    id: 'q3333333-0000-4000-8000-000000000003',
    title: 'כמה נהניתם?', tts_text: 'כמה נהניתם הערב', kind: 'survey', status: 'active',
    closes_at: null, show_results_live: false, judges_weight: 0,
    survey_group: 'poll-night', sort_order: 2, created_at: '2026-01-01T00:00:01Z',
  });
  db.tables.options.push(
    { id: 'o31', question_id: 'q3333333-0000-4000-8000-000000000003', digit: 1, label: 'מאוד' },
    { id: 'o32', question_id: 'q3333333-0000-4000-8000-000000000003', digit: 2, label: 'פחות' },
  );

  const step1 = await handleIvrCall(baseCall, { db, now });
  assert.match(step1, /מי לדעתכם ינצח בתחרות.*=v_q1111111,/);

  const step2 = await handleIvrCall({ ...baseCall, v_q1111111: '1' }, { db, now });
  assert.match(step2, /^read=t-כמה נהניתם הערב\.t-מאוד, הקישו 1\.t-פחות, הקישו 2=v_q3333333,/);

  const step3 = await handleIvrCall({ ...baseCall, v_q1111111: '1', v_q3333333: '2' }, { db, now });
  assert.match(step3, /^id_list_message=t-הצבעתכם נקלטה בהצלחה/);
  assert.equal(db.tables.votes.length, 2);
});
