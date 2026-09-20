/**
 * THE KEYS TABLE IS PRINTED AND TAPED TO A TABLE.
 *
 * README's day-of card lists the number keys a marshal uses to move the stall
 * around: `0` attract, `1` rig check, `2`-`8` a game each. It was read by
 * somebody talking to a queue, and nothing checked it against the app.
 *
 * It was already wrong in one direction: `9` goes to the MENU and the card
 * never said so — which is the key you want when a game is misbehaving and you
 * would rather not F5 the whole stall in front of a queue. The table sent you
 * to PANIC or a reload instead.
 *
 * The map lived in `main.ts`, which no test can import because it boots the
 * app on evaluation. Same problem as the camera backoff, same fix: it now
 * lives in `shell/router.ts` and this compares it against the printed table in
 * BOTH directions — a key the app has and the card omits is a capability
 * nobody knows about, and a key the card promises and the app lacks is worse.
 *
 * Same idea as `runbook.test.ts` on slider names, which exists because that
 * table had already drifted four labels out of five.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SCREEN_KEYS, router } from '../src/shell/router.ts';

const readme = async (): Promise<string> => {
  const { readFile } = await import('node:fs/promises');
  return readFile('README.md', 'utf8');
};

/**
 * Keys named in the Keys table, with `X`-`Y` ranges expanded.
 *
 * The range row is why this is parsed rather than eyeballed: `2`-`8` is seven
 * screens written as one row, so a game added or cut changes the meaning of a
 * line nobody edited.
 */
async function documented(): Promise<Set<string>> {
  const md = await readme();
  const start = md.indexOf('### Keys');
  assert.ok(start >= 0, 'the README no longer has a Keys section');
  // Up to the next heading.
  const rest = md.slice(start + 8);
  const end = rest.search(/\n#{2,3} /);
  const table = end >= 0 ? rest.slice(0, end) : rest;

  const keys = new Set<string>();
  for (const line of table.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cell = line.split('|')[1];
    if (!cell) continue;

    const range = /`(\d)`\s*[–—-]\s*`(\d)`/.exec(cell);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) keys.add(String(n));
      continue;
    }
    for (const m of cell.matchAll(/`(\d)`/g)) keys.add(m[1]!);
  }
  return keys;
}

describe('the printed keys table matches the app', () => {
  test('every number key the app answers is on the card', async () => {
    const onCard = await documented();
    const missing = Object.keys(SCREEN_KEYS)
      .filter((k) => !onCard.has(k))
      .sort();
    assert.deepEqual(
      missing,
      [],
      `these keys work and the day-of card does not mention them: ` +
        missing.map((k) => `${k} -> ${SCREEN_KEYS[k]}`).join(', ')
    );
  });

  test('and every number key the card promises really works', async () => {
    const onCard = await documented();
    const phantom = [...onCard].filter((k) => !(k in SCREEN_KEYS)).sort();
    assert.deepEqual(
      phantom,
      [],
      `the card sends a marshal to keys that do nothing: ${phantom.join(', ')}`
    );
  });

  /**
   * The card says `2`-`8` is "jump to a game", so that range has to be exactly
   * the games — no menu or rig check hiding inside it, and no game outside it.
   */
  test('the range the card calls "a game" really is seven games', async () => {
    const inRange = Object.entries(SCREEN_KEYS)
      .filter(([k]) => k >= '2' && k <= '8')
      .map(([, v]) => v);
    assert.equal(inRange.length, 7, `keys 2-8 map to ${inRange.length} screens, not 7`);
    assert.ok(
      !inRange.includes('menu') && !inRange.includes('attract') && !inRange.includes('rigcheck'),
      `keys 2-8 are documented as games but include ${inRange.join(', ')}`
    );
  });

  test('no two keys go to the same screen', () => {
    const seen = new Map<string, string>();
    for (const [k, v] of Object.entries(SCREEN_KEYS)) {
      const prev = seen.get(v);
      assert.equal(prev, undefined, `keys ${prev} and ${k} both go to ${v}`);
      seen.set(v, k);
    }
  });
});

/**
 * The app must use the map that is tested. Moving a constant somewhere
 * checkable and leaving a copy behind is a guard that guards nothing.
 */
describe('main.ts routes through the tested map', () => {
  test('it imports SCREEN_KEYS rather than keeping its own', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/main.ts', 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

    assert.match(code, /SCREEN_KEYS/, 'main.ts no longer uses the screen-key map at all');
    assert.doesNotMatch(
      code,
      /const\s+SCREEN_KEYS\s*[:=]/,
      'main.ts has its own copy of the map again, so the tested one is decoration'
    );
  });

  /**
   * The safety rule printed under the table: "Number keys only jump screens
   * from attract or the menu. Mid-round you must hold SHIFT, so a bag on the
   * keyboard cannot end somebody's turn."
   */
  test('and still refuses a bare number key mid-round', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/main.ts', 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    assert.match(
      code,
      /if\s*\(\s*mid\s*&&\s*!e\.shiftKey\s*\)\s*return/,
      'the shift guard is gone, so an elbow on the keyboard can end a turn'
    );
  });
});


