/**
 * ליבת ה-IVR: מטפלת בכל בקשה מימות המשיח ומחזירה מחרוזת פרוטוקול.
 *
 * העיצוב חסר-מצב (stateless) בכוונה: ימות צוברת את כל הערכים שנקלטו
 * בשלוחה ושולחת אותם בכל בקשה, ולכן זיהוי השלב נעשה לפי אילו ערכים
 * כבר קיימים בבקשה. זה מאפשר ל-Worker לרוץ על אלפי שיחות במקביל
 * בלי שום זיכרון שיחה בשרת.
 *
 * שמות ערכים בשימוש:
 *   jm            - בחירת תפריט שופט
 *   jso / jsc     - שופט: בחירת מתמודד + ציון
 *   jext          - שופט: שניות הארכה
 *   jadm          - שופט-מנהל: פעולת ניהול
 *   say_name      - הקלטת שם בדיבור (STT)
 *   v_<qid8>      - הצבעה לשאלה מסוימת (ייחודי פר שאלה)
 */

import {
  ttsMsg, readTap, readStt, playAndHangup, idListMessage, hangup, sanitizeTts,
} from './yemot.js';
import {
  getSettings, getActiveQuestion, getActiveSurveyQuestions, getJudgeByPhone,
  isQuestionOpen, secondsLeft, computeResults, invalidateCache,
} from './db.js';

const qVal = (question) => `v_${String(question.id).replace(/-/g, '').slice(0, 8)}`;

export async function handleIvrCall(params, { db, now = () => new Date() } = {}) {
  // ניתוק שיחה - אישור בלבד
  if (params.hangup === 'yes') return 'ok';

  const phone = params.ApiPhone || '';
  const callId = params.ApiCallId || '';
  const voterKey = !phone || phone === 'Anonymous' ? `anon:${callId}` : phone;

  const [settings, judge] = await Promise.all([
    getSettings(db),
    getJudgeByPhone(db, phone),
  ]);

  const ctx = { db, settings, params, phone, callId, voterKey, judge, now };

  // ---- מסלול שופט ----
  if (judge) {
    const choice = params.jm;
    if (!choice) return judgeMenu(ctx);
    if (choice === '2') return judgeScoreFlow(ctx);
    if (choice === '3' && judge.can_extend) return judgeExtendFlow(ctx);
    if (choice === '4' && judge.can_control) return judgeAdminFlow(ctx);
    // choice === '1' או כל דבר אחר → הצבעה רגילה
  }

  return votingFlow(ctx);
}

/* ================================================================ */
/* מסלול הצבעה                                                       */
/* ================================================================ */

async function votingFlow(ctx) {
  const { db, settings, params, now } = ctx;

  const question = await getActiveQuestion(db);
  if (!question) {
    return playAndHangup([ttsMsg(settings.greeting_text), ttsMsg(settings.no_active_text)]);
  }

  // רצף סקר: כמה שאלות פעילות באותה קבוצה
  const surveyQuestions = question.survey_group
    ? await getActiveSurveyQuestions(db, question.survey_group)
    : [question];

  // בקשת שם בדיבור (אם מופעל בהגדרות והמצביע חדש)
  if (settings.ask_name_enabled && ctx.phone && ctx.phone !== 'Anonymous' && !params.say_name) {
    const known = await db.selectOne(
      'participants',
      `phone=eq.${encodeURIComponent(ctx.phone)}&select=phone,display_name`,
    );
    if (!known?.display_name) {
      return readStt(
        [ttsMsg(settings.greeting_text), ttsMsg(settings.ask_name_text)],
        'say_name',
        { lang: 'he-IL' },
      );
    }
  }
  if (params.say_name && params.say_name !== 'None' && ctx.phone && ctx.phone !== 'Anonymous') {
    await db.insert(
      'participants',
      [{ phone: ctx.phone, display_name: sanitizeTts(params.say_name).slice(0, 60), last_seen: now().toISOString() }],
      { upsertOn: 'phone' },
    ).catch(() => {});
  }

  // מציאת השאלה הראשונה ברצף שעדיין לא נענתה בשיחה הזו
  for (let i = 0; i < surveyQuestions.length; i++) {
    const q = surveyQuestions[i];
    const val = params[qVal(q)];

    if (val === undefined) {
      return await askQuestion(ctx, q, i === 0);
    }

    const handled = await saveVote(ctx, q, val);
    if (handled) return handled; // הודעת שגיאה/כבר-הצביע שמנתקת
  }

  // כל השאלות נענו
  return finishCall(ctx, surveyQuestions[surveyQuestions.length - 1]);
}

