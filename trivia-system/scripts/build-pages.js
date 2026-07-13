/**
 * בונה את src/pages.generated.js - הטמעת כל דפי ה-HTML כמחרוזות בתוך ה-Worker.
 * כך ה-Worker מגיש את הממשקים בעצמו, ללא תלות בהגדרת assets של Cloudflare.
 *   node scripts/build-pages.js
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const OUT = join(__dirname, '..', 'src', 'pages.generated.js');

const files = (await readdir(PUBLIC)).filter((f) => f.endsWith('.html'));
const entries = {};
for (const f of files) {
  entries[f] = await readFile(join(PUBLIC, f), 'utf8');
}

// שימוש ב-JSON.stringify כדי לברוח בבטחה מכל תו (גרשיים, backtick, שורות חדשות)
const body = Object.entries(entries)
  .map(([name, html]) => `  ${JSON.stringify(name)}: ${JSON.stringify(html)},`)
  .join('\n');

const out = `/* קובץ נוצר אוטומטית ע"י scripts/build-pages.js - אין לערוך ידנית */
export const PAGES = {
${body}
};
`;

await writeFile(OUT, out);
console.log(`✓ נוצר ${OUT} עם ${files.length} דפים: ${files.join(', ')}`);
