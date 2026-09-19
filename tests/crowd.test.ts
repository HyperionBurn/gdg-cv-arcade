/**
 * "Ensure passersby don't affect the game."
 *
 * That is the stall owner's requirement, verbatim, and a club fair is a
 * corridor of moving people. The other report from the same playtest was
 * "tracking is a bit wonky". These tests are the two of them written down as
 * scenes: somebody walking behind the player, somebody watching from two
 * metres back, two players crossing, a player turning until the model loses
 * their shoulders, a player briefly hidden by a stranger.
 *
 * WHY BY HAND AND NOT THROUGH THE SIMULATOR. `core/simulator.ts` emits exactly
 * as many clean, evenly-lit, identically-sized bodies as it is told to, all
 * standing still in the middle of the frame. Not one scene below is a shape of
 * input it can produce, and the one tracker bug that reached a real camera —
 * Red Light reading one person as four — is precisely the bug it could never
 * have caught.
 *
 * Bodies come from `tests/scene.ts`, which builds them in isotropic units and
 * squeezes x by the aspect last, exactly as MediaPipe reports and exactly as
 * the simulator does. Noise is pixel-isotropic for the same reason.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PoseTracker, type TrackedPlayer } from '../src/core/tracker.ts';
import {
  computeArea,
  computeCentroid,
  computeScale,
  dist,
  selectCandidates,
} from '../src/core/candidates.ts';
import { POSE } from '../src/core/types.ts';
import type { RawPose } from '../src/core/types.ts';
import {
  SCENE_ASPECT,
  personAt,
  makeBody,
  heightAt,
  groundYAt,
  lateralNormX,
  roughen,
  rng,
  REALISTIC_NOISE,
  HOSTILE_NOISE,
  type NoiseSpec,
} from './scene.ts';

const A = SCENE_ASPECT;
const FPS = 30;

interface Snapshot {
  frame: number;
  players: Array<{ id: number; slot: number; unit: number; x: number; speed: number }>;
  primaryId: number | null;
}

/** Step a tracker through a scripted scene and record what games would see. */
function run(
  tracker: PoseTracker,
  scene: (frame: number) => RawPose[],
  frames: number,
  noise: NoiseSpec = REALISTIC_NOISE,
  seed = 1
): Snapshot[] {
  const r = rng(seed);
  const out: Snapshot[] = [];
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    const poses = scene(f).map((p) => roughen(p, noise, r));
    const players = tracker.update(poses, t);
    const primary = tracker.getPrimary();
    out.push({
      frame: f,
      players: players.map((p: TrackedPlayer) => ({
        id: p.id,
        slot: p.slot,
        unit: p.scale.unit,
        x: p.centroid.x,
        speed: p.speed,
      })),
      primaryId: primary ? primary.id : null,
    });
  }
  return out;
}

/** Frames from the first one that had any confirmed player. */
function afterAdmission(log: Snapshot[]): Snapshot[] {
  const i = log.findIndex((s) => s.players.length > 0);
  return i < 0 ? [] : log.slice(i);
}

/* ------------------------------------------------------------------ */
/* The scenes are only worth anything if they are actually adversarial */
/* ------------------------------------------------------------------ */

describe('the scenes really are hard', () => {
  test('a walker passing behind comes well inside the old match radius', () => {
    // If this stops being true the passer-by tests below are not testing
    // anything. 0.25 was the shipped `matchRadius`, in raw normalised units,
    // which `dist()` measures in fractions of frame HEIGHT.
    const player = personAt(0.45, 3);
    const pc = computeCentroid(player.landmarks);
    const pu = computeScale(player.landmarks, A).unit;
    let closest = Infinity;
    for (const d of [3.6, 4.2, 5]) {
      const wc = computeCentroid(personAt(0.45, d).landmarks);
      closest = Math.min(closest, dist(pc.x, pc.y, wc.x, wc.y, A));
    }
    assert.ok(closest < 0.25, `closest approach ${closest.toFixed(3)} must be inside the old 0.25`);
    assert.ok(
      closest / pu < 1.0,
      `closest approach is ${(closest / pu).toFixed(2)} torso units — inside any plausible radius`
    );
  });

  test('a walker with their arms out really does outrank a still player by bbox area', () => {
    // The mechanism that stole the player's one candidate slot. Pinned so the
    // fix cannot be quietly reverted by re-sorting on area.
    const player = personAt(0.35, 3, { armSpread: 0.05 });
    const walker = personAt(0.7, 4.2, { armSpread: 1 });
    const chosen = selectCandidates([player, walker], {
      maxPlayers: 1,
      minArea: 0.02,
      minConfidence: 0.45,
      dedupeTorsos: 0.55,
      minRelativeSize: 0.5,
      aspect: A,
    });
    assert.equal(chosen.length, 1);
    assert.ok(
      chosen[0]!.unit > computeScale(walker.landmarks, A).unit,
      'the single candidate handed to the tracker must be the PLAYER'
    );
    // ...and the thing that used to decide it:
    const areaOf = (p: RawPose): number => {
      const c = selectCandidates([p], {
        maxPlayers: 1, minArea: 0, minConfidence: 0, dedupeTorsos: 0, minRelativeSize: 0, aspect: A,
      });
      return c[0]!.area;
    };
    assert.ok(
      areaOf(walker) > areaOf(player),
      'the walker must still WIN on area, or this test proves nothing'
    );
  });
});

