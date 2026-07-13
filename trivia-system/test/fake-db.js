/**
 * אמולטור PostgREST זעיר בזיכרון - לבדיקות בלבד.
 * תומך בתחביר שהקוד משתמש בו: eq / is.true, select, order, limit, הטמעות.
 */

let idCounter = 1;
const uuid = () => `00000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`;

export function createFakeDb(seed = {}) {
  const tables = {
    settings: [],
    questions: [],
    options: [],
    votes: [],
    judges: [],
    judge_scores: [],
    participants: [],
    ...seed,
  };

  function parseQuery(query) {
    const filters = [];
    let order = null;
    let limit = Infinity;
    for (const part of String(query || '').split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const key = decodeURIComponent(part.slice(0, eq));
      const val = decodeURIComponent(part.slice(eq + 1));
      if (key === 'select') continue;
      if (key === 'order') { order = val; continue; }
      if (key === 'limit') { limit = Number(val); continue; }
      if (val.startsWith('eq.')) filters.push((r) => String(r[key]) === val.slice(3));
      else if (val === 'is.true') filters.push((r) => r[key] === true);
      else if (val === 'is.false') filters.push((r) => r[key] === false);
      else if (val === 'is.null') filters.push((r) => r[key] == null);
      else throw new Error(`fake-db: filter לא נתמך: ${part}`);
    }
    return { filters, order, limit };
  }

  function applyQuery(table, query) {
    const { filters, order, limit } = parseQuery(query);
    let rows = tables[table].filter((r) => filters.every((f) => f(r)));
    if (order) {
      const specs = order.split(',').map((s) => s.split('.'));
      rows = [...rows].sort((a, b) => {
        for (const [col, dir] of specs) {
          const av = a[col]; const bv = b[col];
          if (av === bv) continue;
          const cmp = av > bv ? 1 : -1;
          return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }
    return rows.slice(0, limit);
  }

  function embed(table, query, rows) {
    const select = new URLSearchParams(query).get('select') || '*';
    return rows.map((row) => {
      const out = { ...row };
      if (table === 'questions' && select.includes('options(')) {
        out.options = tables.options.filter((o) => o.question_id === row.id).map((o) => ({ ...o }));
      }
      if (table === 'judge_scores' && select.includes('judges(')) {
        out.judges = tables.judges.find((j) => j.id === row.judge_id) || null;
      }
      return out;
    });
  }

  // ברירות מחדל של הסכמה (כמו DEFAULT בפוסטגרס)
  const COLUMN_DEFAULTS = {
    judges: { active: true, can_extend: true, can_control: false, min_percent: 0, max_percent: 100, pin: null },
    questions: { status: 'draft', kind: 'poll', judges_weight: 0, sort_order: 0, show_results_live: true, closes_at: null, survey_group: null, correct_digit: null, seconds_to_answer: null, allow_vote_change: null, announce_time_left: false, tts_text: null },
    votes: { weight: 1, source: 'phone' },
    options: { tts_text: null, color: null, image_url: null },
  };

  const db = {
    tables,
    async select(table, query) {
      return embed(table, query, applyQuery(table, query));
    },
    async selectOne(table, query) {
      const rows = await db.select(table, query);
      return rows[0] ?? null;
    },
    async insert(table, rows, { upsertOn } = {}) {
      const inserted = [];
      for (const row of rows) {
        const newRow = {
          id: table === 'votes' || table === 'judge_scores' ? idCounter++ : uuid(),
          created_at: new Date().toISOString(),
          ...(COLUMN_DEFAULTS[table] || {}),
          ...row,
        };
        if (upsertOn) {
          const keys = upsertOn.split(',');
          const existing = tables[table].find((r) => keys.every((k) => String(r[k]) === String(row[k])));
          if (existing) {
            Object.assign(existing, row);
            inserted.push(existing);
            continue;
          }
        } else {
          const uniqueKeys = { options: ['question_id', 'digit'], votes: ['question_id', 'phone'] }[table];
          if (uniqueKeys && tables[table].some((r) => uniqueKeys.every((k) => String(r[k]) === String(row[k])))) {
            throw new Error(`fake-db: duplicate key on ${table}`);
          }
        }
        tables[table].push(newRow);
        inserted.push(newRow);
      }
      return inserted;
    },
    async update(table, query, patch) {
      const rows = applyQuery(table, query);
      for (const r of rows) Object.assign(r, patch);
      return rows;
    },
    async delete(table, query) {
      const toDelete = new Set(applyQuery(table, query));
      tables[table] = tables[table].filter((r) => !toDelete.has(r));
      return null;
    },
    async rpc(fn, args) {
      if (fn === 'vote_counts') {
        const groups = new Map();
        for (const v of tables.votes.filter((v) => v.question_id === args.q_id)) {
          const g = groups.get(v.option_digit) || { option_digit: v.option_digit, votes: 0, total_weight: 0 };
          g.votes += 1;
          g.total_weight += Number(v.weight ?? 1);
          groups.set(v.option_digit, g);
        }
        return [...groups.values()].sort((a, b) => a.option_digit - b.option_digit);
      }
      throw new Error(`fake-db: rpc לא נתמך: ${fn}`);
    },
  };
  return db;
}
