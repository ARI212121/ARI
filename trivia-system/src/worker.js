/**
 * Cloudflare Worker - נקודת הכניסה.
 *
 * נתיבים:
 *   /ivr     - נקודת הקצה של ימות המשיח (מודול API, GET או POST)
 *   /api/*   - REST API לממשקי הרשת
 *   /*       - קבצים סטטיים (דפי הניהול/צפייה/שליטה/שופטים) מתוך public/
 */

import { handleIvrCall } from './ivr.js';
import { handleApi } from './api.js';
import { createDb } from './db.js';
import { parseYemotParams, ivrResponse, playAndHangup, ttsMsg } from './yemot.js';
import { PAGES } from './pages.generated.js';

const PAGE_MIME = { '.html': 'text/html; charset=utf-8' };

function servePage(pathname) {
  let name = pathname.replace(/^\/+/, '');
  if (name === '' || name === '/') name = 'index.html';
  const html = PAGES[name];
  if (html === undefined) return null;
  return new Response(html, {
    headers: { 'Content-Type': PAGE_MIME['.html'], 'Cache-Control': 'no-cache' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/ivr' || url.pathname === '/ivr/') {
      return handleIvrRequest(request, env);
    }

    if (url.pathname.startsWith('/api/')) {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
        return new Response(JSON.stringify({ error: 'חסרות הגדרות SUPABASE_URL / SUPABASE_SERVICE_KEY' }), {
          status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      return handleApi(request, env, createDb(env));
    }

    // בדיקת חיים
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, time: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // דפי הממשקים - מוטמעים בתוך ה-Worker (ללא תלות בהגדרת assets)
    const page = servePage(url.pathname);
    if (page) return page;

    // גיבוי: אם בכל זאת מוגדר assets binding, ננסה אותו
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('לא נמצא', {
      status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

async function handleIvrRequest(request, env) {
  try {
    const params = await parseYemotParams(request);
    const db = createDb(env);
    const responseText = await handleIvrCall(params, { db });
    return ivrResponse(responseText);
  } catch (e) {
    // לעולם לא מפילים שיחה - משמיעים הודעת שגיאה ידידותית ומנתקים
    console.error('IVR error:', e);
    return ivrResponse(playAndHangup([ttsMsg('אירעה שגיאה זמנית, אנא נסו שוב בעוד מספר רגעים')]));
  }
}
