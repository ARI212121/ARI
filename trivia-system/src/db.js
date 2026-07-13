/**
 * שכבת גישה ל-Supabase דרך PostgREST.
 * ה-Worker מחזיק את מפתח ה-service_role כסוד של Cloudflare (הרשאה חד-פעמית),
 * והדפדפנים/ימות לעולם לא נוגעים ב-Supabase ישירות.
 */

export function createDb(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_KEY;

  async function rest(path, { method = 'GET', body, headers = {}, expectJson = true } = {}) {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    if (!expectJson || res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    /** שליפה: select('questions', 'status=eq.active&select=*') */
    select: (table, query) => rest(`${table}?${query}`),

    selectOne: async (table, query) => {
      const rows = await rest(`${table}?${query}&limit=1`);
      return rows?.[0] ?? null;
    },

    insert: (table, rows, { upsertOn, ignoreDuplicates = false } = {}) =>
      rest(table + (upsertOn ? `?on_conflict=${upsertOn}` : ''), {
        method: 'POST',
        body: rows,
        headers: {
          Prefer: upsertOn
            ? `resolution=${ignoreDuplicates ? 'ignore-duplicates' : 'merge-duplicates'},return=representation`
            : 'return=representation',
        },
      }),

    update: (table, query, patch) =>
      rest(`${table}?${query}`, {
        method: 'PATCH',
        body: patch,
        headers: { Prefer: 'return=representation' },
      }),

    delete: (table, query) =>
      rest(`${table}?${query}`, { method: 'DELETE', expectJson: false }),

    /** קריאה לפונקציית SQL (RPC) - משמש לאגרגציה בצד המסד לעומסים גדולים */
    rpc: (fn, args) => rest(`rpc/${fn}`, { method: 'POST', body: args ?? {} }),
  };
}

/* ------------------------------------------------------------------ */
/* מטמון קצר-מועד ברמת ה-isolate: חוסך קריאות מסד בעומס שיחות/צפיות.  */
/* ------------------------------------------------------------------ */

const memCache = new Map();

export async function cached(cacheKey, ttlMs, loader) {
  const hit = memCache.get(cacheKey);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = await loader();
  memCache.set(cacheKey, { at: now, value });
  if (memCache.size > 500) {
    for (const [k, v] of memCache) if (now - v.at > 60_000) memCache.delete(k);
  }
  return value;
}

export function invalidateCache(prefix = '') {
  for (const k of memCache.keys()) if (k.startsWith(prefix)) memCache.delete(k);
}

/* ------------------------------------------------------------------ */
/* פונקציות דומיין משותפות ל-IVR ול-API                                */
/* ------------------------------------------------------------------ */

export const SETTING_DEFAULTS = {
  system_name: 'מערכת הצבעות חכמה',
  greeting_text: 'שלום וברוכים הבאים למערכת ההצבעות',
  no_active_text: 'אין כרגע הצבעה פעילה, נסו שוב מאוחר יותר',
  closed_text: 'ההצבעה הסתיימה',
  already_voted_text: 'כבר הצבעתם בשאלה זו',
  vote_saved_text: 'הצבעתכם נקלטה בהצלחה',
  invalid_choice_text: 'בחירה לא חוקית',
  goodbye_text: 'תודה ולהתראות',
  results_intro_text: 'ואלו התוצאות נכון לעכשיו',
  say_results_on_phone: true,       // השמעת תוצאות למצביע אחרי הצבעה
  allow_vote_change: false,          // ברירת מחדל גלובלית - שינוי הצבעה
  ask_name_enabled: false,           // בקשת שם בדיבור ממצביע חדש
  ask_name_text: 'לאחר הצליל אמרו את שמכם ולסיום הקישו סולמית',
  judge_menu_text: 'זוהיתם כשופט',
  judge_score_prompt: 'הקישו ציון בין',
  extend_prompt: 'הקישו בכמה שניות להאריך את זמן ההצבעה',
  results_visible_on_display: true,  // האם דף הצפייה מציג תוצאות כרגע
  display_theme: 'dark',
  display_message: '',               // כיתוב רץ בדף הצפייה
  reveal_correct: false,             // חשיפת תשובה נכונה (טריוויה)
};

export async function getSettings(db) {
  const rows = await cached('settings', 2000, () => db.select('settings', 'select=key,value'));
  const merged = { ...SETTING_DEFAULTS };
  for (const row of rows || []) merged[row.key] = row.value?.v ?? row.value;
  return merged;
}

export async function setSetting(db, key, value) {
  await db.insert('settings', [{ key, value: { v: value } }], { upsertOn: 'key' });
  invalidateCache('settings');
}

/** השאלה הפעילה + אפשרויותיה (במטמון קצר - קריטי לעומס שיחות) */
export async function getActiveQuestion(db) {
  return cached('active_question', 1500, async () => {
    const q = await db.selectOne(
      'questions',
      'status=eq.active&select=*,options(*)&order=sort_order.asc,created_at.asc',
    );
    if (q?.options) q.options.sort((a, b) => a.digit - b.digit);
    return q;
  });
}

/** כל השאלות הפעילות בקבוצת סקר, ממוינות */
export async function getActiveSurveyQuestions(db, group) {
  return cached(`survey:${group}`, 1500, async () => {
    const rows = await db.select(
      'questions',
      `status=eq.active&survey_group=eq.${encodeURIComponent(group)}&select=*,options(*)&order=sort_order.asc,created_at.asc`,
    );
    for (const q of rows || []) q.options?.sort((a, b) => a.digit - b.digit);
    return rows || [];
  });
}

/** האם השאלה סגורה מבחינת זמן (כולל הארכות) */
export function isQuestionOpen(question, now = new Date()) {
  if (!question || question.status !== 'active') return false;
  if (!question.closes_at) return true;
  return new Date(question.closes_at).getTime() > now.getTime();
}

/** זמן שנותר בשניות (null = ללא הגבלה) */
export function secondsLeft(question, now = new Date()) {
  if (!question?.closes_at) return null;
  return Math.max(0, Math.round((new Date(question.closes_at).getTime() - now.getTime()) / 1000));
}

export async function getJudgeByPhone(db, phone) {
  if (!phone || phone === 'Anonymous') return null;
  return cached(`judge:${phone}`, 3000, () =>
    db.selectOne('judges', `phone=eq.${encodeURIComponent(phone)}&active=is.true&select=*`),
  );
}

/**
 * חישוב תוצאות משוקללות של שאלה.
 * הציון הסופי לכל אפשרות:
 *   final = audience% * (100 - judges_weight)/100 + judgeAvg * judges_weight/100
 * כאשר ציוני השופטים כפופים לטווח האישי שהוגדר מראש לכל שופט.
 */
export async function computeResults(db, question) {
  if (!question) return null;
  const [voteRows, scoreRows] = await Promise.all([
    db.rpc('vote_counts', { q_id: question.id }),
    db.select(
      'judge_scores',
      `question_id=eq.${question.id}&select=option_digit,score,judge_id,judges(name,min_percent,max_percent)`,
    ),
  ]);

  const totalWeight = (voteRows || []).reduce((s, r) => s + Number(r.total_weight), 0);
  const judgesWeight = Number(question.judges_weight) || 0;

  const options = (question.options || []).map((opt) => {
    const vr = (voteRows || []).find((r) => Number(r.option_digit) === Number(opt.digit));
    const votes = vr ? Number(vr.votes) : 0;
    const weight = vr ? Number(vr.total_weight) : 0;
    const audiencePct = totalWeight > 0 ? (weight / totalWeight) * 100 : 0;

    const optScores = (scoreRows || []).filter((s) => Number(s.option_digit) === Number(opt.digit));
    const judgeAvg = optScores.length
      ? optScores.reduce((s, r) => s + Number(r.score), 0) / optScores.length
      : null;

    const finalPct = judgesWeight > 0 && judgeAvg !== null
      ? audiencePct * (100 - judgesWeight) / 100 + judgeAvg * judgesWeight / 100
      : audiencePct;

    return {
      digit: opt.digit,
      label: opt.label,
      color: opt.color,
      votes,
      audience_pct: round1(audiencePct),
      judge_avg: judgeAvg === null ? null : round1(judgeAvg),
      judge_scores: optScores.map((s) => ({
        judge: s.judges?.name || '',
        score: Number(s.score),
      })),
      final_pct: round1(finalPct),
      is_correct: question.correct_digit !== null && Number(question.correct_digit) === Number(opt.digit),
    };
  });

  return {
    question_id: question.id,
    title: question.title,
    kind: question.kind,
    status: question.status,
    judges_weight: judgesWeight,
    total_votes: (voteRows || []).reduce((s, r) => s + Number(r.votes), 0),
    seconds_left: secondsLeft(question),
    closes_at: question.closes_at,
    options,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
