/**
 * THE BOOT SCREEN IS THE LAST THING THAT STILL WORKS.
 *
 * `showBoot` is what a marshal sees when nothing else came up: insecure
 * context, camera error, or a startup that threw. It is the one screen that has
 * to be right when everything around it is wrong.
 *
 * Its titles are brand headlines, which in this app means angle brackets —
 * `<INSECURE CONTEXT>`, `<CAMERA ERROR>`, `<STARTUP FAILED>`. Assigned through
 * `innerHTML`, the browser parsed that as a tag and produced
 *
 *   <h1><startup failed=""></startup></h1>
 *
 * with an EMPTY heading. Both failure screens that existed before this one had
 * invisible titles, and nobody noticed because you only see them on a bad day.
 *
 * Caught by reading the DOM of a deliberately broken boot, not by looking at
 * the screen — the heading is simply absent, so there is nothing to see.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { COLORS, contrastRatio, MIN_CONTRAST } from '../src/shell/theme.ts';

const read = async (): Promise<string> => {
  const { readFile } = await import('node:fs/promises');
  return readFile('src/main.ts', 'utf8');
};

describe('the boot screen renders what it was given', () => {
  test('the title is assigned as text, not parsed as markup', async () => {
    const src = await read();
    const body = src.slice(src.indexOf('function showBoot'));
    const fn = body.slice(0, body.indexOf('\n}\n'));

    assert.match(
      fn,
      /\.textContent = message/,
      'showBoot must set its heading with textContent — every title it is ' +
        'called with is wrapped in angle brackets, and innerHTML eats them'
    );
    assert.doesNotMatch(
      fn,
      /innerHTML\s*=\s*[`'"][^`'"]*<h1>/,
      'the heading is going through innerHTML again, which renders it empty'
    );
  });

  /**
   * Not a style point. A caller passing `<INSECURE CONTEXT>` and getting a
   * blank heading is the bug this file exists for, so the callers have to keep
   * looking like that — if they ever stop, this guard is guarding nothing.
   */
  test('the callers really do pass angle-bracket titles', async () => {
    const src = await read();
    const titles = [...src.matchAll(/showBoot\(\s*'([^']+)'/g)].map((m) => m[1]!);

    assert.ok(titles.length >= 2, `expected several showBoot calls, found ${titles.length}`);
    for (const t of titles) {
      assert.match(t, /^<.+>$/, `"${t}" is not a bracketed headline; check this guard still applies`);
    }
  });

  /**
   * A boot that throws must not be a black screen. `step()` has wrapped every
   * frame for a long time, with a comment about black screens being
   * unrecoverable without a console; `boot()` was launched with a bare `void`.
   */
  test('boot failures reach a human', async () => {
    const src = await read();
    assert.match(
      src,
      /void boot\(\)\s*\.catch\(/,
      'boot() is unguarded again — anything it throws is a silent black screen'
    );
    assert.match(src, /STARTUP FAILED/, 'the startup failure screen lost its message');
  });
});

/* ------------------------------------------------------------------ */
/* ... and is legible once it has rendered                             */
/* ------------------------------------------------------------------ */

/**
 * The guards above prove the boot screen says something. These prove somebody
 * can READ it. Both bugs had the same shape — a failure screen that is only
 * ever seen on a bad day, wrong in a way no green test could notice.
 */
