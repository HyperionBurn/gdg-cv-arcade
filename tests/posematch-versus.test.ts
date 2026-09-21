import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * THE TWO SKELETONS MUST LIVE IN THEIR OWN HALVES, IN VERSUS.
 *
 * Reported after a real playtest: "Hole in the wall split screen is not
 * tracking the players separately". The scoring WAS separate — per-slot walls,
 * per-slot holes, per-slot scores — but the player skeletons were drawn at
 * their RAW camera positions with no clip, the only player representation in
 * any versus game allowed to cross the divider. Two friends standing a
 * shoulder apart (which the centre tape encourages) rendered as one
 * overlapping figure in the middle, and from the player's side that IS "not
 * tracking us separately", whatever the score columns say.
 *
 * Every other versus game constrains its representation to the slot: Rhythm
 * clamps its lane anchor inside the rect, 67 draws its arm dots at
 * rect.centerX. The wall buffer in this very file clips for a different
 * reason (two walls, one canvas). The skeleton needs the same clip for this
 * one.
 *
 * This is a source-reading guard because the render path needs a real canvas;
 * see HANDOFF "Write the guard, then make it fail".
 */
describe('the versus skeleton is clipped to its own half', () => {
  const src = readFileSync(new URL('../src/games/posematch.ts', import.meta.url), 'utf8')
    // Comments out, so the guard cannot be satisfied by its own explanation.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('the drawPose call site saves, clips, and restores around it', () => {
    const at = src.indexOf('SKELETON_STYLES.attract');
    assert.ok(at > 0, 'the skeleton draw site has moved; update this guard');

    const before = src.lastIndexOf('for (const p of players)', at);
    assert.ok(before > 0, 'the players loop is gone');

    const window = src.slice(before, at + 600);
    assert.match(window, /ctx\.save\(\)/, 'no save() before the draw');
    assert.match(window, /ctx\.rect\(rect\.x, rect\.y, rect\.width, rect\.height\)/, 'no clip rect');
    assert.match(window, /ctx\.clip\(\)/, 'no clip() applied');
    assert.match(
      window.slice(window.indexOf('drawPose')),
      /ctx\.restore\(\)/,
      'no restore() after drawPose — the clip would leak to the footer shelf'
    );
  });

  test('the clip is versus-only, never in solo', () => {
    // A solo player clipped to half the screen is the same bug wearing a
    // different hat, so the clip's OWN gate must read playerCount — not some
    // other line in the loop that happens to mention it.
    const at = src.indexOf('SKELETON_STYLES.attract');
    assert.ok(at > 0, 'the skeleton draw site has moved; update this guard');
    const save = src.lastIndexOf('ctx.save()', at);
    const rect = src.indexOf('ctx.rect(rect.x', save);
    assert.ok(save > 0 && rect > save, 'the clip block has moved; update this guard');
    const gate = src.slice(save, rect);
    assert.match(
      gate,
      /if\s*\(\s*this\.playerCount\s*>\s*1\s*\)/,
      'the clip is not gated on versus — a solo player would lose half the screen'
    );
  });
});

