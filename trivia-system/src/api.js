/**
 * REST API עבור ממשקי הרשת: ניהול, צפייה חיה, שליטה ושופטים.
 *
 * הרשאות:
 *   /api/public/*  - פתוח (נתוני תצוגה בלבד, ללא פרטים אישיים)
 *   /api/judge/*   - טלפון + קוד אישי של שופט
 *   /api/admin/*   - Bearer ADMIN_TOKEN (סוד של Cloudflare)
 */

import {
  getSettings, setSetting, getActiveQuestion, computeResults,
  invalidateCache, cached, secondsLeft, SETTING_DEFAULTS,
} from './db.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Judge-Phone, X-Judge-Pin',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Cache-Control': 'no-store',
  },
});

const err = (message, status = 400) => json({ error: message }, status);

function timingSafeEqual(a, b) {
  const sa = String(a ?? ''); const sb = String(b ?? '');
  if (sa.length !== sb.length) return false;
  let out = 0;
  for (let i = 0; i < sa.length; i++) out |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return out === 0;
}

export async function handleApi(request, env, db) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  if (method === 'OPTIONS') return json({ ok: true });

  let body = {};
  if (method === 'POST' || method === 'PATCH') {
    try { body = await request.json(); } catch { body = {}; }
  }

  try {
    /* ---------------- ציבורי ---------------- */

    if (path === '/public/state' && method === 'GET') {
      return json(await publicState(db));
    }

    /* ---------------- שופטים ---------------- */

    if (path.startsWith('/judge/')) {
      return await judgeApi(path, method, body, request, db);
    }

    /* ---------------- ניהול ---------------- */

    if (path.startsWith('/admin/')) {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (!env.ADMIN_TOKEN || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
        return err('אין הרשאה - טוקן ניהול שגוי', 401);
      }
      return await adminApi(path, method, body, url, db);
    }

    return err('נתיב לא קיים', 404);
  } catch (e) {
    return err(`שגיאת שרת: ${e.message}`, 500);
  }
}

/* ================================================================ */
/* מצב ציבורי - דף הצפייה מושך כל שנייה, לכן במטמון קצר             */
/* ================================================================ */

async function publicState(db) {
  return cached('public_state', 1000, async () => {
    const [settings, question] = await Promise.all([getSettings(db), getActiveQuestion(db)]);

    const showResults = settings.results_visible_on_display !== false
      && question?.show_results_live !== false;

    let results = null;
    if (question) {
      results = await computeResults(db, question);
      if (!showResults && question.status === 'active' && !settings.reveal_correct) {
        // מסתירים אחוזים אבל משאירים מונה הצבעות כללי
        results = {
          ...results,
          options: results.options.map((o) => ({
            ...o, votes: null, audience_pct: null, judge_avg: null, judge_scores: [], final_pct: null,
          })),
          hidden: true,
        };
      }
    }

    return {
      server_time: new Date().toISOString(),
      settings: {
        system_name: settings.system_name,
        display_theme: settings.display_theme,
        display_message: settings.display_message,
        reveal_correct: settings.reveal_correct,
        results_visible_on_display: settings.results_visible_on_display,
      },
      question: question ? {
        id: question.id,
        title: question.title,
        kind: question.kind,
        status: question.status,
        closes_at: question.closes_at,
        seconds_left: secondsLeft(question),
        judges_weight: question.judges_weight,
        correct_digit: settings.reveal_correct ? question.correct_digit : null,
        options: (question.options || []).map((o) => ({
          digit: o.digit, label: o.label, color: o.color, image_url: o.image_url,
        })),
      } : null,
      results,
    };
  });
}

/* ================================================================ */
/* API שופטים                                                        */
/* ================================================================ */

async function judgeAuth(request, body, db) {
  const phone = request.headers.get('X-Judge-Phone') || body.phone;
  const pin = request.headers.get('X-Judge-Pin') || body.pin;
  if (!phone) return null;
  const judge = await db.selectOne(
    'judges',
    `phone=eq.${encodeURIComponent(phone)}&active=is.true&select=*`,
  );
  if (!judge) return null;
  if (judge.pin && !timingSafeEqual(String(pin ?? ''), String(judge.pin))) return null;
  return judge;
}