/* ------------------------------------------------------------------ */
/* Passers-by                                                          */
/* ------------------------------------------------------------------ */

describe('a stranger walking behind the player', () => {
  /** Player standing at 3m; a stranger crosses the whole frame at 4.2m. */
  const scene = (f: number): RawPose[] => {
    const t = f / FPS;
    const vx = lateralNormX(1.3, 4.2);
    return [personAt(0.45, 3, { armSpread: 0.05 }), personAt(0.02 + vx * t, 4.2, { armSpread: 0.8 })];
  };

  test('the player keeps their identity, their lane and their scale', () => {
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log = afterAdmission(run(tracker, scene, 150));
    assert.ok(log.length > 100, 'the player should be admitted early and stay');

    const ids = new Set<number>();
    const units: number[] = [];
    for (const s of log) {
      assert.equal(s.players.length, 1, `frame ${s.frame}: ${s.players.length} players`);
      ids.add(s.players[0]!.id);
      assert.equal(s.players[0]!.slot, 0, `frame ${s.frame}: slot moved`);
      units.push(s.players[0]!.unit);
    }
    assert.equal(ids.size, 1, `identity changed ${ids.size} times while somebody walked past`);

    const lo = Math.min(...units);
    const hi = Math.max(...units);
    assert.ok(
      hi / lo < 1.1,
      `scale.unit swung ${(100 * (hi / lo - 1)).toFixed(0)}% (${lo.toFixed(4)}..${hi.toFixed(4)}) — ` +
        'every gesture threshold in every game moves with it'
    );
  });

  test('the stranger is never admitted, even in a two-player game', () => {
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    for (const s of run(tracker, scene, 150)) {
      assert.ok(s.players.length <= 1, `frame ${s.frame}: ${s.players.length} players admitted`);
    }
  });

  test('the stranger is never admitted in a six-player game either', () => {
    // Red Light asks for six, which is where every previous crowd failure
    // surfaced: spare lanes mean nothing is competing for a slot.
    const tracker = new PoseTracker({ maxPlayers: 6, aspect: A });
    for (const s of run(tracker, scene, 150)) {
      assert.ok(s.players.length <= 1, `frame ${s.frame}: ${s.players.length} players admitted`);
    }
  });

  test('the stranger does not steal getPrimary, arms out or not', () => {
    const tracker = new PoseTracker({ maxPlayers: 6, aspect: A });
    const log = afterAdmission(run(tracker, scene, 150));
    const ids = new Set(log.map((s) => s.primaryId));
    assert.equal(ids.size, 1, `getPrimary changed identity ${ids.size} times`);
  });

  test('the walker is measurably moving and the player measurably is not', () => {
    // The signal admission is actually keyed on, asserted directly so a
    // regression reads as "the speed estimate broke" rather than as a mystery.
    const tracker = new PoseTracker({ maxPlayers: 6, aspect: A });
    const log = afterAdmission(run(tracker, scene, 150, HOSTILE_NOISE, 4));
    const speeds = log.flatMap((s) => s.players.map((p) => p.speed)).filter((v) => v > 0);
    assert.ok(speeds.length > 50, 'expected a speed reading on most frames');
    assert.ok(
      Math.max(...speeds) < 0.9,
      `a standing player peaked at ${Math.max(...speeds).toFixed(2)} torso/s, over the admission gate`
    );
  });
});

