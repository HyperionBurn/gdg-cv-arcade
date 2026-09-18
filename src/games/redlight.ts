/**
 * RED LIGHT, GREEN LIGHT — "the sleeper hit".
 *
 * PLAN.md §3 rates this the single best addition to the roster, for one reason
 * the other six games cannot touch: **up to six people play at once**, which
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
 * `PLAYER_COLORS` runs yellow, blue, green, red, INK, muted — six identities
 * for a six-player game. Five of the six take ink; the ink one obviously does
 * not, and a black stick figure on a black chip is an invisible player.
 */
function markOn(fill: string): string {
  return fill === COLORS.ink ? COLORS.paper : COLORS.ink;
}

/** PLAN.md §3: "Up to 6 players at once." Also the length of PLAYER_COLORS. */
const LANES = 6;

/** Seconds a newly-seen player is immune. Walking in must never mean walking out. */
const SETTLE_SEC = 0.6;

/** How long the winning tableau holds before the results screen takes over. */
const WIN_HOLD_SEC = 1.9;
const WIPEOUT_HOLD_SEC = 1.2;

/**
 * Elimination callouts. Deliberately daft — PLAN.md §11: "failure should be
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
  /** Time constant used during that window. Fast enough to settle inside it. */
  calibrateTau: number;
}

/**
 * PLAN.md §4: every gesture tunable is expected to need adjusting on the day,
 * for real bodies under hall lighting. These are calibrated against the pose
 * simulator, which is the weakest part of this file — see the note on
 * `moveEnter` in `thresholdFor`.
 */