async function judgeApi(path, method, body, request, db) {
  const judge = await judgeAuth(request, body, db);
  if (!judge) return err('שופט לא מזוהה או קוד שגוי', 401);

  const publicJudge = {
    id: judge.id, name: judge.name, min_percent: judge.min_percent,
    max_percent: judge.max_percent, can_extend: judge.can_extend, can_control: judge.can_control,
  };

  if (path === '/judge/login' && method === 'POST') {
    return json({ judge: publicJudge });
  }

  if (path === '/judge/state' && method === 'GET') {
    const question = await getActiveQuestion(db);
    let myScores = [];
    if (question) {
      myScores = await db.select(
        'judge_scores',
        `judge_id=eq.${judge.id}&question_id=eq.${question.id}&select=option_digit,score`,
      );
    }
    return json({
      judge: publicJudge,
      question: question ? {
        id: question.id, title: question.title, status: question.status,
        seconds_left: secondsLeft(question), judges_weight: question.judges_weight,
        options: (question.options || []).map((o) => ({ digit: o.digit, label: o.label, color: o.color })),
      } : null,
      my_scores: myScores,
    });
  }

  if (path === '/judge/score' && method === 'POST') {
    const { question_id, option_digit, score } = body;
    const min = Number(judge.min_percent) || 0;
    const max = Number(judge.max_percent ?? 100);
    const s = Number(score);
    if (!question_id || option_digit === undefined) return err('חסרים נתונים');
    if (!Number.isFinite(s) || s < min || s > max) {
      return err(`הציון חייב להיות בטווח האישי שלך: ${min}-${max}`);
    }
    await db.insert(
      'judge_scores',
      [{ judge_id: judge.id, question_id, option_digit: Number(option_digit), score: s }],
      { upsertOn: 'judge_id,question_id,option_digit' },
    );
    invalidateCache('public_state');
    return json({ ok: true });
  }

  if (path === '/judge/extend' && method === 'POST') {
    if (!judge.can_extend) return err('אין לך הרשאת הארכה', 403);
    const seconds = Number(body.seconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) return err('מספר שניות לא חוקי');
    const question = await getActiveQuestion(db);
    if (!question) return err('אין שאלה פעילה');
    const nowMs = Date.now();
    const base = question.closes_at ? Math.max(new Date(question.closes_at).getTime(), nowMs) : nowMs;
    await db.update('questions', `id=eq.${question.id}`, {
      closes_at: new Date(base + seconds * 1000).toISOString(),
      status: 'active',
    });
    invalidateCache('');
    return json({ ok: true });
  }

  return err('נתיב לא קיים', 404);
}

/* ================================================================ */
/* API ניהול                                                         */
/* ================================================================ */