async function askQuestion(ctx, question, withGreeting) {
  const { settings } = ctx;

  if (!isQuestionOpen(question, ctx.now())) {
    return closedMessage(ctx, question);
  }

  const messages = [];
  if (withGreeting && settings.greeting_text) messages.push(ttsMsg(settings.greeting_text));
  messages.push(ttsMsg(question.tts_text || question.title));

  const digits = [];
  for (const opt of question.options || []) {
    digits.push(opt.digit);
    messages.push(ttsMsg(`${opt.tts_text || opt.label}, הקישו ${opt.digit}`));
  }

  const left = secondsLeft(question, ctx.now());
  if (left !== null && left <= 120 && question.announce_time_left) {
    messages.push(ttsMsg(`נותרו ${left} שניות להצבעה`));
  }

  return readTap(messages, qVal(question), {
    maxDigits: 1,
    minDigits: 1,
    digitsAllowed: digits.length ? digits : null,
    secWait: 10,
    amountAttempts: 3,
  });
}

async function saveVote(ctx, question, rawVal) {
  const { db, settings } = ctx;
  const digit = Number(rawVal);
  const option = (question.options || []).find((o) => Number(o.digit) === digit);

  if (!option) {
    // לא אמור לקרות בזכות digits_allowed, אבל ליתר ביטחון
    return readTap(
      [ttsMsg(settings.invalid_choice_text), ttsMsg(question.tts_text || question.title)],
      qVal(question),
      { maxDigits: 1, minDigits: 1, reEnterIfExists: true, digitsAllowed: (question.options || []).map((o) => o.digit) },
    );
  }

  if (!isQuestionOpen(question, ctx.now())) {
    return closedMessage(ctx, question);
  }

  const allowChange = question.allow_vote_change ?? settings.allow_vote_change;

  const existing = await db.selectOne(
    'votes',
    `question_id=eq.${question.id}&phone=eq.${encodeURIComponent(ctx.voterKey)}&select=id,option_digit`,
  );

  if (existing && !allowChange) {
    if (Number(existing.option_digit) === digit) return null; // אותה הצבעה - המשך רצף
    return playAndHangup([
      ttsMsg(settings.already_voted_text),
      ...(await resultsMessages(ctx, question)),
      ttsMsg(settings.goodbye_text),
    ]);
  }

  await db.insert(
    'votes',
    [{
      question_id: question.id,
      option_digit: digit,
      phone: ctx.voterKey,
      display_phone: ctx.phone === 'Anonymous' ? null : ctx.phone,
      source: 'phone',
      weight: 1,
    }],
    { upsertOn: 'question_id,phone' },
  );

  if (ctx.phone && ctx.phone !== 'Anonymous') {
    await db.insert(
      'participants',
      [{ phone: ctx.phone, last_seen: ctx.now().toISOString() }],
      { upsertOn: 'phone' },
    ).catch(() => {});
  }

  return null; // המשך לשאלה הבאה ברצף / סיום
}

async function finishCall(ctx, lastQuestion) {
  const { settings } = ctx;
  return playAndHangup([
    ttsMsg(settings.vote_saved_text),
    ...(await resultsMessages(ctx, lastQuestion)),
    ttsMsg(settings.goodbye_text),
  ]);
}

async function closedMessage(ctx, question) {
  const { settings } = ctx;
  return playAndHangup([
    ttsMsg(settings.closed_text),
    ...(await resultsMessages(ctx, question)),
    ttsMsg(settings.goodbye_text),
  ]);
}

