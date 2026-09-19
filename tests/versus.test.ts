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
  DEPART_GRACE_SEC,
  LEAD_DEBOUNCE_SEC,
  leadChange,
  ADMIT_LATENCY_SEC,
  STEP_IN_REACTION_SEC,
  INVITE_UNTIL_SEC,
  type GameConfig,
} from '../src/games/base.ts';
import { GAME_SEATS, seatBadge } from '../src/meta/games.ts';
import { setPlayMode, takePlayMode } from '../src/meta/mode.ts';
import { modeScreenApplies } from '../src/shell/mode.ts';
import type { GameId } from '../src/meta/leaderboard.ts';
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
    assert.equal(versus.length, 6, 'six split-screen games — update this if that changes');

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

  test('every game on the roster can be played with somebody', () => {
    // The Runner was the last hold-out and the reason was structural rather
    // than deliberate — see `RunnerLane`. If a future game ships solo-only
    // that is a decision, not an accident, and this test is where it gets
    // written down.
    const solo = GAMES.filter(([, c]) => !c.supportsVersus && !c.partyMode);
    assert.deepEqual(
      solo.map(([n]) => n),
      [],
      'a solo-only game is fine, but say so here and say why'
    );
  });

  test('the menu badge agrees with what the game will actually do', () => {
    // GAME_SEATS is a deliberate duplicate of `config.maxPlayers` — the menu
    // cannot import seven game modules to draw a two-character badge. This is
    // the guard that makes the duplicate safe: a tile promising "1-2P" for a
    // game that will hard-lock solo is worse than no badge at all, because a
    // pair will step up together and one of them will be a spectator.
    const byId = new Map(GAMES.map(([, c]) => [c.gameId, c]));
    for (const [id, seats] of Object.entries(GAME_SEATS) as [GameId, number][]) {
      const cfg = byId.get(id);
      assert.ok(cfg, `GAME_SEATS has "${id}" but no game does`);
      assert.equal(seats, cfg.maxPlayers, `${id}: menu says ${seats}, game seats ${cfg.maxPlayers}`);
    }
    for (const [name, cfg] of GAMES) {
      assert.ok(cfg.gameId in GAME_SEATS, `${name} is missing from GAME_SEATS`);
    }
  });

  test('only games that can actually take a friend advertise one', () => {
    for (const [name, cfg] of GAMES) {
      const badge = seatBadge(cfg.gameId);
      if (cfg.maxPlayers > 1) {
        assert.equal(badge, `1-${cfg.maxPlayers}P`, `${name} badge`);
      } else {
        assert.equal(badge, null, `${name} must not draw a "1P" badge`);
      }
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
  const FRAME = 1 / 60;

  type Roster = ReturnType<typeof countdownRoster>;

  /** A countdown that has just been entered, with one person in front of it. */
  const solo = (stateTime = 0): Roster => ({
    playerCount: 1,
    lateJoins: 0,
    stateTime,
    belowFor: 0,
    arrived: false,
  });

  /** Advance one frame with `want` people visible. */
  const step = (want: number, s: Roster, dt = FRAME): Roster => countdownRoster(want, s, dt);

  /** Advance `seconds` worth of frames with a steady `want`. */
  const hold = (want: number, s: Roster, seconds: number): Roster => {
    let cur = s;
    for (let t = 0; t < seconds; t += FRAME) cur = step(want, cur);
    return cur;
  };

  test('a solo turn is not slowed by one millisecond', () => {
    // The whole reason this is in the countdown rather than in a lobby.
    let s = solo();
    for (let i = 0; i < 200; i++) {
      const t = s.stateTime;
      s = step(1, s);
      assert.equal(s.arrived, false);
      assert.equal(s.stateTime, t, 'a solo countdown must never be rewound');
      assert.equal(s.lateJoins, 0);
      s = { ...s, stateTime: t + COUNTDOWN_SEC / 200 };
    }
  });

  test('someone arriving late still gets a real countdown', () => {
    // 2.9s into a 3.2s countdown: without the rewind they would be walking
    // into frame as the round started.
    const r = step(2, solo(2.9));
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
    const r = step(2, solo(0.2));
    assert.equal(r.arrived, true);
    assert.equal(r.stateTime, 0.2, 'an early arrival must not push the clock backwards');
  });

  test('the rewind lands exactly on the floor and no further', () => {
    const r = step(2, solo(COUNTDOWN_SEC));
    assert.ok(Math.abs(r.stateTime - FLOOR_AT) < 1e-9);
  });

  test('an arrival is honoured once, not every frame it persists', () => {
    // `lateJoins` is the only thing bounding the worst case, so a steady two
    // people must not keep spending it.
    let s = step(2, solo(1.0));
    assert.equal(s.lateJoins, 1);
    s = hold(2, s, 2.0);
    assert.equal(s.lateJoins, 1, 'a standing pair kept re-triggering the arrival');
    assert.equal(s.stateTime, FLOOR_AT > 1.0 ? 1.0 : s.stateTime);
  });

  /* ---------------- departures ---------------- */

  test('one dropped frame does NOT turn a versus round solo', () => {
    // Two people close enough to play side by side occlude each other
    // constantly. This is the failure that would only ever show up with two
    // real bodies: the friend is standing right there and the game has quietly
    // decided they are not playing.
    let s = step(2, solo(0.5));
    assert.equal(s.playerCount, 2);
    s = step(1, s); // blink
    assert.equal(s.playerCount, 2, 'demoted on a single frame of tracker loss');
    s = step(2, s); // back
    assert.equal(s.belowFor, 0, 'the grace window did not reset when they reappeared');
    assert.equal(s.playerCount, 2);
  });

  test('a run of dropped frames shorter than the grace is survived', () => {
    let s = step(2, solo(0.5));
    s = hold(1, s, DEPART_GRACE_SEC * 0.8);
    assert.equal(s.playerCount, 2, `demoted after ${(DEPART_GRACE_SEC * 0.8).toFixed(2)}s`);
  });

  test('actually walking away does drop the round back to solo', () => {
    // Otherwise the round opens with a split divider, a second HUD and a
    // second score belonging to nobody.
    let s = step(2, solo(0.5));
    s = hold(1, s, DEPART_GRACE_SEC + 2 * FRAME);
    assert.equal(s.playerCount, 1);
    assert.equal(s.arrived, false);
  });

  test('a departure never extends the wait for whoever stayed', () => {
    let s = step(2, solo(1.0));
    const clock = s.stateTime;
    s = hold(1, s, DEPART_GRACE_SEC * 2);
    assert.equal(s.stateTime, clock, 'leaving must not rewind the countdown');
    assert.equal(s.lateJoins, 1, 'leaving does not refund a join');
  });

  test('the grace fits inside the countdown a late joiner is given', () => {
    // A departure must still be CAUGHT before GO in the tightest case, or a
    // round can start versus with one person in it.
    assert.ok(
      DEPART_GRACE_SEC < LATE_JOIN_FLOOR_SEC,
      `grace ${DEPART_GRACE_SEC}s does not fit in ${LATE_JOIN_FLOOR_SEC}s`
    );
  });

  /* ---------------- adversarial ---------------- */

  test('a flickering tracker cannot hold the countdown open forever', () => {
    // A body hovering at the edge of the play zone makes the tracker oscillate
    // 1 <-> 2. Two independent things have to stop that becoming an infinite
    // countdown: the grace absorbs the flicker so it reads as ONE arrival, and
    // the cap bounds it even if the grace is ever removed.
    let s = solo(COUNTDOWN_SEC - 0.05);
    let honoured = 0;

    for (let i = 0; i < 50; i++) {
      s = step(2, s);
      if (s.arrived) honoured++;
      s = step(1, s);
      assert.equal(s.arrived, false, 'a departure is never an arrival');
      s = { ...s, stateTime: s.stateTime + 0.05 };
    }

    assert.equal(honoured, 1, 'the grace should have read 50 flickers as one arrival');
    assert.ok(honoured <= MAX_LATE_JOINS, 'and the cap bounds it regardless');
    assert.ok(s.stateTime > COUNTDOWN_SEC, 'the clock ran out despite the flicker');
  });

  test('a flicker faster than the grace is absorbed, not counted', () => {
    // The pair case: player two blinks out every few frames for the whole
    // countdown. They must still be in the round at GO, and it must still be
    // ONE join, because `lateJoins` is what bounds the worst case.
    let s = step(2, solo(0.3));
    for (let i = 0; i < 40; i++) {
      s = step(i % 5 === 0 ? 1 : 2, s);
    }
    assert.equal(s.playerCount, 2);
    assert.equal(s.lateJoins, 1);
  });

  test('worst case is bounded, and it is short enough to stand still for', () => {
    // Two honoured arrivals, each at the last possible moment.
    let s = solo(COUNTDOWN_SEC);
    let spent = COUNTDOWN_SEC;
    for (let i = 0; i < MAX_LATE_JOINS; i++) {
      const before = s.stateTime;
      s = step(s.playerCount + 1, s);
      assert.equal(s.arrived, true);
      spent += before - s.stateTime;
      s = { ...s, stateTime: COUNTDOWN_SEC };
    }
    assert.ok(
      spent <= COUNTDOWN_SEC + MAX_LATE_JOINS * LATE_JOIN_FLOOR_SEC + 1e-9,
      `worst-case countdown ran ${spent.toFixed(2)}s`
    );
    assert.ok(spent < 7, 'nobody stands still in front of a crowd for seven seconds');
  });

  test('the invitation never outlives its own deadline', () => {
    // The pill says "A FRIEND CAN STEP IN". Someone acting on it on its last
    // visible frame has to actually make it into the round, or the machine
    // lied — which is worse than never offering. Reaction plus the tracker's
    // admission latency must fit inside what is left on the clock.
    assert.ok(
      INVITE_UNTIL_SEC >= STEP_IN_REACTION_SEC + ADMIT_LATENCY_SEC,
      `invite runs to ${INVITE_UNTIL_SEC}s but joining costs ` +
        `${STEP_IN_REACTION_SEC + ADMIT_LATENCY_SEC}s`
    );
    // And it has to be shown long enough to be read at all.
    assert.ok(COUNTDOWN_SEC - INVITE_UNTIL_SEC >= 1.5, 'the invitation is barely on screen');
  });

  test('a friend admitted on the last honest frame still gets a real countdown', () => {
    // Worst case that the invitation actually promises: they moved on the
    // final visible frame of the pill and the tracker took its full latency.
    const admittedAt = COUNTDOWN_SEC - INVITE_UNTIL_SEC + STEP_IN_REACTION_SEC + ADMIT_LATENCY_SEC;
    assert.ok(admittedAt < COUNTDOWN_SEC, 'admitted after GO — the offer was a lie');
    const r = step(2, solo(admittedAt));
    assert.equal(r.arrived, true);
    assert.ok(COUNTDOWN_SEC - r.stateTime >= LATE_JOIN_FLOOR_SEC - 1e-9);
  });

  test('a party game can absorb two arrivals, not just one', () => {
    // Red Light holds six. Two people joining a lobby of one is ordinary.
    const first = step(2, solo(1.0));
    assert.equal(first.playerCount, 2);
    const second = step(3, first);
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

/* ------------------------------------------------------------------ */
/* 4. The overtake                                                     */
/* ------------------------------------------------------------------ */

/**
 * A head-to-head has exactly one moment that is worth a celebration for free:
 * the instant the person who was losing goes ahead. Until `watchLead` the only
 * sign of it was a 2.2vh line flipping between "DOWN BY 3" and "LEADING BY 1",
 * which the crowd standing behind two friends cannot read.
 *
 * The rule is small and every one of its edges is a way to ruin it — announce
 * on a tie and it fires twice per overtake, announce every crossing and a
 * see-saw becomes wallpaper, announce the first lead and the opening second of
 * every round has a celebration in it.
 */
describe('the overtake is announced, and only the overtake', () => {
  const start = { leadSlot: -1, leadAt: -Infinity };

  test('the first player to go ahead has not overtaken anybody', () => {
    const r = leadChange(1, 0, start, 0.5);
    assert.equal(r.leadSlot, 0);
    assert.equal(r.announce, false, 'a celebration in the first second of the round');
  });

  test('taking the lead from somebody IS announced', () => {
    const first = leadChange(1, 0, start, 0.5);
    const over = leadChange(1, 2, first, 9);
    assert.equal(over.leadSlot, 1);
    assert.equal(over.announce, true);
    assert.equal(over.leadAt, 9);
  });

  test('a tie keeps the incumbent, so an overtake fires once and not twice', () => {
    // Scores cross THROUGH equality. Treating a draw as "nobody leads" fires
    // on the way in and again on the way out.
    let s = leadChange(5, 3, start, 1);
    s = leadChange(5, 5, s, 8); // the moment they draw level
    assert.equal(s.leadSlot, 0, 'the lead changed hands on a tie');
    assert.equal(s.announce, false);

    s = leadChange(5, 6, s, 8.1); // and now they are actually ahead
    assert.equal(s.leadSlot, 1);
    assert.equal(s.announce, true, 'the real overtake went unannounced');
  });

  test('a see-saw at one point apart is not eight celebrations', () => {
    // 67 Speed with two evenly matched players: the lead changes hands on
    // almost every rep.
    let s: ReturnType<typeof leadChange> = { ...start, announce: false };
    let fired = 0;
    let t = 0;
    for (let i = 0; i < 40; i++) {
      // Genuinely alternating: each one scores a point and goes one ahead.
      const base = 20 + Math.floor(i / 2);
      const a = base + (i % 2 === 0 ? 1 : 0);
      const b = base + (i % 2 === 0 ? 0 : 1);
      s = leadChange(a, b, s, t);
      if (s.announce) fired++;
      t += 0.25; // 10 seconds of trading the lead
    }
    assert.ok(fired <= 10 / LEAD_DEBOUNCE_SEC + 1, `${fired} announcements in 10s`);
    assert.ok(fired >= 1, 'a genuine back-and-forth said nothing at all');
  });

  test('the debounce never LOSES the lead, only the announcement', () => {
    // Whoever is actually ahead has to be right even when the celebration is
    // suppressed — the HUD and the results screen both read this.
    let s = leadChange(1, 0, start, 0.5);
    s = leadChange(0, 1, s, 1.0); // announced
    assert.equal(s.leadSlot, 1);
    s = leadChange(2, 1, s, 1.2); // inside the debounce
    assert.equal(s.leadSlot, 0, 'the leader was wrong while the debounce held');
    assert.equal(s.announce, false);
  });

  test('a round where nobody ever scores says nothing', () => {
    let s: ReturnType<typeof leadChange> = { ...start, announce: false };
    for (let i = 0; i < 200; i++) {
      s = leadChange(0, 0, s, i / 60);
      assert.equal(s.announce, false);
    }
    assert.equal(s.leadSlot, -1);
  });

  test('a runaway winner is announced once, not once per point', () => {
    let s = leadChange(0, 1, start, 0.5);
    let fired = 0;
    for (let i = 0; i < 100; i++) {
      s = leadChange(i, 1, s, 1 + i * 0.5);
      if (s.announce) fired++;
    }
    assert.equal(fired, 1, `${fired} announcements for one overtake`);
  });
});

/* ------------------------------------------------------------------ */
/* 5. "How many playing?"                                              */
/* ------------------------------------------------------------------ */

/**
 * The one thing the camera cannot read is INTENT.
 *
 * Two friends stand side by side, one wants a solo run for the board and the
 * other is watching from inside the play zone. To the tracker that is a versus
 * round; to them it is a ruined turn, and the only fix available before the
 * mode screen was folklore — "step back off the tape" — that nothing on screen
 * ever said.
 *
 * So `solo` is the only mode that changes anything: `open` is exactly what the
 * detection already produced. That asymmetry is the whole design and it is
 * what these pin.
 */
describe('the play mode caps the round, and only downward', () => {
  test('JUST ME means one seat however many bodies are in frame', () => {
    for (const [name, cfg] of GAMES) {
      for (const present of [1, 2, 3, 6]) {
        assert.equal(
          rosterSize(present, cfg, 'solo'),
          1,
          `${name} seated more than one with ${present} present`
        );
      }
    }
  });

  test('OPEN is exactly what the machine does on its own', () => {
    // If these ever diverge, the mode screen has started changing behaviour
    // for people who never touched it.
    for (const [name, cfg] of GAMES) {
      for (const present of [0, 1, 2, 3, 6, 12]) {
        assert.equal(
          rosterSize(present, cfg, 'open'),
          rosterSize(present, cfg),
          `${name} at ${present} present`
        );
      }
    }
  });

  test('no mode at all is also what the machine does on its own', () => {
    // A game reached without the screen — a keyboard jump, the dev harness, a
    // one-seat game — must behave exactly as it did before the screen existed.
    for (const [name, cfg] of GAMES) {
      for (const present of [0, 1, 2, 6]) {
        assert.equal(
          rosterSize(present, cfg, null),
          rosterSize(present, cfg),
          `${name} at ${present} present`
        );
      }
    }
  });

  test('solo still seats one when nobody is in frame', () => {
    // `rosterSize` feeds array lengths and loop bounds; zero is never an answer.
    for (const [, cfg] of GAMES) assert.equal(rosterSize(0, cfg, 'solo'), 1);
  });

  test('the screen only appears where there is a question', () => {
    // A screen offering a choice of one is a delay dressed as agency.
    for (const [name, cfg] of GAMES) {
      assert.equal(
        modeScreenApplies(cfg.gameId),
        cfg.maxPlayers > 1,
        `${name} seats ${cfg.maxPlayers}`
      );
    }
  });

  test('a choice is consumed once and never inherited', () => {
    // The failure this prevents: somebody picks JUST ME, walks away before the
    // round starts, and the next person up gets a solo round they never asked
    // for — on the game they did not choose either.
    setPlayMode('solo');
    assert.equal(takePlayMode(), 'solo');
    assert.equal(takePlayMode(), null, 'the choice outlived the turn it was made for');
  });
});