describe('the boot screen is legible on the surface it appears on', () => {
  /**
   * THE ONE SCREEN A MARSHAL READS WHEN THE STALL IS BROKEN MEASURED 1.11:1.
   *
   * `#stage` is built with `getContext('2d', { alpha: false })`. An opaque 2D
   * canvas does not start transparent — it starts SOLID BLACK — and it fills
   * the viewport, so it hides the paper-white `body` for as long as the render
   * loop has not painted a screen.
   *
   * `showBoot()` is called on exactly the paths where the render loop never got
   * there: `<CAMERA ERROR>`, `<INSECURE CONTEXT>`, `<STARTUP FAILED>`. `.boot`
   * set no background of its own, so all three rendered #111111 on #000000.
   *
   * MEASURED on the production build with the camera denied. Note how nearly it
   * escaped: walking the DOM for the first painted ancestor reports
   * `rgb(255, 255, 255)` from BODY and a cheerful 18.88:1, because the black is
   * in a CANVAS and not in anybody's background-color. Sampling the canvas
   * itself returned `[0, 0, 0, 255]`. Real figures: headline 1.11:1, detail
   * 2.82:1. The yellow TRY AGAIN button was the only legible thing on screen,
   * which is why the result read as deliberately styled rather than as broken.
   *
   * The guard reads BOTH files, because neither is wrong on its own and either
   * one in isolation says everything is fine.
   */
  test('the boot overlay paints its own background', async () => {
    const { readFile } = await import('node:fs/promises');

    // The premise: the canvas underneath is opaque, so it is black until drawn.
    const mainTs = await readFile('src/main.ts', 'utf8');
    assert.match(
      mainTs,
      /getContext\(\s*'2d'\s*,\s*\{\s*alpha:\s*false\s*\}\s*\)/,
      'the stage canvas is no longer opaque. If that was deliberate the reasoning ' +
        'below needs redoing rather than deleting — a transparent canvas would let ' +
        'the paper `body` through and the boot background would stop mattering'
    );

    // Comments stripped first: the rule below is preceded by a long one that
    // NAMES the properties being searched for, and this repo has shipped a
    // guard satisfied by its own prose before.
    const raw = (await readFile('src/styles.css', 'utf8')).replace(/\/\*[\s\S]*?\*\//g, ' ');

    const rule = /(^|\})\s*\.boot\s*\{([^}]*)\}/m.exec(raw)?.[2];
    assert.ok(rule, 'the .boot rule is gone; the failure screens have no styling at all');

    const bg = /background(?:-color)?:\s*([^;]+);/.exec(rule)?.[1]?.trim();
    assert.ok(
      bg,
      'the boot overlay has no background again, so every failure headline renders ' +
        'ink on the black canvas at 1.11:1 — see this test’s note'
    );

    // Resolve the token out of :root, so repointing --paper is caught too.
    // Found by scanning lines rather than by building a `new RegExp` around a
    // string taken from the file: `--paper` is three regex metacharacters in a
    // row, and a pattern assembled from data reads as one thing and means
    // another.
    const token = /^var\(\s*(--[\w-]+)\s*\)$/.exec(bg!)?.[1];
    const decl = token
      ? raw.split(/\r?\n/).find((l) => l.trim().startsWith(token + ':'))
      : undefined;
    const resolved = token
      ? /(#[0-9a-fA-F]{3,8})/.exec(decl ?? '')?.[1]
      : /^#[0-9a-fA-F]{3,8}$/.test(bg!)
        ? bg!
        : undefined;
    assert.ok(resolved, `the boot background (${bg}) does not resolve to an opaque hex colour`);

    // Opaque: eight hex digits ending in anything but FF is a see-through
    // surface, which puts the black canvas straight back.
    assert.ok(
      resolved!.length !== 9 || resolved!.slice(-2).toLowerCase() === 'ff',
      `the boot background ${resolved} is translucent, so the black canvas shows through`
    );

    // And the text on it is readable. --text-dim is the detail line.
    const dim = /--text-dim:\s*(#[0-9a-fA-F]{3,8})/.exec(raw)?.[1];
    assert.ok(dim, '--text-dim is gone');
    for (const [what, fg] of [
      ['the headline', COLORS.ink],
      ['the detail line', dim!],
    ] as const) {
      const ratio = contrastRatio(fg, resolved!);
      assert.ok(
        ratio >= MIN_CONTRAST,
        `${what} on the boot screen is ${ratio.toFixed(2)}:1 against ${resolved}, ` +
          `under the ${MIN_CONTRAST}:1 floor`
      );
    }
  });
});

/**
 * PLAN.md §9 CALLS THIS THE CRITICAL FAILURE MODE, AND ITS SYMPTOM IS SILENCE.
 *
 * `getUserMedia` does not exist outside a secure context. Serving the stall
 * over `http://192.168.x.x` — which is what happens the moment anybody wants a
 * second machine to see it, or plugs into the hall's network and reads the IP
 * off `vite --host` — leaves the camera permanently dead, with no permission
 * prompt and nothing on screen to say why.
 *
 * `localhost` is a secure context and an IP address is not, so the stall works
 * perfectly during setup and fails in the one configuration nobody rehearsed.
 */
describe('a LAN IP is told what is wrong with it', () => {
  test('the secure-context guard runs before the camera is touched', async () => {
    const src = await read();
    const boot = src.slice(src.indexOf('async function boot'));
    assert.ok(boot.length > 0, 'boot() is gone');

    const secure = boot.indexOf('window.isSecureContext');
    const start = boot.indexOf('camera.start()');

    assert.ok(secure >= 0, 'the secure-context guard is gone, and PLAN.md §9 calls it critical');
    assert.ok(start >= 0, 'boot() no longer starts the camera');
    assert.ok(
      secure < start,
      'the camera is started before the secure-context check. Behind it a marshal ' +
        'still gets a screen, but it is <CAMERA ERROR> carrying whatever the browser ' +
        'chose to say, on a stall whose actual fix is one word in the address bar'
    );
  });

  /**
   * The diagnosis is useless without the remedy. A marshal reading this is
   * four days from an event and does not know what a secure context is; they
   * need the word `localhost`.
   */
  test('and the message carries the origin and the fix, not just the fault', async () => {
    const src = await read();
    const at = src.indexOf("'<INSECURE CONTEXT>'");
    assert.ok(at >= 0, 'the insecure-context screen lost its title');
    const call = src.slice(at, at + 600);

    for (const [what, re] of [
      ['the origin it is actually being served from', /location\.protocol/],
      ['the hostname', /location\.hostname/],
      ['the one-word fix', /localhost/],
      ['the other fix', /https/],
    ] as const) {
      assert.match(call, re, `the insecure-context message no longer names ${what}`);
    }
  });
});