/** הודעות תוצאות מוקראות בטלפון (אם מופעל) */
async function resultsMessages(ctx, question) {
  const { db, settings } = ctx;
  if (!settings.say_results_on_phone || !question) return [];
  if (question.show_results_live === false && question.status === 'active') return [];
  try {
    const results = await computeResults(db, question);
    if (!results || !results.total_votes) return [];
    const msgs = [ttsMsg(settings.results_intro_text)];
    for (const opt of results.options) {
      msgs.push(ttsMsg(`${opt.label}, ${Math.round(opt.final_pct)} אחוז`));
    }
    return msgs;
  } catch {
    return [];
  }
}

/* ================================================================ */
/* מסלולי שופט                                                       */
/* ================================================================ */

function judgeMenu(ctx) {
  const { settings, judge } = ctx;
  const messages = [
    ttsMsg(`${settings.judge_menu_text} ${judge.name || ''}`),
    ttsMsg('להצבעה רגילה הקישו 1'),
    ttsMsg('למתן ציון שופט הקישו 2'),
  ];
  const allowed = [1, 2];
  if (judge.can_extend) {
    messages.push(ttsMsg('להארכת זמן ההצבעה הקישו 3'));
    allowed.push(3);
  }
  if (judge.can_control) {
    messages.push(ttsMsg('לתפריט ניהול הקישו 4'));
    allowed.push(4);
  }
  return readTap(messages, 'jm', { maxDigits: 1, minDigits: 1, digitsAllowed: allowed });
}

async function judgeScoreFlow(ctx) {
  const { db, settings, params, judge } = ctx;
  const question = await getActiveQuestion(db);
  if (!question) return playAndHangup([ttsMsg(settings.no_active_text)]);

  const options = question.options || [];
  const min = Number(judge.min_percent) || 0;
  const max = Number(judge.max_percent ?? 100);

  // בחירת מתמודד/אפשרות (אם יש יותר מאחת)
  let optionDigit;
  if (options.length === 1) {
    optionDigit = Number(options[0].digit);
  } else if (params.jso === undefined) {
    const messages = [ttsMsg('למי מהמתמודדים תרצו לתת ציון')];
    for (const o of options) messages.push(ttsMsg(`${o.tts_text || o.label}, הקישו ${o.digit}`));
    return readTap(messages, 'jso', {
      maxDigits: 1, minDigits: 1, digitsAllowed: options.map((o) => o.digit),
    });
  } else {
    optionDigit = Number(params.jso);
    if (!options.some((o) => Number(o.digit) === optionDigit)) {
      return readTap([ttsMsg(settings.invalid_choice_text)], 'jso', {
        maxDigits: 1, minDigits: 1, reEnterIfExists: true, digitsAllowed: options.map((o) => o.digit),
      });
    }
  }

  // קליטת ציון בטווח האישי של השופט
  if (params.jsc === undefined) {
    return readTap(
      [ttsMsg(`${settings.judge_score_prompt} ${min} ל ${max}, ולסיום הקישו סולמית`)],
      'jsc',
      { maxDigits: 3, minDigits: 1, secWait: 10 },
    );
  }

  const score = Number(params.jsc);
  if (!Number.isFinite(score) || score < min || score > max) {
    return readTap(
      [ttsMsg(`ציון לא בטווח, ${settings.judge_score_prompt} ${min} ל ${max}`)],
      'jsc',
      { maxDigits: 3, minDigits: 1, reEnterIfExists: true, secWait: 10 },
    );
  }

  await db.insert(
    'judge_scores',
    [{ judge_id: judge.id, question_id: question.id, option_digit: optionDigit, score }],
    { upsertOn: 'judge_id,question_id,option_digit' },
  );
  invalidateCache('results');

  const optLabel = options.find((o) => Number(o.digit) === optionDigit)?.label || '';
  return playAndHangup([
    ttsMsg(`הציון ${score} עבור ${optLabel} נשמר בהצלחה`),
    ttsMsg(ctx.settings.goodbye_text),
  ]);
}

