# Dockerfile אופציונלי – השתמשו בו רק אם ההקלטות של ימות אינן WAV תקני
# וצריך המרה עם ffmpeg. בברירת מחדל אין צורך בו (Render עובד ישר עם requirements.txt).
#
# כדי להשתמש: ב-Render בחרו Runtime = Docker במקום Python.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

ENV PORT=10000
CMD gunicorn app:app --bind 0.0.0.0:$PORT --timeout 120 --workers 1
