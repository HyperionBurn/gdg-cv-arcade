/**
 * RED LIGHT, GREEN LIGHT — "the sleeper hit".
 *
 * PLAN.md §3 rates this the single best addition to the roster, for one reason
 * the other six games cannot touch: **up to five people play at once**, which
 * turns the queue itself into the game. It is universally recognisable, needs
 * no explanation, has no skill floor, and is the best thing on the stall to
 * stand and watch.
 *
 * Two design decisions carry the whole game.
 *
 * 1. ADVANCING IS MOTION, NOT WALKING.
 *    PLAN.md §9 gives us ~3m of clear depth and a camera that can barely frame
 *    a whole body in it. Nobody can walk toward the line. So progress is
 *    accumulated from motion energy during green: you gain ground by moving a
 *    lot, anywhere. That fits the room, and it is much funnier — people flail
 *    to get ahead and then have to kill it instantly, which is precisely the
 *    posture the crowd came to see.
 *
 * 2. THE GRACE PERIOD IS THE GAME.
 *    A human cannot stop a flail in zero time, and neither can a low-pass
 *    filter. Judging movement the instant the light turns red eliminates
 *    everybody for momentum they could not have stopped, and the game goes
 *    from funny to infuriating in one round. Nothing is judged for the first
 *    `graceSec` (400ms) of red. Everything else here is tuning; this is not.
 *
 * Eliminated players are never removed. Their lane goes flat `COLORS.muted` and
 * their progress freezes exactly where they were caught, and that frozen
 * tableau of people who are visibly out is most of the comedy.
 *
 * ---------------------------------------------------------------------------
 * BRAND NOTE — how RED/GREEN survives the move to paper
 * ---------------------------------------------------------------------------
 *
 * The one thing this game cannot lose is that the light state is readable from
 * three metres, with the sound off, over somebody's shoulder. On the old dark
 * theme that was done with a full-screen low-alpha colour wash.
 *
 * A wash is a see-through colour, which DESIGN.md forbids outright — and on
 * paper it is also simply worse. 20% red over white is pale pink; on the cheap
 * panel a club fair actually supplies, with its own gamma and its own
 * contrast setting, a pale tint is the first thing to disappear. The word that
 * rode on top of it was drawn at alpha 0.13, which is invisible at any
 * distance.
 *
 * What replaced it is LOUDER, not merely legal: a full-bleed band of 100%
 * flat brand colour across the width of the screen, a second full-bleed
 * stripe under the lanes, and the doll's dress in the same flat colour. ~15%
 * of the screen at full saturation inside the overscan safe area, ~18% with
 * the stripe, against a wash that covered 100% at roughly a fifth of one.
 * Saturated area beats tinted area for pop-out at distance, it survives a
 * badly calibrated panel, and it carries the instruction — `<FREEZE>` /
 * `<MOVE>` in ink at 8.6vh — instead of a ghost word nobody could read. See
 * `onRenderBackground` and `drawBanner`.
 */

import { MotionEnergy, Hysteresis } from '../core/gestures';
import { tunables } from '../meta/tunables';
import { POSE_CONNECTIONS, type Landmark } from '../core/types';
import type { TrackedPlayer } from '../core/tracker';
import { GameBase } from './base';
import { audio } from '../engine/audio';
import { BURST } from '../engine/particles';
import {
  drawText,
  drawTabularNumber,
  measureText,
  graphPaper,
  stickerPill,
  vh,
  roundRect,
  type Viewport,
} from '../engine/draw';
import {
  COLORS,
  PLAYER_COLORS,
  FONTS,
  EASE,
  SHADOW,
  STROKE,
  TRACK,
  WEIGHT,
  idlePulse,
} from '../shell/theme';
import { GAME_COLORS } from '../meta/games';
import type { FrameContext } from '../shell/screen';

/**
 * What to draw ON a flat fill so it stays legible.
 *
 * `PLAYER_COLORS` runs yellow, blue, green, red, INK — five identities, one
 * per lane. Four of the five take ink; the ink one obviously does not, and a
 * black stick figure on a black chip is an invisible player.
 */
function markOn(fill: string): string {
  return fill === COLORS.ink ? COLORS.paper : COLORS.ink;
}

/**
 * FIVE, AND THE LENGTH OF `PLAYER_COLORS` IS WHY.
 *
 * PLAN.md §3 asked for six at once, and six is what this was — for the same
 * reason it is five now: the lane's identity IS its entry in `PLAYER_COLORS`,
 * so the roster can only be as long as that array. The sixth entry used to be
 * `COLORS.muted`, which is the exact value `drawLane` and `drawChip` use for
 * an ELIMINATED racer. Lane six was therefore drawn in the game's own colour
 * for "you are out", under a HUD reading 6/6 STILL IN.
 *
 * Four brand hues plus ink is five unmistakable identities and there is no
 * sixth to be had without a ninth palette token or a second identity axis.
 * Five real players beats six where one cannot tell whether they are playing.
 */
const LANES = 5;

/**
 * THE ELIMINATION DECISION, FOR ONE RACER, FOR ONE FRAME.
 *
 * Extracted for the same reason `laneScore` was: this is the rule the whole
 * game is judged on, it is four lines, and it had no test. What covered it was
 * the smoke probe — which is a real end-to-end check and deliberately tolerant
 * ("one honest player being caught is within the signal's spread") — and a
 * README line reading "0 false eliminations in a full 45s round", measured
 * once. Neither pins the three properties that decide whether this game is
 * funny or infuriating:
 *
 *   BREACH RESETS ON ANY STILL FRAME. You have to move CONTINUOUSLY for
 *   `breachSec`. A noise spike cannot accumulate across the still frames
 *   between spikes, which is the entire reason the game does not eliminate
 *   people for standing still.
 *
 *   NOTHING IS JUDGED BEFORE THE GRACE EXPIRES. `judging` is false for
 *   `graceSec` after the light turns, because judging the instant it turns
 *   punishes reaction time rather than obedience.
 *
 *   A NEWLY-ADMITTED PLAYER IS IMMUNE. Walking into frame must never mean
 *   walking straight out of the round.
 *
 * `settled` is `settle <= 0` — the immunity has expired. Returns the per-frame
 * near-miss flag rather than latching it; the caller ORs it, because a near
 * miss is worth celebrating for the rest of the light.
 */
export function judgeRedLight(
  breach: number,
  o: {
    moving: boolean;
    judging: boolean;
    settled: boolean;
    dt: number;
    breachSec: number;
  }
): { breach: number; eliminate: boolean; nearMiss: boolean } {
  // Still immune: carry the breach unchanged rather than resetting it, which
  // is what the guard this replaced did by skipping the branch entirely.
  if (!o.settled) return { breach, eliminate: false, nearMiss: false };

  const next = o.moving ? breach + o.dt : 0;
  return {
    breach: next,
    eliminate: o.judging && next >= o.breachSec,
    // Inside the grace window movement is not a foul, but it IS the near miss
    // worth celebrating when they survive the light.
    nearMiss: o.moving && !o.judging,
  };
}

/** Seconds a newly-seen player is immune. Walking in must never mean walking out. */
const SETTLE_SEC = 0.6;

/** How long the winning tableau holds before the results screen takes over. */
const WIN_HOLD_SEC = 1.9;
const WIPEOUT_HOLD_SEC = 1.2;

/**
 * Elimination callouts. Deliberately daft — ARCHITECTURE.md, "What good means
 * here": "Failure should be
 * funny, never punishing." Being out has to look like the best thing that
 * happened to you, or nobody queues twice.
 */
const TAUNTS = ['CAUGHT!', 'BUSTED!', 'TOO SLOW!', 'GOTCHA!', 'WOBBLED!', 'TWITCHED!'] as const;

export interface RedLightTunables {
  /**
   * Floor for the elimination threshold, in torso-units of mean landmark speed
   * per second. Everything in this file is measured in torso units per second,
   * never pixels and never per-frame — see `sample()`.
   */
  moveEnter: number;
  /** Hysteresis exit as a fraction of enter. ARCHITECTURE: every gate has a gap. */
  exitRatio: number;
  /** Threshold as a multiple of this player's own observed still-energy. */
  quietMult: number;
  /**
   * Hard ceiling on the learned STILL energy, as a multiple of `moveEnter`.
   * The threshold is `quietMult` times that, so this bounds what the game is
   * willing to believe "standing still" looks like. See `thresholdFor`.
   */
  quietCeiling: number;
  /** Nothing is judged for this long after the light turns red. THE feel knob. */
  graceSec: number;
  /** Movement must persist this long to count. Kills single-frame noise spikes. */
  breachSec: number;
  /**
   * Energy above the threshold that earns the maximum advance rate, as a
   * MULTIPLE of that threshold. See the note at the call site.
   */
  driveSpan: number;
  /** Percent of the track gained per second at full drive. */
  advanceRate: number;
  /** Time constant of the energy smoother. Must be well inside `graceSec`. */
  energyTau: number;
  /**
   * How long a newly admitted player's noise floor is learned FAST.
   *
   * Without this the game eliminates people for standing still. Measured
   * against a simulated body with realistic sensor noise (0.004 normalised,
   * about 3px of frame height): a PERFECTLY FROZEN player's energy settles at
   * ~1.99 torso-units/sec, while `quiet` crawls from 0.35 to 0.60 in six
   * seconds on a 20s time constant — and its ceiling of
   * `quietCeiling * moveEnter` = 1.615 sits BELOW the real floor anyway, so no
   * amount of waiting could have saved them. They advanced during green
   * without moving, and were eliminated during red for the same reason.
   *
   * The noise floor is a property of the ROOM, not of the player, and it is
   * observable in the first couple of seconds. So: learn it quickly while
   * nobody is racing yet, then lock to the slow constant that stops anyone
   * raising their own threshold by fidgeting.
   */
  calibrateSec: number;
  /**
   * Time constants of the lobby estimator, for energy BELOW the estimate and
   * for energy above it. Their ratio sets which percentile of the energy
   * distribution `quiet` converges on — see `calibrate`. Roughly the 10th at
   * 9:1, which is "how quiet this body gets when it is not doing anything"
   * while people walk in, wave and settle around it.
   */
  calibrateDown: number;
  calibrateUp: number;
}

/**
 * PLAN.md §4: every gesture tunable is expected to need adjusting on the day,
 * for real bodies under hall lighting. These are calibrated against the pose
 * simulator, which is the weakest part of this file — see the note on
 * `moveEnter` in `thresholdFor`.
 */
