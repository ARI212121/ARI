@echo off
echo מתחיל ביצירת קובץ ההרצה עבור בודק החדשות...
pip install pyinstaller feedparser
pyinstaller --noconfirm --onedir --windowed --name "NewsChecker" "news_checker.py"
echo סיום! הקובץ זמין בתיקיית dist
pause