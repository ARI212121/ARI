import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeTts, ttsMsg, readTap, readStt, idListMessage, playAndHangup,
  hangup, goToFolder, joinMessages, parseYemotParams,
} from '../src/yemot.js';

test('sanitizeTts מסיר תווים אסורים בימות (נקודה, מקף, גרשיים, אמפרסנד)', () => {
  assert.equal(sanitizeTts('שלום. מה-נשמע? "טוב" & יפה | כן'), 'שלום מה נשמע? טוב יפה כן');
  assert.equal(sanitizeTts('50%'), '50 אחוז');
});

test('פורמט read במצב הקשה תואם בדיוק לפרוטוקול ימות', () => {
  // פורמט הייחוס מאומת מול yemot-router2: read=t-hello world=val_1,no,,1,7,No,no,no,,,,,None,
  const r = readTap([ttsMsg('hello world')], 'val_1', { allowEmpty: true });
  assert.equal(r, 'read=t-hello world=val_1,no,,1,7,No,no,no,,,,Ok,None,');
});

test('read עם ספרות מותרות ומספר נסיונות', () => {
  const r = readTap([ttsMsg('בחרו')], 'v_abc', {
    maxDigits: 1, digitsAllowed: [1, 2, 3], amountAttempts: 3, secWait: 10,
  });
  assert.equal(r, 'read=t-בחרו=v_abc,no,1,1,10,No,no,no,,1.2.3,3,,,');
});

test('read חוזר עם re_enter_if_exists=yes דורס ערך קיים', () => {
  const r = readTap([ttsMsg('שוב')], 'jsc', { reEnterIfExists: true, maxDigits: 3 });
  assert.equal(r, 'read=t-שוב=jsc,yes,3,1,7,No,no,no,,,,,,');
});

test('read במצב זיהוי דיבור (stt)', () => {
  const r = readStt([ttsMsg('אמרו את שמכם')], 'say_name', { lang: 'he-IL' });
  assert.equal(r, 'read=t-אמרו את שמכם=say_name,no,voice,he-IL,,,,,');
});

test('id_list_message מסתיים באמפרסנד ומרובה הודעות מופרד בנקודה', () => {
  assert.equal(idListMessage([ttsMsg('אחת'), ttsMsg('שתיים')]), 'id_list_message=t-אחת.t-שתיים&');
});

test('playAndHangup משרשר g-hangup בסוף ההודעות', () => {
  assert.equal(playAndHangup([ttsMsg('להתראות')]), 'id_list_message=t-להתראות.g-hangup&');
});

test('go_to_folder וניתוק', () => {
  assert.equal(goToFolder('/2'), 'go_to_folder=/2');
  assert.equal(hangup(), 'go_to_folder=hangup');
});

test('joinMessages מדלג על ערכים ריקים', () => {
  assert.equal(joinMessages([ttsMsg('א'), null, ttsMsg('ב')]), 't-א.t-ב');
});

test('parseYemotParams קורא GET query', async () => {
  const req = new Request('https://x.test/ivr?ApiCallId=abc&ApiPhone=0501234567&val_1=3');
  const p = await parseYemotParams(req);
  assert.equal(p.ApiCallId, 'abc');
  assert.equal(p.ApiPhone, '0501234567');
  assert.equal(p.val_1, '3');
});

test('parseYemotParams קורא POST בפורמט טפסים', async () => {
  const req = new Request('https://x.test/ivr', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'ApiCallId=abc&ApiPhone=0501234567&jm=2',
  });
  const p = await parseYemotParams(req);
  assert.equal(p.jm, '2');
});
