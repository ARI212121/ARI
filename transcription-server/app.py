# -*- coding: utf-8 -*-
"""
שרת תמלול לימות המשיח – רץ על Render (חינם).

הרעיון:
  1. ימות המשיח שולח לשרת בקשה עם הנתיב של קובץ ההקלטה.
  2. השרת מוריד את הקובץ מ-API של ימות (DownloadFile).
  3. מתמלל אותו באמצעות SpeechRecognition + recognize_google (מנוע גוגל, חינם, עברית).
  4. שומר את הטקסט חזרה למערכת ימות כקובץ .tts (UploadTextFile) – כדי שיוקרא למשתמש.
  5. מחזיר לימות תשובה שמקריאה למשתמש את התמלול (id_list_message).

אין כאן שום קוד רגיש – הטוקן של ימות נקרא ממשתני סביבה שמוגדרים ב-Render,
ולא נמצא בקוד עצמו.
"""

import io
import os
import tempfile

import requests
import speech_recognition as sr
from flask import Flask, Response, request

app = Flask(__name__)

# ---------------------------------------------------------------------------
# הגדרות – נקראות ממשתני הסביבה של Render (Environment Variables)
# ---------------------------------------------------------------------------
# YEMOT_TOKEN  – הטוקן של ימות בפורמט  "מספר-מערכת:סיסמה"  (למשל 0733181234:1234)
# YEMOT_OUTPUT_PATH – נתיב ברירת מחדל לשמירת קובץ הטקסט, למשל  ivr2:/5/000.tts
# YEMOT_REC_FOLDER  – (אופציונלי) תיקיית ההקלטות, למשל ivr2:/4 – משמש כשלא נשלח path
# ---------------------------------------------------------------------------
YEMOT_API = "https://www.call2all.co.il/ym/api"
TOKEN = os.environ.get("YEMOT_TOKEN", "")
DEFAULT_OUTPUT = os.environ.get("YEMOT_OUTPUT_PATH", "ivr2:/5/000.tts")
REC_FOLDER = os.environ.get("YEMOT_REC_FOLDER", "")
DEFAULT_LANG = os.environ.get("YEMOT_LANG", "he-IL")


