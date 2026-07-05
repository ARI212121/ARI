import tkinter as tk
from tkinter import ttk, messagebox
import feedparser
import webbrowser
import threading
from datetime import datetime

# רשימת מקורות RSS ישראלים מובילים
NEWS_SOURCES = {
    "Ynet": "http://www.ynet.co.il/Integration/StoryRss2.xml",
    "Walla": "https://rss.walla.co.il/feed/1?type=main",
    "N12 (Mako)": "http://rcs.mako.co.il/rss/31750a2610f26110VgnVCM1000005201000aRCRD.xml",
    "Maariv": "https://www.maariv.co.il/Rss/RssFeedsMainArticles",
    "Israel Hayom": "https://www.israelhayom.co.il/rss.xml"
}

class NewsCheckerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("בודק חדשות יומיות - ישראל")
        self.root.geometry("800x600")
        self.root.configure(bg="#f4f4f4")

        # RTL support trick in tkinter
        self.root.option_add("*Font", "Arial 12")

        self.create_widgets()

    def create_widgets(self):
        # Header
        header_frame = tk.Frame(self.root, bg="#2c3e50", pady=15)
        header_frame.pack(fill=tk.X)

        tk.Label(header_frame, text="חדשות היום במבט מהיר", font=("Arial", 20, "bold"), fg="white", bg="#2c3e50").pack()

        # Toolbar
        toolbar = tk.Frame(self.root, bg="#ecf0f1", pady=10)
        toolbar.pack(fill=tk.X)

        self.refresh_btn = ttk.Button(toolbar, text="רענן חדשות", command=self.refresh_news)
        self.refresh_btn.pack(side=tk.RIGHT, padx=20)

        self.status_var = tk.StringVar()
        self.status_var.set("מוכן.")
        tk.Label(toolbar, textvariable=self.status_var, bg="#ecf0f1", fg="gray").pack(side=tk.LEFT, padx=20)

        # Main content
        content_frame = tk.Frame(self.root, padx=20, pady=20)
        content_frame.pack(fill=tk.BOTH, expand=True)

        # Treeview for news items
        columns = ("source", "title", "time")
        self.tree = ttk.Treeview(content_frame, columns=columns, show="headings")
        self.tree.heading("source", text="מקור")
        self.tree.heading("title", text="כותרת")
        self.tree.heading("time", text="זמן/תאריך")

        self.tree.column("source", width=120, anchor=tk.E)
        self.tree.column("title", width=500, anchor=tk.E)
        self.tree.column("time", width=140, anchor=tk.CENTER)

        # Scrollbar
        scrollbar = ttk.Scrollbar(content_frame, orient=tk.VERTICAL, command=self.tree.yview)
        self.tree.configure(yscroll=scrollbar.set)

        scrollbar.pack(side=tk.LEFT, fill=tk.Y)
        self.tree.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)

        # Event bindings
        self.tree.bind("<Double-1>", self.on_double_click)

        # Items storage for URLs
        self.news_items = []

        # Fetch news on startup
        self.refresh_news()

    def refresh_news(self):
        self.refresh_btn.config(state=tk.DISABLED)
        self.status_var.set("טוען חדשות... נא להמתין.")

        # Clear existing
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.news_items.clear()

        # Run in thread to prevent UI freezing
        threading.Thread(target=self.fetch_news_thread, daemon=True).start()

    def fetch_news_thread(self):
        all_news = []

        for source_name, url in NEWS_SOURCES.items():
            try:
                feed = feedparser.parse(url)
                # Take top 10 items from each source
                for entry in feed.entries[:10]:
                    # Extract date if available
                    pub_date = entry.get('published', entry.get('updated', ''))

                    all_news.append({
                        "source": source_name,
                        "title": entry.title,
                        "link": entry.link,
                        "date": pub_date
                    })
            except Exception as e:
                print(f"Error fetching from {source_name}: {e}")

        # Update UI in main thread
        self.root.after(0, self.update_ui_with_news, all_news)

    def update_ui_with_news(self, news_data):
        self.news_items = news_data

        for i, item in enumerate(self.news_items):
            self.tree.insert("", tk.END, iid=i, values=(item['source'], item['title'], item['date']))

        self.status_var.set(f"עודכן לאחרונה: {datetime.now().strftime('%H:%M:%S')} - נטענו {len(self.news_items)} כתבות.")
        self.refresh_btn.config(state=tk.NORMAL)

    def on_double_click(self, event):
        item_id = self.tree.selection()[0]
        item = self.news_items[int(item_id)]
        url = item['link']
        if url:
            webbrowser.open(url)

if __name__ == "__main__":
    root = tk.Tk()
    app = NewsCheckerApp(root)
    root.mainloop()