async function judgeExtendFlow(ctx) {
  const { db, settings, params } = ctx;
  const question = await getActiveQuestion(db);
  if (!question) return playAndHangup([ttsMsg(settings.no_active_text)]);

  if (params.jext === undefined) {
    return readTap(
      [ttsMsg(`${settings.extend_prompt}, ולסיום הקישו סולמית`)],
      'jext',
      { maxDigits: 4, minDigits: 1, secWait: 10 },
    );
  }

  const seconds = Number(params.jext);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
    return readTap([ttsMsg('ערך לא חוקי, נסו שוב')], 'jext', {
      maxDigits: 4, minDigits: 1, reEnterIfExists: true, secWait: 10,
    });
  }

  const nowMs = ctx.now().getTime();
  const base = question.closes_at ? Math.max(new Date(question.closes_at).getTime(), nowMs) : nowMs;
  const newCloses = new Date(base + seconds * 1000).toISOString();

  await db.update('questions', `id=eq.${question.id}`, {
    closes_at: newCloses,
    status: 'active',
  });
  invalidateCache('active_question');
  invalidateCache('survey');

  return playAndHangup([
    ttsMsg(`זמן ההצבעה הוארך ב ${seconds} שניות לכלל המשתמשים`),
    ttsMsg(settings.goodbye_text),
  ]);
}

async function judgeAdminFlow(ctx) {
  const { db, settings, params } = ctx;

  if (params.jadm === undefined) {
    return readTap([
      ttsMsg('תפריט ניהול'),
      ttsMsg('לסגירת ההצבעה הנוכחית הקישו 1'),
      ttsMsg('להפעלת השאלה הבאה בתור הקישו 2'),
      ttsMsg('לשמיעת מצב התוצאות הקישו 3'),
    ], 'jadm', { maxDigits: 1, minDigits: 1, digitsAllowed: [1, 2, 3] });
  }

  const question = await getActiveQuestion(db);

  if (params.jadm === '1') {
    if (!question) return playAndHangup([ttsMsg(settings.no_active_text)]);
    await db.update('questions', `id=eq.${question.id}`, {
      status: 'closed',
      closes_at: ctx.now().toISOString(),
    });
    invalidateCache('');
    return playAndHangup([ttsMsg('ההצבעה נסגרה'), ttsMsg(settings.goodbye_text)]);
  }

  if (params.jadm === '2') {
    if (question) {
      await db.update('questions', `id=eq.${question.id}`, {
        status: 'closed',
        closes_at: ctx.now().toISOString(),
      });
    }
    const next = await db.selectOne(
      'questions',
      'status=eq.draft&select=*&order=sort_order.asc,created_at.asc',
    );
    invalidateCache('');
    if (!next) return playAndHangup([ttsMsg('אין שאלה נוספת בתור'), ttsMsg(settings.goodbye_text)]);
    const patch = { status: 'active', opened_at: ctx.now().toISOString() };
    if (next.seconds_to_answer) {
      patch.closes_at = new Date(ctx.now().getTime() + next.seconds_to_answer * 1000).toISOString();
    }
    await db.update('questions', `id=eq.${next.id}`, patch);
    invalidateCache('');
    return playAndHangup([
      ttsMsg(`השאלה ${next.title} הופעלה`),
      ttsMsg(settings.goodbye_text),
    ]);
  }

  if (params.jadm === '3') {
    if (!question) return playAndHangup([ttsMsg(settings.no_active_text)]);
    const results = await computeResults(db, question);
    const msgs = [ttsMsg(settings.results_intro_text)];
    for (const opt of results?.options || []) {
      msgs.push(ttsMsg(`${opt.label}, ${Math.round(opt.final_pct)} אחוז, ${opt.votes} מצביעים`));
    }
    return playAndHangup([...msgs, ttsMsg(settings.goodbye_text)]);
  }

  return playAndHangup([ttsMsg(settings.invalid_choice_text)]);
}