async function adminApi(path, method, body, url, db) {
  const seg = path.split('/').filter(Boolean); // ['admin', ...]

  /* ----- הגדרות ----- */
  if (path === '/admin/settings' && method === 'GET') {
    return json({ settings: await getSettings(db), defaults: SETTING_DEFAULTS });
  }
  if (path === '/admin/settings' && method === 'POST') {
    for (const [key, value] of Object.entries(body)) await setSetting(db, key, value);
    invalidateCache('');
    return json({ ok: true });
  }

  /* ----- שאלות ----- */
  if (path === '/admin/questions' && method === 'GET') {
    const rows = await db.select(
      'questions',
      'select=*,options(*)&order=sort_order.asc,created_at.asc',
    );
    for (const q of rows || []) q.options?.sort((a, b) => a.digit - b.digit);
    return json({ questions: rows || [] });
  }

  if (path === '/admin/questions' && method === 'POST') {
    const { options = [], ...q } = body;
    const [created] = await db.insert('questions', [cleanQuestion(q)]);
    if (options.length) {
      await db.insert('options', options.map((o, i) => cleanOption(o, created.id, i)));
    }
    invalidateCache('');
    return json({ question: created });
  }

  if (seg[1] === 'questions' && seg[2] && !seg[3]) {
    const id = seg[2];
    if (method === 'PATCH') {
      const { options, ...q } = body;
      if (Object.keys(q).length) await db.update('questions', `id=eq.${id}`, cleanQuestion(q, true));
      if (Array.isArray(options)) {
        await db.delete('options', `question_id=eq.${id}`);
        if (options.length) await db.insert('options', options.map((o, i) => cleanOption(o, id, i)));
      }
      invalidateCache('');
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await db.delete('questions', `id=eq.${id}`);
      invalidateCache('');
      return json({ ok: true });
    }
  }

  if (seg[1] === 'questions' && seg[2] && seg[3] && method === 'POST') {
    const id = seg[2];
    const action = seg[3];

    if (action === 'activate') {
      // סוגרים כל שאלה פעילה אחרת (מלבד סקרים באותה קבוצה אם צוין keep_group)
      const current = await db.select('questions', 'status=eq.active&select=id,survey_group');
      const target = await db.selectOne('questions', `id=eq.${id}&select=*`);
      if (!target) return err('שאלה לא נמצאה', 404);
      for (const c of current || []) {
        if (c.id === id) continue;
        if (body.keep_group && target.survey_group && c.survey_group === target.survey_group) continue;
        await db.update('questions', `id=eq.${c.id}`, { status: 'closed', closes_at: new Date().toISOString() });
      }
      const patch = { status: 'active', opened_at: new Date().toISOString(), closes_at: null };
      const secs = body.seconds_to_answer ?? target.seconds_to_answer;
      if (secs) patch.closes_at = new Date(Date.now() + Number(secs) * 1000).toISOString();
      await db.update('questions', `id=eq.${id}`, patch);
      invalidateCache('');
      return json({ ok: true, closes_at: patch.closes_at });
    }

    if (action === 'close') {
      await db.update('questions', `id=eq.${id}`, { status: 'closed', closes_at: new Date().toISOString() });
      invalidateCache('');
      return json({ ok: true });
    }

    if (action === 'extend') {
      const seconds = Number(body.seconds);
      if (!Number.isFinite(seconds) || seconds === 0) return err('מספר שניות לא חוקי');
      const q = await db.selectOne('questions', `id=eq.${id}&select=closes_at`);
      if (!q) return err('שאלה לא נמצאה', 404);
      const nowMs = Date.now();
      const base = q.closes_at ? Math.max(new Date(q.closes_at).getTime(), nowMs) : nowMs;
      const closes = new Date(base + seconds * 1000).toISOString();
      await db.update('questions', `id=eq.${id}`, { closes_at: closes, status: 'active' });
      invalidateCache('');
      return json({ ok: true, closes_at: closes });
    }

    if (action === 'reset-votes') {
      await db.delete('votes', `question_id=eq.${id}`);
      await db.delete('judge_scores', `question_id=eq.${id}`);
      invalidateCache('');
      return json({ ok: true });
    }

    if (action === 'results') {
      const q = await db.selectOne('questions', `id=eq.${id}&select=*,options(*)`);
      if (!q) return err('שאלה לא נמצאה', 404);
      q.options?.sort((a, b) => a.digit - b.digit);
      return json({ results: await computeResults(db, q) });
    }

    if (action === 'simulate-vote') {
      // כלי בדיקה: הדמיית מצביע
      const digit = Number(body.option_digit);
      const fake = body.phone || `sim:${Math.random().toString(36).slice(2, 10)}`;
      await db.insert('votes', [{
        question_id: id, option_digit: digit, phone: fake, source: 'simulator', weight: 1,
      }], { upsertOn: 'question_id,phone' });
      invalidateCache('public_state');
      return json({ ok: true });
    }
  }

  /* ----- שופטים ----- */
  if (path === '/admin/judges' && method === 'GET') {
    return json({ judges: await db.select('judges', 'select=*&order=created_at.asc') || [] });
  }
  if (path === '/admin/judges' && method === 'POST') {
    const [created] = await db.insert('judges', [cleanJudge(body)]);
    invalidateCache('judge');
    return json({ judge: created });
  }
  if (seg[1] === 'judges' && seg[2]) {
    if (method === 'PATCH') {
      await db.update('judges', `id=eq.${seg[2]}`, cleanJudge(body, true));
      invalidateCache('judge');
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await db.delete('judges', `id=eq.${seg[2]}`);
      invalidateCache('judge');
      return json({ ok: true });
    }
  }

  /* ----- משתתפים (שינוי שמות בזמן אמת) ----- */
  if (path === '/admin/participants' && method === 'GET') {
    return json({
      participants: await db.select('participants', 'select=*&order=last_seen.desc.nullslast&limit=500') || [],
    });
  }
  if (path === '/admin/participants' && method === 'POST') {
    const { phone, display_name } = body;
    if (!phone) return err('חסר טלפון');
    await db.insert('participants', [{ phone, display_name: display_name ?? null }], { upsertOn: 'phone' });
    return json({ ok: true });
  }
  if (seg[1] === 'participants' && seg[2] && method === 'DELETE') {
    await db.delete('participants', `phone=eq.${encodeURIComponent(seg[2])}`);
    return json({ ok: true });
  }

  /* ----- הצבעות בודדות ----- */
  if (path === '/admin/votes' && method === 'GET') {
    const qid = url.searchParams.get('question_id');
    if (!qid) return err('חסר question_id');
    return json({
      votes: await db.select('votes', `question_id=eq.${qid}&select=*&order=created_at.desc&limit=1000`) || [],
    });
  }
  if (seg[1] === 'votes' && seg[2] && method === 'DELETE') {
    await db.delete('votes', `id=eq.${seg[2]}`);
    invalidateCache('public_state');
    return json({ ok: true });
  }

  /* ----- ייצוא CSV ----- */
  if (seg[1] === 'export' && seg[2] && method === 'GET') {
    const votes = await db.select(
      'votes',
      `question_id=eq.${seg[2]}&select=phone,display_phone,option_digit,source,weight,created_at&order=created_at.asc`,
    );
    const lines = ['phone,option_digit,source,weight,created_at'];
    for (const v of votes || []) {
      lines.push([v.display_phone || v.phone, v.option_digit, v.source, v.weight, v.created_at].join(','));
    }
    return new Response('﻿' + lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="votes-${seg[2]}.csv"`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  /* ----- סקירה כללית ----- */
  if (path === '/admin/overview' && method === 'GET') {
    const [questions, judges, participants, active] = await Promise.all([
      db.select('questions', 'select=id,status'),
      db.select('judges', 'select=id&active=is.true'),
      db.select('participants', 'select=phone&limit=1'),
      getActiveQuestion(db),
    ]);
    return json({
      total_questions: questions?.length || 0,
      active_question: active ? { id: active.id, title: active.title } : null,
      judges_count: judges?.length || 0,
      results: active ? await computeResults(db, active) : null,
    });
  }

  return err('נתיב לא קיים', 404);
}

/* ----- ניקוי קלט ----- */

function cleanQuestion(q, partial = false) {
  const allowed = [
    'title', 'tts_text', 'kind', 'status', 'correct_digit', 'seconds_to_answer',
    'closes_at', 'show_results_live', 'allow_vote_change', 'judges_weight',
    'sort_order', 'survey_group', 'announce_time_left',
  ];
  const out = {};
  for (const k of allowed) if (k in q) out[k] = q[k];
  if (!partial) {
    out.title = String(q.title || 'שאלה חדשה');
    out.kind = out.kind || 'poll';
    out.status = out.status || 'draft';
  }
  return out;
}

function cleanOption(o, questionId, index) {
  return {
    question_id: questionId,
    digit: Number(o.digit ?? index + 1),
    label: String(o.label || `אפשרות ${index + 1}`),
    tts_text: o.tts_text || null,
    color: o.color || null,
    image_url: o.image_url || null,
  };
}

function cleanJudge(j, partial = false) {
  const allowed = ['name', 'phone', 'pin', 'min_percent', 'max_percent', 'can_extend', 'can_control', 'active'];
  const out = {};
  for (const k of allowed) if (k in j) out[k] = j[k];
  if (!partial) {
    out.name = String(j.name || 'שופט');
    out.phone = String(j.phone || '');
    out.min_percent = Number(j.min_percent ?? 0);
    out.max_percent = Number(j.max_percent ?? 100);
  }
  return out;
}