/**
 * `?screen=` IS A DAY-OF TOOL AND A TYPO GAVE A BLACK SCREEN.
 *
 * README documents it: "Boot straight to a screen." It went to `router.go`
 * unchecked, and `go` on an unknown id logs a console warning and RETURNS — so
 * at boot, when nothing is mounted yet, nothing ever gets mounted. The render
 * loop has no screen to draw and a marshal who typed `?screen=redlihgt` gets a
 * black rectangle with nothing to press.
 *
 * That is the same failure `showBoot` was hardened against, reached by a
 * different road: a typo in a query string rather than a throw during boot. A
 * wrong screen that still runs costs one keystroke; a blank one at a stall
 * costs the queue.
 */
describe('an unknown screen name does not leave a blank screen', () => {
  test('router.go on an unknown id mounts nothing — the hazard itself', async () => {
    // The singleton, with nothing registered: main.ts is what registers the
    // screens and no test can import it. That makes every id unknown here,
    // which is exactly the case under test.
    const before = router.currentId;
    await router.go('redlihgt');
    assert.equal(
      router.currentId,
      before,
      'go() now mounts something for an unknown id, so the fallback in boot() ' +
        'may no longer be needed — check before deleting it'
    );
    assert.equal(router.has('redlihgt'), false, 'a typo is not a registered screen');
  });

  test('and boot filters the query parameter through router.has', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/main.ts', 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

    assert.match(
      code,
      /router\.has\(wanted\)/,
      'the ?screen= parameter is no longer checked against the registered ' +
        'screens, so a typo mounts nothing'
    );
    assert.doesNotMatch(
      code,
      /router\.go\(new URLSearchParams/,
      'boot passes the raw query parameter straight to router.go again'
    );
  });

  /** Both entry points — the simulator path and the camera path. */
  test('on both boot paths', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/main.ts', 'utf8');
    const calls = [...src.matchAll(/router\.go\(requestedScreen\('(\w+)'\)\)/g)].map((m) => m[1]);
    assert.deepEqual(
      calls.sort(),
      ['attract', 'sixtyseven'],
      'one of the two boot paths no longer falls back — ?sim=1 and the camera ' +
        'path each have their own default'
    );
  });
});

/**
 * AND THE OTHER KEY TABLE, WHICH NOTHING WAS WATCHING.
 *
 * The guards above cover the day-of card's `### Keys` table. README opens
 * with a SECOND one — `## Screens` — that lists every key against a screen
 * and a description, and it had drifted in both possible directions at once:
 *
 *   - `8` was missing entirely, so Rhythm Punch did not appear on the map of
 *     the stall at all.
 *   - Runner was described as `1P`, which stopped being true when it became a
 *     two-seat game. A marshal reading that turns a pair away from a game
 *     they can play together.
 *
 * The day-of table says `2`–`8` and was right the whole time, which is
 * exactly why a second unguarded copy of the same facts is dangerous: the
 * guarded one keeps being correct while the other rots beside it.
 */
describe('the Screens table agrees with the key map', () => {
  const screensTable = async (): Promise<string> => {
    const md = (await readme()).replace(/\r\n/g, '\n');
    const start = md.indexOf('## Screens');
    assert.ok(start >= 0, 'README no longer opens with a Screens table');
    const rest = md.slice(start + 10);
    const end = rest.search(/\n## /);
    return end >= 0 ? rest.slice(0, end) : rest;
  };

  test('every key the app binds is listed', async () => {
    const table = await screensTable();
    const missing = Object.keys(SCREEN_KEYS).filter((k) => !table.includes(`\`${k}\``));
    assert.deepEqual(
      missing,
      [],
      'these number keys jump to a screen and the Screens table does not ' +
        'mention them, so that screen is invisible on the map of the stall',
    );
  });

  test('and lists nothing the app does not bind', async () => {
    const table = await screensTable();
    const listed = [...table.matchAll(/\|\s*`(\d)`\s*\|/g)].map((m) => m[1] ?? '');
    assert.ok(listed.length >= 8, 'the Screens table stopped parsing');
    const ghosts = listed.filter((k) => !(k in SCREEN_KEYS));
    assert.deepEqual(ghosts, [], 'the Screens table offers keys that do nothing');
  });

  /**
   * DERIVED FROM THE GAME CONFIG, not from a list here. A game that seats two
   * must not be described as solo. This is the half that was wrong, and the
   * half a marshal acts on when a pair walks up.
   */
  test('no two-seat game is described as solo', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const table = await screensTable();

    for (const f of await readdir('src/games')) {
      if (!f.endsWith('.ts')) continue;
      const src = await readFile(`src/games/${f}`, 'utf8');
      if (!/supportsVersus: true/.test(src)) continue;

      const id = f.replace(/\.ts$/, '');
      const key = Object.keys(SCREEN_KEYS).find((k) => SCREEN_KEYS[k] === id);
      if (!key) continue;

      const row = table.split('\n').find((l) => l.includes(`\`${key}\``));
      assert.ok(row, `${id} has no row in the Screens table`);
      assert.doesNotMatch(
        row,
        /\b1P\b(?!\s*[–—-]\s*2P)/,
        `${id} seats two players and its row still says 1P, so a marshal ` +
          'turns a pair away from a game they can play together',
      );
    }
  });
});
