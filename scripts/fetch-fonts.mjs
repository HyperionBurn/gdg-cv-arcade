/**
 * Downloads the display fonts into /public/fonts.
 *
 * PLAN.md §5a: fonts are the one asset worth downloading. PLAN.md §1: zero
 * runtime network calls. Both are satisfied by pulling the woff2 files once,
 * at build time, and serving them from disk.
 *
 * Linking fonts.googleapis.com at runtime would mean the TV renders in Times
 * New Roman the moment venue wifi drops — which is a small disaster on a
 * screen where typography is most of the visual design.
 *
 * Run once: npm run fetch-fonts
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS_DIR = join(ROOT, 'public', 'fonts');

// Asking the CSS API with a modern UA yields woff2 rather than legacy formats.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * Archivo, and only Archivo.
 *
 * The club brand kit (gdg-resources/design/DESIGN.md) is explicit: "Archivo
 * exclusively... No other typefaces." Weights map to the brand's type roles —
 * 900 Black for display/headings/numbers, 800 ExtraBold for H2, 700 Bold for
 * pill labels, 500 Medium for body.
 */
const FONTS = [
  { file: 'Archivo-Black.woff2', family: 'Archivo', weight: 900 },
  { file: 'Archivo-ExtraBold.woff2', family: 'Archivo', weight: 800 },
  { file: 'Archivo-Bold.woff2', family: 'Archivo', weight: 700 },
  { file: 'Archivo-Medium.woff2', family: 'Archivo', weight: 500 },
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Pull the CSS for one family/weight and pick out the latin woff2 URL. */
async function resolveWoff2(family, weight) {
  const url = `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&display=swap`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`CSS ${family}@${weight}: HTTP ${res.status}`);
  const css = await res.text();

  // Prefer the `latin` subset block; fall back to the first woff2 we see.
  const blocks = css.split('@font-face');
  let chosen = null;
  for (const b of blocks) {
    const m = b.match(/src:\s*url\(([^)]+\.woff2)\)/);
    if (!m) continue;
    if (b.includes('/* latin */')) return m[1];
    if (!chosen) chosen = m[1];
  }
  if (!chosen) throw new Error(`no woff2 found for ${family}@${weight}`);
  return chosen;
}

async function main() {
  await mkdir(FONTS_DIR, { recursive: true });
  console.log('\nFonts → public/fonts');

  for (const f of FONTS) {
    const dest = join(FONTS_DIR, f.file);
    if (await exists(dest)) {
      console.log(`  = ${f.file} (already present)`);
      continue;
    }
    process.stdout.write(`  ↓ ${f.file} ... `);
    try {
      const woff2 = await resolveWoff2(f.family, f.weight);
      const res = await fetch(woff2, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);
      console.log(`${(buf.length / 1024).toFixed(0)}KB`);
    } catch (err) {
      // Non-fatal: styles.css declares system-ui fallbacks, so a missing font
      // degrades the look without breaking the app.
      console.log(`FAILED (${err.message}) — will fall back to system-ui`);
    }
  }
  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
