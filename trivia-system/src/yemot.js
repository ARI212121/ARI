/**
 * שכבת פרוטוקול "מודול API" של ימות המשיח.
 *
 * הפרוטוקול (מאומת מול התיעוד הרשמי בפורום המפתחים f2.freeivr.co.il
 * ומול מימושי הייחוס yemot-router2):
 *
 * ימות שולחת לכתובת api_link בקשת GET (או POST אם api_url_post=yes) עם:
 *   ApiCallId    - מזהה ייחודי לכל השיחה
 *   ApiPhone     - מספר המחייג (או "Anonymous" בחסוי)
 *   ApiDID       - מספר המערכת הראשי
 *   ApiRealDID   - המספר שאליו חייגו בפועל
 *   ApiExtension - נתיב השלוחה הנוכחית
 *   hangup=yes   - נשלח בניתוק שיחה (אם api_hangup_send פעיל)
 *   וכן כל הערכים (val_name) שנאספו עד כה בשלוחה הנוכחית.
 *
 * השרת מחזיר טקסט פשוט (UTF-8) עם פעולה אחת או יותר מופרדות ב-&:
 *   read=<messages>=<options>       - השמעה + קליטת נתון
 *   id_list_message=<messages>&     - השמעת הודעות בלבד
 *   go_to_folder=<path|hangup>      - מעבר שלוחה / ניתוק
 *
 * <messages> = הודעות מופרדות בנקודה, כל אחת בפורמט <type>-<data>:
 *   t-טקסט (הקראה TTS), f-קובץ, n-מספר (מאה חמש), d-ספרות (אחת אפס חמש),
 *   m-הודעת מערכת, g-מעבר שלוחה, a-אותיות, s-speech, z-זמנים, h-מוזיקה
 *
 * תווים אסורים בטקסט TTS: נקודה, מקף, גרש, גרשיים, אמפרסנד, פייפ.
 */

const TTS_INVALID = /[.\-"'&|=]/g;

/** ניקוי טקסט להקראת TTS - הסרת תווים שמפילים את ימות */
export function sanitizeTts(text) {
  return String(text ?? '')
    .replace(/%/g, ' אחוז')
    .replace(TTS_INVALID, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** הודעת טקסט מוקראת */
export const ttsMsg = (text) => `t-${sanitizeTts(text)}`;
/** השמעת מספר בצורה מילולית (105 = מאה וחמש) */
export const numberMsg = (n) => `n-${String(n).replace(/[^\d.]/g, '')}`;
/** הקראת ספרות אחת אחת (105 = אחד אפס חמש) */
export const digitsMsg = (n) => `d-${String(n).replace(/\D/g, '')}`;
/** השמעת קובץ מהמערכת (ללא סיומת) */
export const fileMsg = (path) => `f-${path}`;

/** צירוף הודעות למחרוזת אחת בפורמט ימות (מופרדות בנקודה) */
export function joinMessages(messages) {
  return messages.filter(Boolean).join('.');
}

/**
 * בניית פקודת read במצב הקשה (tap).
 * הפורמט המדויק:
 * read=<messages>=<val_name>,<re_enter yes/no>,<max_digits>,<min_digits>,
 *      <sec_wait>,<playback_mode>,<block_asterisk yes/no>,<block_zero yes/no>,
 *      <replace_char>,<digits_allowed מופרד בנקודות>,<amount_attempts>,
 *      <allow_empty "Ok">,<empty_val>,<block_change_keyboard>
 */
export function readTap(messages, valName, {
  reEnterIfExists = false,
  maxDigits = '',
  minDigits = 1,
  secWait = 7,
  playbackMode = 'No', // No / Number / Digits / File / TTS / Alpha / HebrewKeyboard...
  blockAsterisk = false,
  blockZero = false,
  replaceChar = '',
  digitsAllowed = null, // מערך ספרות מותרות
  amountAttempts = '',
  allowEmpty = false,
  emptyVal = 'None',
} = {}) {
  const ops = [
    valName,
    reEnterIfExists ? 'yes' : 'no',
    maxDigits,
    minDigits,
    secWait,
    playbackMode,
    blockAsterisk ? 'yes' : 'no',
    blockZero ? 'yes' : 'no',
    replaceChar,
    Array.isArray(digitsAllowed) ? digitsAllowed.join('.') : '',
    amountAttempts,
    allowEmpty ? 'Ok' : '',
    allowEmpty ? String(emptyVal) : '',
    '',
  ];
  return `read=${joinMessages(messages)}=${ops.join(',')}`;
}

/**
 * בניית פקודת read במצב זיהוי דיבור (stt).
 * read=<messages>=<val_name>,<re_enter>,voice,<lang>,<block_typing>,<max_digits>,...
 */
export function readStt(messages, valName, { lang = '', blockTyping = false, maxDigits = '' } = {}) {
  const ops = [valName, 'no', 'voice', lang, blockTyping ? 'no' : '', maxDigits, '', '', ''];
  return `read=${joinMessages(messages)}=${ops.join(',')}`;
}

/**
 * בניית פקודת read במצב הקלטה.
 * read=<messages>=<val_name>,<re_enter>,record,<path>,<file_name>,
 *      <no_confirm "no">,<save_on_hangup "yes">,<append "yes">,<min_len>,<max_len>
 */
export function readRecord(messages, valName, {
  path = '',
  fileName = '',
  noConfirmMenu = true,
  saveOnHangup = false,
  minLength = '',
  maxLength = '',
} = {}) {
  const ops = [
    valName, 'no', 'record', path, fileName,
    noConfirmMenu ? 'no' : '', saveOnHangup ? 'yes' : '', '', minLength, maxLength,
  ];
  return `read=${joinMessages(messages)}=${ops.join(',')}`;
}

/** השמעת הודעות וחזרה לתפריט האב (id_list_message מסתיים ב-&) */
export function idListMessage(messages) {
  return `id_list_message=${joinMessages(messages)}&`;
}

/** השמעת הודעות וניתוק */
export function playAndHangup(messages) {
  return `id_list_message=${joinMessages(messages)}.g-hangup&`;
}

/** מעבר לשלוחה אחרת */
export function goToFolder(target) {
  return `go_to_folder=${target}`;
}

/** ניתוק שיחה */
export function hangup() {
  return 'go_to_folder=hangup';
}

/** תשובת טקסט תקינה לימות (Content-Type טקסט, UTF-8) */
export function ivrResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** חילוץ פרמטרים מבקשת ימות - GET (query) או POST (body) */
export async function parseYemotParams(request) {
  const url = new URL(request.url);
  const params = {};
  for (const [k, v] of url.searchParams) params[k] = v;
  if (request.method === 'POST') {
    const ct = request.headers.get('content-type') || '';
    try {
      if (ct.includes('application/json')) {
        Object.assign(params, await request.json());
      } else {
        const body = await request.text();
        for (const [k, v] of new URLSearchParams(body)) params[k] = v;
      }
    } catch { /* גוף ריק */ }
  }
  return params;
}