describe('a watcher standing still behind the player', () => {
  /** Torso centroid height in frame for somebody standing `d` metres away. */
  const centroidY = (d: number): number => computeCentroid(personAt(0.5, d).landmarks).y;
  /** Torso unit for somebody standing `d` metres away. */
  const unitAt = (d: number): number => computeScale(personAt(0.5, d).landmarks, A).unit;

  /** The lateral half of a play area: a box, generous vertically. */
  const PLAY_BOX = { x0: 0.12, x1: 0.88, y0: 0.05, y1: 0.95 };
  /**
   * The depth half: floor tape at 3.7m, expressed as the size a body standing
   * on it reads. BOTH gates, because they are an OR — `minUnit` can only ever
   * ADMIT a body the area gate rejected (that is its whole job: keeping a
   * turned player, whose box collapsed but whose torso did not). Moving the
   * line means moving both.
   */
  const TAPE_UNIT = unitAt(3.7);
  const TAPE_AREA = computeArea(personAt(0.5, 3.7).landmarks);

  test('somebody clearly further back is rejected by relative size', () => {
    const tracker = new PoseTracker({ maxPlayers: 6, aspect: A });
    const log = run(tracker, () => [personAt(0.4, 3), personAt(0.75, 7)], 120);
    for (const s of afterAdmission(log)) {
      assert.equal(s.players.length, 1, `frame ${s.frame}: the watcher got a lane`);
    }
  });

  test('BE HONEST: a watcher at 4.5m who stops IS admitted by size alone', () => {
    // Not a regression — the limit `minRelativeSize` already documents, written
    // down so nobody discovers it at the stall. Apparent size is a proxy for
    // distance and the ranges overlap: a watcher at 4.5m is 0.67 of a 3m
    // player, and two GENUINE players at 3m and 4m are 0.75. No size threshold
    // separates those, and motion does not either, because a watcher who has
    // stopped is standing exactly as still as a player.
    //
    // Only a 6-lane game can be hurt by it: with `maxPlayers` 1 or 2 the real
    // players hold the slots. Red Light is the 6-lane game.
    const tracker = new PoseTracker({ maxPlayers: 6, aspect: A });
    const log = run(tracker, () => [personAt(0.4, 3), personAt(0.75, 4.5)], 120);
    assert.equal(
      log[119]!.players.length,
      2,
      'if this ever becomes 1, the size gate got stricter — check it did not also ' +
        'start rejecting a real player one step back'
    );
  });

  test('...and an absolute depth limit is what actually rejects them', () => {
    // The honest fix, and the one the marshal can apply in the real room:
    // floor tape, expressed as the torso size a body standing on it reads.
    // ABSOLUTE, so unlike `minRelativeSize` it does not depend on who else is
    // in shot — a watcher behind an EMPTY stall is rejected too.
    const tape = { minUnit: TAPE_UNIT, minArea: TAPE_AREA };
    const tracker = new PoseTracker({ maxPlayers: 6, aspect: A, ...tape });
    const log = run(tracker, () => [personAt(0.4, 3), personAt(0.75, 4.5)], 120);
    for (const s of afterAdmission(log)) {
      assert.equal(s.players.length, 1, `frame ${s.frame}: the watcher stood behind the tape`);
    }

    // ...it does not cost the player one step back, who is still inside it...
    const t2 = new PoseTracker({ maxPlayers: 2, aspect: A, ...tape });
    assert.equal(
      run(t2, () => [personAt(0.35, 3), personAt(0.68, 3.5)], 120)[119]!.players.length,
      2,
      'a player standing just inside the tape must still be admitted'
    );

    // ...and it does not re-break the turned player, which is the whole reason
    // the two gates are an OR rather than an AND.
    const t3 = new PoseTracker({ maxPlayers: 1, aspect: A, ...tape });
    assert.equal(
      run(t3, () => [personAt(0.5, 3, { yaw: (85 * Math.PI) / 180 })], 60)[59]!.players.length,
      1,
      'a turned player inside the tape must survive a raised area gate'
    );
  });

  test('the Y axis of a play zone cannot do depth, and here is why', () => {
    // Pinned so nobody reaches for floor tape as a y band and quietly ships a
    // gate that does nothing. A tripod sits at chest height and so does a
    // standing adult's torso centre, so the centroid lands on the lens axis and
    // barely moves with distance — while `scale.unit` moves by 3.5x.
    const ys = [2, 2.4, 3, 4, 5, 7].map(centroidY);
    const units = [2, 2.4, 3, 4, 5, 7].map(unitAt);
    const ySpan = Math.max(...ys) - Math.min(...ys);
    assert.ok(ySpan < 0.02, `centroid y spans only ${ySpan.toFixed(4)} from 2m to 7m`);
    assert.ok(
      Math.max(...units) / Math.min(...units) > 3,
      'scale.unit is the signal that actually carries distance'
    );
    // Not even monotone: it turns around further out than the play spot.
    assert.ok(centroidY(7) < centroidY(4.5), 'centroid y is not monotone in distance');
  });

  test('a real player standing one step back is still admitted', () => {
    // The failure the gates must NOT cause, at tracker level rather than just
    // in selection. Two genuine players at 3m and 4m are 0.75 on relative
    // size, which is nowhere near the 0.5 floor.
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    const log = run(tracker, () => [personAt(0.35, 3), personAt(0.68, 4)], 120);
    assert.equal(log[log.length - 1]!.players.length, 2, 'both players must be admitted');
  });

  test('somebody more than half out of frame is not a player', () => {
    // MediaPipe extrapolates what it cannot see rather than omitting it, so a
    // body mostly outside the frame still reports a confident FULL-SIZE torso —
    // which is why `minUnit` may only admit a body whose scale is `reliable`.
    // Without that guard this is the one case the area gate was really catching.
    const leaner = (): RawPose => {
      const p = personAt(-0.07, 3);
      for (const l of p.landmarks) if (l.x < 0) l.visibility = 0.1;
      return p;
    };
    assert.ok(
      computeScale(leaner().landmarks, A).unit > 0.2,
      'the leaner must still REPORT a full-size torso, or this proves nothing'
    );
    assert.equal(computeScale(leaner().landmarks, A).reliable, false, 'but not a believable one');

    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    const log = run(tracker, () => [personAt(0.5, 3), leaner()], 120);
    for (const s of afterAdmission(log)) {
      assert.equal(s.players.length, 1, `frame ${s.frame}: the leaner got a lane`);
    }
  });

  test('somebody leaning in at the edge is rejected by the zone', () => {
    // Half-in rather than mostly-out: enough of them is framed to pass the
    // area gate, so only "they are not standing in the play area" is left.
    const leaner = (): RawPose => {
      const p = personAt(0.02, 3);
      for (const l of p.landmarks) if (l.x < 0) l.visibility = 0.1;
      return p;
    };
    const open = new PoseTracker({ maxPlayers: 2, aspect: A });
    assert.equal(
      run(open, () => [personAt(0.5, 3), leaner()], 120)[119]!.players.length,
      2,
      'without a zone the edge leaner IS admitted — the limit this documents'
    );

    const boxed = new PoseTracker({ maxPlayers: 2, aspect: A, zone: PLAY_BOX });
    for (const s of afterAdmission(run(boxed, () => [personAt(0.5, 3), leaner()], 120))) {
      assert.equal(s.players.length, 1, `frame ${s.frame}: the leaner got a lane`);
    }
  });

  test('a zone never evicts a player already admitted inside it', () => {
    // A player who leans out of the taped box to swing at something must not
    // lose their round for it. `keep` exempts bodies we are already tracking.
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A, zone: PLAY_BOX });
    const log = run(
      tracker,
      // Admitted in the middle of the box, then leans out past its right edge.
      (f) => [personAt(f < 60 ? 0.5 : 0.5 + 0.45 * Math.min(1, (f - 60) / 30), 3)],
      140
    );
    const after = afterAdmission(log);
    const ids = new Set(after.flatMap((s) => s.players.map((p) => p.id)));
    assert.equal(ids.size, 1, 'the player was dropped and re-admitted as somebody else');
    assert.equal(log[139]!.players.length, 1, 'leaning out of the tape must not end the round');
  });
});

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

