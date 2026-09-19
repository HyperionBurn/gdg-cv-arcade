/**
 * TWO PLAYERS — the path that had no coverage at all.
 *
 * Six of the seven games declare `maxPlayers: 2` and draw a real split screen,
 * and every test in this repo before this file drove exactly one body. That is
 * how the two-player path shipped with three separate faults that only a
 * second person could ever expose:
 *
 *   - Red Light returned ONE score for all six lanes (`laneScore` below).
 *   - Pose Match's two walls shared a canvas, so each punched a hole in the
 *     other's plane — covered in `posematch.test.ts`.
 *   - And the one that made the other two nearly unreachable: the countdown
 *     froze the player count on the frame the FIRST body was confirmed, so a
 *     friend half a step behind never got in (`countdownRoster` below).
 *
 * The testers asked for multiplayer. It was there. Nobody could get to it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  rosterSize,
  countdownRoster,
  COUNTDOWN_SEC,
  LATE_JOIN_FLOOR_SEC,
  MAX_LATE_JOINS,
  type GameConfig,
} from '../src/games/base.ts';
import { laneScore, type ScorableRacer } from '../src/games/redlight.ts';
import { BalloonPopGame } from '../src/games/balloonpop.ts';
import { FruitNinjaGame } from '../src/games/fruitninja.ts';
import { PoseMatchGame } from '../src/games/posematch.ts';
import { RedLightGame } from '../src/games/redlight.ts';
import { RhythmGame } from '../src/games/rhythm.ts';
import { RunnerGame } from '../src/games/runner.ts';
import { SixtySevenGame } from '../src/games/sixtyseven.ts';

/** `config` is protected; a test is allowed to look at what it advertises. */
const configOf = (g: unknown): GameConfig => (g as { config: GameConfig }).config;

const GAMES: ReadonlyArray<readonly [string, GameConfig]> = [
  ['67 Speed', configOf(new SixtySevenGame())],
  ['Fruit Ninja', configOf(new FruitNinjaGame())],
  ['Balloon Pop', configOf(new BalloonPopGame())],
  ['Red Light', configOf(new RedLightGame())],
  ['Pose Match', configOf(new PoseMatchGame())],
  ['Runner', configOf(new RunnerGame())],
  ['Rhythm', configOf(new RhythmGame())],
];

/* ------------------------------------------------------------------ */
/* 1. What each game says it can hold, against what it actually does   */
/* ------------------------------------------------------------------ */

