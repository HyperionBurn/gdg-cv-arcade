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
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCoverage } from './woff2-cmap.mjs';

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

/**
 * Pull the CSS for one family/weight and pick out the BASIC LATIN woff2 URL.
 *
 * THE BUG THIS REPLACES, because it was invisible for the life of the project
 * and the next person to touch this will be tempted to write it back.
 *
 * Google Fonts emits the subset name as a comment BEFORE the block it labels:
 *
 *     /* cyrillic *\/        @font-face { src: url(A); unicode-range: ... }
 *     /* latin-ext *\/       @font-face { src: url(B); unicode-range: ... }
 *     /* latin *\/           @font-face { src: url(C); unicode-range: ... }
 *
 * The old code did `css.split('@font-face')` and returned the first chunk
 * containing `/* latin *\/`. After that split, every chunk holds one block's
 * BODY followed by the NEXT block's comment — so the chunk matching `latin`
 * carries the src for `latin-ext`, one block early. We shipped `latin-ext`:
 * 262 glyphs of accented characters, with no A-Z and no digits in it.
 *
 * Nothing failed. `styles.css` lists fallbacks, so the browser quietly rendered
 * the entire arcade in Helvetica/Arial while every file, every @font-face and
 * every review read as correct.
 *
 * So: match on `unicode-range`, which is DATA inside the block and cannot drift
 * out of step with it, and then verify the downloaded bytes anyway.
 */
async function resolveWoff2(family, weight) {
  const url = `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&display=swap`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`CSS ${family}@${weight}: HTTP ${res.status}`);
  const css = await res.text();

  const blocks = css.split('@font-face').slice(1);
  let fallback = null;
  for (const b of blocks) {
    const src = b.match(/src:\s*url\(([^)]+\.woff2)\)/);
    if (!src) continue;
    if (!fallback) fallback = src[1];

    const range = b.match(/unicode-range:\s*([^;}]+)/);
    if (!range) continue;
    // U+0041 is 'A'. Only the basic-latin block claims it, and it claims it as
    // part of a range (U+0000-00FF), so the ranges have to be parsed rather
    // than string-matched.
    if (rangeCovers(range[1], 0x41) && rangeCovers(range[1], 0x30)) return src[1];
  }
  if (!fallback) throw new Error(`no woff2 found for ${family}@${weight}`);
  // Better than nothing, and `verify()` below will reject it if it is wrong.
  return fallback;
}

/** Does a CSS `unicode-range` value cover this codepoint? */
function rangeCovers(value, cp) {
  for (const part of value.split(',')) {
    const m = part.trim().match(/^U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?$/);
    if (!m) continue;
    // A wildcard form like U+00?? means the whole block.
    const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
    const hi = m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'F'), 16);
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** Read the file's own cmap. The only check that cannot be fooled. */
async function verify(dest) {
  try {
    return checkCoverage(await readFile(dest));
  } catch (err) {
    return { ok: false, missing: [`unreadable: ${err.message}`], total: 0 };
  }
}

async function main() {
  await mkdir(FONTS_DIR, { recursive: true });
  console.log('\nFonts → public/fonts');

  const failed = [];

  for (const f of FONTS) {
    const dest = join(FONTS_DIR, f.file);

    // "Already present" is not "already correct" — that assumption is how a
    // broken subset survived every re-run of this script. Re-read the bytes.
    if (await exists(dest)) {
      const have = await verify(dest);
      if (have.ok) {
        console.log(`  = ${f.file} (present, ${have.total} glyphs)`);
        continue;
      }
      console.log(`  ! ${f.file} present but missing ${have.missing.length} characters — refetching`);
    }

    process.stdout.write(`  ↓ ${f.file} ... `);
    try {
      const woff2 = await resolveWoff2(f.family, f.weight);
      const res = await fetch(woff2, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);

      const got = await verify(dest);
      if (!got.ok) {
        throw new Error(
          `downloaded file is missing ${got.missing.length} of the characters ` +
            `this app sets type in (${got.missing.slice(0, 6).join('')}…)`
        );
      }
      console.log(`${(buf.length / 1024).toFixed(0)}KB, ${got.total} glyphs`);
    } catch (err) {
      // FATAL, deliberately.
      //
      // This used to print a warning and carry on, on the reasoning that
      // styles.css has fallbacks so a missing font "degrades the look without
      // breaking the app". That reasoning is exactly what let the arcade ship
      // in Helvetica: the fallback is not a safety net, it is a disguise.
      // DESIGN.md says Archivo exclusively, and a stall whose typography is
      // most of its visual design should refuse to build rather than quietly
      // become a different-looking product.
      failed.push(`${f.file}: ${err.message}`);
      console.log(`FAILED (${err.message})`);
    }
  }
  if (failed.length > 0) {
    console.error('\nFONTS ARE NOT USABLE:\n  ' + failed.join('\n  '));
    console.error(
      '\nThe app will render in Helvetica, which is not the brand. Fix the ' +
        'network or the subset selection above and re-run.\n'
    );
    process.exit(1);
  }

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