describe('identity survives what a crowd does to it', () => {
  test('a player hidden for over a second keeps their id AND their lane', () => {
    // Longer than `maxMissingFrames`, which is the case the reservation exists
    // for: somebody walks between the player and the camera mid-round.
    const scene = (f: number): RawPose[] => {
      const t = f / FPS;
      const vx = lateralNormX(1.3, 4.2);
      const walker = personAt(0.02 + vx * t, 4.2);
      // Hidden for 40 frames — 1.33s — well past the 15-frame grace.
      if (f >= 60 && f < 100) return [walker];
      return [personAt(0.45, 3), walker];
    };
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    const log = run(tracker, scene, 170);

    const before = log[55]!.players;
    const after = log[169]!.players;
    assert.equal(before.length, 1, 'one player before the occlusion');
    assert.equal(after.length, 1, 'one player after it');
    assert.equal(after[0]!.id, before[0]!.id, 'the player came back as somebody else');
    assert.equal(after[0]!.slot, before[0]!.slot, 'the player came back in a different lane');
  });

  test('coming back is immediate, not another stand-still wait', () => {
    const scene = (f: number): RawPose[] =>
      f >= 60 && f < 100 ? [] : [personAt(0.45, 3)];
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log = run(tracker, scene, 140);
    // Frame 100 is the first frame the body is back. One update to create the
    // track, and it should already be a player.
    assert.equal(log[100]!.players.length, 1, 'the player should be back on the first frame they are');
  });

  test('two players crossing do not swap ids', () => {
    // PLAN.md §2, the failure this module was written for.
    //
    // They stand still first, because that is what admission now requires and
    // because it is what people do: you arrive, you are given a lane, THEN you
    // move. They pass at different depths, because two people walking through
    // each other is not a scene and two people walking AROUND each other is.
    const CROSS_START = 45;
    const CROSS_FRAMES = 90;
    const scene = (f: number): RawPose[] => {
      const u = Math.min(1, Math.max(0, (f - CROSS_START) / CROSS_FRAMES));
      return [personAt(0.28 + 0.44 * u, 3.0), personAt(0.72 - 0.44 * u, 3.7)];
    };
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    const log = run(tracker, scene, 180);

    // Identify each track by which SIDE it started on, then check it ends on
    // the other side still carrying the same id.
    const start = log[CROSS_START]!.players;
    assert.equal(start.length, 2, 'both players admitted before the crossing');
    const startLeft = [...start].sort((a, b) => a.x - b.x)[0]!;

    const end = log[179]!.players;
    assert.equal(end.length, 2, 'both players still present after the crossing');
    const endRight = [...end].sort((a, b) => b.x - a.x)[0]!;
    assert.equal(
      endRight.id,
      startLeft.id,
      'the player who started on the left must be the one who ended on the right'
    );
    assert.equal(new Set(end.map((p) => p.id)).size, 2, 'two distinct identities');

    // And their lanes really did change hands, so this is not passing because
    // nothing moved.
    assert.notEqual(
      end.find((p) => p.id === startLeft.id)!.slot,
      startLeft.slot,
      'the crossing must actually have reordered the slots'
    );
  });

  test('two people who only ever walk across the frame never become players', () => {
    // The same motion without the standing-still bracket. This is a pair of
    // strangers crossing behind an empty stall, and nobody should get a lane.
    const scene = (f: number): RawPose[] => {
      const u = f / 90;
      return [personAt(0.02 + 0.9 * u, 3.4), personAt(0.98 - 0.9 * u, 4.1)];
    };
    const tracker = new PoseTracker({ maxPlayers: 6, aspect: A });
    for (const s of run(tracker, scene, 95)) {
      assert.equal(s.players.length, 0, `frame ${s.frame}: a passer-by was admitted`);
    }
  });

  test('a body that keeps flickering cannot fake standing still', () => {
    // A stranger crossing behind a queue is detected in bursts. If the motion
    // window is allowed to span the gaps, a small distance over a long span
    // reads as somebody perfectly still — which is precisely the one thing
    // admission asks for. The history is dropped whenever we lose a body.
    const scene = (f: number): RawPose[] => {
      if (f % 12 >= 6) return []; // occluded half the time, in 0.2s bursts
      const vx = lateralNormX(1.2, 4);
      return [personAt(0.02 + vx * (f / FPS), 4)];
    };
    const tracker = new PoseTracker({ maxPlayers: 6, aspect: A });
    for (const s of run(tracker, scene, 160)) {
      assert.equal(s.players.length, 0, `frame ${s.frame}: a flickering walker was admitted`);
    }
  });

  test('after a long blind gap the speed is UNKNOWN, not computed across it', () => {
    // The motion window is a window. Keeping a floor of two samples in it looks
    // harmless and is not: after a gap longer than the window, the older
    // survivor is stale, and displacement measured between two points 0.43s
    // apart — most of which we did not see — is not a speed. A body that
    // vanished and came back near where it left would read as perfectly still,
    // which is exactly what admission is looking for.
    const scene = (f: number): RawPose[] => (f >= 60 && f < 73 ? [] : [personAt(0.45, 3)]);
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log = run(tracker, scene, 120, REALISTIC_NOISE, 5);

    // 13 frames blind is 0.43s, longer than the 0.4s window but inside the
    // 15-frame grace, so the track is still alive and still a player.
    assert.equal(log[73]!.players.length, 1, 'the track should survive a 13-frame gap');
    assert.equal(
      log[73]!.players[0]!.speed,
      0,
      'the first frame back must report no speed rather than one measured across the gap'
    );
    // And it comes back on its own once enough of a window has been rebuilt.
    assert.ok(log[90]!.players[0]!.speed >= 0, 'speed is available again after the window refills');
  });

  test('a player who flickers but stands still IS admitted', () => {
    // The other half of the same rule: dropping the history must cost latency,
    // not the player. Somebody partly occluded at the tape still gets in.
    const scene = (f: number): RawPose[] => (f % 12 >= 8 ? [] : [personAt(0.5, 3)]);
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log = run(tracker, scene, 160);
    assert.ok(
      log.slice(-30).every((s) => s.players.length === 1),
      'a still body that blinks must still become a player'
    );
  });

  test('somebody who steps in FRONT of the player takes the slot', () => {
    // The failure the takeover rule exists for: whoever stops in front of the
    // camera first would otherwise own the only slot a 1P game has until they
    // walk away — a marshal setting up, or somebody reading the sign. 1.25x on
    // torso size is 60cm nearer at a 3m play spot, i.e. physically between the
    // player and the lens.
    const scene = (f: number): RawPose[] =>
      f < 60 ? [personAt(0.45, 3)] : [personAt(0.45, 3), personAt(0.62, 2.2)];
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log = run(tracker, scene, 200);

    const before = log[59]!.players;
    assert.equal(before.length, 1, 'the first body owns the slot to begin with');
    const after = log[199]!.players;
    assert.equal(after.length, 1, 'still exactly one player');
    assert.notEqual(after[0]!.id, before[0]!.id, 'the nearer body should have taken over');

    // ...but not instantly. Leaning through shot for half a second must not do it.
    const brief = (f: number): RawPose[] =>
      f >= 60 && f < 78 ? [personAt(0.45, 3), personAt(0.62, 2.2)] : [personAt(0.45, 3)];
    const t2 = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log2 = run(t2, brief, 140);
    assert.equal(
      log2[139]!.players[0]!.id,
      log2[59]!.players[0]!.id,
      'a body that leaned through shot must not have taken the slot'
    );
  });

  test('getPrimary does not flip between two players at the same distance', () => {
    // attract.ts MEASURED the largest-body identity changing up to 38 times a
    // second between people at similar distances, and worked around it locally.
    // The hysteresis belongs here, where every screen gets it.
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    const log = afterAdmission(
      run(tracker, () => [personAt(0.38, 3), personAt(0.62, 3.02)], 300, HOSTILE_NOISE, 41)
    );
    const flips = log.filter((s, i) => i > 0 && s.primaryId !== log[i - 1]!.primaryId).length;
    assert.equal(flips, 0, `getPrimary changed identity ${flips} times in 10s with nobody moving`);
  });

  test('two people standing side by side do not trade lanes', () => {
    // Slots used to be re-sorted by centroid x every frame with no memory, and
    // in a split-screen game a lane is half the television.
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    const log = afterAdmission(
      run(tracker, () => [personAt(0.42, 3), personAt(0.58, 3)], 300, HOSTILE_NOISE, 12)
    );
    const seen = new Map<number, number>();
    let churn = 0;
    for (const s of log) {
      for (const p of s.players) {
        const was = seen.get(p.id);
        if (was !== undefined && was !== p.slot) churn++;
        seen.set(p.id, p.slot);
      }
    }
    assert.equal(churn, 0, `lanes changed hands ${churn} times while nobody moved`);
  });
});