/**
 * MEASURED ENERGY DISTRIBUTIONS, in torso-units/sec, over 500 samples each.
 * Every number below is derived from these rather than guessed, because three
 * earlier attempts to tune this game by feel each moved it in the wrong
 * direction. Re-measure before changing any of them.
 *
 * RE-MEASURED after two compounding corrections landed together: `MotionEnergy`
 * was missing its aspect correction (under-reading HORIZONTAL motion by 1.78x),
 * and the simulator was adding landmark noise isotropically in the already
 * squeezed landmark space rather than in pixels (over-stating horizontal noise
 * by the same 1.78x). The two errors had been partly cancelling, so fixing
 * either one alone moved the numbers the wrong way.
 *
 *                     p10    p50    p90    p99
 *   clean  still      0.23   0.28   0.35   0.40
 *   clean  moving     4.15   4.25   4.90   4.94
 *   real   still      1.93   2.03   3.53   7.13
 *   real   moving     5.19   5.98   7.73  11.34
 *   host.  still      3.88   4.22   7.53  10.86
 *   host.  moving     6.90   7.29  11.24  14.99
 *
 * "real" is the simulator's realistic body: sensor noise, dropout, dominant-arm
 * bias, occasional limb swaps, edge bias and a lighting dip.
 *
 * THE HEADLINE: under realistic noise the still and moving distributions
 * OVERLAP — still p99 (5.40) sits above moving p10 (5.07). No instantaneous
 * threshold can separate them. That is not a tuning failure, it is a property
 * of the signal, and it is why `breachSec` has to carry the discrimination:
 * noise excursions are brief, a person who keeps moving is not.
 */
export const DEFAULT_REDLIGHT_TUNABLES: RedLightTunables = {
  moveEnter: 1.1,
  // 0.55 -> 0.75. The gate closes at `threshold * exitRatio`. At 0.55 that was
  // 2.1 against a realistic still-median of 2.01 — so one noise spike opened
  // the gate and it then hung open, because the body's ordinary still energy
  // was barely under the closing level. 0.75 puts the close at ~2.9, clear of
  // still p50 and still far below moving p10 (5.07).
  exitRatio: 0.75,
  // 2.4 -> 2.0. The threshold wants to sit between still p90 (2.92) and moving
  // p10 (5.07). `quiet` converges near still p10 (~1.93), so 2.0 lands it at
  // ~3.9 — the middle of that gap.
  quietMult: 1.6,
  /**
   * Caps what the lobby is allowed to believe "standing still" looks like.
   *
   * 3.8 -> 2.3, and this is a DELIBERATE TRADE between two bad cases rather
   * than a free win. Measured, 3 players, full rounds:
   *
   *                          ceiling 3.8      ceiling 2.3
   *   realistic, honest      wins, 100%       wins, 98-100%
   *   realistic, idle        3/3 alive        3/3 alive
   *   realistic, FLAILED
   *     through the lobby    10% of track     57% of track
   *   hostile, idle          3/3 alive        1/3 alive
   *
   * Somebody waving at the screen while they wait is ORDINARY behaviour — it
   * is what a stall queue does — and at 3.8 it trained the floor so high that
   * the threshold landed above real movement and the race crawled to a tenth
   * of the track. Double sensor noise is a stress case, and one where a still
   * body's p90 already sits ABOVE a moving body's p10, so false eliminations
   * there are arithmetically guaranteed however this is set.
   *
   * So: protect the common case, and let the hall's lighting and the camera
   * answer the hostile one. STILL CEILING is on the operator console if the
   * room turns out to be worse than the model.
   */
  quietCeiling: 2.3,
  // 0.4 -> 0.55.
  //
  // The 400ms figure came from testing ONE red transition in isolation. Over a
  // full round with 10+ transitions you only have to be slow once, and a
  // measured reaction sweep put the real survive/eliminate cliff at 400-500ms,
  // not the 500-600ms the docs claimed. A simple visual reaction is ~250ms
  // before you add "recognise the light changed" and "stop a moving body" — in
  // a loud hall, plenty of first-timers land past 500ms.
  //
  // Widening this only affects stopping in time. It does NOT make creeping
  // easier, because progress is measured as motion ABOVE the elimination
  // threshold, so anything quiet enough to survive is too quiet to gain ground.
  // 0.55 -> 0.75, from the second playtest: "red light freezes too fast".
  //
  // This is a FEEL number and human report is the right evidence for it —
  // there is no reaction time in the simulator to measure against. The budget
  // to stop is graceSec + breachSec, so this moves it from 0.85s to 1.05s.
  //
  // A simple visual reaction is ~250ms before you add "notice the doll turned",
  // "decide", and "arrest a moving body". First-timers in a loud hall, watching
  // a TV rather than the camera, land well past that. Being caught while you
  // are visibly already stopping reads as cheating to the whole queue, and the
  // queue is the audience this game is really for.
  graceSec: 0.75,
  // 0.12 -> 0.30. THIS is what separates still from moving, because no
  // threshold can — see the table above. A noise excursion is one or two vision
  // frames smoothed by `energyTau` into a hump of ~0.2s; a person who has not
  // stopped is above the line continuously. 0.12s was inside the noise and
  // eliminated motionless players.
  //
  // The cost is that the total budget to stop becomes graceSec + breachSec =
  // 0.85s. That is MORE forgiving than before, not less, and the grace is
  // already the number the whole game turns on.
  // 0.3 -> 0.45.
  //
  // The still-energy tail is HEAVY: realistic p90 is 3.53 but p99 is 7.13, so
  // a motionless body throws occasional excursions twice its own p90. No
  // threshold placed below a moving body (p10 5.19) sits above that tail, and
  // a player standing perfectly still was eliminated on it. Duration is the
  // only thing that separates a spike from a person who has not stopped.
  //
  // Total budget to stop is graceSec + breachSec = 1.2s, which also answers
  // the playtest's "red light freezes too fast" from the other direction.
  breachSec: 0.45,
  // 1.5 -> 0.75, a MULTIPLE of the threshold rather than an absolute span.
  //
  // `drive` is (energy - threshold) / span, so span sets how far above your own
  // still-level you must be to advance at full speed. At 1.5 and a realistic
  // threshold of ~3.9 the span was 5.8, and a moving body (p50 5.91) scored a
  // drive of 0.35 — a race six times slower than the same body in a clean room,
  // which is the "the markers barely move" failure this file has hit before.
  // MEASURED at 0.55: realistic rounds ended at 81-98% of the track with the
  // clock run out and no winner declared, three times running. A race nobody
  // crosses the line in is the whole spectacle of this game not happening.
  // 0.36. Under realistic noise the learned still-level (~1.85) sits ABOVE the
  // STILL CEILING, so the clamp binds and the threshold is pinned at 4.53 every
  // run. Against a moving median of 5.91 that leaves an excess of only 1.38, so
  // the span has to be ~1.6 for a competent player to drive near full speed.
  // MEASURED: 0.55 timed out at 81-98%, 0.46 finished in two runs of three,
  // 0.36 finishes around 38s of a 45s round. A clean body is capped at 1.0 by
  // any of these and is unaffected.
  //
  // This is RACE PACE in the operator console, and it is the first knob to
  // reach for if the hall's real noise floor differs from the simulator's:
  // everyone stuck at 80% when the clock runs out means drop it.
  // 0.2 -> 0.45. At 0.2 the span was 0.84 torso/s, so a NOISE SPIKE only 0.8
  // above the threshold already drove at 95% of full speed — a motionless body
  // gained 9-12% of the track per round on tail excursions alone. 0.45 puts a
  // spike at ~0.4 drive and a genuinely moving body (p50 5.98) at ~0.94, and
  // costs nothing in pace: rounds were finishing in 24-25s against a 45s clock.
  driveSpan: 0.45,
  // 6 -> 7. `drive` is computed per frame from instantaneous energy and then
  // clipped at 1, so its average over a round sits well BELOW the value the
  // median energy implies — measured, a realistic body that should have driven
  // at 0.85 advanced as if at 0.57 and finished the round at 85% of the track
  // with no winner. The rate carries that gap.
  advanceRate: 7,
  energyTau: 0.1,
  calibrateSec: 2.2,
  calibrateDown: 0.5,
  calibrateUp: 4.5,
};

type Light = 'green' | 'red';

interface Racer {
  /** Tracker id. Identity is keyed on this, never on slot — slots re-sort. */
  id: number;
  /** Fixed at first sight so a lane never swaps owner mid-round. */
  lane: number;
  color: string;
  /** 0..100. Frozen forever the moment they are eliminated. */
  progress: number;
  alive: boolean;
  finished: boolean;
  /** Smoothed movement, torso-units per second. */
  energy: number;
  /** Running estimate of this player's still-energy — the room's noise floor. */
  quiet: number;
  /** Seconds since admitted. Drives the fast calibration window. */
  age: number;
  motion: MotionEnergy;
  gate: Hysteresis;
  /** Seconds the move gate has been open during the current red. */
  breach: number;
  /** Moved inside the grace window but stopped in time. Worth telling them. */
  nearMiss: boolean;
  present: boolean;
  /** Seconds since last seen, for lane recycling. */
  absent: number;
  settle: number;
  /** Live reference into the tracker's filtered array — no copy needed. */
  landmarks: readonly Landmark[] | null;
  /** 0..1, drives the marker's bounce. Purely cosmetic. */
  wobble: number;
  /**
   * Seconds left on the round clock when this racer crossed the line, or 0.
   *
   * Per racer rather than read off `timeLeft` at scoring time, so finishing
   * FIRST is worth more than finishing last — the clock has moved on by the
   * time the round ends, and everyone would otherwise collect the same bonus.
   */
  finishedWith: number;
}

/** The subset of a racer that scoring actually reads. */
export interface ScorableRacer {
  lane: number;
  /** 0..100. */
  progress: number;
  /** Seconds left on the round clock when they crossed, or 0. */
  finishedWith: number;
}

/**
 * ONE SCORE PER LANE — the pure rule, extracted so it can be tested.
 *
 * THE BUG THIS REPLACED. `scoreFor(slot)` ignored `slot` entirely and returned
 * the same number for every player: Red Light is the only six-player game on
 * the roster, so six people finished a round, looked at the results screen,
 * and saw six identical scores. The leaderboard then took that one number six
 * times. A party game whose entire pitch is "last one standing" was, at the
 * only moment that pitch pays off, unable to say who won.
 *
 * Lane is the right key and slot is the right lookup: `lane` is fixed at first
 * sight precisely so it survives the tracker re-sorting slots mid-round, and
 * the base class asks for scores by slot. A racer who has left the frame still
 * has a lane and still has their frozen progress, so their score survives them
 * walking off — which is the common case at a stall.
 *
 * FINISHING FIRST BEATS FINISHING LAST. Everyone who crossed is on 100
 * progress, so progress alone makes the whole finishing group tie. The bonus
 * is the clock they had LEFT when they crossed, stamped per racer at the
 * moment of crossing — reading `timeLeft` at scoring time would hand every
 * finisher the same end-of-round value and re-create the tie one layer down.
 * Ten points a second is enough to separate a two-second gap and not enough to
 * let a fast finisher out-rank a whole extra lap of progress.
 */
export function laneScore(racers: Iterable<ScorableRacer>, slot: number): number {
  for (const r of racers) {
    if (r.lane !== slot) continue;
    if (r.progress >= 100) return 100 + Math.round(Math.max(0, r.finishedWith) * 10);
    // FLOOR AND CAP, not round. `Math.round(99.9)` is 100, and 100 is what a
    // racer who crossed the line with no clock left scores — so the player who
    // was eliminated a hand's width from the finish tied with the player who
    // actually got there. At a game whose whole drama is who crossed and who
    // froze, that is the one tie that must never happen. 0..99 is "did not
    // finish"; 100 and up is "finished", and the two ranges cannot touch.
    return Math.min(99, Math.floor(r.progress));
  }
  // No racer in that lane: an empty lane scores nothing. Never `undefined` —
  // this feeds a `RollingNumber` and then the leaderboard.
  return 0;
}

