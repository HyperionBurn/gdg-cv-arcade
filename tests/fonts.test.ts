/**
 * THE ARCADE RENDERED IN HELVETICA FOR THE WHOLE PROJECT AND NOBODY SAW IT.
 *
 * Two independent bugs, stacked, each of which hid the other:
 *
 *  1. `scripts/fetch-fonts.mjs` picked the wrong Google Fonts subset. It split
 *     the CSS on `@font-face` and took the chunk containing the `/* latin *\/`
 *     comment — but Google emits that comment BEFORE the block it labels, so
 *     every chunk carried one block's src and the NEXT block's name. We
 *     vendored `latin-ext`: 262 glyphs of accented characters, no A-Z, no
 *     digits. And the script skipped any file that already existed, so
 *     re-running it could never repair itself.
 *
 *  2. Nothing ever asked the browser to load the fonts. `@font-face` declares;
 *     it does not fetch. The browser fetches on first use by a laid-out DOM
 *     element, and this app draws every glyph to a canvas — where `ctx.font`
 *     silently falls back and reports nothing. Measured at six seconds on
 *     attract: zero woff2 requests, three faces `unloaded`.
 *
 * Neither produced an error, a warning or a visibly broken screen. A
 * well-set Helvetica looks fine; DESIGN.md's "Archivo exclusively" was
 * satisfied in the CSS and violated on the glass. Every review, every
 * screenshot and every playtest this month looked at the wrong typeface.
 *
 * The lesson these tests encode: when a binary asset is vendored, the only
 * honest check reads the binary.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const WEIGHTS = [
  { file: 'Archivo-Black.woff2', weight: 900, role: 'display, headings, every number' },
  { file: 'Archivo-ExtraBold.woff2', weight: 800, role: 'H2' },
  { file: 'Archivo-Bold.woff2', weight: 700, role: 'pill labels, buttons' },
  { file: 'Archivo-Medium.woff2', weight: 500, role: 'body' },
];

describe('the vendored fonts can actually set this app', () => {
  for (const { file, weight, role } of WEIGHTS) {
    test(`${file} (${weight}, ${role}) covers the characters we draw`, async () => {
      const { readFile } = await import('node:fs/promises');
      const { checkCoverage } = await import('../scripts/woff2-cmap.mjs');

      const buf = await readFile(`public/fonts/${file}`);
      const { ok, missing, total } = checkCoverage(buf);

      assert.ok(
        ok,
        `${file} has ${total} glyphs but is missing ${missing.length} of the ` +
          `characters this app sets type in: ${missing.join('')}\n` +
          `This is the latin-ext subset, not latin. Delete public/fonts and ` +
          `run \`npm run fetch-fonts\`.`
      );
    });
  }

  /**
   * Every weight `styles.css` declares must exist on disk, and every weight on
   * disk must be declared. A face declared but missing falls back silently; a
   * file present but undeclared is 13KB of dead weight that looks like cover.
   */
  test('every declared @font-face has a file, and vice versa', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const css = await readFile('src/styles.css', 'utf8');

    const declared = [...css.matchAll(/url\(['"]?\/fonts\/([^'")]+\.woff2)/g)].map(
      (m) => m[1]
    );
    assert.ok(declared.length > 0, 'styles.css declares no @font-face at all');

    const onDisk = (await readdir('public/fonts')).filter((f) => f.endsWith('.woff2'));

    for (const f of declared) {
      assert.ok(onDisk.includes(f), `styles.css declares ${f}, which is not on disk`);
    }
    for (const { file } of WEIGHTS) {
      assert.ok(declared.includes(file), `${file} is fetched but never declared`);
    }
  });

  /**
   * The bug in `resolveWoff2` was a parse that LOOKED right. Guard the shape of
   * the fix rather than only its output: selection must key off `unicode-range`,
   * which is data inside the block, not off a comment that sits outside it.
   */
  test('the fetch script selects a subset by unicode-range, not by comment', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('scripts/fetch-fonts.mjs', 'utf8');

    assert.match(
      src,
      /unicode-range/,
      'subset selection does not look at unicode-range, so it is guessing'
    );
    assert.match(
      src,
      /checkCoverage/,
      'the script does not verify what it downloaded'
    );
  });

  /**
   * And the half that no amount of correct bytes can fix: something has to ASK.
   */
  test('boot explicitly loads the fonts before drawing', async () => {
    const { readFile } = await import('node:fs/promises');
    const main = await readFile('src/main.ts', 'utf8');

    assert.match(
      main,
      /document\.fonts\.load\(/,
      'nothing calls document.fonts.load — a canvas-only app never triggers a ' +
        'font fetch, so Archivo will never load'
    );
    assert.match(main, /await loadFonts\(\)/, 'boot does not wait for the fonts');
  });
});