/* ------------------------------------------------------------------ */
/* Scale                                                               */
/* ------------------------------------------------------------------ */

describe('scale.unit holds still', () => {
  /** Worst ratio between any two published units over the run. */
  function swing(log: Snapshot[], id?: number): number {
    const us = log
      .flatMap((s) => s.players)
      .filter((p) => id === undefined || p.id === id)
      .map((p) => p.unit);
    return Math.max(...us) / Math.min(...us);
  }

  test('a player turning to profile does not move it', () => {
    // `unit` is torso HEIGHT and a yaw is horizontal, so this should be exact
    // but for noise. It is the property the whole aspect correction exists to
    // deliver, and the thing that silently broke before it.
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log = afterAdmission(
      run(
        tracker,
        (f) =>
          [personAt(0.5, 3, { yaw: (Math.min(1, Math.max(0, (f - 40) / 30)) * 80 * Math.PI) / 180 })],
        140,
        HOSTILE_NOISE,
        21
      )
    );
    assert.ok(swing(log) < 1.1, `unit swung ${((swing(log) - 1) * 100).toFixed(0)}% as the player turned`);
  });

  test('losing the hips does not move it', () => {
    // MediaPipe guesses occluded hips rather than omitting them, and when it
    // guesses badly the raw unit collapses by two thirds. Held instead.
    const scene = (f: number): RawPose[] => {
      const p = personAt(0.5, 3);
      if (f >= 60 && f < 100) {
        for (const i of [POSE.LEFT_HIP, POSE.RIGHT_HIP]) {
          const hip = p.landmarks[i]!;
          const sh = p.landmarks[i === POSE.LEFT_HIP ? POSE.LEFT_SHOULDER : POSE.RIGHT_SHOULDER]!;
          hip.y = sh.y + (hip.y - sh.y) * 0.12;
          hip.visibility = 0.1;
        }
      }
      return [p];
    };
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log = afterAdmission(run(tracker, scene, 160, HOSTILE_NOISE, 22));
    assert.ok(
      swing(log) < 1.12,
      `unit swung ${((swing(log) - 1) * 100).toFixed(0)}% while the hips were guessed`
    );
  });

  test('a stranger overlapping the player does not move it', () => {
    const scene = (f: number): RawPose[] => {
      const t = f / FPS;
      const vx = lateralNormX(1.1, 4.2);
      return [personAt(0.45, 3), personAt(0.1 + vx * t, 4.2, { armSpread: 0.9 })];
    };
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log = afterAdmission(run(tracker, scene, 150, HOSTILE_NOISE, 23));
    assert.ok(swing(log) < 1.1, `unit swung ${((swing(log) - 1) * 100).toFixed(0)}% as somebody passed`);
  });

  test('it still follows a player who genuinely walks closer', () => {
    // The failure a stabiliser causes if it is only a lock: a real 1.6x change
    // has to arrive, or every threshold is wrong for the player who moved.
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log = afterAdmission(
      run(tracker, (f) => [personAt(0.5, Math.max(2.5, 4 - 1.2 * (f / FPS)))], 150, HOSTILE_NOISE, 24)
    );
    const settled = log[log.length - 1]!.players[0]!.unit;
    const truth = computeScale(personAt(0.5, 2.5).landmarks, A).unit;
    assert.ok(
      Math.abs(settled / truth - 1) < 0.05,
      `after the approach unit read ${settled.toFixed(4)} against a true ${truth.toFixed(4)}`
    );
  });
});