/**
 * What the lobby learned about one body, carried into the round.
 *
 * Kept OUTSIDE `racers` deliberately. `onStart` clears the racer map, and the
 * whole point of this measurement is that it was taken before the round began.
 */
interface Calib {
  /** Low quantile of smoothed energy — this body's still-level. See `calibrate`. */
  quiet: number;
  /** Smoothed movement, torso-units per second. */
  energy: number;
  /** Seconds of usable observation. Below `calibrateSec` we do not trust it. */
  age: number;
  /** Seconds since last seen, for eviction. */
  absent: number;
  motion: MotionEnergy;
}

interface LaneGeom {
  top: number;
  bottom: number;
  /** Height of one lane. */
  h: number;
  /** Start of the track (0%). */
  left: number;
  /** The finish line (100%). */
  right: number;
  chipX: number;
  chipW: number;
  dollW: number;
}

export class RedLightGame extends GameBase {
  private tun: RedLightTunables = { ...DEFAULT_REDLIGHT_TUNABLES };
  private racers = new Map<number, Racer>();

  /** Lobby noise-floor measurements, keyed by tracker id. See `Calib`. */
  private calib = new Map<number, Calib>();

  private light: Light = 'green';
  private lightT = 0;
  /**
   * True until the first red. Gates the one line that teaches the action.
   *
   * A time window rather than a behavioural one, because the person who needs
   * the instruction is by definition the person who has not acted on it yet —
   * see `drawBanner`.
   */
  private firstGreen = true;
  private lightDur = 3;
  /** Fraction of the phase after which the visual tightening starts. */
  private tellStart = 0.7;
  /** This green is a trap: very short, and with no tell. */
  private fakeout = false;

  /** 0 = doll faces away, 1 = doll is staring straight down the lanes. */
  private dollTurn = 0;
  private nextBeat = 0;
  /** True once the grace window of the current red has expired. */
  private judgeArmed = false;
  /** Eliminations on this frame, so a mass wipeout does not stack into itself. */
  private elimsThisFrame = 0;
  private elimPending = false;

  /** Most players seen at once. "Last one standing" needs somebody to outlast. */
  private startedCount = 0;
  private winnerId: number | null = null;
  private finalCall = '';
  private endHold = 0;
  private holdTotal = WIN_HOLD_SEC;

  private lastVisionFrame = -1;
  private lastVisionTime = 0;

