-- ============================================================
-- מערכת הצבעות/טריוויה טלפונית - סכמת Supabase
-- הרצה חד-פעמית: SQL Editor בלוח הבקרה של Supabase → Run
-- ============================================================

-- הגדרות מערכת (מפתח/ערך) - כל טקסטי ה-IVR וההתנהגות נשלטים מכאן
create table if not exists settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- שאלות / סקרים / טריוויה
create table if not exists questions (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  tts_text           text,                -- נוסח ההקראה בטלפון (אם שונה מהכותרת)
  kind               text not null default 'poll' check (kind in ('poll','trivia','survey')),
  status             text not null default 'draft' check (status in ('draft','active','closed','archived')),
  correct_digit      int,                 -- לטריוויה: הספרה הנכונה
  seconds_to_answer  int,                 -- משך ברירת מחדל בהפעלה (null = ללא הגבלה)
  opened_at          timestamptz,
  closes_at          timestamptz,         -- כולל הארכות זמן
  announce_time_left boolean not null default false,
  show_results_live  boolean not null default true,
  allow_vote_change  boolean,             -- null = לפי הגדרה גלובלית
  judges_weight      int not null default 0 check (judges_weight between 0 and 100),
  survey_group       text,                -- קיבוץ שאלות לסקר רב-שלבי
  sort_order         int not null default 0,
  created_at         timestamptz not null default now()
);

create index if not exists idx_questions_status on questions (status, sort_order);

-- אפשרויות תשובה (מתמודדים)
create table if not exists options (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions (id) on delete cascade,
  digit       int not null check (digit between 0 and 9),
  label       text not null,
  tts_text    text,               -- נוסח הקראה (אם שונה מהתווית)
  color       text,               -- צבע בתצוגה החיה
  image_url   text,
  unique (question_id, digit)
);

create index if not exists idx_options_question on options (question_id);

-- הצבעות. phone הוא מפתח המצביע (טלפון אמיתי / anon:callid / sim:xxx / web:xxx)
create table if not exists votes (
  id            bigint generated always as identity primary key,
  question_id   uuid not null references questions (id) on delete cascade,
  option_digit  int not null,
  phone         text not null,
  display_phone text,
  source        text not null default 'phone',
  weight        numeric not null default 1,
  created_at    timestamptz not null default now(),
  unique (question_id, phone)
);

create index if not exists idx_votes_question on votes (question_id, option_digit);

-- שופטים: טווח אחוזים אישי מוגדר מראש + הרשאות טלפוניות
create table if not exists judges (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  phone        text not null unique,   -- זיהוי אוטומטי לפי מספר מחייג
  pin          text,                   -- קוד לממשק הרשת (רשות)
  min_percent  int not null default 0 check (min_percent between 0 and 100),
  max_percent  int not null default 100 check (max_percent between 0 and 100),
  can_extend   boolean not null default true,
  can_control  boolean not null default false,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  check (min_percent <= max_percent)
);

-- ציוני שופטים (ציון לכל אפשרות/מתמודד, בטווח האישי של השופט)
create table if not exists judge_scores (
  id           bigint generated always as identity primary key,
  judge_id     uuid not null references judges (id) on delete cascade,
  question_id  uuid not null references questions (id) on delete cascade,
  option_digit int not null,
  score        numeric not null,
  updated_at   timestamptz not null default now(),
  unique (judge_id, question_id, option_digit)
);

create index if not exists idx_judge_scores_question on judge_scores (question_id);

-- משתתפים - שמות ניתנים לשינוי בזמן אמת מהממשק
create table if not exists participants (
  phone        text primary key,
  display_name text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz
);

-- ============================================================
-- אגרגציה בצד המסד - קריטי לעומסים גדולים:
-- ה-Worker לא מושך את כל שורות ההצבעה, רק סיכומים.
-- ============================================================
create or replace function vote_counts(q_id uuid)
returns table (option_digit int, votes bigint, total_weight numeric)
language sql stable
as $$
  select option_digit, count(*)::bigint as votes, coalesce(sum(weight), 0) as total_weight
  from votes
  where question_id = q_id
  group by option_digit
  order by option_digit;
$$;

-- ============================================================
-- אבטחה: RLS פעיל על הכל, בלי שום policy -
-- רק מפתח ה-service_role (שנמצא ב-Cloudflare בלבד) ניגש לנתונים.
-- ============================================================
alter table settings      enable row level security;
alter table questions     enable row level security;
alter table options       enable row level security;
alter table votes         enable row level security;
alter table judges        enable row level security;
alter table judge_scores  enable row level security;
alter table participants  enable row level security;

-- ============================================================
-- נתוני דוגמה להתחלה מהירה (אפשר למחוק מהממשק)
-- ============================================================
insert into questions (title, tts_text, kind, status, judges_weight, sort_order)
values ('מי המתמודד הטוב ביותר?', 'מי המתמודד הטוב ביותר', 'poll', 'draft', 30, 1)
on conflict do nothing;

insert into options (question_id, digit, label, color)
select id, d.digit, d.label, d.color
from questions q,
     (values (1, 'מתמודד ראשון', '#4f8ef7'),
             (2, 'מתמודד שני',  '#f7654f'),
             (3, 'מתמודד שלישי', '#3ecf8e')) as d(digit, label, color)
where q.title = 'מי המתמודד הטוב ביותר?'
on conflict do nothing;
