/**
 * THE STALL HAS NO INTERNET, AND FINDING THAT OUT ON THE DAY IS TOO LATE.
 *
 * PLAN.md §1 is unambiguous: zero network calls at the stall, because venue
 * wifi will fail. The mechanism is already in place — `npm run setup` fetches
 * the MediaPipe wasm, the three pose models and the Archivo weights into
 * `public/`, and `.gitignore` explains why they are not committed — so this
 * file does not implement offline operation. It holds it.
 *
 * WHY A TEST AND NOT A README LINE. The failure is silent and delayed. A font
 * `@import`, a CDN script tag or a `fetch` against an analytics endpoint all
 * work perfectly on the machine they are written on, and on every machine with
 * a network. They fail for the first time in a hall, in front of a queue, with
 * whoever is holding the laptop having no idea which of the last fifty commits
 * did it. There is no way to notice this by using the app normally, which is
 * exactly the shape of thing a test is for.
 *
 * It scans SOURCE rather than `dist/`, so it runs in a second and needs no
 * build. The two are not the same guarantee — a dependency could fetch at
 * runtime and this would not see it — so `README.md` also carries the physical
 * check: pull the ethernet, turn off wifi, and run a full turn. Do that once
 * before the fair. This test is what stops it from needing to be done again
 * after every commit.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const SCAN_DIRS = ['src'];
const SCAN_FILES = ['index.html'];

/** A URL in prose is documentation. A URL in code is a network call. */
function isCommentary(line: string): boolean {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('<!--');
}

/**
 * Hosts that cannot cause a runtime fetch even when they appear in code.
 *
 * `w3.org` is the SVG and XHTML namespace: `createElementNS` takes it as an
 * identifier string and no browser has ever resolved it. Everything else has
 * to justify itself in review.
 */
const HARMLESS = [/w3\.org/, /localhost/, /127\.0\.0\.1/];

async function sourceLines(): Promise<Array<{ file: string; n: number; line: string }>> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else out.push(p);
    }
    return out;
  };

  const files: string[] = [...SCAN_FILES];
  for (const d of SCAN_DIRS) files.push(...(await walk(d)));

  const rows: Array<{ file: string; n: number; line: string }> = [];
  for (const file of files) {
    if (!/\.(ts|tsx|js|mjs|css|html)$/.test(file)) continue;
    const text = await readFile(file, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => rows.push({ file, n: i + 1, line }));
  }
  return rows;
}

describe('the stall runs with the network unplugged', () => {
  test('no source line fetches from the internet', async () => {
    const offenders = (await sourceLines())
      .filter((r) => !isCommentary(r.line))
      .filter((r) => /https?:\/\//.test(r.line))
      .filter((r) => !HARMLESS.some((h) => h.test(r.line)))
      .map((r) => `${r.file}:${r.n}  ${r.line.trim()}`);

    assert.deepEqual(
      offenders,
      [],
      'an absolute URL in shipped code is a network call the fair will not be ' +
        'able to make — vendor it into public/ via scripts/, like the models ' +
        'and the fonts'
    );
  });

  /**
   * The specific one that would be easiest to reintroduce and hardest to spot.
   *
   * Every design tool in the world emits a Google Fonts `<link>`, and the app
   * would look completely correct on any machine that has ever loaded Archivo
   * — including, in particular, this one. `scripts/fetch-fonts.mjs` puts the
   * real files in `public/fonts` and `styles.css` declares `@font-face`
   * against them.
   */
  test('fonts are self-hosted, not linked', async () => {
    const { readFile } = await import('node:fs/promises');
    const css = await readFile('src/styles.css', 'utf8');
    const html = await readFile('index.html', 'utf8');

    assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(css + html));
    assert.ok(
      /@font-face/.test(css),
      'styles.css declares no @font-face, so the typeface is coming from ' +
        'somewhere this test cannot see'
    );
  });

  /**
   * `public/` is the whole offline story and it is deliberately not in git, so
   * a fresh clone is one `npm run setup` away from a dead stall. The scripts
   * that reproduce it must therefore keep existing, and `setup` must keep
   * running both of them.
   */
  test('setup reproduces everything public/ holds', async () => {
    const { readFile, access } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    assert.match(pkg.scripts.setup ?? '', /fetch-models/);
    assert.match(pkg.scripts.setup ?? '', /fetch-fonts/);

    for (const f of ['scripts/fetch-models.mjs', 'scripts/fetch-fonts.mjs']) {
      await access(f);
    }
  });
});