  constructor() {
    super({
      gameId: 'redlight',
      title: 'RED LIGHT, GREEN LIGHT',
      // Player-facing, so it carries the brand voice: the action in brackets.
      //
      // "MOVE ON GREEN" WAS THE PROBLEM. Testers read it and started actually
      // walking — which is the one thing that cannot work here: there is no
      // floor space at a stall, and stepping toward the camera changes the
      // body scale every threshold in this game is divided by. The tester who
      // got it right described what he was doing as "moving my arms like I'm
      // running without running", and that is the whole interaction. Say so.
      tagline: '<PUMP YOUR ARMS ON GREEN — FREEZE ON RED>',
      // WAS THE TAIL OF THE TAGLINE, and it read as a run-on: the bracketed
      // instruction and a loose clause in the same weight on the same line,
      // with the clause contradicting the instruction at a glance ("pump your
      // arms" / "stay where you are"). It is the same failure 67 Speed has —
      // testers read an instruction to move and WALKED, which cannot work at a
      // stall and rescales the torso unit every threshold here divides by — so
      // it gets the same words and the same red pill.
      avoid: "DON'T WALK — STAY PUT",
      visionMode: 'pose',
      maxPlayers: LANES,
      roundSeconds: 45,
      color: GAME_COLORS.redlight,
      // Not a split-screen duel. Five people share one screen and one set of
      // lanes, so the base's versus layout would be actively wrong here.
      supportsVersus: false,
      // Everyone in frame plays together.
      partyMode: true,
      // Hold a lobby. This is the one game whose entire value is five people at
      // once, so starting the moment one person is confirmed would throw that
      // away — the rest of the group is still shuffling into frame.
      gatherSeconds: 10,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Round lifecycle                                                     */
  /* ------------------------------------------------------------------ */

  protected onStart(): void {
    // Per round, not per frame: moveEnter is captured into each racer's
    // Hysteresis when they're admitted, so a mid-round change would apply
    // to some players and not others.
    //
    // moveEnter in particular has never seen a real body — it is right against
    // the simulator by 3-4x, but MediaPipe's noise floor on a real person at 3m
    // under hall lighting is unknown. Too low and everyone is eliminated in two
    // seconds, which is unrecoverable at a stall without live retuning.
    this.tun = tunables.overlayOn('redlight.', DEFAULT_REDLIGHT_TUNABLES);

    this.racers.clear();
    this.light = 'green';
    this.lightT = 0;
    this.firstGreen = true;
    // The opening green is long and honest. Six strangers need a moment to
    // work out that the round has started before anything can go wrong.
    this.lightDur = 3.4 + Math.random() * 0.8;
    this.tellStart = 0.72;
    this.fakeout = false;
    this.dollTurn = 0;
    this.nextBeat = 0;
    this.judgeArmed = false;
    this.elimsThisFrame = 0;
    this.elimPending = false;
    this.startedCount = 0;
    this.winnerId = null;
    this.finalCall = '';
    this.endHold = 0;
    this.holdTotal = WIN_HOLD_SEC;
    this.lastVisionFrame = -1;
    this.lastVisionTime = 0;
  }

  /** The leaderboard number: how far the furthest player got. */
  /**
   * Progress, plus a speed bonus for actually finishing.
   *
   * Progress alone caps at 100, so every winner tied and the leaderboard filled
   * with identical scores — which makes the board worthless exactly where it
   * matters most, since this is the game the biggest groups play.
   *
   * Finishing with time to spare is the skill worth rewarding: 10 points per
   * second remaining, so a decisive win reads clearly above a photo finish, and
   * a non-finisher can never out-score someone who crossed the line.
   */
  /**
   * PER PLAYER, by lane.
   *
   * This used to ignore its `slot` argument entirely and return the best
   * progress in the race, so a six-person round handed all six the same number
   * — measured, six racers all scored 296 while three of them were frozen at
   * 26% of the track. Everyone got the winner's score, including the people who
   * were eliminated in the first ten seconds. A playtester asked for exactly
   * this: "it'd keep track of two separate players scores, same thing with hole
   * in the wall and red light".
   *
   * Lane is the right key rather than iteration order: it is fixed when a racer
   * is first seen, it is keyed on the tracker id, and it is never re-sorted —
   * which is the whole reason a lane never swaps owner mid-round.
   *
   * The finish bonus stays per player, so crossing the line first is worth more
   * than crossing it last, and somebody who never crossed cannot out-score
   * somebody who did.
   */
  protected scoreFor(slot: number): number {
    return laneScore(this.racers.values(), slot);
  }

  private aliveCount(): number {
    let n = 0;
    for (const r of this.racers.values()) if (r.alive) n++;
    return n;
  }

  /**
   * "Show a live count of who's still in." This is the base's big HUD number,
   * which matters more here than any individual's score: the drama of the
   * round is the roster shrinking.
   */
  protected primaryStat(): string {
    const total = this.racers.size;
    return total === 0 ? '0' : `${this.aliveCount()}/${total}`;
  }

  protected primaryLabel(): string {
    return this.state === 'results' ? 'FURTHEST' : 'STILL IN';
  }

  /* ------------------------------------------------------------------ */
  /* Light schedule                                                      */
  /* ------------------------------------------------------------------ */

  private roundProgress(): number {
    return 1 - Math.max(0, this.timeLeft) / this.roundTotal;
  }

  /**
   * How long after the red transition eliminations start, in seconds.
   *
   * `graceSec` is the PLAYER's allowance to stop. The detector's own settling
   * time is added on top, rather than charged to the same account: an energy
   * estimate smoothed over `energyTau` is still reporting the flail for about
   * three time constants after the flail ended, so judging at exactly 400ms
   * would quietly turn a 400ms grace into a 100ms one and make the single most
   * important mechanic in the game a lie.
   *
   * Measuring instantaneously instead was the other option, and it is worse:
   * the per-frame landmark delta for a motionless player swings between 0.2
   * and 2.0 torso-units per second, so a single raw sample decides the round
   * on noise. The smoother is load-bearing; the delay pays for it.
   */
  private judgeOpensAt(): number {
    return this.tun.graceSec + this.tun.energyTau * 3;
  }

  /**
   * Rolls the next light.
   *
   * Durations shorten and scatter as the round runs on, so the back half is
   * genuinely harder than the front half without anyone being told. Some greens
   * are fake-outs — under a second, with no visual tell — because the moment
   * somebody commits to a big flail and the light dies under them is the single
   * funniest thing this game produces.
   *
   * @param duration overrides the roll. Only the tests pass this.
   */
  private setLight(next: Light, duration?: number): void {
    const p = this.roundProgress();
    if (next === 'red') this.firstGreen = false;
    this.light = next;
    this.lightT = 0;
    this.fakeout = false;

    if (next === 'green') {
      // Fake-outs rarer early, still escalating: was 0.18 + p*0.22 (18% rising
      // to 40%), now 0.08 + p*0.24 (8% rising to 32%).
      //
      // A fake-out green is under a second with NO tell, so it is the one thing
      // in this game that can catch a player with zero warning. That is a great
      // joke on someone who already understands the rules and a bad first
      // impression on someone learning them — and at a club fair most of the
      // queue is meeting this game for the first time. Weighting them toward
      // the back half keeps the joke and moves it after the lesson.
      this.fakeout = duration === undefined && Math.random() < 0.08 + p * 0.24;
      // Late-round greens bottom out at 1.6s rather than 1.3s. Below about a
      // second and a half there is no room for a tell that anyone can act on,
      // so the compression stops buying tension and starts buying confusion.
      const base = this.fakeout ? 0.45 : 3 - p * 1.4;
      const spread = this.fakeout ? 0.45 : 1.6 - p * 0.9;
      this.lightDur = duration ?? base + Math.random() * spread;
      // THE TELL STARTS EARLIER: was 0.52-0.85 of the green, now 0.38-0.63.
      //
      // The doll's head turn is the only warning a red is coming, and on a
      // short late-round green 0.52 left barely half a second of it. Starting
      // sooner does not make the game easier — the red still arrives when it
      // arrives — it makes the warning legible, which is the difference
      // between losing and feeling cheated.
      this.tellStart = this.fakeout ? 1 : 0.38 + Math.random() * 0.25;
    } else {
      // A red has to outlast the grace, the smoother and the breach dwell with
      // room to spare, or late reds become un-losable and the back half of the
      // round gets easier instead of harder.
      const floor = this.judgeOpensAt() + this.tun.breachSec + 0.35;
      this.lightDur = Math.max(floor, duration ?? 1.9 - p * 0.75 + Math.random() * (0.9 - p * 0.4));
      this.tellStart = 1;
    }
  }

  private goRed(): void {
    this.setLight('red');
    audio.play('redlight');
    this.juice.shake(0.14);
    this.juice.chromatic(0.5);
    this.juice.flash(COLORS.red, 0.16, 6);
    // First heartbeat lands exactly as judging opens, so the sound and the
    // moment you can actually be caught are the same event.
    this.nextBeat = this.judgeOpensAt();
    this.judgeArmed = false;
    for (const r of this.racers.values()) {
      r.gate.reset();
      r.breach = 0;
      r.nearMiss = false;
    }
  }

  private goGreen(fc: FrameContext): void {
    this.setLight('green');
    audio.play('greenlight');
    const g = this.laneGeom(fc.v);
    for (const r of this.racers.values()) {
      if (r.alive && r.nearMiss) {
        // The grace period, made visible. Without this the player who stopped
        // 300ms late never finds out how close they came, and the single most
        // important mechanic in the game is invisible.
        this.popups.spawn(
          'PHEW',
          this.markerX(g, r.progress),
          g.top + g.h * (r.lane + 0.5) - g.h * 0.5,
          COLORS.yellow,
          vh(fc.v, 3.2)
        );
        audio.play('pop', 1.5);
      }
      r.gate.reset();
      r.breach = 0;
      r.nearMiss = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Simulation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Seconds since the last NEW vision frame, or 0 if this render frame carries
   * no new landmarks.
   *
   * Vision lands at ~30fps under a 60fps render (and at the render rate in sim
   * mode). Sampling motion on a frame that carries no new landmarks pushes a
   * fake zero into the signal, so everything that measures movement keys off
   * the vision frame id and converts to per-second units using the real
   * interval.
   *
   * Clamped at both ends. This is a divisor, so a bad value does not degrade
   * the signal, it inverts the game: too small and a motionless player reads as
   * a flail, too large and a flailing one reads as a statue. `fc.time` is the
   * right clock — these landmarks came off a camera at wall-clock time, not at
   * the clamped physics dt — but a GC pause, a tab switch or a test harness
   * re-basing its clock can all produce a gap that means nothing, so the range
   * is bounded to plausible inference intervals.
   */
  private visionDelta(fc: FrameContext): number {
    const vf = fc.vision?.frameId ?? -1;
    if (vf === this.lastVisionFrame) return 0;
    const raw = fc.time - this.lastVisionTime;
    const dtv = this.lastVisionTime > 0 ? Math.min(1 / 8, Math.max(1 / 120, raw)) : 0;
    this.lastVisionFrame = vf;
    this.lastVisionTime = fc.time;
    return dtv;
  }

  /**
   * The lobby pass: measure the room's noise floor on every body in frame,
   * before anybody can be eliminated by it. See `calibrate` for the statistic
   * and `Calib` for why it is not stored on the racer.
   */
  protected onPreTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    const dtv = this.visionDelta(fc);

    for (const c of this.calib.values()) c.absent += dt;

    for (const p of players) {
      let c = this.calib.get(p.id);
      if (!c) {
        c = {
          // Seed at the absolute floor, so a body we have barely seen is judged
          // by `moveEnter` until it has shown us what its own still looks like.
          quiet: this.tun.moveEnter / this.tun.quietMult,
          energy: 0,
          age: 0,
          absent: 0,
          motion: new MotionEnergy(1),
        };
        this.calib.set(p.id, c);
      }

      const wasAbsent = c.absent;
      c.absent = 0;
      if (dtv <= 0 || p.missing > 0 || !p.scale.valid) continue;

      // Back after a dropout: the stored landmark history is stale and the
      // first delta against it is a teleport, which would read as a flail and
      // lift this body's floor for the whole round.
      if (wasAbsent > 0.15) {
        c.motion.reset();
        continue;
      }

      c.energy += (c.motion.update(p) / dtv - c.energy) * (1 - Math.exp(-dtv / this.tun.energyTau));
      c.age += dtv;
      this.calibrate(c, dtv);
    }

    // Evict anyone who has left. A lane-sized map that only grows would hand a
    // stale floor to whoever inherits that tracker id later in the day.
    for (const [id, c] of this.calib) if (c.absent > 3) this.calib.delete(id);
  }

  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    const tun = this.tun;

    const dtv = this.visionDelta(fc);
    const fresh = dtv > 0;

    if (this.endHold <= 0) {
      this.lightT += dt;
      if (this.lightT >= this.lightDur) {
        if (this.light === 'green') this.goRed();
        else this.goGreen(fc);
      }
    }

    // The head turn is the readability cue — it must be finished well before
    // the grace expires, so it snaps around and ambles back.
    const turnTarget = this.light === 'red' ? 1 : 0;
    const turnSpeed = turnTarget > this.dollTurn ? 14 : 3.4;
    this.dollTurn += (turnTarget - this.dollTurn) * Math.min(1, turnSpeed * dt);

    const live = this.endHold <= 0;
    const judging = live && this.light === 'red' && this.lightT > this.judgeOpensAt();
    const advancing = live && this.light === 'green';

    // Everything that happened during the grace is forgiven, including a gate
    // that momentum left hanging open. Without this reset a player who stopped
    // at 300ms is eliminated the instant judging opens, on breach they
    // accumulated while they were still protected — which is the same bug the
    // grace period exists to prevent, moved one step later.
    if (judging && !this.judgeArmed) {
      this.judgeArmed = true;
      for (const r of this.racers.values()) {
        r.gate.reset();
        r.breach = 0;
      }
    }

    for (const r of this.racers.values()) {
      r.present = false;
      r.absent += dt;
      r.wobble = Math.max(0, r.wobble - dt * 2.5);
    }

    // Admit in slot order so lanes read left-to-right the way people are
    // actually standing, which is how anyone finds their own lane.
    const ordered = [...players].sort((a, b) => a.slot - b.slot);

    for (const p of ordered) {
      const r = this.racers.get(p.id) ?? this.admit(p);
      if (!r) continue;

      if (r.absent > 0.15) {
        // Back after a dropout. The stored landmark history is stale and the
        // first delta against it is a teleport, which would read as a flail.
        r.motion.reset();
        r.settle = Math.max(r.settle, 0.35);
      }
      r.present = true;
      r.absent = 0;
      r.landmarks = p.landmarks;
      r.settle = Math.max(0, r.settle - dt);
      r.age += dt;

      // missing > 0 means this track is coasting on last frame's landmarks.
      // Sampling it reports a perfectly still player — a free pass through a
      // red light for anyone the detector happens to lose.
      if (fresh && dtv > 0 && p.missing === 0 && p.scale.valid) this.sample(r, p, dtv);

      if (!r.alive || r.finished) continue;

      const threshold = this.thresholdFor(r);
      r.gate.enter = threshold;
      r.gate.exit = threshold * tun.exitRatio;
      const moving = r.gate.update(r.energy);

      if (advancing) {
        // Progress is motion ABOVE this player's own elimination threshold.
        // Anything quiet enough to survive a red light is, by construction,
        // too quiet to gain ground, which closes the "creep along just under
        // the line" exploit without a separate anti-cheat.
        // Progress is motion ABOVE this player's own elimination threshold.
        //
        // NOT gated on the `moving` hysteresis, which was tried and measured
        // WORSE. That gate latches open on a noise spike and only closes below
        // `threshold * exitRatio`, so under sensor noise it stayed open and a
        // frozen player advanced at nearly the same rate as a moving one —
        // 13.5 against 14.4, i.e. no discrimination at all. Reading `energy`
        // directly keeps the separation (3.6 against 13.8 measured) because
        // the excess over threshold, not merely crossing it, sets the rate.
        // DRIVE IS A RATIO OF THE THRESHOLD, NOT AN ABSOLUTE EXCESS.
        //
        // `driveSpan` was a fixed span in torso-units/sec, chosen against a
        // noiseless simulator where the threshold is always `moveEnter`. Now
        // that the threshold floats on the room's measured noise floor, a
        // fixed span demands the same ABSOLUTE excess in a noisy room as in a
        // silent one — while the floor underneath it has moved up.
        //
        // MEASURED over ten seconds of correct play: 7.3% of the track with a
        // clean body, 0.7% with mild sensor noise. A tenfold collapse, which
        // on a real camera means the markers barely move and the race — the
        // whole spectacle of the game — stops happening.
        //
        // Scaling the span with the threshold keeps "how far above your own
        // still-level you have to be to move at full speed" constant, which is
        // what the number was always trying to express.
        const span = Math.max(0.2, threshold * tun.driveSpan);
        const drive = Math.min(1, Math.max(0, (r.energy - threshold) / span));
        if (drive > 0) {
          r.progress = Math.min(100, r.progress + drive * tun.advanceRate * dt);
          r.wobble = Math.min(1, r.wobble + drive * dt * 4);
        }
        if (r.progress >= 100) this.win(fc, r, true);
      } else if (this.light === 'red') {
        const j = judgeRedLight(r.breach, {
          moving,
          judging,
          settled: r.settle <= 0,
          dt,
          breachSec: tun.breachSec,
        });
        r.breach = j.breach;
        if (j.nearMiss) r.nearMiss = true;
        if (j.eliminate) this.eliminate(fc, r);
      }
    }

    this.startedCount = Math.max(this.startedCount, this.racers.size);

    // Checked once per frame, after every elimination has landed — never from
    // inside eliminate(). Doing it per-player declares whoever happens to be
    // last in the iteration order the winner, and then eliminates them a
    // microsecond later: a wipeout used to end on "PLAYER 6 WINS" with nobody
    // left standing.
    if (this.elimPending) {
      this.elimPending = false;
      this.checkRoundOver(fc);
    }
    this.elimsThisFrame = 0;

    if (this.endHold > 0) {
      // Real time, not `dt` — the win also fires slow-mo, and the two together
      // would stretch a 1.9s tableau to four seconds with a queue waiting.
      this.endHold -= fc.dt;
      if (this.endHold <= 0) this.enter('results');
    }

    this.pulseAudio(dt);
  }

  /**
   * Per-player movement, in torso-units per second.
   *
   * MotionEnergy is constructed with a window of 1: we want its per-landmark,
   * visibility-filtered, torso-normalised delta — and it reads `player.raw`
   * deliberately, because One Euro exists to suppress exactly the fast small
   * motion this has to detect — but NOT its frame-count smoothing. A fixed
   * window of N frames is a different amount of TIME at 30fps and at 60fps,
   * and `graceSec` is specified in milliseconds. So the smoothing happens here
   * instead, as a time-constant filter over the per-second rate.
   */
  private sample(r: Racer, p: TrackedPlayer, dtv: number): void {
    const perFrame = r.motion.update(p);
    const rate = perFrame / dtv;
    r.energy += (rate - r.energy) * (1 - Math.exp(-dtv / this.tun.energyTau));

    // Falls fast (tau 90ms, comfortably inside the grace window) so a freeze is
    // recognised in time.
    //
    // RISING is the asymmetric part. For the first couple of seconds after a
    // player is admitted it rises FAST, because what it is measuring then is
    // the room — sensor noise at this distance, in this light — and that has to
    // be known before anyone is judged against it. After that it reverts to the
    // 20-second constant, which is what stops a player lifting their own
    // threshold by never quite standing still.
    //
    // The calibration window sits in the lobby and countdown, before the round
    // starts, so it costs nothing and nobody is racing through it.
    // ONLY BEFORE THE ROUND STARTS. `age` alone was wrong: it counts from
    // admission, and a player admitted late in a short lobby is still
    // calibrating when the light goes green — at which point the window learns
    // their RUNNING energy as their still-level.
    //
    // MEASURED: a moving player's energy and their learned floor converged at
    // ~3.4 and ~3.0, putting the threshold (floor x 2.4) far above the signal,
    // and the advance rate collapsed from 7.3% of the track per ten seconds to
    // 0.7%. The race stopped happening — which is worse than the bug the
    // calibration was added to fix.
    //
    // The lobby and countdown are the correct window: nobody is racing, and
    // the light has not gone green.
    //
    // ONCE THE ROUND STARTS, THE FLOOR IS FIXED. It used to keep adapting,
    // falling fast whenever energy dipped below it. That makes it a MINIMUM
    // tracker, and a minimum is the wrong statistic for a noise floor: it
    // drifts down toward the quietest instant, the threshold follows, and the
    // noise PEAKS then cross it. Measured under mild noise, that eliminated a
    // player who never moved. The floor is a property of the room and the
    // camera; it does not change because somebody stopped moving.
    //
    // The learning itself lives in `onPreTick` — see `calibrate`. It used to
    // live here, guarded on `state !== 'playing'`, inside a method that only
    // ever runs when the state IS `playing`. The condition could not be true,
    // so nothing was ever learned and `quiet` sat at its seed for the whole
    // round. MEASURED with that dead branch: a player standing perfectly still
    // read an energy of ~1.95 against a threshold of 0.85 and was eliminated
    // 10s into every round, and all three test bodies were out inside 6s of
    // play. That is the "red light is very buggy" report from the playtest.
  }

  /**
   * Learn what "standing still" costs in THIS room, before anyone is judged.
   *
   * Runs during the lobby and countdown only (see `onPreTick`). The statistic
   * is a LOW QUANTILE of each player's smoothed energy, not a mean and not a
   * minimum, because neither of those is what we want:
   *
   *   - a mean is dragged up by people walking into frame and waving, which is
   *     most of what happens in a lobby;
   *   - a minimum is dragged down to the quietest single instant, and then the
   *     noise peaks sit above the threshold it implies.
   *
   * An EMA whose time constant is short when the signal is BELOW the estimate
   * and long when it is above converges on a low percentile of the
   * distribution — roughly the 10th at a 9:1 ratio. That is "how quiet this
   * person gets when they are not doing anything", which is exactly the floor
   * the elimination threshold should be a multiple of.
   */
  private calibrate(c: Calib, dtv: number): void {
    const tau = c.energy < c.quiet ? this.tun.calibrateDown : this.tun.calibrateUp;
    c.quiet += (c.energy - c.quiet) * (1 - Math.exp(-dtv / tau));
  }

  /**
   * This player's elimination threshold.
   *
   * MediaPipe's raw landmark noise is not a constant. It scales with distance,
   * lighting and how much of the body is actually visible, and in a six-wide
   * line somebody is always further back and noisier than everybody else. One
   * absolute threshold that is right at a desk will be wrong in the hall, and
   * "everyone is out in two seconds" is an unrecoverable failure at a stall.
   *
   * So the threshold floats on each player's own observed still-energy — but
   * capped at `quietCeiling × moveEnter`, because a floating threshold with no
   * ceiling is just a detector that learns to ignore whatever you are doing.
   *
   * `moveEnter` is the number most likely to be wrong on Sept 20. It is right
   * against the simulator by a factor of four; it has never seen a real body.
   */
  private thresholdFor(r: Racer): number {
    const { moveEnter, quietMult, quietCeiling } = this.tun;

    // THE CEILING BOUNDS THE LEARNED FLOOR, NOT THE FINAL THRESHOLD.
    //
    // It used to clamp the threshold itself to `moveEnter * quietCeiling`,
    // which with the shipped numbers is 1.615 — and a body with realistic
    // sensor noise reads a still-energy near 2. The clamp therefore sat BELOW
    // the noise, so the detector called a frozen player "moving" no matter how
    // long it was given to adapt. Measured: a perfectly still body advanced
    // during green and was eliminated during red within about six seconds.
    //
    // WHY A CREEPER IS NOT ELIMINATED, AND WHY THAT IS CORRECT.
    //
    // Under realistic noise a slow creep is genuinely indistinguishable from a
    // motionless body. Measured, in torso-units/sec:
    //
    //                  p10    p50    p90
    //   still          1.93   2.01   2.92
    //   slow creep     2.48   2.94   4.17
    //
    // The creep's median sits ON the still distribution's p90. Any threshold
    // low enough to catch it eliminates people who are standing perfectly
    // still — which is the exact failure this game shipped with, and the one
    // the playtest reported.
    //
    // It does not matter, because the anti-cheat here is STRUCTURAL rather
    // than detective: progress is motion ABOVE your own threshold, so anything
    // quiet enough to evade the detector is by construction too quiet to move
    // your marker. MEASURED over a full round: a body creeping through 16.2
    // seconds of red light gained 0.00% of the track, identical to a body that
    // froze. Creeping buys nothing, so there is nothing to punish.
    //
    // Do not "fix" this by lowering the threshold. That trades a harmless
    // non-detection for eliminating innocent players.
    //
    // The ceiling exists to stop someone training the detector to ignore them.
    // That is a statement about what "still" can plausibly be — so it belongs
    // on `quiet`, the estimate of still. The signal-to-noise margin
    // (`quietMult`) then applies on top, and the threshold is free to land
    // wherever the room's noise actually puts it.
    // AFFINE IN THE NOISE FLOOR, not a pure multiple of it.
    //
    // `Math.max(moveEnter, floor * quietMult)` cannot satisfy every room,
    // because the still distribution's SPREAD grows faster than its floor.
    // Measured across three noise regimes:
    //
    //                floor   still p90   moving p10   threshold must land in
    //   clean         0.27     0.35         4.15        0.4 - 4.1
    //   realistic     2.28     3.53         5.19        3.5 - 5.2
    //   hostile       3.89     7.53         6.90        (inverted - see below)
    //
    // A pure multiple has to pass through the origin, and no single slope hits
    // all three windows: the multiplier realistic wants (~2.4) puts hostile at
    // 7.7, above the point where a MOVING body is detected at all, and the one
    // hostile wants (~1.9) puts realistic at 3.3 — fine — but clean at 0.4,
    // under its own noise. Adding a constant floor gives the extra degree of
    // freedom, and 1.1 + 1.45x lands where it needs to: clean 1.49, realistic
    // 4.41, hostile 6.74.
    //
    // HOSTILE IS NOT SOLVABLE and that is a fact about the signal, not a tuning
    // failure. At double noise a motionless body's p90 (7.53) sits ABOVE a
    // moving body's p10 (6.90) — the two distributions have crossed, so no
    // threshold anywhere separates them and some false eliminations are
    // arithmetically guaranteed. The design target is the realistic profile;
    // hostile is the stress case, and the answer there is the camera and the
    // lighting, not this number.
    //
    // NOTE ON OVERFITTING: the slope and intercept are fitted to the pose
    // simulator's noise model, which is a guess at a real hall. The SHAPE is
    // the durable part — an absolute floor plus a term proportional to the
    // measured noise — and all three constants are live-tunable from the
    // operator console for exactly this reason.
    //
    // This is why the old shape failed at double noise with every player
    // eliminated inside the lobby: the ceiling pinned the threshold at 4.53
    // while a motionless body's p90 was 5.88.
    const floor = Math.min(r.quiet, moveEnter * quietCeiling);
    return moveEnter + floor * quietMult;
  }

  private admit(p: TrackedPlayer): Racer | null {
    const used = new Set<number>();
    for (const r of this.racers.values()) used.add(r.lane);

    let lane = -1;
    for (let i = 0; i < LANES; i++) {
      if (!used.has(i)) {
        lane = i;
        break;
      }
    }

    if (lane < 0) {
      // Every lane taken. Recycle the one belonging to somebody who left and
      // never got anywhere — at a stall that is a bystander who drifted
      // through frame, and the lane is worth more to whoever is standing in it
      // now. An eliminated player's lane is never recycled: being visibly out
      // is the point.
      let stale: Racer | null = null;
      for (const r of this.racers.values()) {
        if (r.present || !r.alive || r.absent < 2 || r.progress > 5) continue;
        if (!stale || r.absent > stale.absent) stale = r;
      }
      if (!stale) return null;
      lane = stale.lane;
      this.racers.delete(stale.id);
    }

    const seed = this.calib.get(p.id);
    const racer: Racer = {
      id: p.id,
      lane,
      color: PLAYER_COLORS[lane] ?? COLORS.blue,
      progress: 0,
      alive: true,
      finished: false,
      energy: 0,
      age: 0,
      // What the lobby learned about this body, if it watched them long enough
      // to mean anything. Otherwise the absolute floor, so a player who walked
      // in during the countdown is judged by `moveEnter` rather than by a
      // number taken from two frames of them still moving.
      quiet: seed && seed.age >= this.tun.calibrateSec
        ? seed.quiet
        : this.tun.moveEnter / this.tun.quietMult,
      motion: new MotionEnergy(1),
      gate: new Hysteresis(this.tun.moveEnter, this.tun.moveEnter * this.tun.exitRatio),
      breach: 0,
      nearMiss: false,
      present: true,
      absent: 0,
      settle: SETTLE_SEC,
      landmarks: p.landmarks,
      wobble: 0,
      finishedWith: 0,
    };
    this.racers.set(p.id, racer);
    return racer;
  }

  private eliminate(fc: FrameContext, r: Racer): void {
    r.alive = false;
    r.breach = 0;

    const g = this.laneGeom(fc.v);
    const x = this.markerX(g, r.progress);
    const y = g.top + g.h * (r.lane + 0.5);

    // A red light regularly takes three or four people on the same frame. Four
    // identical sawtooth drops fired at the same millisecond phase-sum into one
    // loud smear; stepping the pitch down turns the same event into an audible
    // cascade, which is both clearer and much funnier.
    //
    // The pitch argument was being thrown away by the sound itself until the
    // `eliminate` case learned to use it, so none of that was happening. Now
    // it does, and the gain ducks with it: a six-player wipeout was measured at
    // 13 concurrent voices and roughly 4.7x unity gain into a 4ms-attack
    // compressor, which is the one place in the app loud enough to crack. Past
    // the second body the tone layer drops out and only the thump survives.
    const n = this.elimsThisFrame;
    audio.play('eliminate', Math.max(0.6, 1 - n * 0.09), n === 0 ? 1 : 0.42 / n);
    this.elimsThisFrame++;
    this.elimPending = true;

    // The VISUALS duck the same way, and for the same reason. Six eliminations
    // each asking for 0.55 of shake and 90ms of hitstop is not six times as
    // dramatic — trauma accumulates, and the round would judder to a halt at
    // the exact moment the crowd is watching. The first body gets the full
    // hit; the rest add a diminishing shove.
    const scale = n === 0 ? 1 : 1 / (1 + n);
    this.juice.flash(COLORS.red, 0.42 * scale, 4.5);
    this.juice.shake(0.55 * scale);
    if (n === 0) this.juice.hitStop(90);
    this.juice.chromatic(0.8 * scale);
    BURST.splat(this.particles, x, y, COLORS.red, 1.6);
    // Taunt sits INSIDE its own lane, not 0.55 lane-heights above it.
    //
    // At 1-2 players the lanes are tall and a fixed fraction looked fine. At 5-6
    // — which is this game's headline and the case a crowd actually produces —
    // the lanes compress and every taunt landed on the track of the lane above.
    // Verified with a simulated six-player mass elimination: all six overlapped.
    //
    // Clamped so it can never cross the lane boundary, whatever the count.
    // SIZE scales with the lane too, not just position.
    //
    // Clamping the vertical offset alone was not enough: at five lanes the taunt
    // was still set at 4.2vh, which is taller than a lane, so it overflowed into
    // its neighbours no matter where it was anchored. Verified with a six-player
    // mass elimination — all six overlapped even after the position clamp.
    const tauntSize = Math.min(vh(fc.v, 4.2), g.h * 0.62);
    const tauntLift = Math.max(0, Math.min(g.h * 0.55, g.h * 0.5 - tauntSize * 0.5));
    this.popups.spawn(
      TAUNTS[Math.floor(Math.random() * TAUNTS.length)] ?? 'OUT!',
      x,
      y - tauntLift,
      // `redBright` only ever existed to make the brand hex work as neon on
      // black. There is no neon; it is the flat brand red and nothing else.
      COLORS.red,
      tauntSize,
      1.3
    );
  }

  private win(fc: FrameContext, r: Racer, crossedTheLine: boolean): void {
    if (this.endHold > 0) return;
    if (crossedTheLine) {
      r.progress = 100;
      r.finished = true;
      r.finishedWith = Math.max(0, this.timeLeft);
    }
    this.winnerId = r.id;
    this.finalCall = `PLAYER ${r.lane + 1} WINS`;
    this.endHold = WIN_HOLD_SEC;
    this.holdTotal = WIN_HOLD_SEC;

    const g = this.laneGeom(fc.v);
    this.juice.celebrate(r.color);
    this.juice.slowMo(0.45, 1.3);
    audio.play('record');
    this.celebrateAt(this.markerX(g, r.progress), g.top + g.h * (r.lane + 0.5));
  }

  private checkRoundOver(fc: FrameContext): void {
    if (this.endHold > 0) return;
    const alive: Racer[] = [];
    for (const r of this.racers.values()) if (r.alive) alive.push(r);

    if (alive.length === 0) {
      this.finalCall = 'EVERYBODY OUT';
      this.endHold = WIPEOUT_HOLD_SEC;
      this.holdTotal = WIPEOUT_HOLD_SEC;
      return;
    }

    // "Last one standing" is only a win if there was somebody to outlast — a
    // solo player must not win the instant the round starts.
    const last = alive[0];
    if (this.startedCount >= 2 && alive.length === 1 && last) this.win(fc, last, false);
  }

  private pulseAudio(dt: number): void {
    const phaseT = this.lightDur > 0 ? Math.min(1, this.lightT / this.lightDur) : 0;

    if (this.light === 'green') {
      // The base drives music intensity from the round clock. Override it: in
      // this game the tension belongs to the light, not the timer, and the
      // ramp inside each green is what makes a fake-out land.
      audio.setMusicIntensity(Math.max(this.roundProgress() * 0.35, phaseT * 0.95));
    } else {
      // Music drops out on red. The hole where it was is the tension.
      audio.setMusicIntensity(0);
      this.nextBeat -= dt;
      if (this.nextBeat <= 0) {
        audio.play('heartbeat', 0.9 + phaseT * 0.5);
        // A VISUAL TWIN, because the hall is loud and the speakers may be off.
        // This beat carries no information by design — it exists to make
        // standing still feel like it costs something — but a feel-cue that
        // only exists in audio does not reach a player who cannot hear it, and
        // this game's whole tension is the wait. Tiny on purpose: it must read
        // as a pulse under the feet, never as the screen shaking at you, and it
        // must not be confused with an elimination.
        this.juice.shake(0.03 + phaseT * 0.035);
        this.nextBeat = 0.62 - phaseT * 0.26;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Layout                                                              */
  /* ------------------------------------------------------------------ */

  private laneGeom(v: Viewport): LaneGeom {
    const top = vh(v, 40.5);
    const bottom = v.height - vh(v, 3.5);
    const chipX = vh(v, 1.6);
    const chipW = vh(v, 6);
    const dollW = Math.min(v.width * 0.17, vh(v, 28));
    return {
      top,
      bottom,
      h: (bottom - top) / LANES,
      left: chipX + chipW + vh(v, 1.6),
      right: v.width - dollW - vh(v, 1.5),
      chipX,
      chipW,
      dollW,
    };
  }

  private markerX(g: LaneGeom, progress: number): number {
    return g.left + (g.right - g.left) * Math.min(1, Math.max(0, progress / 100));
  }

  /** 0..1 — how far into the "something is about to happen" tell we are. */
  private tell(): number {
    if (this.light !== 'green' || this.tellStart >= 1 || this.lightDur <= 0) return 0;
    const t = this.lightT / this.lightDur;
    return Math.min(1, Math.max(0, (t - this.tellStart) / (1 - this.tellStart)));
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  /** Flat brand colour of the current light. The only place this is decided. */
  private stateColor(): string {
    return this.light === 'red' ? COLORS.red : COLORS.green;
  }

  /**
   * Graph paper, and the lower half of the state signal.
   *
   * WHAT THIS REPLACED, AND WHY THE REPLACEMENT IS LOUDER.
   *
   * This used to be a full-screen `withAlpha(col, 0.2)` wash with the word
   * "RED" behind it at alpha 0.13. Three separate brand violations — a
   * see-through brand colour, a second see-through brand colour, and a vignette
   * (a gradient) — but the reason to change it is not that it was illegal. It
   * is that on paper it stopped working.
   *
   * A 20% red wash over white is #FAD9D7. That is a pale pink, it is the first
   * thing a mis-set TV contrast control eats, and from the back of a crowd it
   * is indistinguishable from a white screen. The 13% word behind it was
   * already invisible.
   *
   * The replacement is three flat, fully saturated, full-opacity shapes:
   *
   *   1. the `<FREEZE>` / `<MOVE>` band — full-bleed, ~13vh tall (drawBanner)
   *   2. this stripe under the lanes — full-bleed, ~3vh tall
   *   3. the doll's dress (drawDoll)
   *
   * Together about 18% of the screen at 100% saturation, framing the playfield
   * top and bottom so the state is in peripheral vision wherever on the screen
   * you are actually looking. A saturated patch pops out at distance in a way a
   * desaturated field never does, and — unlike a wash — it degrades gracefully:
   * a badly calibrated panel shifts the hue, it does not erase the shape.
   *
   * The lane fills were the other candidate and were rejected: they already
   * carry five player identities in five different colours, and overloading them
   * with a seventh meaning would have cost every player the ability to find
   * their own lane.
   *
   * Recolouring the graph paper was rejected too, for a measured reason —
   * `graphPaper` caches its raster by colour, so flipping it every two seconds
   * would rebuild a full-screen bitmap on the light change, which is the exact
   * frame we least want to spend 2.18ms on.
   */
  protected onRenderBackground(fc: FrameContext): void {
    const { ctx, v } = fc;

    // The brand substrate, under every state of the round.
    graphPaper(ctx, v);

    if (this.state !== 'playing') return;

    const g = this.laneGeom(v);
    const col = this.stateColor();

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = col;
    ctx.fillRect(0, g.bottom + vh(v, 0.8), v.width, v.height - g.bottom - vh(v, 0.8));
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(0, g.bottom + vh(v, 0.8), v.width, vh(v, STROKE.base));
    ctx.restore();
  }

  protected onRender(fc: FrameContext, _players: TrackedPlayer[]): void {
    const g = this.laneGeom(fc.v);

    this.drawTension(fc, g);
    this.drawFinishLine(fc, g);

    const ordered = [...this.racers.values()].sort((a, b) => a.lane - b.lane);
    for (const r of ordered) this.drawLane(fc, g, r);

    this.drawDoll(fc, g);
    this.drawBanner(fc);
    if (this.endHold > 0) this.drawFinalCall(fc);
  }

  /**
   * The tightening before the light changes: a frame that contracts around the
   * playfield.
   *
   * It is a real tell, and that is on purpose — the original game's doll sings
   * faster as she gets to the end of the verse, and that anticipation is the
   * best part. It is defused as a strategy by the tell starting at a random
   * fraction of each green, and by fake-out greens having none at all.
   *
   * It used to `lerpColor(green, yellow, t)`, which is a gradient between two
   * brand colours — the thing DESIGN.md most explicitly forbids, and unreadable
   * besides: nobody at 3m can tell how far along a green-to-yellow ramp a thin
   * stroke is. The tell is now FLAT YELLOW and the animation is entirely
   * geometric: the frame contracts and thickens. Motion is a channel a crowd
   * can read; hue interpolation is not.
   *
   * Yellow specifically, because the brand assigns it to action and it is the
   * one colour that is neither of the two light states — so the tell can never
   * be mistaken for the light having already changed.
   */
  private drawTension(fc: FrameContext, g: LaneGeom): void {
    const t = this.tell();
    if (t <= 0) return;
    const { ctx, v } = fc;
    const inset = t * vh(v, 1.8);
    const pad = vh(v, 2);

    ctx.save();
    ctx.shadowBlur = 0;
    // Whole-element fade-in over the first third, then solid. The one alpha the
    // brand allows, and it keeps the tell from popping in like a light change.
    ctx.globalAlpha = Math.min(1, t * 3);
    ctx.strokeStyle = COLORS.yellow;
    ctx.lineWidth = vh(v, 0.45 + t * 0.9);
    roundRect(
      ctx,
      inset,
      g.top - pad + inset,
      v.width - inset * 2,
      g.bottom + pad - (g.top - pad) - inset * 2,
      vh(v, 1.4)
    );
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The finish line, as a checkered flag column: alternating ink and paper
   * squares with an ink outline.
   *
   * A glowing dashed yellow rule became a plain dashed yellow rule when the
   * blur came off, which reads as "a divider" rather than "the end". Checkers
   * are the universal sign for a finish line, they need no explanation and no
   * text, and they are drawn entirely in ink and paper — so the thing every
   * player is racing toward costs nothing at all out of the ten-percent brand
   * colour budget.
   */
  private drawFinishLine(fc: FrameContext, g: LaneGeom): void {
    const { ctx, v } = fc;
    const w = vh(v, 1.7);
    // Just PAST the end of the track, not straddling it. The lane fills and the
    // markers are drawn after this and would otherwise chop the flag into six
    // disconnected fragments — and a marker at 100% would sit on top of the
    // thing it just reached.
    const x = g.right + vh(v, 0.6);
    const h = g.bottom - g.top;
    const rows = Math.max(4, Math.round(h / (w * 0.9)));
    const cell = h / rows;

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(x, g.top, w, h);
    ctx.fillStyle = COLORS.ink;
    for (let i = 0; i < rows; i++) {
      // Two columns, offset row by row — a real two-wide chequer, not stripes.
      const yy = g.top + i * cell;
      ctx.fillRect(x + (i % 2 === 0 ? 0 : w / 2), yy, w / 2, cell);
    }
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, STROKE.thin);
    ctx.strokeRect(x, g.top, w, h);
    ctx.restore();
  }

  /**
   * One lane: a sticker track, a flat progress fill, and a sticker marker.
   *
   * ELIMINATION IS `COLORS.muted`, FLAT — not a desaturated, half-transparent
   * copy of the live treatment. Muted is the token this brand has for "this
   * one is done"; used at full opacity it is unambiguous at 3m, where a 45%
   * alpha version of a colour just reads as a rendering glitch. It also means
   * an eliminated lane spends nothing from the colour budget, which is what
   * lets five live lanes be five different colours without the screen falling
   * apart.
   */
  private drawLane(fc: FrameContext, g: LaneGeom, r: Racer): void {
    const { ctx, v } = fc;
    const y = g.top + g.h * (r.lane + 0.5);
    const trackH = g.h * 0.42;
    const out = !r.alive;
    // Eliminated lanes go muted and stay on screen with their progress frozen
    // where it stopped. Removing them would delete the joke.
    const color = out ? COLORS.muted : r.color;
    const won = this.winnerId === r.id;
    const x = this.markerX(g, r.progress);

    const trackX = g.left;
    const trackY = y - trackH / 2;
    const trackW = g.right - g.left;

    ctx.save();
    ctx.shadowBlur = 0;

    // Track: grid fill, ink outline, no shadow. The brand's "flat card" — a
    // container that groups without asking for attention.
    ctx.fillStyle = COLORS.grid;
    roundRect(ctx, trackX, trackY, trackW, trackH, trackH / 2);
    ctx.fill();

    // Progress: one flat fill, clipped to the track so the cap stays round.
    ctx.save();
    roundRect(ctx, trackX, trackY, trackW, trackH, trackH / 2);
    ctx.clip();
    ctx.fillStyle = color;
    roundRect(ctx, trackX, trackY, Math.max(trackH, x - trackX), trackH, trackH / 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, STROKE.thin);
    roundRect(ctx, trackX, trackY, trackW, trackH, trackH / 2);
    ctx.stroke();
    ctx.restore();

    const bob = out ? 0 : Math.sin(fc.time * 11 + r.lane * 1.7) * r.wobble * g.h * 0.14;
    const my = y + bob;
    const markerR = g.h * 0.26;

    // Danger ring. During red it fills toward this player's own threshold, so
    // everyone can see how close they are to being caught BEFORE they are —
    // which is the difference between a game and a punishment.
    //
    // The SWEEP carries the amount; the colour carries only the two states that
    // matter. It used to interpolate yellow→red, which put a third brand colour
    // in the lane and asked a crowd to read a hue as a number.
    if (!out && this.light === 'red' && !r.finished) {
      const t = Math.min(1, r.energy / Math.max(1e-3, this.thresholdFor(r)));
      if (t > 0.22) {
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = t >= 0.999 ? COLORS.red : COLORS.yellow;
        ctx.lineWidth = vh(v, STROKE.thick);
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.arc(x, my, g.h * 0.4, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Winner ring: flat yellow, 1st-place colour. Only the RADIUS breathes, and
    // `idlePulse` flattens that to nothing under prefers-reduced-motion.
    if (won) {
      const halo = 1 + (idlePulse(fc.time, 12, 0.5) - 0.5) * 0.24;
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = COLORS.yellow;
      ctx.lineWidth = vh(v, STROKE.thick);
      ctx.beginPath();
      ctx.arc(x, my, g.h * 0.46 * halo, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // The marker, as a sticker: hard ink shadow straight down, flat fill, ink
    // outline. Same object as every pill and card in the app, at disc size.
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(x, my + vh(v, SHADOW.base), markerR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, my, markerR, 0, Math.PI * 2);
    ctx.fill();
    // The outline inverts for the ink player: an ink ring on an ink marker at
    // the end of an ink bar is one undifferentiated blob, and lane 5 loses the
    // "where am I" read that every other lane gets for free.
    ctx.strokeStyle = markOn(color);
    ctx.lineWidth = vh(v, STROKE.base);
    ctx.stroke();
    ctx.restore();

    if (out) {
      // A cross through the marker. Reads as "out" with no text and no colour
      // vision required — the shape is the signal, red just agrees with it.
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = vh(v, STROKE.thick);
      ctx.lineCap = 'round';
      const d = markerR * 0.72;
      ctx.beginPath();
      ctx.moveTo(x - d, my - d);
      ctx.lineTo(x + d, my + d);
      ctx.moveTo(x + d, my - d);
      ctx.lineTo(x - d, my + d);
      ctx.stroke();
      ctx.restore();
    }

    const labelY = y - g.h * 0.46;
    if (out) {
      // RED, matching the X struck through the marker beside it, not the
      // kit's disabled grey. Elimination is the loudest event in this game and
      // the word announcing it was the least legible thing on the lane — and
      // the racer it is aimed at has just been told to stop moving, so it is
      // the one label they are definitely reading.
      drawText(ctx, 'OUT', x, labelY, {
        size: vh(v, 2.1),
        color: COLORS.red,
        font: FONTS.body,
        weight: WEIGHT.black,
        letterSpacing: TRACK.pill,
      });
    } else {
      // Tabular: this counts up every frame, and proportional figures make it
      // shuffle sideways under its own marker as it rolls.
      drawTabularNumber(ctx, String(Math.round(r.progress)), x, labelY, {
        size: vh(v, 2.1),
        color: COLORS.ink,
        font: FONTS.body,
        weight: WEIGHT.black,
        letterSpacing: TRACK.number,
      });
    }

    this.drawChip(fc, g, r);
  }

  /**
   * The identity chip: a live stick figure of that player, at the head of their
   * own lane. Five people in a line all need to answer "which one is me" in
   * under a second, and their own colour plus their own silhouette moving in
   * time with them answers it without a word.
   */
  private drawChip(fc: FrameContext, g: LaneGeom, r: Racer): void {
    const { ctx, v } = fc;
    const y = g.top + g.h * (r.lane + 0.5);
    const h = g.h * 0.8;
    const out = !r.alive;
    const color = out ? COLORS.muted : r.color;
    const mark = markOn(color);
    const drop = vh(v, SHADOW.base);
    const radius = vh(v, 0.9);

    // A sticker: solid identity colour, ink outline, hard ink shadow. The fill
    // is what has to carry "which one is me" across a hall, so it gets the flat
    // colour and the figure inside it gets whatever contrasts.
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.ink;
    roundRect(ctx, g.chipX, y - h / 2 + drop, g.chipW, h, radius);
    ctx.fill();
    ctx.fillStyle = color;
    roundRect(ctx, g.chipX, y - h / 2, g.chipW, h, radius);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, STROKE.base);
    roundRect(ctx, g.chipX, y - h / 2, g.chipW, h, radius);
    ctx.stroke();
    ctx.restore();

    if (r.landmarks) {
      this.drawMiniFigure(
        ctx,
        r.landmarks,
        g.chipX + g.chipW / 2,
        y,
        g.chipW * 0.74,
        h * 0.82,
        mark
      );
    } else {
      drawText(ctx, `P${r.lane + 1}`, g.chipX + g.chipW / 2, y, {
        size: vh(v, 2.4),
        color: mark,
        font: FONTS.body,
        weight: WEIGHT.black,
        letterSpacing: TRACK.pill,
      });
    }
  }

  private drawMiniFigure(
    ctx: CanvasRenderingContext2D,
    lms: readonly Landmark[],
    cx: number,
    cy: number,
    boxW: number,
    boxH: number,
    color: string
  ): void {
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    let any = false;
    for (const l of lms) {
      if (!l || l.visibility < 0.35) continue;
      any = true;
      if (l.x < minX) minX = l.x;
      if (l.x > maxX) maxX = l.x;
      if (l.y < minY) minY = l.y;
      if (l.y > maxY) maxY = l.y;
    }
    if (!any) return;

    const s = Math.min(boxW / Math.max(0.02, maxX - minX), boxH / Math.max(0.02, maxY - minY));
    const mx = (minX + maxX) / 2;
    const my = (minY + maxY) / 2;
    // The display is mirrored, so subject-left has to appear on the right.
    const px = (l: Landmark): number => cx + (mx - l.x) * s;
    const py = (l: Landmark): number => cy + (l.y - my) * s;

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = color;
    // Fattened: with no halo behind it, stroke weight is the only thing keeping
    // this legible on a saturated chip from three metres.
    ctx.lineWidth = Math.max(2, s * 0.024);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [a, b] of POSE_CONNECTIONS) {
      const la = lms[a];
      const lb = lms[b];
      if (!la || !lb || Math.min(la.visibility, lb.visibility) < 0.35) continue;
      ctx.moveTo(px(la), py(la));
      ctx.lineTo(px(lb), py(lb));
    }
    ctx.stroke();

    const nose = lms[0];
    if (nose && nose.visibility >= 0.35) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px(nose), py(nose), Math.max(2.5, s * 0.05), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * The doll. Entirely procedural — PLAN.md §5a, nothing is downloaded.
   *
   * Deliberately a flat geometric figure rather than anything characterful: a
   * triangle, a circle and two dots read at 3m, and a detailed one does not.
   * The head turn is the whole point of her existing, so the hair slides off
   * the face as she rotates and the eyes appear, which is legible in peripheral
   * vision while you are looking at your own lane.
   *
   * BRAND: she is now a sticker, and her DRESS is the third piece of the state
   * signal. She used to be two `lerpColor` mixes of background and text with a
   * blurred accent outline — a grey figure whose only state cue was a halo, at
   * the exact distance where halos vanish. Flat brand colour on a large shape
   * is the thing that carries; ink and paper do everything else. One brand
   * colour on the whole figure, so she never competes with the band.
   */
  private drawDoll(fc: FrameContext, g: LaneGeom): void {
    const { ctx, v } = fc;
    const f = this.dollTurn;
    const accent = this.stateColor();

    const cx = g.right + (v.width - g.right) / 2;
    const baseY = g.bottom;
    // Also bounded by the width she has to stand in. The TV's resolution and
    // aspect are unknown (ARCHITECTURE rule 7) and on anything narrower than
    // about 4:3 a height-only clamp walks her hem out over the finish line and
    // across the lanes.
    const H = Math.min(vh(v, 46), (g.bottom - g.top) * 0.95, (v.width - g.right) * 2.1);
    // Shoulders lift a fraction as the tell builds — she is winding up.
    const tension = this.tell() * H * 0.012;

    const hemY = baseY - H * 0.2;
    const shoulderY = baseY - H * 0.6 - tension;
    const neckY = baseY - H * 0.67 - tension;
    const R = H * 0.135;
    const headY = neckY - R;
    const hemHalf = H * 0.21;
    const shoulderHalf = H * 0.085;

    const drop = H * 0.024;

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Legs.
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = H * 0.035;
    ctx.beginPath();
    ctx.moveTo(cx - H * 0.06, hemY);
    ctx.lineTo(cx - H * 0.06, baseY);
    ctx.moveTo(cx + H * 0.06, hemY);
    ctx.lineTo(cx + H * 0.06, baseY);
    ctx.stroke();

    // Arms, tucked in against the dress. Under the dress so the joins vanish.
    ctx.lineWidth = H * 0.028;
    ctx.beginPath();
    ctx.moveTo(cx - shoulderHalf, shoulderY + H * 0.01);
    ctx.lineTo(cx - hemHalf * 0.8, hemY - H * 0.06);
    ctx.moveTo(cx + shoulderHalf, shoulderY + H * 0.01);
    ctx.lineTo(cx + hemHalf * 0.8, hemY - H * 0.06);
    ctx.stroke();

    // Neck.
    ctx.lineWidth = H * 0.03;
    ctx.beginPath();
    ctx.moveTo(cx, shoulderY);
    ctx.lineTo(cx, neckY);
    ctx.stroke();

    // Dress: the silhouette that makes her recognisable from across the hall,
    // and the biggest single piece of flat state colour outside the band.
    // Sticker treatment — hard ink shadow straight down, flat fill, ink outline.
    const dress = (dy: number): void => {
      ctx.beginPath();
      ctx.moveTo(cx - shoulderHalf, shoulderY + dy);
      ctx.lineTo(cx + shoulderHalf, shoulderY + dy);
      ctx.lineTo(cx + hemHalf, hemY + dy);
      ctx.lineTo(cx - hemHalf, hemY + dy);
      ctx.closePath();
    };
    ctx.fillStyle = COLORS.ink;
    dress(drop);
    ctx.fill();
    ctx.fillStyle = accent;
    dress(0);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = H * 0.018;
    dress(0);
    ctx.stroke();

    // Sash. Ink, not yellow — a yellow sash would put a second brand colour on
    // the one figure whose whole job is to be unambiguously one state.
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(cx - hemHalf * 0.78, hemY - H * 0.055, hemHalf * 1.56, H * 0.03);

    // Head: paper sticker, so the ink hair and ink eyes have something to read
    // against no matter which way she is facing.
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(cx, headY + drop, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, headY, R, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.paper;
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = H * 0.016;
    ctx.stroke();

    // Hair. Centred over the whole head when she faces away, sliding off to
    // one side as she comes round — that slide IS the turn, and it works at a
    // glance in a way a rotating face never would at this size. Flat ink: when
    // she is facing away the head is a solid black disc, when she is looking it
    // is a paper face. Two states, maximum contrast, no colour spent.
    const turnEase = EASE.out(f);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, headY, R * 0.995, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(cx + turnEase * R * 0.95, headY + R * 0.06, R * 1.02, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Bunches.
    ctx.fillStyle = COLORS.ink;
    for (const side of [-1, 1] as const) {
      ctx.beginPath();
      ctx.arc(
        cx + side * R * (0.92 - turnEase * 0.35) + turnEase * R * 0.5,
        headY - R * 0.45,
        R * (0.34 - turnEase * 0.08),
        0,
        Math.PI * 2
      );
      ctx.fill();
    }

    // Eyes. They exist only when she is looking. Flat ink on the paper face —
    // the old version glowed red, which is a blur doing the work that the
    // paper-versus-ink contrast does better and for free. `eye` fades the whole
    // element in as she turns, which is the permitted use of alpha.
    const eye = Math.min(1, Math.max(0, (f - 0.3) / 0.4));
    if (eye > 0.01) {
      ctx.globalAlpha = eye;
      ctx.fillStyle = COLORS.ink;
      for (const side of [-1, 1] as const) {
        ctx.beginPath();
        ctx.arc(cx + side * R * 0.34 - R * 0.16, headY - R * 0.05, R * 0.19, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // HER LINE OF SIGHT IS GONE, AND THAT IS THE FIX, NOT A LOSS.
    //
    // It was a translucent red gradient cone fanned across every lane — a
    // gradient and a see-through brand colour, so it had to go either way. The
    // obvious flat replacement, two ink rays along the same edges, was built
    // and rejected on the screenshot: with no soft falloff to sell it as a
    // cone, two hairlines crossing five lanes diagonally read as a rendering
    // glitch, and they cut straight through the progress figures.
    //
    // Nothing replaced it because nothing needed to. "She can see you" is
    // already carried by the head snapping round, the eyes appearing on a
    // paper face, and a red band across the width of the screen. A fourth
    // simultaneous cue for one bit of information is what the brand's
    // restraint is for.
  }

  /**
   * THE STATE BAND — the single loudest object in the game.
   *
   * A full-bleed horizontal band of flat brand colour, ruled top and bottom in
   * ink, carrying the instruction in ink capitals inside code brackets. It says
   * which state we are in AND what to do about it, which is what somebody who
   * walked up thirty seconds into a round needs.
   *
   * Full-bleed rather than a centred pill on purpose. A pill is the brand's
   * shape for one fact among several; this is the only fact on the screen, and
   * edge-to-edge saturated colour is the loudest thing a flat system can do.
   * It is also why the slam-in animates the band's HEIGHT rather than scaling
   * it: scaling a full-bleed bar would pull its ends in and turn it back into
   * a box.
   *
   * Straight, never tilted — DESIGN.md allows tilt on decorative stickers only,
   * and this is the most functional element in the app.
   */
  private drawBanner(fc: FrameContext): void {
    const { ctx, v } = fc;
    const red = this.light === 'red';
    const col = this.stateColor();
    // '<PUMP>', not '<MOVE>'. The whole confusion at the playtest was people
    // reading "move" and walking, which cannot work at a stall: there is no
    // floor space, and stepping toward the camera changes the body scale every
    // threshold here is divided by.
    const word = red ? '<FREEZE>' : '<PUMP>';

    const cy = vh(v, 32.4);
    // Slams in on the transition, then settles. Bounded at 1.8vh: any more and
    // the overshoot reaches the first lane's progress figure at 40.9vh.
    const slam = (1 - EASE.out(Math.min(1, this.lightT / 0.24))) * vh(v, 1.8);
    const h = vh(v, 13) + slam * 2;
    const y = cy - h / 2;

    // THE OPENING GREEN IS A TWO-LINE BAND. See the teach line below for why
    // the second line cannot live anywhere else. The word gives up 2.2vh for
    // the duration of one light, and gets it back the instant the game stops
    // explaining itself and starts shouting — which is its own piece of
    // choreography, and free.
    const teaching = !red && this.firstGreen;
    let size = vh(v, teaching ? 6.4 : 8.6);
    const maxW = v.width - vh(v, 8);
    const measured = measureText(ctx, word, size, WEIGHT.extrabold);
    if (measured > maxW) size *= maxW / measured;

    ctx.save();
    ctx.shadowBlur = 0;

    ctx.fillStyle = col;
    ctx.fillRect(0, y, v.width, h);

    const rule = vh(v, STROKE.thick);
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(0, y, v.width, rule);
    ctx.fillRect(0, y + h - rule, v.width, rule);
    ctx.restore();

    // Ink on a saturated field, no shadow — an ink shadow under ink type is a
    // smudge, and the band behind it is already all the separation it needs.
    drawText(ctx, word, v.width / 2, teaching ? cy - vh(v, 2.1) : cy, {
      size,
      color: COLORS.ink,
      weight: WEIGHT.extrabold,
      letterSpacing: TRACK.h2,
    });

    // THE FIRST GREEN TEACHES THE ACTION, and only the first.
    //
    // The banner alone cannot say what "pump" means to somebody meeting the
    // game in a queue. A line under it during the opening green — which is
    // deliberately the longest and most forgiving of the round — costs nothing
    // and is gone before it can become clutter. After that, the doll, the
    // light and six other people are the instruction.
    //
    // GATED ON THE LIGHT, NOT ON PROGRESS. It used to hide the moment ANY
    // racer passed 0.5% of the track, which in a six-player game is the moment
    // the FASTEST person starts — so the one line explaining the game was
    // pulled off screen by somebody who had already understood it, away from
    // the five who had not. The person who needs an instruction is by
    // definition the person who has not acted on it yet, so a behavioural gate
    // is always aimed at the wrong player. The opening green is 3.4-4.2s and
    // there is exactly one of them; that is the window.
    //
    // INSIDE THE BAND, NOT UNDER IT. It used to be drawn at `y + h + 3.4vh`,
    // which is 42.3vh — and the comment on `slam` two screens up already knew
    // that the first lane's progress figure sits at 40.9vh. So the one line
    // that explains the game was laid directly across lane one's track, during
    // the only light in the round when lane one's token is guaranteed to be
    // travelling through it. Worse on a slam, which pushes the line DOWN.
    //
    // There is no free paper anywhere near the band: 38.9vh to 40.4vh is the
    // whole gap, and above the band is the HUD. The band itself is the only
    // surface on this screen that nothing moves across — a flat green field,
    // ink on it at 6.2:1 — so the line belongs in it.
    if (teaching) {
      const line = 'SWING YOUR ARMS — DO NOT WALK';
      drawText(ctx, line, v.width / 2, cy + vh(v, 3.6), {
        size: vh(v, 2.5),
        maxWidth: maxW,
        color: COLORS.ink,
        font: FONTS.body,
        weight: 700,
        letterSpacing: TRACK.body,
      });
    }
  }

  /**
   * The result slam, as the biggest sticker in the game.
   *
   * The half-transparent backing panel is gone — a see-through surface, and one
   * that left the lanes showing through the most important line of the round.
   * An opaque paper band knocks the playfield back completely, and the call
   * sits on a flat pill in the winner's own colour so the lane that won and the
   * banner that says so are unmistakably the same object.
   */
  private drawFinalCall(fc: FrameContext): void {
    const { ctx, v } = fc;
    const t = EASE.back(Math.min(1, (this.holdTotal - this.endHold) / 0.45));
    const winner = this.winnerId !== null ? this.racers.get(this.winnerId) : undefined;
    const col = winner ? winner.color : COLORS.red;
    const cy = vh(v, 32);

    // Opaque paper band with ink rules, full-bleed. Same language as the state
    // band it is covering.
    const bandY = vh(v, 23);
    const bandH = vh(v, 18);
    const rule = vh(v, STROKE.thick);
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, bandY, v.width, bandH);
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(0, bandY, v.width, rule);
    ctx.fillRect(0, bandY + bandH - rule, v.width, rule);
    ctx.restore();

    let size = vh(v, 7.2);
    const maxW = v.width - vh(v, 14);
    const measured = measureText(ctx, this.finalCall, size, WEIGHT.black);
    if (measured > maxW) size *= maxW / measured;

    const textW = measureText(ctx, this.finalCall, size, WEIGHT.black);
    const pillH = size * 1.62;
    const pillW = textW + pillH * 0.8;

    ctx.save();
    ctx.translate(v.width / 2, cy);
    ctx.scale(t, t);
    stickerPill(ctx, v, -pillW / 2, -pillH / 2, pillW, pillH, {
      fill: col,
      outline: COLORS.ink,
      outlineWidth: vh(v, STROKE.thick),
      shadow: vh(v, SHADOW.lifted),
    });
    drawText(ctx, this.finalCall, 0, 0, {
      size,
      color: markOn(col),
      weight: WEIGHT.black,
      letterSpacing: TRACK.h1,
    });
    ctx.restore();
  }
}