export const DEFAULT_REDLIGHT_TUNABLES: RedLightTunables = {
  moveEnter: 0.85,
  exitRatio: 0.55,
  quietMult: 2.4,
  // Raised 1.9 -> 4.0 when the clamp moved onto `quiet`. It now bounds the
  // believable STILL energy (4.0 * 0.85 = 3.4 torso-units/sec) rather than the
  // threshold, so a noisy room can be absorbed while "stand there vibrating to
  // raise your own bar" still cannot.
  quietCeiling: 4.0,
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
  graceSec: 0.55,
  breachSec: 0.12,
  // Now a MULTIPLE of the threshold rather than an absolute span. 1.5 against
  // the old default threshold of 0.85 was a span of ~1.3, so 1.5 keeps the
  // clean-room feel roughly unchanged while tracking a noisy room.
  driveSpan: 1.5,
  advanceRate: 6,
  energyTau: 0.1,
  calibrateSec: 2.2,
  calibrateTau: 0.35,
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

  private light: Light = 'green';
  private lightT = 0;
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
      tagline: '<MOVE ON GREEN, FREEZE ON RED> UP TO 6 PLAYERS',
      visionMode: 'pose',
      maxPlayers: LANES,
      roundSeconds: 45,
      color: GAME_COLORS.redlight,
      // Not a split-screen duel. Six people share one screen and one set of
      // lanes, so the base's versus layout would be actively wrong here.
      supportsVersus: false,
      // Everyone in frame plays together.
      partyMode: true,
      // Hold a lobby. This is the one game whose entire value is six people at
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
  protected scoreFor(): number {
    let best = 0;
    for (const r of this.racers.values()) best = Math.max(best, r.progress);

    if (best >= 100) {
      return 100 + Math.round(Math.max(0, this.timeLeft) * 10);
    }
    return Math.round(best);
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
    this.light = next;
    this.lightT = 0;
    this.fakeout = false;

    if (next === 'green') {
      this.fakeout = duration === undefined && Math.random() < 0.18 + p * 0.22;
      const base = this.fakeout ? 0.45 : 3 - p * 1.7;
      const spread = this.fakeout ? 0.45 : 1.6 - p * 0.9;
      this.lightDur = duration ?? base + Math.random() * spread;
      this.tellStart = this.fakeout ? 1 : 0.52 + Math.random() * 0.33;
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

  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    const tun = this.tun;

    // Vision lands at ~30fps under a 60fps render (and at the render rate in
    // sim mode). Sampling motion on a frame that carries no new landmarks
    // pushes a fake zero into the signal, so everything below keys off the
    // vision frame id and converts to per-second units using the real interval.
    const vf = fc.vision?.frameId ?? -1;
    const fresh = vf !== this.lastVisionFrame;
    let dtv = 0;
    if (fresh) {
      // Clamped at both ends. This is a divisor, so a bad value does not
      // degrade the signal, it inverts the game: too small and a motionless
      // player reads as a flail, too large and a flailing one reads as a
      // statue. `fc.time` is the right clock — these landmarks came off a
      // camera at wall-clock time, not at the clamped physics dt — but a GC
      // pause, a tab switch or a test harness re-basing its clock can all
      // produce a gap that means nothing, so the range is bounded to plausible
      // inference intervals.
      const raw = fc.time - this.lastVisionTime;
      dtv = this.lastVisionTime > 0 ? Math.min(1 / 8, Math.max(1 / 120, raw)) : 0;
      this.lastVisionFrame = vf;
      this.lastVisionTime = fc.time;
    }

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
      } else if (this.light === 'red' && r.settle <= 0) {
        if (moving) {
          r.breach += dt;
          // Inside the grace window this is not a foul, but it IS the near
          // miss we want to celebrate when they survive the light.
          if (!judging) r.nearMiss = true;
        } else {
          r.breach = 0;
        }
        if (judging && r.breach >= tun.breachSec) this.eliminate(fc, r);
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
    const calibrating = this.state !== 'playing' && r.age < this.tun.calibrateSec;

    // ONCE THE ROUND STARTS, THE FLOOR IS FIXED.
    //
    // It used to keep adapting, falling fast (tau 0.09) whenever energy dipped
    // below it. That makes it a MINIMUM tracker, and a minimum is the wrong
    // statistic for a noise floor: it drifts down toward the quietest instant,
    // the threshold follows, and the noise PEAKS then cross it. Measured under
    // mild noise, that eliminated a player who never moved.
    //
    // The fast fall was justified as "so a freeze is recognised in time", but
    // that is the job of `energy`, which has its own 0.1s smoother. The floor
    // is a property of the room and the camera; it does not change because
    // somebody stopped moving.
    //
    // So it adapts during the lobby and countdown, and holds for the round.
    if (calibrating) {
      const tau = r.energy < r.quiet ? 0.09 : this.tun.calibrateTau;
      r.quiet += (r.energy - r.quiet) * (1 - Math.exp(-dtv / tau));
    }
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
    // The ceiling exists to stop someone training the detector to ignore them.
    // That is a statement about what "still" can plausibly be — so it belongs
    // on `quiet`, the estimate of still. The signal-to-noise margin
    // (`quietMult`) then applies on top, and the threshold is free to land
    // wherever the room's noise actually puts it.
    const floor = Math.min(r.quiet, moveEnter * quietCeiling);
    return Math.max(moveEnter, floor * quietMult);
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

    const racer: Racer = {
      id: p.id,
      lane,
      color: PLAYER_COLORS[lane] ?? COLORS.blue,
      progress: 0,
      alive: true,
      finished: false,
      energy: 0,
      age: 0,
      // Start where the absolute floor is, so a fresh player is judged by
      // `moveEnter` until they have shown us what their own still looks like.
      quiet: this.tun.moveEnter / this.tun.quietMult,
      motion: new MotionEnergy(1),
      gate: new Hysteresis(this.tun.moveEnter, this.tun.moveEnter * this.tun.exitRatio),
      breach: 0,
      nearMiss: false,
      present: true,
      absent: 0,
      settle: SETTLE_SEC,
      landmarks: p.landmarks,
      wobble: 0,
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
    // Clamping the vertical offset alone was not enough: at six lanes the taunt
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
   * carry six player identities in six different colours, and overloading them
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
   * lets six live lanes be six different colours without the screen falling
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
      drawText(ctx, 'OUT', x, labelY, {
        size: vh(v, 2.1),
        color: COLORS.muted,
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
   * own lane. Six people in a line all need to answer "which one is me" in
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
    // cone, two hairlines crossing six lanes diagonally read as a rendering
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
    const word = red ? '<FREEZE>' : '<MOVE>';

    const cy = vh(v, 32.4);
    // Slams in on the transition, then settles. Bounded at 1.8vh: any more and
    // the overshoot reaches the first lane's progress figure at 40.9vh.
    const slam = (1 - EASE.out(Math.min(1, this.lightT / 0.24))) * vh(v, 1.8);
    const h = vh(v, 13) + slam * 2;
    const y = cy - h / 2;

    let size = vh(v, 8.6);
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
    drawText(ctx, word, v.width / 2, cy, {
      size,
      color: COLORS.ink,
      weight: WEIGHT.extrabold,
      letterSpacing: TRACK.h2,
    });
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
