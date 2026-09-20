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

import { SCREEN_KEYS } from '../src/shell/router.ts';

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