/* ------------------------------------------------------------------ */
/* Aspect                                                              */
/* ------------------------------------------------------------------ */

describe('everything new is aspect-correct', () => {
  test('speed is the same for the same physical motion on either axis', () => {
    // Landmark x is normalised by frame WIDTH and y by HEIGHT. A speed that
    // forgot that would under-report a body moving SIDEWAYS by 1.78x — which
    // is the only direction a passer-by moves, so the gate would be measuring
    // the one case it exists for at 56% strength.
    const step = 0.004; // in frame HEIGHTS per frame
    const sideways = new PoseTracker({ maxPlayers: 1, aspect: A });
    const vertical = new PoseTracker({ maxPlayers: 1, aspect: A });

    const sx = run(sideways, (f) => [makeBody({ x: 0.3 + (step * f) / A, height: heightAt(3), groundY: groundYAt(3) })], 60, {}, 31);
    const sy = run(vertical, (f) => [makeBody({ x: 0.5, height: heightAt(3), groundY: groundYAt(3) - step * f })], 60, {}, 31);

    const last = (l: Snapshot[]): number => l[l.length - 1]!.players[0]!.speed;
    assert.ok(sx[59]!.players.length === 1 && sy[59]!.players.length === 1, 'both bodies tracked');
    const ratio = last(sx) / last(sy);
    assert.ok(
      Math.abs(ratio - 1) < 0.02,
      `sideways ${last(sx).toFixed(3)} vs vertical ${last(sy).toFixed(3)} torso/s — ratio ${ratio.toFixed(3)}`
    );
  });

  test('the match radius is body-relative, so it tightens as people get smaller', () => {
    // It was 0.25 in raw normalised units, which is 0.80 torso units for a
    // player at 2.5m and 1.27 at 4m: loosest exactly where bodies are closest
    // together on screen.
    const near = computeScale(personAt(0.5, 2.5).landmarks, A).unit;
    const far = computeScale(personAt(0.5, 4).landmarks, A).unit;
    const opts = new PoseTracker({ aspect: A }).getOptions();
    assert.ok(near > far, 'a nearer body has a bigger torso unit');
    assert.ok(
      opts.matchRadiusTorsos * near > opts.matchRadiusTorsos * far,
      'the radius must shrink with the body, not stay fixed in frame units'
    );
    // And the old constant is genuinely gone, not merely renamed.
    assert.ok(!('matchRadius' in opts), 'matchRadius in normalised units must not come back');
  });

  test('a body turned 85 degrees is still a player', () => {
    // Its bounding box collapses to under `minArea` while its torso height does
    // not move at all, so the AREA gate alone deleted a player who had not
    // gone anywhere. Reported as "they had to 67 at a certain angle".
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A });
    const log = run(tracker, () => [personAt(0.5, 3, { yaw: (85 * Math.PI) / 180 })], 60);
    assert.equal(log[59]!.players.length, 1, 'a turned player must not vanish');
  });
});