describe('roster — capacity is one fact, not three', () => {
  test('every game seats at least one person, whatever walks up', () => {
    for (const [name, cfg] of GAMES) {
      for (const present of [0, 1, 2, 3, 6, 12]) {
        const n = rosterSize(present, cfg);
        assert.ok(
          n >= 1,
          `${name} seated ${n} with ${present} present — the round would divide by zero`
        );
        assert.ok(
          n <= cfg.maxPlayers,
          `${name} seated ${n} but only has ${cfg.maxPlayers} slots`
        );
      }
    }
  });

  test('a versus game takes the second person and refuses the third', () => {
    const versus = GAMES.filter(([, c]) => c.supportsVersus);
    assert.equal(versus.length, 5, 'five split-screen games — update this if that changes');

    for (const [name, cfg] of versus) {
      assert.equal(rosterSize(1, cfg), 1, `${name} solo`);
      assert.equal(rosterSize(2, cfg), 2, `${name} pair`);
      // A queue standing behind the players is the normal case at a stall.
      assert.equal(rosterSize(5, cfg), 2, `${name} with spectators behind`);
    }
  });

  test('the party game takes the whole group, up to its lane count', () => {
    const [, redlight] = GAMES.find(([n]) => n === 'Red Light')!;
    assert.equal(redlight.partyMode, true);
    assert.equal(rosterSize(1, redlight), 1);
    assert.equal(rosterSize(4, redlight), 4);
    assert.equal(rosterSize(redlight.maxPlayers, redlight), redlight.maxPlayers);
    assert.equal(rosterSize(99, redlight), redlight.maxPlayers, 'a crowd cannot overflow the lanes');
  });

  test('a solo game stays solo no matter how many people crowd in', () => {
    const solo = GAMES.filter(([, c]) => !c.supportsVersus && !c.partyMode);
    assert.ok(solo.length > 0);
    for (const [name, cfg] of solo) {
      assert.equal(rosterSize(4, cfg), 1, `${name} must not split`);
    }
  });

  test('a split-screen game declares exactly two slots', () => {
    // `slotRect` halves the viewport; three slots would be three drawings on
    // two halves. Any game that ever wants three needs a layout change first.
    for (const [name, cfg] of GAMES) {
      if (!cfg.supportsVersus) continue;
      assert.equal(cfg.maxPlayers, 2, `${name} is versus but claims ${cfg.maxPlayers} slots`);
      assert.notEqual(cfg.partyMode, true, `${name} cannot be both versus and party`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. The late join                                                    */
/* ------------------------------------------------------------------ */

describe('countdown — the friend who is half a step behind', () => {
  const FLOOR_AT = COUNTDOWN_SEC - LATE_JOIN_FLOOR_SEC;

  test('a solo turn is not slowed by one millisecond', () => {
    // The whole reason this is in the countdown rather than in a lobby.
    let t = 0;
    for (let i = 0; i < 200; i++) {
      const r = countdownRoster(1, 1, 0, t);
      assert.equal(r.arrived, false);
      assert.equal(r.stateTime, t, 'a solo countdown must never be rewound');
      assert.equal(r.lateJoins, 0);
      t += COUNTDOWN_SEC / 200;
    }
  });

  test('someone arriving late still gets a real countdown', () => {
    // 2.9s into a 3.2s countdown: without the rewind they would be walking
    // into frame as the round started.
    const r = countdownRoster(2, 1, 0, 2.9);
    assert.equal(r.arrived, true);
    assert.equal(r.playerCount, 2);
    assert.ok(
      COUNTDOWN_SEC - r.stateTime >= LATE_JOIN_FLOOR_SEC - 1e-9,
      `only ${(COUNTDOWN_SEC - r.stateTime).toFixed(2)}s left after a late join`
    );
  });

  test('someone arriving early does not get a longer wait than they had', () => {
    // Rewinding to the floor unconditionally would EXTEND the countdown for a
    // pair who walked up together, which is the common case.
    const r = countdownRoster(2, 1, 0, 0.2);
    assert.equal(r.arrived, true);
    assert.equal(r.stateTime, 0.2, 'an early arrival must not push the clock backwards');
  });

  test('the rewind lands exactly on the floor and no further', () => {
    const r = countdownRoster(2, 1, 0, COUNTDOWN_SEC);
    assert.ok(Math.abs(r.stateTime - FLOOR_AT) < 1e-9);
  });

  test('a flickering tracker cannot hold the countdown open forever', () => {
    // A spectator hovering at the edge of the play zone makes the tracker
    // oscillate 1 <-> 2. Without the cap, every oscillation buys another
    // LATE_JOIN_FLOOR_SEC and the round never starts.
    let count = 1;
    let joins = 0;
    let t = COUNTDOWN_SEC - 0.05;
    let honoured = 0;

    for (let i = 0; i < 50; i++) {
      // ... appears ...
      const up = countdownRoster(2, count, joins, t);
      if (up.arrived) honoured++;
      ({ playerCount: count, lateJoins: joins, stateTime: t } = up);
      // ... and vanishes again.
      const down = countdownRoster(1, count, joins, t);
      assert.equal(down.arrived, false, 'a departure is never an arrival');
      ({ playerCount: count, lateJoins: joins, stateTime: t } = down);
      t += 0.05;
    }

    assert.equal(honoured, MAX_LATE_JOINS, 'the cap is the only thing ending this round');
    assert.ok(t > COUNTDOWN_SEC, 'the clock ran out despite the flicker');
  });

  test('worst case is bounded, and it is short enough to stand still for', () => {
    // Two honoured arrivals, each at the last possible moment.
    let { playerCount, lateJoins, stateTime } = { playerCount: 1, lateJoins: 0, stateTime: COUNTDOWN_SEC };
    let spent = COUNTDOWN_SEC;
    for (let i = 0; i < MAX_LATE_JOINS; i++) {
      const r = countdownRoster(playerCount + 1, playerCount, lateJoins, stateTime);
      assert.equal(r.arrived, true);
      spent += stateTime - r.stateTime;
      ({ playerCount, lateJoins, stateTime } = r);
      stateTime = COUNTDOWN_SEC;
    }
    assert.ok(
      spent <= COUNTDOWN_SEC + MAX_LATE_JOINS * LATE_JOIN_FLOOR_SEC + 1e-9,
      `worst-case countdown ran ${spent.toFixed(2)}s`
    );
    assert.ok(spent < 7, 'nobody stands still in front of a crowd for seven seconds');
  });

  test('the friend changing their mind drops the round back to solo', () => {
    // Otherwise the round opens with a split divider, a second HUD and a
    // second score belonging to nobody.
    const r = countdownRoster(1, 2, 1, 1.0);
    assert.equal(r.playerCount, 1);
    assert.equal(r.arrived, false);
    assert.equal(r.stateTime, 1.0, 'a departure must not extend the wait for whoever stayed');
    assert.equal(r.lateJoins, 1, 'leaving does not refund a join');
  });

  test('a party game can absorb two arrivals, not just one', () => {
    // Red Light holds six. Two people joining a lobby of one is ordinary.
    const first = countdownRoster(2, 1, 0, 1.0);
    assert.equal(first.playerCount, 2);
    const second = countdownRoster(3, first.playerCount, first.lateJoins, first.stateTime);
    assert.equal(second.playerCount, 3);
    assert.equal(second.arrived, true);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Red Light — one score per lane                                   */
/* ------------------------------------------------------------------ */

describe('Red Light — six players, six scores', () => {
  const racer = (lane: number, progress: number, finishedWith = 0): ScorableRacer => ({
    lane,
    progress,
    finishedWith,
  });

  test('each lane reads its own racer', () => {
    const field = [racer(0, 12), racer(1, 40), racer(2, 88), racer(3, 5)];
    assert.deepEqual([0, 1, 2, 3].map((s) => laneScore(field, s)), [12, 40, 88, 5]);
  });

  test('a lane nobody is standing in scores zero, not NaN', () => {
    assert.equal(laneScore([racer(0, 50)], 4), 0);
    assert.equal(laneScore([], 0), 0);
  });

  test('finishing first beats finishing last', () => {
    // Both crossed. The only thing separating them is the clock they had left.
    const early = laneScore([racer(0, 100, 22)], 0);
    const late = laneScore([racer(0, 100, 2)], 0);
    assert.ok(early > late, `${early} should beat ${late}`);
    assert.equal(early, 100 + 220);
    assert.equal(late, 100 + 20);
  });

  test('anyone who finished outranks anyone who did not', () => {
    const slowestFinisher = laneScore([racer(0, 100, 0)], 0);
    const nearestMiss = laneScore([racer(0, 99.9)], 0);
    assert.ok(slowestFinisher > nearestMiss, `${slowestFinisher} vs ${nearestMiss}`);
  });

  test('the whole field is separable — the point of a last-one-standing game', () => {
    const field = [
      racer(0, 28),
      racer(1, 64),
      racer(2, 100, 10),
      racer(3, 100, 4),
      racer(4, 7),
      racer(5, 91),
    ];
    const scores = field.map((r) => laneScore(field, r.lane));
    assert.equal(new Set(scores).size, field.length, `ties in ${JSON.stringify(scores)}`);
    // And the winner is the one who crossed first, not the one with the
    // highest progress number.
    assert.equal(scores.indexOf(Math.max(...scores)), 2);
  });

  test('a negative clock cannot pay a bonus', () => {
    // `finishedWith` is read off a float countdown that can undershoot zero.
    assert.equal(laneScore([racer(0, 100, -3)], 0), 100);
  });

  test('a racer who walked off keeps the score they earned', () => {
    // Progress is frozen at elimination and the lane is never reassigned
    // mid-round, so scoring does not care whether they are still in frame.
    assert.equal(laneScore([racer(2, 73)], 2), 73);
  });
});