# ---------------------------------------------------------------------------
# עזרי API של ימות
# ---------------------------------------------------------------------------
def yemot_download(path: str) -> bytes:
    """מוריד קובץ מהמערכת של ימות ומחזיר את התוכן הבינארי."""
    resp = requests.get(
        f"{YEMOT_API}/DownloadFile",
        params={"token": TOKEN, "path": path},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.content


def yemot_list_newest(folder: str) -> str:
    """מוצא את הקובץ (wav) העדכני ביותר בתיקייה נתונה של ימות.

    מחזיר נתיב מלא כמו ivr2:/4/007.wav, או מחרוזת ריקה אם לא נמצא.
    """
    resp = requests.get(
        f"{YEMOT_API}/GetIVR2Dir",
        params={"token": TOKEN, "path": folder},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    files = data.get("files") or data.get("data") or []
    wavs = []
    for f in files:
        name = f.get("name") if isinstance(f, dict) else str(f)
        if name and name.lower().endswith(".wav"):
            wavs.append(name)
    if not wavs:
        return ""
    wavs.sort()  # שמות רצים כמו 000,001,002 – האחרון הוא העדכני
    return f"{folder}/{wavs[-1]}"


def yemot_upload_text(target_path: str, text: str) -> None:
    """שומר טקסט כקובץ במערכת של ימות. סיומת .tts גורמת לימות להקריא אותו."""
    requests.post(
        f"{YEMOT_API}/UploadTextFile",
        data={"token": TOKEN, "what": target_path, "contents": text},
        timeout=30,
    ).raise_for_status()


# ---------------------------------------------------------------------------
# התמלול עצמו
# ---------------------------------------------------------------------------
def transcribe_audio(audio_bytes: bytes, lang: str) -> str:
    """מקבל בייטים של קובץ אודיו ומחזיר טקסט מתומלל בעברית."""
    recognizer = sr.Recognizer()

    # נסיון ראשון: לקרוא ישירות כ-WAV (ימות שומר הקלטות ב-WAV, אז לרוב זה מספיק).
    try:
        with sr.AudioFile(io.BytesIO(audio_bytes)) as source:
            audio = recognizer.record(source)
    except Exception:
        # נסיון גיבוי: המרה עם pydub+ffmpeg (רק אם הפורמט אינו WAV תקני).
        from pydub import AudioSegment  # ייבוא עצל – לא נדרש אם ה-WAV תקין

        seg = AudioSegment.from_file(io.BytesIO(audio_bytes))
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            seg.set_channels(1).set_frame_rate(16000).export(tmp.name, format="wav")
            with sr.AudioFile(tmp.name) as source:
                audio = recognizer.record(source)

    # recognize_google – מנוע התמלול החינמי של גוגל
    return recognizer.recognize_google(audio, language=lang)


# ---------------------------------------------------------------------------
# נתיבים (Routes)
# ---------------------------------------------------------------------------
@app.route("/")
def home():
    """בדיקת חיים – גם משמש את סקריפט ה-keep-alive כדי שהשרת לא ירדם."""
    return "Yemot transcription server is running.", 200


@app.route("/health")
def health():
    return "OK", 200


@app.route("/transcribe", methods=["GET", "POST"])
def transcribe():
    """
    הנתיב הראשי. ימות קורא לו עם הפרמטרים הבאים (query string):

      path      – נתיב הקובץ להורדה (למשל ivr2:/4/000.wav). אם חסר – נחפש בתיקייה.
      save_to   – (אופציונלי) לאן לשמור את קובץ הטקסט. ברירת מחדל: YEMOT_OUTPUT_PATH.
      lang      – (אופציונלי) שפת התמלול. ברירת מחדל he-IL.
      format    – "yemot" (ברירת מחדל, מחזיר פקודת ימות) או "json" (לבדיקות).

    התשובה בפורמט ימות מקריאה למשתמש את התמלול (id_list_message).
    """
    # תמיכה גם ב-GET (ימות) וגם ב-POST
    args = request.values

    if not TOKEN:
        return _yemot_msg("שגיאה: לא הוגדר טוקן בשרת.", args)

    path = args.get("path", "").strip()
    if not path and REC_FOLDER:
        try:
            path = yemot_list_newest(REC_FOLDER)
        except Exception as exc:  # noqa: BLE001
            return _reply(args, ok=False, text=f"שגיאה באיתור הקובץ: {exc}")

    if not path:
        return _reply(args, ok=False, text="לא התקבל נתיב קובץ לתמלול.")

    save_to = args.get("save_to", "").strip() or DEFAULT_OUTPUT
    lang = args.get("lang", "").strip() or DEFAULT_LANG

    try:
        audio_bytes = yemot_download(path)
        text = transcribe_audio(audio_bytes, lang)
    except sr.UnknownValueError:
        return _reply(args, ok=False, text="לא הצלחתי להבין את ההקלטה, נסו שוב.")
    except Exception as exc:  # noqa: BLE001
        return _reply(args, ok=False, text=f"שגיאה בתמלול: {exc}")

    # שמירת התמלול חזרה לימות כקובץ טקסט/TTS
    try:
        yemot_upload_text(save_to, text)
    except Exception as exc:  # noqa: BLE001
        # גם אם השמירה נכשלה – עדיין נקריא למשתמש את התמלול
        return _reply(args, ok=True, text=text,
                      note=f"(אזהרה: השמירה נכשלה: {exc})")

    return _reply(args, ok=True, text=text)


# ---------------------------------------------------------------------------
# עזרי תשובה
# ---------------------------------------------------------------------------
def _reply(args, ok: bool, text: str, note: str = ""):
    """בונה תשובה בהתאם לפורמט המבוקש (ימות או JSON)."""
    if args.get("format") == "json":
        import json
        body = json.dumps({"ok": ok, "text": text, "note": note},
                          ensure_ascii=False)
        return Response(body, content_type="application/json; charset=utf-8")
    return _yemot_msg(text, args)


def _yemot_msg(text: str, args):
    """
    מחזיר פקודת ימות שמקריאה טקסט למשתמש.
    id_list_message=t-<טקסט>  => ימות מקריא את הטקסט ב-TTS.
    לאחר מכן מעביר לשלוחה שמוגדרת ב-NEXT_EXT (אם הוגדרה).
    """
    # ניקוי תווים שעלולים לשבור את פורמט ימות
    clean = text.replace(".", " ").replace("=", " ").replace("&", " ").strip()
    parts = [f"id_list_message=t-{clean}."]
    next_ext = os.environ.get("YEMOT_NEXT_EXT", "").strip()
    if next_ext:
        parts.append(f"go_to_folder={next_ext}")
    body = "&".join(parts)
    return Response(body, content_type="text/plain; charset=utf-8")


if __name__ == "__main__":
    # הרצה מקומית לבדיקות בלבד. ב-Render מריצים דרך gunicorn.
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