/* ------------------------------------------------------------------ */
/* A slot is where a score lives, so it cannot move mid-round          */
/* ------------------------------------------------------------------ */

/**
 * The tracker reorders slots when two people genuinely walk around each other,
 * and that is correct: slot is SCREEN ORDER, and a split screen is spatial.
 *
 * It is also, on its own, a silent scoring bug. Every versus game on the roster
 * indexes its points by slot — `this.points[slot]`, `this.counters[slot]`,
 * `this.slots[slot].score` — so the moment two players cross, each one inherits
 * the other's number, in the middle of a head-to-head round, with nothing on
 * screen to say it happened.
 *
 * Identity was never the problem: ids survive a crossing (see the test above).
 * The fix is to stop asking the ordering question while a round is live.
 */
describe('slots are frozen while a round is running', () => {
  /** The same crossing as the identity test, which is known to reorder slots. */
  const crossing = (f: number): RawPose[] => {
    const u = Math.min(1, Math.max(0, (f - 45) / 90));
    return [personAt(0.28 + 0.44 * u, 3.0), personAt(0.72 - 0.44 * u, 3.7)];
  };

  test('unlocked, a crossing DOES move both players to the other slot', () => {
    // The failing case, pinned. If this ever stops being true the lock below
    // is solving a problem that no longer exists and should be reconsidered.
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    const log = run(tracker, crossing, 180);

    const start = log[45]!.players;
    assert.equal(start.length, 2, 'both admitted before the crossing');
    const left = [...start].sort((a, b) => a.x - b.x)[0]!;

    const end = log[179]!.players.find((p) => p.id === left.id)!;
    assert.notEqual(end.slot, left.slot, 'the crossing did not reorder anything');
  });

  test('locked, the same crossing leaves every slot where it was', () => {
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    // Let admission and ordering settle first, exactly as a round does: the
    // lobby and countdown run unlocked, the lock goes on at GO.
    run(tracker, crossing, 45);
    const settled = tracker.getPlayers();
    const before = new Map(settled.map((p) => [p.id, p.slot]));
    const startX = new Map(settled.map((p) => [p.id, p.centroid.x]));
    assert.equal(before.size, 2, 'both admitted before the lock');

    tracker.setOptions({ lockSlots: true });
    const log = run(tracker, crossing, 180, REALISTIC_NOISE, 2);

    const end = log[179]!.players;
    assert.equal(end.length, 2, 'both players still present');
    for (const p of end) {
      assert.equal(p.slot, before.get(p.id), `player ${p.id} changed halves mid-round`);
    }
    // And they really did swap sides, so this is not passing because the scene
    // stopped being a crossing. Compared in landmark x, which is what ordering
    // is computed from, rather than in slot terms — `mirrored` flips those.
    const startLeftId = [...startX.keys()].sort(
      (a, b) => startX.get(a)! - startX.get(b)!
    )[0]!;
    const endLeftId = [...end].sort((a, b) => a.x - b.x)[0]!.id;
    assert.notEqual(endLeftId, startLeftId, 'nobody actually crossed');
  });

  test('locked, a newcomer still gets a slot rather than none at all', () => {
    // A mid-round takeover, or somebody returning after the tracker gave up on
    // them, arrives with slot -1. Freezing the order must not mean freezing
    // them out — a player with slot -1 indexes nothing and scores nowhere.
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    const alone = (): RawPose[] => [personAt(0.3, 3.0)];
    run(tracker, alone, 45);
    assert.equal(tracker.getPlayers().length, 1);

    tracker.setOptions({ lockSlots: true });
    const pair = (): RawPose[] => [personAt(0.3, 3.0), personAt(0.7, 3.0)];
    const log = run(tracker, pair, 120, REALISTIC_NOISE, 3);

    const end = log[119]!.players;
    assert.equal(end.length, 2, 'the second person was never admitted');
    const slots = end.map((p) => p.slot).sort();
    assert.deepEqual(slots, [0, 1], `slots were ${JSON.stringify(slots)}`);
  });

  test('locked, two people standing still keep their halves under hostile noise', () => {
    // The everyday case. Two friends side by side, neither going anywhere, for
    // a whole round.
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    const still = (): RawPose[] => [personAt(0.34, 3.0), personAt(0.66, 3.05)];
    run(tracker, still, 45);
    const before = new Map(tracker.getPlayers().map((p) => [p.id, p.slot]));
    assert.equal(before.size, 2);

    tracker.setOptions({ lockSlots: true });
    const log = run(tracker, still, 600, HOSTILE_NOISE, 7);

    let churn = 0;
    for (const s of log) {
      for (const p of s.players) if (before.has(p.id) && p.slot !== before.get(p.id)) churn++;
    }
    assert.equal(churn, 0, `${churn} frames with a swapped half`);
  });

  test('the lock lifts, and ordering catches up with the room', () => {
    // Between rounds the order has to be free again, or the next pair inherit
    // the last pair's halves regardless of where they are standing.
    const tracker = new PoseTracker({ maxPlayers: 2, aspect: A });
    run(tracker, crossing, 45);
    tracker.setOptions({ lockSlots: true });
    run(tracker, crossing, 180, REALISTIC_NOISE, 4);

    tracker.setOptions({ lockSlots: false });
    const after = run(tracker, crossing, 60, REALISTIC_NOISE, 5);
    const end = after[59]!.players;
    const byX = [...end].sort((a, b) => a.x - b.x);
    // Mirrored is on by default, so slot 0 is the RIGHTMOST body in landmark x.
    assert.equal(byX[byX.length - 1]!.slot, 0, 'ordering did not resume');
  });
});
