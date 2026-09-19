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
