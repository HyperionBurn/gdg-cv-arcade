/**
 * Shared round lifecycle for every game.
 *
 * PLAN.md §6 defines one flow: countdown → play → score slam → rank reveal →
 * faction contribution → initials → "wave to play again". Seven games
 * implementing that separately would be seven chances to get the queue
 * behaviour subtly wrong, so it lives here once.
 *
 * Also enforces the two hard stall rules from PLAN.md §1:
 *   - hard turn cap, no lives-based rounds
 *   - idle timeout back to attract when nobody is in frame
 *
 * Subclasses implement only what makes their game different: onStart, onTick,
 * onRender, and a score per slot.
 */

import { PoseTracker, DEFAULT_TRACKER_OPTIONS, type TrackedPlayer } from '../core/tracker';
import type { FilterPreset } from '../core/filter';
import { vision } from '../core/vision';
import { camera } from '../core/camera';
import { isSimEnabled } from '../core/simulator';
import type { VisionMode } from '../core/types';
import { Projection } from '../engine/projection';
import { Juice, RollingNumber, PopupLayer } from '../engine/juice';
import { ParticleSystem, BURST } from '../engine/particles';
import { audio } from '../engine/audio';
import {
  clearFrame,
  drawText,
  fitText,
  vh,
  progressBar,
  roundRect,
  graphPaper,
  labelPill,
  rankedRow,
} from '../engine/draw';
import {
  COLORS,
  PLAYER_COLORS,
  FONTS,
  EASE,
  SHADOW,
  SPACE,
  STROKE,
  WEIGHT,
  textColor,
  dur,
  ramp,
  idlePulse,
} from '../shell/theme';
import { leaderboard, type GameId, type RankResult } from '../meta/leaderboard';
import { tunables } from '../meta/tunables';
import { ghosts, drawGhost, type GhostPlayback } from '../meta/ghosts';
import { highlights } from '../meta/highlights';
import { tournament, isTournamentGame } from '../meta/tournament';
import { setPendingScore } from '../shell/initials';
import { takePlayMode, type PlayMode } from '../meta/mode';
import { router } from '../shell/router';
import type { Screen, FrameContext } from '../shell/screen';

export type RoundState = 'waiting' | 'gathering' | 'countdown' | 'playing' | 'results';

export interface GameConfig {
  gameId: GameId;
  title: string;
  /** One line, shown during the countdown. Must explain the game completely. */
  tagline: string;
  /**
   * THE ONE THING THAT MAKES A NEW PLAYER THINK THE GAME IS BROKEN.
   *
   * Not a second tagline and not a tip. Every game here has at most one rule
   * that, unmet, produces *silence* rather than a wrong result — balloons that
   * will not pop, an arm-pump game that ignores you because you walked. A
   * player who gets a wrong result learns; a player who gets nothing concludes
   * the camera is broken and leaves, and the queue behind them watches them do
   * it.
   *
   * Four or five words. It is read off a television by somebody who is also
   * watching a numeral count down, and it is phrased as the AVOIDANCE, because
   * the tagline directly above it already carries the positive instruction.
   *
   * OMIT IT when the game teaches the rule in the moment and teaches it well.
   * Rhythm pops `<LEFT!>` on a wrong-fist reach and leaves the note live;
   * Runner is fully playable during the countdown, which is a better tutorial
   * than any sentence. Pose Match's meter is red / yellow / green. A line on
   * the countdown for any of those is clutter charged against the three games
   * that genuinely need one.
   */
  avoid?: string;
  visionMode: VisionMode;
  maxPlayers: number;
  roundSeconds: number;
  color: string;
  /** Show the split-screen divider and per-slot HUD when 2 players are present. */
  supportsVersus: boolean;
  /**
   * Hold a lobby for this many seconds before starting, so more people can
   * join. 0 or absent starts as soon as someone is in frame.
   *
   * Essential for party games. Without it the countdown fires the instant ONE
   * player is confirmed — which for a six-player game means it starts while
   * everyone else is still shuffling into frame, and the whole reason the game
   * is on the roster is lost.
   */
  gatherSeconds?: number;
  /**
   * Everyone present plays together on one shared screen — no split, no slots.
   * `playerCount` then tracks however many are actually in frame.
   */
  partyMode?: boolean;
  /**
   * Draw the ghost as a translucent SKELETON as well as a score line.
   *
   * Off for games with their own 3D camera. The ghost silhouette is projected
   * from camera space, so over the Runner's perspective track it renders as a
   * large grey figure straddling the whole playfield — two incompatible spaces
   * composited on top of each other. Those games still race the ghost; they
   * just do it through the score line, which is the part that carries the
   * information anyway.
   *
   * Defaults to true.
   */
  ghostSilhouette?: boolean;
  /**
   * This game's playfield fills its whole slot, edge to edge.
   *
   * Changes the split-screen divider from the usual faint dashed rule to a
   * full-height ink one. Only the Runner needs it today: every other versus
   * game leaves white space either side of its playfield, so the halves are
   * already visually separate and a loud divider would be the noisiest object
   * on the screen.
   */
  fullBleedSlots?: boolean;
  /**
   * Put the HUD on a solid paper shelf with a hard ink rule, and shrink it to
   * fit above that rule.
   *
   * FOR GAMES WHOSE PLAYFIELD OWNS THE WHOLE SCREEN. Pose Match is the case
   * that forced it: the wall is a full-opacity ink plane that scales from
   * `WALL_SPAN * S_FAR` to wider than the viewport, and by the halfway point of
   * its approach its top edge has left the screen — so for most of every wall's
   * life the ink plane is behind the entire HUD band. Blue score on ink is
   * 2.3:1; muted grey label on ink is worse.
   *
   * The three fixes that DON'T work, so nobody retries them:
   *  - Cap the wall's growth below `hudBottom()`. The hole is 42% of the plane
   *    and centred at 0.58H, so at impact its TOP edge is at 0.20H — above the
   *    default 0.30H band. Capping the plane cuts the silhouette the player is
   *    supposed to copy, which is the entire game.
   *  - Move the HUD sideways. At impact the plane is 1.8x the viewport width.
   *    There is no horizontal clear space.
   *  - Fade the HUD while a wall is close. It would be faded for most of the
   *    round, which is just deleting the HUD with extra steps.
   *
   * A shelf is the arcade answer: the playfield slides UNDER a header, which
   * reads as depth rather than as a collision, and the header is paper, so
   * every HUD colour is back on its designed background.
   *
   * WHY THE BAND IS 15.8vh AND NOT MORE. A shelf occludes whatever is behind
   * it, and in Pose Match that is the PLAYER — the thing they are checking
   * their own shape against. Measured against the simulator's 3m framing, a
   * standing head tops out around 22vh and fully raised fingertips around
   * 21.6vh; several poses on the roster put the arms straight up. 15.8 keeps
   * ~6vh of clearance over that, which is the margin a taller player or one
   * standing closer to the camera eats into. It also clears the hole's top edge
   * at impact (20.2vh) with room to spare.
   */
  hudShelf?: boolean;
  /**
   * One Euro preset for this game's tracker. Defaults to `body`.
   *
   * FOR GAMES WHOSE INPUT IS STOPPING. One Euro widens its cutoff with speed,
   * so fast motion is tracked with little lag — but as a limb DECELERATES the
   * cutoff closes back to `minCutoff`, and the `body` preset's 1Hz floor is a
   * time constant of ~159ms. At 30 samples/sec that is roughly a third of a
   * second for the skeleton to finish arriving after the arm has already
   * stopped.
   *
   * Every game whose input is motion hides this. Pose Match is the one game
   * that scores a HELD SHAPE, so its player stops and then watches the match
   * percentage creep upward for 300ms — reported, accurately, as "very laggy".
   */
  filterPreset?: FilterPreset;
  /**
   * Draw the faint camera ghost behind this game's playfield. Defaults to true.
   *
   * Off for games that own the whole frame with their own camera space — the
   * Runner's 3D track is not in camera coordinates, so a mirrored webcam image
   * behind it is two incompatible spaces stacked on each other.
   */
  cameraGhost?: boolean;
}

/**
 * Vertical HUD layout, in vh. Two presets: the default, and the compact one
 * used with `hudShelf`. Every number the HUD positions itself with lives here
 * so that `hudBottom()` cannot drift out of agreement with what is drawn.
 */
interface HudMetrics {
  barY: number;
  barH: number;
  clockY: number;
  clockSize: number;
  statY: number;
  statSize: number;
  labelY: number;
  labelSize: number;
  chaseY: number;
  /** Multiplier on the chase line's several context-dependent sizes. */
  chaseScale: number;
  /**
   * Lay the clock, the score and the chase line out as ONE ROW — clock flush
   * left, score centred in the slot, chase flush right — instead of stacking
   * them down the middle.
   *
   * A shelf is short by definition, and stacking five elements into 19.8vh
   * costs the score 40% of its height and pushes the label to 1.5vh, which
   * TYPE.micro reserves for operator text nobody has to read. The stacked
   * layout only ever used the centre column; going wide buys back the vertical
   * space for free, and the score ends up at 9vh — within 2vh of the full HUD's
   * 11 — instead of 6.8.
   */
  inlineRow?: boolean;
  /** `hudBottom()`. Must clear the lowest thing above, with margin. */
  bottom: number;
}

const HUD_FULL: HudMetrics = {
  barY: 3, barH: 1.1,
  clockY: 7.5, clockSize: 3.6,
  statY: 16, statSize: 11,
  labelY: 23, labelSize: 1.9,
  chaseY: 26, chaseScale: 1,
  bottom: 30,
};

/**
 * Compact, and laid out across the band rather than down it. The score gives
 * up 2vh; the label and the chase line keep their full size.
 */
const HUD_SHELF: HudMetrics = {
  barY: 2.0, barH: 0.85,
  clockY: 8.6, clockSize: 3.0,
  statY: 8.6, statSize: 8.2,
  labelY: 14.3, labelSize: 1.9,
  chaseY: 8.6, chaseScale: 0.85,
  inlineRow: true,
  bottom: 15.8,
};

/** Frames a player must be absent before we end their round. */
const PLAYER_LOST_GRACE_SEC = 2.5;
/** PLAN.md §6: idle timeout back to attract. */
const IDLE_TIMEOUT_SEC = 20;
export const COUNTDOWN_SEC = 3.2;
/**
 * The friend is always half a step behind.
 *
 * Six of the seven games hold two players and draw a real split screen, but
 * only Red Light ran a lobby. Everything else went `waiting -> countdown` on
 * the single frame the FIRST body was confirmed, froze `playerCount` there,
 * and never looked again — `tickCountdown` had no player-count logic at all.
 * So the actual failure at a stall was not "two-player is missing", it was
 * "two-player exists and is unreachable": two friends walk up, one is a beat
 * ahead, and the game locks solo while the second person stands inside the
 * frame feeding the tracker a body that scores nothing.
 *
 * The obvious fix — give every versus game `gatherSeconds` — costs the SOLO
 * player 1.5-2.6s of lobby on every single turn, at a stall whose whole
 * problem is queue throughput. That is the wrong trade: the countdown is
 * already 3.2 seconds of a person standing still watching a numeral, which is
 * exactly the window the late friend needs and it is already being spent.
 *
 * So the countdown re-resolves the player count every frame, and an ARRIVAL
 * rewinds the clock to at least `LATE_JOIN_FLOOR_SEC` so nobody starts a
 * versus round mid-stride. Solo turns pay nothing.
 */
export const LATE_JOIN_FLOOR_SEC = 1.7;
/**
 * Arrivals that may rewind the countdown, per round.
 *
 * Without a cap a tracker oscillating between one and two bodies — which is
 * exactly what a spectator hovering at the edge of the play zone produces —
 * could hold the countdown open indefinitely. Two is enough for the real case
 * (one friend joining a 2P game, or two joining a 6-lane one) and bounds the
 * worst case at COUNTDOWN_SEC + 2 * LATE_JOIN_FLOOR_SEC.
 */
export const MAX_LATE_JOINS = 2;

/**
 * How long the tracker takes to turn a body that walked in into a PLAYER.
 *
 * Not a tunable — a MEASUREMENT, taken against the real pipeline: a second
 * simulated body added mid-countdown was admitted 27 frames (0.45s) later.
 * That is `minAgeToConfirm` plus `admitStillSec` plus detection lag, and it is
 * deliberately slow: the same hysteresis is what stops a person walking past
 * the stall being handed half the screen. Shortening it to make joining
 * quicker would re-open the bystander bug, so the UI has to be built around
 * the latency rather than against it. Rounded up from 0.45.
 */
export const ADMIT_LATENCY_SEC = 0.5;

/**
 * Remaining countdown at which "A FRIEND CAN STEP IN" stops being offered.
 *
 * THE INVITATION MUST NOT OUTLIVE ITS OWN DEADLINE. An offer shown at "1" is a
 * taunt: the friend reads it, steps in, and the round has already started
 * without them — which is worse than never having offered, because now the
 * machine looks like it lied.
 *
 * So the cutoff is derived, not chosen: a person needs roughly 0.8s to read a
 * badge, decide, and move, and the tracker then needs ADMIT_LATENCY_SEC to
 * call them a player. Anyone who acts on the invitation on its very last
 * visible frame is therefore admitted with ~0.2s to spare, and the late-join
 * rewind gives them a full LATE_JOIN_FLOOR_SEC from there.
 */
export const STEP_IN_REACTION_SEC = 0.8;
export const INVITE_UNTIL_SEC = ADMIT_LATENCY_SEC + STEP_IN_REACTION_SEC + 0.2;

/**
 * How many of the people in frame a game actually plays with.
 *
 * Party games take everyone up to their lane count. Versus games take at most
 * two, because the split screen has exactly two halves and the third body is
 * by definition a spectator. Solo games take one and let the tracker's own
 * ranking decide WHICH one — that is `tracker.ts`'s job, not this one's.
 */
export function rosterSize(
  present: number,
  cfg: { partyMode?: boolean; supportsVersus: boolean; maxPlayers: number },
  mode: PlayMode | null = null
): number {
  // THE ONLY MODE THAT CHANGES ANYTHING. `open` is exactly what the detection
  // already produces, so the mode screen's real job is offering "just me" —
  // the one intent a camera cannot read off two people standing side by side.
  // See `meta/mode.ts`.
  if (mode === 'solo') return 1;
  if (cfg.partyMode) return Math.max(1, Math.min(present, cfg.maxPlayers));
  if (cfg.supportsVersus) return Math.min(Math.max(present, 1), 2);
  return 1;
}

/**
 * How long the tracker must keep reporting FEWER people before the countdown
 * believes somebody actually left.
 *
 * Without this, one dropped frame silently turns a versus round into a solo
 * one. Two people standing close enough to play side by side occlude each
 * other constantly — that is the entire reason `PLAYER_LOST_GRACE_SEC` exists
 * for the round itself — and the countdown was making a permanent decision off
 * an instantaneous reading, on the one screen where the decision cannot be
 * revisited afterwards. The friend is standing right there, and the game has
 * quietly decided they are not playing.
 *
 * Shorter than the in-round grace on purpose: the whole countdown is 3.2s, so
 * a genuine walk-away still has to be caught inside it.
 */
export const DEPART_GRACE_SEC = 0.5;

/** What one countdown frame decides about the number of people in frame. */
export interface CountdownRoster {
  playerCount: number;
  lateJoins: number;
  /** Rewound on an arrival so the newcomer is not mid-stride at GO. */
  stateTime: number;
  /** Seconds the tracker has continuously reported fewer people than we count. */
  belowFor: number;
  /** True on the frame an arrival was honoured — drives sound, shake, banner. */
  arrived: boolean;
}

/**
 * Pure half of the late-join rule, so it can be tested without a canvas.
 *
 * `want` is what `resolvePlayerCount` makes of the bodies currently tracked.
 * Everything this returns is a decision; `tickCountdown` owns the effects.
 *
 * The two directions are deliberately asymmetric, in both time and effect.
 * An ARRIVAL is believed immediately — the tracker has already spent
 * ADMIT_LATENCY_SEC deciding this is a player, and doubting it again here
 * would just be the same hysteresis twice — and it rewinds the clock. A
 * DEPARTURE has to persist for DEPART_GRACE_SEC, and never touches the clock:
 * the person still standing there has already waited long enough.
 */
export function countdownRoster(
  want: number,
  prev: Pick<CountdownRoster, 'playerCount' | 'lateJoins' | 'stateTime' | 'belowFor'>,
  dt: number
): CountdownRoster {
  const { playerCount, lateJoins, stateTime, belowFor } = prev;

  if (want > playerCount && lateJoins < MAX_LATE_JOINS) {
    return {
      playerCount: want,
      lateJoins: lateJoins + 1,
      stateTime: Math.min(stateTime, COUNTDOWN_SEC - LATE_JOIN_FLOOR_SEC),
      belowFor: 0,
      arrived: true,
    };
  }

  if (want < playerCount) {
    const below = belowFor + dt;
    if (below < DEPART_GRACE_SEC) {
      return { playerCount, lateJoins, stateTime, belowFor: below, arrived: false };
    }
    return { playerCount: want, lateJoins, stateTime, belowFor: 0, arrived: false };
  }

  return { playerCount, lateJoins, stateTime, belowFor: 0, arrived: false };
}

/** Lobby ends early once this many have joined and held still briefly. */
const GATHER_SETTLE_SEC = 1.2;
/**
 * How long the lobby waits after the LAST person joins before giving up on
 * more arriving.
 *
 * `gatherSeconds` alone was a flat hold: a solo stranger stepping up to Red
 * Light — the only game with a lobby — sat through all 10 seconds of "1 PLAYER
 * READY / STARTING IN 10..9..8" before anything happened. That is a sixth of
 * their turn spent watching a number, alone, at a stall built around a moving
 * queue, and nobody was ever going to join them.
 *
 * Waiting on STABILITY instead gets both cases right: every new arrival resets
 * the clock, so a group trickling in keeps the doors open for as long as they
 * keep coming, and a lone player is off the hook in under three seconds.
 * `gatherSeconds` stays as the hard ceiling.
 */
const GATHER_STABLE_SEC = 2.6;
/**
 * Quietest an overtake can be announced, in seconds. See `watchLead`.
 *
 * Two players a point apart trade the lead several times a second in a game
 * like 67 Speed; every one of those is technically an overtake and none of
 * them is a moment. Long enough to be an event, short enough that a genuine
 * back-and-forth still reads as one.
 */
export const LEAD_DEBOUNCE_SEC = 2.5;

/** Who holds the lead, and whether this frame is worth announcing. */
export interface LeadState {
  leadSlot: number;
  /** `stateTime` of the last announcement, for the debounce. */
  leadAt: number;
  announce: boolean;
}

/**
 * Pure half of the overtake rule, so it can be tested without a canvas.
 *
 * A TIE KEEPS THE INCUMBENT. Scores cross THROUGH equality, so treating a draw
 * as "nobody leads" fires twice on every overtake — once into the tie and once
 * out — and in a game where both players score on the same beat it fires
 * continuously.
 *
 * The FIRST player to go ahead has not overtaken anybody, so that one is
 * recorded silently. After that, a debounce: two players a point apart trade
 * the lead several times a second, every one of those is technically an
 * overtake and none of them is a moment.
 */
export function leadChange(
  a: number,
  b: number,
  prev: Pick<LeadState, 'leadSlot' | 'leadAt'>,
  stateTime: number
): LeadState {
  const next = a > b ? 0 : b > a ? 1 : prev.leadSlot;
  if (next === prev.leadSlot) return { ...prev, announce: false };

  // Nobody held it before, so nobody lost it.
  if (prev.leadSlot < 0) return { leadSlot: next, leadAt: prev.leadAt, announce: false };

  if (stateTime - prev.leadAt < LEAD_DEBOUNCE_SEC) {
    return { leadSlot: next, leadAt: prev.leadAt, announce: false };
  }
  return { leadSlot: next, leadAt: stateTime, announce: true };
}

const RESULTS_SEC = 7;
/**
 * Shorter results hold once the player has actually walked off.
 *
 * The 7s hold exists so a turn is PREDICTABLE, and so the person who just
 * played gets to read their rank. Neither reason survives them leaving. Timed
 * end to end, the old unconditional hold put ~13.3s between a round ending and
 * the menu being usable again, and ~17.7s before the next person was actually
 * playing — past the point where a queue at a stall starts breaking up.
 *
 * `RESULTS_EMPTY_GRACE_SEC` is there because tracking drops a stationary body
 * for a frame or two fairly often, and cutting someone's own results short
 * while they are still standing there reading them is a worse bug than the one
 * being fixed.
 */
/**
 * Camera-ghost bitmap size. A positioning aid, not a picture — this is plenty
 * to see where a body is, and it makes the import cheap enough to do per frame.
 */
const GHOST_W = 480;
const GHOST_H = 270;

/**
 * Age at which a vision frame stops counting as evidence that anyone is there.
 * Generous: it must clear a `numPoses` model rebuild, measured at a 492-575ms
 * dead window plus a 354-418ms first inference.
 */
const VISION_STALE_MS = 1500;

/**
 * Which pose model the GAMES run. Attract stays on `lite` — it only has to
 * notice that somebody is there.
 *
 * A number rather than a string because the operator console is numeric, and
 * being able to A/B this on the actual rig in the actual hall is worth more
 * than a tidy type: landmark steadiness is the one thing that cannot be
 * evaluated in `?sim=1` at all, because MediaPipe never runs there.
 *
 * 0 = lite, 1 = full, 2 = heavy. Defaults to `full`: every gesture threshold is
 * divided by `scale.unit`, which is computed from these landmarks, so model
 * jitter moves every threshold in every game simultaneously — which is exactly
 * what the playtest reported as "tracking is a bit wonky".
 */
function poseModelChoice(): 'lite' | 'full' | 'heavy' {
  const n = Math.round(tunables.get('vision.poseModel', 1));
  return n <= 0 ? 'lite' : n >= 2 ? 'heavy' : 'full';
}

const RESULTS_ABANDONED_SEC = 2.6;
const RESULTS_EMPTY_GRACE_SEC = 0.9;

/**
 * Entrance fade on the pre-play lifecycle screens.
 *
 * `enter()` is a pure assignment — `state = x; stateTime = 0` — so
 * waiting -> gathering -> countdown were hard cuts, frame-stepped and
 * confirmed: one `tick(1)` apart, a full lobby composition is replaced by a
 * completely different one with no intermediate frame. That fires on every
 * turn, for every game, for every stranger, and it is the highest-frequency
 * motion gap in the app.
 *
 * A fade and not a `wipe()`. The shell's screen-level wipes are right for
 * screen-level navigation, but four 0.22s wipes inside a single turn would add
 * most of a second of dead time to a handover we have just spent effort
 * shortening — and these are not different screens, they are the same screen
 * changing its mind. countdown -> playing is deliberately excluded: `enter`
 * already fires `juice.flash` there, which is a louder and better marker than
 * a fade.
 *
 * Via `ramp`, so it is already 1 on frame one under reduced motion rather than
 * a very fast 0.
 */
const STATE_ENTER_SEC = 0.2;

export abstract class GameBase implements Screen {
  readonly id: string;
  onExit?: (next: string) => void;

  protected tracker: PoseTracker;
  protected proj: Projection | null = null;
  protected juice = new Juice();
  protected particles = new ParticleSystem();
  protected popups = new PopupLayer();
  protected scores: RollingNumber[] = [];

  protected state: RoundState = 'waiting';
  protected stateTime = 0;
  /** Seconds remaining in the round. */
  protected timeLeft = 0;
  /**
   * The round's ACTUAL length in seconds, after `game.roundScale`.
   *
   * `timeLeft` was being scaled while every consumer went on dividing by the
   * unscaled `config.roundSeconds`, so the operator's one lever for a long
   * queue silently corrupted everything derived from elapsed time. Measured at
   * scale 0.7, half a second into a 67 round: the game believed 6.58s had
   * elapsed rather than 0.5, the ghost target read 57 reps instead of 4, the
   * ghost race latched as already lost on the first frame, and the HUD timer
   * bar started 67% drained.
   *
   * Worse, `ghosts.sample` records against the same figure, so a scaled round
   * saved a time-shifted ghost that then mis-paced the NEXT player's race.
   *
   * Every consumer reads this. `config.roundSeconds` is the design intent;
   * this is what actually ran.
   */
  protected roundTotal = 0;
  protected players: TrackedPlayer[] = [];
  protected playerCount = 1;
  /** Arrivals already honoured this countdown. See `MAX_LATE_JOINS`. */
  private lateJoins = 0;
  /** `fc.time` of the last arrival, so the VERSUS banner can land rather than blink on. */
  private lateJoinAt = -1;
  /** Seconds the tracker has continuously reported fewer people than we count. */
  private rosterBelowFor = 0;
  /**
   * What the mode screen was told, for the life of this visit.
   *
   * Read ONCE on mount rather than per round: a player who picked JUST ME and
   * then plays again without going back to the menu has not changed their
   * mind, and re-reading a handoff that `takePlayMode` has already cleared
   * would silently put them back into versus on their second turn.
   */
  private playMode: PlayMode | null = null;
  /** Who is ahead in a versus round, or -1 before anyone is. See `watchLead`. */
  private leadSlot = -1;
  /** `stateTime` of the last lead announcement, for the debounce. */
  private leadAt = -Infinity;

  private lastFrameId = -1;
  private idleTime = 0;
  private lostTime = 0;
  private results: Array<{ slot: number; score: number; rank: RankResult }> = [];
  private lastCountdownTick = -1;
  /** Highest headcount seen this lobby, and when it last went up. */
  private gatherPeak = 0;
  private gatherLastJoin = 0;
  /**
   * Latched once the ghost race is out of reach, so the chase line can fall
   * back to the leaderboard instead. LATCHED rather than recomputed each
   * frame, because the deficit crosses any threshold repeatedly and the line
   * would flicker between two different messages.
   */
  private ghostRaceLost = false;
  /** Continuous seconds with nobody in frame, during results only. */
  private resultsEmptyTime = 0;
  /** Cached downscaled camera frame for the ghost. See drawCameraGhost. */
  private ghostBitmap: ImageBitmap | null = null;
  private ghostAt = -1;
  private ghostPending = false;
  /** stateTime at which the results panel first drew. -1 until it has. */
  private panelStart = -1;
  /** Did THIS round produce the clip currently held? See tickResults. */
  private capturedThisRound = false;
  private frameBudgetStrikes = 0;
  /**
   * The best previous solo run, replayed alongside the live player.
   * PLAN.md §4: "turns a solo run into a race."
   */
  private ghost: GhostPlayback | null = null;

  /**
   * Declared as a field rather than a constructor parameter property.
   *
   * `node --test` runs TypeScript in strip-only mode, which cannot compile
   * `constructor(protected config: ...)` — it throws
   * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at PARSE time, before any test body
   * runs. One shorthand therefore made this entire module, and everything
   * that imports it, untestable under the runner the project uses. The round
   * state machine is the most shared code in the repo; it should be the most
   * testable, not the least.
   */
  protected config: GameConfig;

  constructor(config: GameConfig) {
    this.config = config;
    this.id = config.gameId;
    this.tracker = new PoseTracker({
      maxPlayers: config.maxPlayers,
      mirrored: true,
      ...(config.filterPreset ? { filterPreset: config.filterPreset } : {}),
    });
    for (let i = 0; i < config.maxPlayers; i++) this.scores.push(new RollingNumber(10));
  }

  /* ---------------- subclass hooks ---------------- */

  /** Reset game state for a new round. */
  protected abstract onStart(playerCount: number): void;
  /** Simulate. `dt` already has hit-stop and slow-mo applied. */
  protected abstract onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void;
  /** Draw the world. HUD is drawn by the base afterwards. */
  protected abstract onRender(fc: FrameContext, players: TrackedPlayer[]): void;
  /** Final score for a slot. */
  protected abstract scoreFor(slot: number): number;

  /**
   * Optional: run every frame BEFORE the round starts — during `gathering` and
   * `countdown`, with whoever is currently in frame.
   *
   * `onTick` only runs while the state is `playing`, which means a game cannot
   * measure anything about the room or the players until it is already scoring
   * them. Red Light needs exactly that: its elimination threshold is a multiple
   * of the camera's noise floor, and the floor has to be learned from bodies
   * that are standing in their lanes rather than racing. Without this hook its
   * calibration branch was unreachable — it was guarded on
   * `state !== 'playing'` inside a method that only runs when the state IS
   * `playing`, so the floor stayed at its seed value and a motionless player
   * was eliminated in ten seconds under ordinary sensor noise.
   */
  protected onPreTick?(fc: FrameContext, players: TrackedPlayer[], dt: number): void;

  /** Optional: draw behind everything (backdrops, camera feed). */
  protected onRenderBackground?(fc: FrameContext): void;
  /** Optional: extra HUD per slot. */
  protected onRenderHud?(fc: FrameContext, slot: number, rect: SlotRect): void;
  /** Optional: what the big number during play should read. Defaults to score. */
  protected primaryStat(slot: number): string {
    return String(this.scoreFor(slot));
  }
  protected primaryLabel(): string {
    return 'SCORE';
  }

  /* ---------------- lifecycle ---------------- */

  async mount(): Promise<void> {
    // What the mode screen was told, if anything. Read and cleared here, once
    // per visit — see `playMode`. A game reached without passing through that
    // screen (a keyboard jump, a one-seat game, the dev harness) gets null,
    // which is the auto-detected behaviour this app had before the screen
    // existed.
    this.playMode = takePlayMode();

    // In sim mode the simulator feeds poses directly; starting MediaPipe would
    // just spin up a worker with no camera behind it.
    // `maxPlayers`, NOT the number of people actually in frame.
    //
    // Narrowing this to the real count at `enter('countdown')` — so a solo
    // player picking Red Light runs numPoses 1 instead of 6 — was proposed as a
    // 13-30ms/frame inference saving, and DECLINED. Changing `numPoses` tears
    // down and rebuilds the pose landmarker: a 492-575ms dead window plus a
    // 354-418ms first inference, nearly a full second blind. Spending that
    // inside a 3-second countdown risks the opening of the round, which is the
    // part every player is watching, to buy latency nobody has measured on this
    // hardware. The saving is also unmeasurable in `?sim=1`, where MediaPipe
    // never runs at all — so it cannot be validated before the day.
    //
    // Revisit only with a real camera and a real number.
    if (!isSimEnabled()) {
      await vision.start({
        mode: this.config.visionMode,
        numPoses: this.config.maxPlayers,
        numHands: this.config.maxPlayers * 2,
        poseModel: poseModelChoice(),
      });
    }
    this.tracker.setOptions({ maxPlayers: this.config.maxPlayers });
    this.enter('waiting');
    audio.init();
  }

  unmount(): void {
    // An abandoned round must not be saved as the run to beat.
    ghosts.cancel();
    audio.stopMusic();
    this.particles.clear();
    this.popups.clear();
    // `celebrate()` sets timeScale to 0.35 and eases it back over ~0.4s. A
    // screen torn down inside that window left slow motion latched, so the
    // NEXT round on this instance opened in slow motion with no way to
    // recover. `reset()` existed for exactly this and had no call sites.
    this.juice.reset();
    // An ImageBitmap holds GPU memory until closed, and a kiosk switches games
    // for hours.
    this.ghostBitmap?.close();
    this.ghostBitmap = null;
    this.ghostAt = -1;
    this.ghostPending = false;
  }

  protected enter(state: RoundState): void {
    this.state = state;
    this.stateTime = 0;

    if (state === 'countdown') {
      this.lastCountdownTick = -1;
      this.lateJoins = 0;
      this.lateJoinAt = -1;
      this.rosterBelowFor = 0;
    }
    if (state === 'gathering') {
      this.gatherPeak = 0;
      this.gatherLastJoin = 0;
    }
    if (state === 'playing') {
      this.capturedThisRound = false;
      this.leadSlot = -1;
      this.leadAt = -Infinity;
      // roundScale lets a marshal shorten every round when the queue backs up.
      this.roundTotal = this.config.roundSeconds * tunables.get('game.roundScale', 1);
      this.timeLeft = this.roundTotal;
      for (const s of this.scores) s.reset(0);
      this.results = [];
      this.onStart(this.playerCount);

      // Ghosts are a solo mechanic — in versus the opponent IS the ghost, and
      // a third translucent body on screen would just be noise.
      this.ghost = null;
      this.ghostRaceLost = false;
      ghosts.cancel();
      if (this.playerCount === 1) {
        this.ghost = ghosts.load(this.config.gameId);
        ghosts.record(this.config.gameId);
      }

      audio.play('go');
      audio.startMusic(126);
      this.juice.flash(this.config.color, 0.3, 5);
    }
    if (state === 'results') {
      this.resultsEmptyTime = 0;
      this.panelStart = -1;
      // Gameplay popups do not belong on the summary. A 67 Speed milestone
      // ("200") was caught floating directly over the final score ("203") —
      // the last rep of a round fires a popup with ~0.9s of life left, and the
      // results screen arrives well inside that. It was always wrong and the
      // new paper knockout made it unmissable.
      this.popups.clear();
      audio.stopMusic();
      this.finaliseResults();
    }
    if (state === 'waiting') {
      this.idleTime = 0;
      this.tracker.reset();
    }
  }

  private finaliseResults(): void {
    this.results = [];
    for (let slot = 0; slot < this.playerCount; slot++) {
      const score = this.scoreFor(slot);
      // Preview only — the real submit happens after initials entry, which is
      // a later milestone. Showing the rank immediately is what creates the
      // "2 off third" retry hook.
      const rank = leaderboard.previewRank(this.config.gameId, score);
      this.results.push({ slot, score, rank });
      this.scores[slot]?.set(score);
    }

    const best = this.results.reduce((a, b) => (b.score > a.score ? b : a), this.results[0]!);

    if (this.playerCount === 1) ghosts.finish(this.scoreFor(0));
    else ghosts.cancel();

    if (best && best.score > 0) {
      this.capturedThisRound = highlights.captureIfWorthy(this.config.gameId, best.score, {
        color: this.config.color,
      });
    }

    // A live bracket owns the result of a versus round.
    //
    // DORMANT AS OF TODAY, and deliberately left wired. `meta/tournament.ts`
    // is a complete, tested single-elimination engine — seeding, byes,
    // propagation, persistence, `drawBracket` — and NOTHING IN THE APP EVER
    // SETS IT RUNNING. There is no menu opt-in and no operator control, so
    // `tournament.active` is false for every round the stall will ever play
    // and this branch cannot be reached.
    //
    // Said out loud here because the alternative is somebody losing an hour to
    // "why does reportCurrent never fire". What is missing is the wiring, not
    // the bracket: a way for a marshal to enter names and start one, and a
    // surface to show it on. PLAN.md §4 wants that surface to be attract,
    // between rounds.
    if (
      this.playerCount === 2 &&
      tournament.active &&
      isTournamentGame(this.config.gameId) &&
      tournament.game === this.config.gameId
    ) {
      // Returns false on a dead heat — the match is NOT advanced and the pair
      // replays. Coin-tossing a tie in front of a crowd is indefensible.
      tournament.reportCurrent(this.scoreFor(0), this.scoreFor(1));
    }

    if (best && best.rank.isRecord && best.score > 0) {
      this.juice.celebrate(COLORS.yellow);
      audio.play('record');
    } else {
      this.juice.impact(0.6, this.config.color);
      // The non-record branch played nothing. That is roughly six rounds in
      // seven landing on a silent screen, for the whole results window, right
      // where the "N OFF THE BOARD" retry hook is supposed to land. Pitched off
      // how well they placed, so a #2 sounds better than a #9 — and `land` is
      // already the app's "that is settled" sound.
      const placed = best?.rank.rank ?? null;
      audio.play('land', placed === null ? 0.82 : 1.15 - Math.min(0.3, (placed - 1) * 0.035));
    }
  }

  /* ---------------- frame ---------------- */

  render(fc: FrameContext): void {
    const { ctx, v } = fc;
    const dt = this.juice.beginFrame(fc.dt);
    this.stateTime += fc.dt;

    this.watchFrameBudget(fc.dt);
    this.ensureProjection(v);
    this.updateTracking(fc);

    clearFrame(ctx, v);
    this.onRenderBackground?.(fc);
    // AFTER the background, BEFORE the playfield. `graphPaper` fills opaque
    // paper, so a ghost drawn earlier would simply be painted over.
    this.drawCameraGhost(fc);

    this.juice.pushTransform(ctx, v);

    // The pre-play screens fade in; see STATE_ENTER_SEC. Set on the context
    // around the whole tick rather than threaded through every draw call.
    const enterT = ramp(this.stateTime, STATE_ENTER_SEC);

    switch (this.state) {
      case 'waiting':
        ctx.save();
        ctx.globalAlpha = enterT;
        this.tickWaiting(fc);
        ctx.restore();
        break;
      case 'gathering':
        ctx.save();
        ctx.globalAlpha = enterT;
        this.onPreTick?.(fc, this.players, dt);
        this.tickGathering(fc);
        ctx.restore();
        break;
      case 'countdown':
        ctx.save();
        ctx.globalAlpha = enterT;
        this.onPreTick?.(fc, this.players, dt);
        this.tickCountdown(fc);
        ctx.restore();
        break;
      case 'playing':
        this.drawGhostPose(fc);
        this.tickPlaying(fc, dt);
        break;
      case 'results':
        this.tickResults(fc);
        break;
    }

    this.particles.update(dt);
    this.popups.update(dt);
    this.particles.draw(ctx);
    this.particles.drawGlow(ctx);
    this.popups.draw(ctx, FONTS.display);

    this.juice.popTransform(ctx);
    this.juice.drawOverlays(ctx, v);
  }

  /**
   * PLAN.md §2: "Frame budget watchdog: auto-drop particle density and effect
   * quality if we miss frame time."
   *
   * TWELVE strikes, not three. A strike is one frame over 22.2ms, and a single
   * slow frame is not a slow machine — a GC pause, a MediaPipe frame landing
   * late, or the first draw of a screen all produce one. Shedding quality on
   * three of them means the effects visibly thin out during ordinary play on a
   * laptop that is coping fine, which reads as the game degrading rather than
   * protecting itself. Good frames pay a strike back each, so a machine that
   * is genuinely struggling accumulates; one that hiccups does not.
   *
   * `fc.dt` and NOT the juiced dt. Hit-stop and slow-mo deliberately return a
   * tiny dt and near-miss slow-mo runs for 0.55s at a time; measuring the
   * watchdog on that would read a celebration as a stall.
   */
  private watchFrameBudget(dt: number): void {
    // Both branches clamp to the operator's cap. Without this, PANIC's quality
    // drop silently decays back to full over ~16s as the watchdog earns credit
    // back — the cap would persist in storage while nothing honoured it.
    const cap = tunables.get('fx.qualityCap', 1);

    if (dt > 1 / 45) {
      this.frameBudgetStrikes++;
      if (this.frameBudgetStrikes > 12) {
        this.particles.quality = Math.min(cap, Math.max(0.25, this.particles.quality - 0.25));
        this.frameBudgetStrikes = 0;
      }
    } else {
      this.frameBudgetStrikes = Math.max(0, this.frameBudgetStrikes - 1);
      if (this.frameBudgetStrikes === 0 && this.particles.quality < cap) {
        this.particles.quality = Math.min(cap, this.particles.quality + 0.0008);
      }
    }
    if (this.particles.quality > cap) this.particles.quality = cap;

    // How the frame-budget watchdog throttles highlight capture.
    highlights.setQuality(this.particles.quality);
  }

  private ensureProjection(v: FrameContext['v']): void {
    const cam = camera.getState();
    if (!this.proj) {
      this.proj = new Projection(v, {
        cameraWidth: cam.width || 1280,
        cameraHeight: cam.height || 720,
        fit: 'cover',
        mirrored: true,
      });
    } else {
      this.proj.update(v, {
        cameraWidth: cam.width || 1280,
        cameraHeight: cam.height || 720,
      });
    }
  }

  private updateTracking(fc: FrameContext): void {
    // STALE VISION MEANS NOBODY, NOT "THE LAST PERSON, FOREVER".
    //
    // `players` is only refreshed on a NEW frameId, so if the worker dies or
    // wedges it simply stops being updated — and a non-empty `players` array
    // then persists indefinitely. The consequences are all silent: a round
    // plays itself out against a frozen skeleton, and `tickWaiting` sees a
    // phantom that never leaves, so the idle timeout never fires and the kiosk
    // never returns to attract. At a stall that is a screen stuck on one dead
    // frame until somebody notices and reloads it.
    //
    // The worker's `onerror` only emits a stat, so nothing else catches this.
    if (fc.vision && fc.now - fc.vision.captureTime > VISION_STALE_MS) {
      if (this.players.length > 0) this.players = [];
      return;
    }

    if (!fc.vision || fc.vision.frameId === this.lastFrameId) return;
    this.lastFrameId = fc.vision.frameId;

    // Landmark space is anisotropic (x normalised by width, y by height), so
    // the tracker needs the real aspect to measure bodies correctly.
    const cam = camera.getState();
    this.tracker.setOptions({
      ...(cam.width > 0 && cam.height > 0 ? { aspect: cam.width / cam.height } : {}),
      // Live, so a marshal can tune crowd rejection in the actual room rather
      // than guessing it here. See the notes on both keys.
      minArea: tunables.get('tracker.minArea', 0.02),
      minRelativeSize: tunables.get('tracker.minRelativeSize', 0.5),
      // The back line of the play area, and how still somebody has to go before
      // they count as a player rather than a passer-by. Both are things you can
      // only really set once you can see the room.
      minUnit: tunables.get('tracker.minUnit', DEFAULT_TRACKER_OPTIONS.minUnit),
      // YOUR HALF OF THE SCREEN IS YOURS FOR THE WHOLE TURN.
      //
      // Every versus game indexes its points by slot, and slot is screen
      // order, so two people who walk around each other mid-round have their
      // SCORES swapped along with their slots — silently, in the middle of a
      // head-to-head. Ordering is still free to settle right up to GO; after
      // that it is frozen. See `lockSlots` in core/tracker.ts.
      lockSlots: this.state === 'playing',
      admitSpeedTorsos: tunables.get(
        'tracker.admitSpeedTorsos',
        DEFAULT_TRACKER_OPTIONS.admitSpeedTorsos
      ),
    });
    this.players = this.tracker.update(fc.vision.poses, fc.time);
  }

  /* ---------------- states ---------------- */

  /** How many of the people in frame this game will actually play with. */
  private resolvePlayerCount(present: number): number {
    return rosterSize(present, this.config, this.playMode);
  }

  private tickWaiting(fc: FrameContext): void {
    const { ctx, v } = fc;
    const present = this.players.length;

    if (present > 0) {
      this.idleTime = 0;
      this.playerCount = this.resolvePlayerCount(present);
      // Party games hold a lobby so the rest of the group can get in frame.
      this.enter((this.config.gatherSeconds ?? 0) > 0 ? 'gathering' : 'countdown');
      return;
    }

    this.idleTime += fc.dt;
    if (this.idleTime > tunables.get('game.idleTimeoutSec', IDLE_TIMEOUT_SEC)) this.onExit?.('attract');

    const pulse = 0.6 + idlePulse(fc.time, 2.4, 1) * 0.4;
    drawText(ctx, this.config.title, v.width / 2, v.height * 0.4, {
      size: vh(v, 9),
      color: this.config.color,
      shadow: vh(v, SHADOW.lifted),
            letterSpacing: '0.03em',
    });
    // "STEP INTO THE FRAME" is singular, and it was the only invitation six
    // two-player games ever issued. Naming the capacity here is free — it
    // replaces words rather than adding a line — and it is the first surface a
    // pair standing in the queue actually reads.
    const invite =
      this.config.maxPlayers > 2
        ? `<STEP IN — UP TO ${this.config.maxPlayers} PLAYERS>`
        : this.config.supportsVersus
          ? '<STEP IN — 1 OR 2 PLAYERS>'
          : '<STEP INTO THE FRAME>';
    drawText(ctx, invite, v.width / 2, v.height * 0.56, {
      size: vh(v, 3.4),
      color: COLORS.text,
      alpha: pulse,
      font: FONTS.body,
      weight: 600,
      letterSpacing: '0.18em',
    });
    // FITTED, because the fair's television is not this developer's monitor.
    // MEASURED across the plausible hardware: every tagline clears 16:9 with
    // room, but on a 4:3 or 5:4 projector — the thing a club fair actually
    // gets handed — Red Light's runs to 88% of the width and Pose Match's and
    // Rhythm's to ~75%. `fitText` is a no-op until it isn't.
    drawText(ctx, this.config.tagline, v.width / 2, v.height * 0.66, {
      size: fitText(ctx, this.config.tagline, v.width - vh(v, 8), vh(v, 2.2), 400, FONTS.body),
      // Sits over the pre-round camera ghost at its strongest.
      knockout: true,
      color: COLORS.ink,
      font: FONTS.body,
      weight: 400,
    });
  }

  /**
   * The lobby. Counts people in, and starts when the timer runs out or the
   * game is full.
   *
   * Deliberately shows the joining count as the headline: it tells the people
   * already in frame that more are welcome, and it tells the queue that this
   * is the game you play WITH people, which is the whole pitch.
   */
  private tickGathering(fc: FrameContext): void {
    const { ctx, v } = fc;
    const present = this.players.length;
    const total = this.config.gatherSeconds ?? 0;

    if (present === 0) {
      this.enter('waiting');
      return;
    }

    this.playerCount = this.resolvePlayerCount(present);

    const elapsed = this.stateTime;
    const full = present >= this.config.maxPlayers;

    // Every arrival reopens the window. Only counts people JOINING — someone
    // stepping out of frame must not shorten the wait for everyone still in it.
    if (present > this.gatherPeak) {
      this.gatherPeak = present;
      this.gatherLastJoin = elapsed;
    }

    // The earlier of "nobody has joined for a while" and the hard ceiling.
    const deadline = Math.min(total, this.gatherLastJoin + GATHER_STABLE_SEC);

    // A full lobby still gets a moment to settle, so the last person to step in
    // isn't mid-stride when the countdown starts.
    if (elapsed >= deadline || (full && elapsed >= GATHER_SETTLE_SEC)) {
      this.enter('countdown');
      return;
    }

    const remain = Math.max(0, deadline - elapsed);
    const pulse = 0.65 + idlePulse(fc.time, 3, 1) * 0.35;

    drawText(ctx, String(present), v.width / 2, v.height * 0.33, {
      size: vh(v, 16),
      color: this.config.color,
          });
    drawText(
      ctx,
      present === 1 ? 'PLAYER READY' : 'PLAYERS READY',
      v.width / 2,
      v.height * 0.47,
      {
        size: vh(v, 3),
        color: COLORS.text,
        font: FONTS.body,
        weight: 700,
        letterSpacing: '0.2em',
      }
    );
    drawText(ctx, `STEP IN — UP TO ${this.config.maxPlayers} CAN PLAY`, v.width / 2, v.height * 0.56, {
      size: vh(v, 2.4),
      color: COLORS.ink,
      font: FONTS.body,
      weight: 500,
      alpha: pulse,
    });

    progressBar(
      ctx, v.width * 0.25, v.height * 0.66, v.width * 0.5, vh(v, 1.2),
      1 - remain / Math.max(0.001, deadline), this.config.color, 14
    );
    drawText(ctx, `<STARTING IN ${Math.ceil(remain)}>`, v.width / 2, v.height * 0.73, {
      size: vh(v, 2.2),
      color: COLORS.ink,
      font: FONTS.mono,
      weight: 600,
      letterSpacing: '0.1em',
    });
  }

  private tickCountdown(fc: FrameContext): void {
    const { ctx, v } = fc;

    if (this.players.length === 0) {
      this.enter('waiting');
      return;
    }

    // WHO IS ACTUALLY GOING TO PLAY — decided here, every frame, not on the
    // frame the first body happened to be confirmed. See `LATE_JOIN_FLOOR_SEC`.
    //
    // Both directions matter. Upward is the friend arriving. Downward is the
    // friend changing their mind and stepping back out, and without it a
    // versus round starts against an empty half of the screen — the split
    // divider, a second HUD and a second score that nobody is attached to.
    // Only the upward case touches the clock; a departure must never be able
    // to extend the wait for the person still standing there.
    const roster = countdownRoster(
      this.resolvePlayerCount(this.players.length),
      {
        playerCount: this.playerCount,
        lateJoins: this.lateJoins,
        stateTime: this.stateTime,
        belowFor: this.rosterBelowFor,
      },
      fc.dt
    );
    this.playerCount = roster.playerCount;
    this.lateJoins = roster.lateJoins;
    this.stateTime = roster.stateTime;
    this.rosterBelowFor = roster.belowFor;
    if (roster.arrived) {
      this.lateJoinAt = fc.time;
      // Rewinding can put the numeral back UP (…2, someone joins, 2 again).
      // Clearing the latch lets that digit re-announce itself instead of
      // silently repeating, which is the audible half of the acknowledgement.
      this.lastCountdownTick = -1;
      audio.play('select', 1.35);
      this.juice.shake(0.16);
    }

    const remaining = COUNTDOWN_SEC - this.stateTime;
    if (remaining <= 0) {
      this.enter('playing');
      return;
    }

    const n = Math.ceil(remaining - 0.2);
    if (n !== this.lastCountdownTick && n > 0) {
      this.lastCountdownTick = n;
      audio.play('tick', 1 + (3 - n) * 0.15);
      this.juice.shake(0.08);
    }

    // POP IN BIG, SETTLE TO FULL SIZE — and hold there.
    //
    // This did the exact opposite of what its own comment claimed. `frac` is
    // just elapsed time within the current digit's one-second window, so the
    // old `ctx.scale(2 - scale, ...)` put the digit at 1.0x for the single
    // frame it appeared, shrank it to 0.6x over the next third of a second,
    // and held it at 0.6x for the remaining two thirds. The largest, most
    // important element in the app — the thing the whole room reads from 3m —
    // spent most of its life at 12vh instead of the 20vh it asks for, and the
    // motion read as a retreat rather than a landing.
    const frac = 1 - ((remaining - 0.2) % 1);
    // `dur` collapses the pop to zero under reduced motion, which leaves the
    // digit at a steady full size — exactly what that setting asks for.
    const popSec = dur(0.333);
    const scale = 1 + 0.4 * (1 - EASE.out(popSec <= 0 ? 1 : Math.min(1, frac / popSec)));

    ctx.save();
    ctx.translate(v.width / 2, v.height * 0.45);
    ctx.scale(scale, scale);
    drawText(ctx, n > 0 ? String(n) : 'GO', 0, 0, {
      size: vh(v, 20),
      color: this.config.color,
      shadow: vh(v, SHADOW.lifted),
          });
    ctx.restore();

    drawText(ctx, this.config.tagline, v.width / 2, v.height * 0.74, {
      size: fitText(ctx, this.config.tagline, v.width - vh(v, 8), vh(v, 3), 600, FONTS.body),
      // Sits over the pre-round camera ghost at its strongest.
      knockout: true,
      color: COLORS.text,
      font: FONTS.body,
      weight: 600,
    });

    // THE INVITATION, AND THE ACKNOWLEDGEMENT OF IT BEING TAKEN.
    //
    // Nothing anywhere in the app told a passer-by that six of these games
    // hold two people. The menu tiles don't say it, the taglines don't say it,
    // and the waiting screen says "STEP INTO THE FRAME" — singular. So the
    // most-requested feature on the roster was also the least discoverable
    // one, and the fix is not a new screen: it is one line on the screen the
    // player is already standing still and reading.
    //
    // It only appears while there is still time to act on it — an invitation
    // shown at "1" is a taunt — and it is worded as a THING TO DO, because a
    // player reads about four words off a TV mid-queue.
    // A PILL, NOT A GREY LINE. First pass drew this as muted text and it was
    // invisible on the TV — `COLORS.muted` is the kit's DISABLED colour, which
    // at 3 metres is the same as absent (see the guard in brand.test.ts). The
    // yellow action badge is the shape this app already uses for "do this now"
    // ("BE THE FIRST!", "NEW BEST!"), so it costs a passer-by nothing to
    // learn and it survives being read past a moving arm.
    if (this.config.supportsVersus && this.playerCount === 1 && remaining > INVITE_UNTIL_SEC) {
      labelPill(ctx, v, v.width / 2, v.height * 0.2, 'A FRIEND CAN STEP IN', vh(v, 5.2), {
        size: vh(v, 2.6),
        fill: COLORS.yellow,
        color: COLORS.ink,
        outline: COLORS.ink,
        outlineWidth: vh(v, STROKE.base),
        shadow: vh(v, SHADOW.base),
        // Static tilt, like every other action badge in the kit. It sits
        // directly above the countdown numeral — the largest, most urgent
        // thing on the roster — and a badge that also moved would be two
        // things competing for the same second of attention.
        tilt: -4,
      });
    }

    // THE GOTCHA, UNDER THE TAGLINE. See `GameConfig.avoid`.
    //
    // RED, and a pill rather than a line. Red is already this app's colour for
    // the thing that costs you — OUT, NOT YET, the bombs — so a passer-by has
    // learned it before they reach this screen. The pill is the same object as
    // the yellow action badge above; they read as a matched pair, DO THIS and
    // NOT THIS, which is the whole content of a first round.
    //
    // Below the tagline at 0.74 and above nothing, so it cannot collide: the
    // numeral is at 0.45 and the badges are at 0.2.
    if (this.config.avoid) {
      labelPill(ctx, v, v.width / 2, v.height * 0.84, this.config.avoid, vh(v, 5.2), {
        size: vh(v, 2.6),
        fill: COLORS.red,
        color: COLORS.ink,
        outline: COLORS.ink,
        outlineWidth: vh(v, STROKE.base),
        shadow: vh(v, SHADOW.base),
        tilt: 3,
      });
    }

    if (this.playerCount === 2) this.drawStandingMarks(fc);

    if (this.playerCount === 2) {
      // Landing, not blinking. A banner that simply exists on the next frame
      // reads as a render glitch; one that overshoots and settles reads as the
      // machine noticing you. Keyed off the arrival so it only animates when
      // it was actually EARNED — a pair who were both in frame from the start
      // get it steady, because for them it is a label, not an event.
      const since = this.lateJoinAt >= 0 ? fc.time - this.lateJoinAt : Infinity;
      const popSec = dur(0.45);
      const pop =
        popSec > 0 && since < popSec ? 1 + 0.6 * (1 - EASE.out(since / popSec)) : 1;
      ctx.save();
      ctx.translate(v.width / 2, v.height * 0.2);
      ctx.scale(pop, pop);
      drawText(ctx, '<VERSUS>', 0, 0, {
        size: vh(v, 4),
        color: COLORS.ink,
        shadow: vh(v, SHADOW.base),
        shadowColor: COLORS.yellow,
        letterSpacing: '0.3em',
      });
      ctx.restore();
    }
  }

  /**
   * WHICH HALF IS MINE?
   *
   * Reported from an outside playtest: in a two-player game people "stand in
   * the middle and swap tracks". Nothing on the countdown ever said where to
   * stand. The screen showed VERSUS, a numeral and a tagline, all centred, and
   * then the round started and two players discovered they were sharing a
   * slot — or worse, crossed over mid-round and swapped scores.
   *
   * Two things fix it, and both are one draw call:
   *
   *   THE DIVIDER, four seconds early. Every versus game already draws one
   *   during play; drawing it during the countdown turns an abstract "versus"
   *   into a visible line on the floor of the screen.
   *
   *   A PLATE PER HALF, in that slot's identity colour — the same colour the
   *   half's HUD and score will be in ten seconds' time, so the association is
   *   made before it has to be read under pressure.
   *
   * The display is mirrored, so screen-left is the player's own left as they
   * face it. That is what a mirror does and what anybody standing in front of
   * one expects, so nothing needs to explain it.
   *
   * Placed at 0.62H: below the numeral, above the tagline, and low enough on
   * the screen to read as floor markings rather than as headings.
   */
  private drawStandingMarks(fc: FrameContext): void {
    const { ctx, v } = fc;
    if (this.config.partyMode || !this.config.supportsVersus) return;

    const y = v.height * 0.62;
    const h = vh(v, 6.4);

    // INK, AND ONLY BETWEEN THE TWO PLATES.
    //
    // First pass drew this in `grid` and ran it from under the numeral to the
    // bottom of the screen. Wrong on both counts: `grid` is the token for
    // structure you read PAST, and here the line is the entire message, so at
    // 3m it simply was not there. And a full-height rule crosses the numeral,
    // which is the one thing on this screen that must not be competed with.
    //
    // A short ink line spanning exactly the plates' band reads as the boundary
    // between two places to stand, which is what it is.
    const top = v.height * 0.56;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(
      v.width / 2 - vh(v, STROKE.base) / 2,
      top,
      vh(v, STROKE.base),
      // Stops at the plates' bottom edge. Running it further put it straight
      // through ONE EACH SIDE, which is centred on the same axis.
      v.height * 0.66 - top
    );
    ctx.restore();

    for (let slot = 0; slot < 2; slot++) {
      const rect = this.slotRect(v, slot);
      const color = PLAYER_COLORS[slot] ?? COLORS.blue;
      // Ink on a flat identity colour. `PLAYER_COLORS[0]` is yellow, which is
      // 1.7:1 as TEXT on paper — as a SURFACE with ink on top it is exactly
      // what the kit asks for, and it is how the seat badge reads during play.
      labelPill(ctx, v, rect.centerX, y, `PLAYER ${slot + 1}`, h, {
        size: vh(v, 2.8),
        fill: color,
        color: COLORS.ink,
        outline: COLORS.ink,
        outlineWidth: vh(v, STROKE.base),
        shadow: vh(v, SHADOW.base),
      });
    }

    drawText(ctx, 'ONE EACH SIDE', v.width / 2, y + vh(v, 6.2), {
      size: vh(v, 2),
      // Runner is playable during its own countdown, so this line lands on a
      // live 3D track rather than on paper. Free everywhere else.
      knockout: true,
      color: COLORS.ink,
      font: FONTS.body,
      weight: 600,
      letterSpacing: '0.24em',
    });
  }

  private tickPlaying(fc: FrameContext, dt: number): void {
    this.timeLeft -= dt;

    // End when the clock runs out, or when the player leaves for long enough
    // that they're clearly gone rather than briefly occluded.
    if (this.players.length === 0) {
      this.lostTime += fc.dt;
      if (this.lostTime > PLAYER_LOST_GRACE_SEC) {
        this.enter('results');
        return;
      }
    } else {
      this.lostTime = 0;
    }

    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.enter('results');
      return;
    }

    // Music intensity tracks the clock so the round builds toward its end.
    const progress = 1 - this.timeLeft / this.roundTotal;
    audio.setMusicIntensity(progress);

    if (this.playerCount === 1) {
      ghosts.sample(
        this.roundTotal - this.timeLeft,
        this.scoreFor(0),
        this.players[0]?.landmarks ?? null
      );
    }

    this.onTick(fc, this.players, dt);
    this.watchLead(fc);
    this.onRender(fc, this.players);

    for (const s of this.scores) s.update(fc.dt);
    this.drawHud(fc);
  }

  /**
   * THE OVERTAKE IS THE BEST MOMENT IN A VERSUS ROUND, AND IT PASSED IN SILENCE.
   *
   * PLAN.md's brief for this project is tactility, feedback and addictiveness,
   * and a head-to-head has exactly one moment that delivers all three for free:
   * the instant the person who was losing goes ahead. Until now the only sign
   * of it was a 2.2vh line under each score flipping between "DOWN BY 3" and
   * "LEADING BY 1" — information, correctly placed, and completely silent. The
   * crowd standing behind two friends could not tell it had happened.
   *
   * A TIE KEEPS THE INCUMBENT. Scores cross through equality, so treating a
   * draw as "nobody leads" would fire twice on every overtake — once into the
   * tie and once out of it — and in a game where both players score on the
   * same beat it would fire continuously. The lead only changes hands when
   * somebody is strictly ahead of the person who was.
   *
   * And a debounce on top, because two players a point apart trading the lead
   * every half second is a see-saw, not a drama; announcing all of it is how a
   * celebration becomes wallpaper.
   */
  private watchLead(fc: FrameContext): void {
    if (this.playerCount !== 2 || this.config.partyMode) return;

    const lead = leadChange(
      this.scoreFor(0),
      this.scoreFor(1),
      { leadSlot: this.leadSlot, leadAt: this.leadAt },
      this.stateTime
    );
    const next = lead.leadSlot;
    this.leadSlot = next;
    this.leadAt = lead.leadAt;
    if (!lead.announce) return;

    const rect = this.slotRect(fc.v, next);
    const color = PLAYER_COLORS[next] ?? COLORS.yellow;
    this.popups.spawn(
      `<PLAYER ${next + 1} AHEAD>`,
      rect.centerX,
      fc.v.height * 0.3,
      COLORS.ink,
      vh(fc.v, 3.6)
    );
    this.juice.flash(color, 0.12, 8);
    this.juice.shake(0.06);
    audio.play('select', 1.5);
  }

  /**
   * The previous best run, replayed translucent behind the live player.
   * Drawn before onRender so it can never occlude the thing being played.
   */
  private drawGhostPose(fc: FrameContext): void {
    if (!this.ghost || !this.proj) return;
    if (this.config.ghostSilhouette === false) return;
    const pose = this.ghost.poseAt(this.roundTotal - this.timeLeft);
    if (pose) drawGhost(fc.ctx, this.proj, pose, { color: COLORS.muted });
  }

  private tickResults(fc: FrameContext): void {
    const { ctx, v } = fc;
    for (const s of this.scores) s.update(fc.dt);

    // Instant replay, if this run earned one.
    //
    // THE REPLAY LIVES INSIDE THE RESULTS WINDOW — it never extends it.
    //
    // The first version returned early while the replay was playing, which put
    // the round-advance check behind it. `play()` defaults to two loops of an
    // ~8s clip, so a good run held the results screen for ~16s instead of 7 and
    // the turn simply never ended. Measured: still on 'results' after 7.5s of
    // extra ticking, replay still going.
    //
    // At a stall that is not a cosmetic bug. Every second here is a second the
    // queue is not moving, and the whole reason RESULTS_SEC exists is that the
    // turn length has to be predictable.
    //
    // One loop, and the advance check below runs unconditionally.
    const t = ramp(this.stateTime, 0.5);
    const versus = this.playerCount === 2 && !this.config.partyMode;

    // BACKDROP FIRST, THEN THE REPLAY ON TOP OF IT.
    //
    // These were the other way round: the replay was rendered and then this
    // full-screen paper rect was painted straight over it, reaching full alpha
    // at 0.5s. So a replay was visible for half a second and then erased — and
    // because `showedReplay` also suppresses the results panel, what remained
    // for the rest of the clip was a blank sheet of paper. The one reward in
    // the app for a top-five run showed nothing at all.
    ctx.save();
    // Opaque paper, faded in by alpha on the whole layer rather than a
    // see-through fill — DESIGN.md forbids transparent colour.
    ctx.globalAlpha = t;
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, v.width, v.height);
    ctx.globalAlpha = 1;
    ctx.restore();

    // ONLY THIS GAME'S OWN, FRESHLY CAPTURED CLIP.
    //
    // `hasClip()` alone was the entire gate: no freshness check and no game
    // check, while `discard()` had zero call sites anywhere in the tree and
    // `stop()` only clears the playing flag. So the first clip captured on the
    // day — boards start empty on the 24th, so that happens within a few plays
    // — was replayed on EVERY later results screen that did not itself
    // capture. A Fruit Ninja run stamped "285" over a Red Light player's
    // results.
    //
    // Not a cosmetic mix-up either: a default clip is 8s and RESULTS_SEC is 7,
    // so it covers the whole window, and `showedReplay` suppresses the score,
    // the rank and the near-miss line — the retry hook PLAN.md §4 is built on.
    const meta = highlights.clipMeta();
    const ownFreshClip =
      !!meta && meta.gameId === this.config.gameId && this.capturedThisRound;

    const replaying =
      highlights.isPlaying ||
      (this.stateTime < 0.2 && ownFreshClip && highlights.play(fc.now, 1));
    const showedReplay = replaying && highlights.render(fc);

    if (!showedReplay) {
      // Fade keyed to when the PANEL starts, not when results did. After a
      // replay finishes mid-window `stateTime` is already well past 0.5, so the
      // panel would otherwise snap in at full opacity with no entrance at all.
      if (this.panelStart < 0) this.panelStart = this.stateTime;
      const pt = ramp(this.stateTime - this.panelStart, 0.5);
      if (this.config.partyMode && this.playerCount > 1) this.drawPartyResults(fc, pt);
      else if (versus) this.drawVersusResults(fc, pt);
      else this.drawSoloResults(fc, pt);
    }

    // Nobody left to read it? Then stop holding the screen.
    this.resultsEmptyTime = this.players.length === 0 ? this.resultsEmptyTime + fc.dt : 0;
    const abandoned =
      this.stateTime >= RESULTS_ABANDONED_SEC && this.resultsEmptyTime >= RESULTS_EMPTY_GRACE_SEC;

    // Unconditional. Nothing drawn above may hold the queue up.
    if (this.stateTime > RESULTS_SEC || abandoned) {
      highlights.stop();
      this.finishRound();
    } else if (!showedReplay) {
      // AN INSTRUCTION, NOT A CLOCK.
      //
      // "NEXT PLAYER IN 5" states a fact about the software. What the stall
      // needs is for the person who just finished to physically move, and a
      // player who has just seen their score is looking at their score, not
      // working out that a countdown is addressed to them. Reported from a
      // playtest as wanting an explicit "step out for the next player".
      //
      // Both halves on one line, in the place the line already occupied: the
      // instruction first because it is the part that has to be acted on, the
      // number after it because it is the part that says how urgently.
      const remain = Math.ceil(RESULTS_SEC - this.stateTime);
      drawText(ctx, `STEP OUT — NEXT PLAYER IN ${remain}`, v.width / 2, v.height * 0.93, {
        size: vh(v, 2),
        color: COLORS.ink,
        font: FONTS.mono,
        weight: 500,
        letterSpacing: '0.1em',
      });
    }
  }

  /**
   * End of the results screen. A score worth putting on the board goes to
   * initials entry; anything else loops straight back to waiting so the queue
   * never stalls behind a prompt nobody wants to answer.
   */
  private finishRound(): void {
    // In versus only the winner goes on the board. Two initials entries per
    // turn would double the slowest part of the flow, and the loser already
    // got the thing that mattered — losing in front of their friend.
    const best = this.results.reduce(
      (a, b) => (b.score > a.score ? b : a),
      this.results[0] ?? { slot: 0, score: 0, rank: null as never }
    );

    // A zero means they walked off or never engaged. Never make the next player
    // in the queue wait behind an entry prompt nobody wants to answer.
    if (best.score > 0 && router.has('initials')) {
      setPendingScore({
        gameId: this.config.gameId,
        score: best.score,
        next: router.firstAvailable('menu', 'attract') ?? this.config.gameId,
        // Versus only. A solo round has nobody to disambiguate from, and
        // "PLAYER 1 WINS" over a game one person played is nonsense.
        ...(this.playerCount > 1 && !this.config.partyMode ? { slot: best.slot } : {}),
      });
      this.onExit?.('initials');
      return;
    }

    const next = router.firstAvailable('attract');
    if (next) this.onExit?.(next);
    else this.enter('waiting');
  }

  private drawSoloResults(fc: FrameContext, t: number): void {
    const { ctx, v } = fc;
    const r = this.results[0];
    if (!r) return;

    const pop = EASE.back(ramp(this.stateTime, 0.6));

    drawText(ctx, this.primaryLabel(), v.width / 2, v.height * 0.26, {
      size: vh(v, 2.6),
      color: COLORS.ink,
      font: FONTS.body,
      weight: 600,
      letterSpacing: '0.24em',
      alpha: t,
    });

    ctx.save();
    ctx.translate(v.width / 2, v.height * 0.42);
    ctx.scale(pop, pop);
    drawText(ctx, String(this.scores[0]?.value ?? r.score), 0, 0, {
      size: vh(v, 18),
      color: this.config.color,
      shadow: vh(v, SHADOW.lifted),
          });
    ctx.restore();

    if (this.stateTime > 0.8) {
      this.drawRankLine(fc, r.rank, v.height * 0.62);
    }
  }

  private drawVersusResults(fc: FrameContext, t: number): void {
    const { ctx, v } = fc;
    const a = this.results[0];
    const b = this.results[1];
    if (!a || !b) return;

    const winner = a.score === b.score ? -1 : a.score > b.score ? 0 : 1;
    const pop = EASE.back(ramp(this.stateTime, 0.6));

    for (let slot = 0; slot < 2; slot++) {
      const res = slot === 0 ? a : b;
      const cx = slot === 0 ? v.width * 0.27 : v.width * 0.73;
      const color = PLAYER_COLORS[slot]!;
      const won = winner === slot;

      drawText(ctx, `PLAYER ${slot + 1}`, cx, v.height * 0.26, {
        size: vh(v, 2.4),
        font: FONTS.body,
        weight: 600,
        letterSpacing: '0.2em',
        alpha: t,
        ...(won
          ? this.playerTextStyle(color, vh(v, SHADOW.base))
          : { color: COLORS.ink }),
      });

      ctx.save();
      ctx.translate(cx, v.height * 0.42);
      const s = won ? pop : pop * 0.82;
      ctx.scale(s, s);
      drawText(ctx, String(this.scores[slot]?.value ?? res.score), 0, 0, {
        size: vh(v, 14),
        color: won ? color : COLORS.ink,
        shadow: won ? vh(v, SHADOW.lifted) : 0,
              });
      ctx.restore();

      if (won && this.stateTime > 0.7) {
        drawText(ctx, '<WINNER>', cx, v.height * 0.58, {
          size: vh(v, 3.6),
          color: COLORS.ink,
          shadow: vh(v, SHADOW.base),
          shadowColor: COLORS.yellow,
          letterSpacing: '0.2em',
        });
      }
    }

    if (winner === -1 && this.stateTime > 0.7) {
      drawText(ctx, '<DEAD HEAT>', v.width / 2, v.height * 0.58, {
        size: vh(v, 3.6),
        color: COLORS.ink,
        shadow: vh(v, SHADOW.base),
        shadowColor: COLORS.yellow,
        letterSpacing: '0.2em',
      });
    }

    ctx.save();
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(v.width / 2, v.height * 0.2);
    ctx.lineTo(v.width / 2, v.height * 0.66);
    ctx.stroke();
    ctx.restore();

    const best = winner === 1 ? b : a;
    if (this.stateTime > 1) this.drawRankLine(fc, best.rank, v.height * 0.74);
  }

  /**
   * SIX PLAYERS, SIX ROWS.
   *
   * The results screen had exactly two renderers: one score (solo) and two
   * scores (versus). Red Light is the only party game on the roster and it
   * seats six, so it fell to the SOLO branch — `results[0]`, one number, for a
   * round six people just played. Fixing `scoreFor` to return a real score per
   * lane (see `laneScore`) produced six distinct numbers that nothing on
   * screen ever showed.
   *
   * And the results screen is where a party game pays off. The whole pitch is
   * "last one standing"; the moment that lands is the standings.
   *
   * Sorted by score, not by lane. A leaderboard sorted by seating order is a
   * seating chart. `PLAYER n` is the LANE number so a racer can find
   * themselves — it is what the lane marker showed them all round — while the
   * rank badge carries the placing, so the two never get confused.
   */
  private drawPartyResults(fc: FrameContext, t: number): void {
    const { ctx, v } = fc;
    if (this.results.length === 0) return;

    const board = [...this.results].sort((a, b) => b.score - a.score);
    const pop = EASE.back(ramp(this.stateTime, 0.6));

    drawText(ctx, '<FINAL STANDINGS>', v.width / 2, v.height * 0.17, {
      size: vh(v, 3.4),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: '0.2em',
      alpha: t,
    });

    // Sized from the ROW COUNT, so two racers get big readable rows and six
    // still fit above the "NEXT PLAYER IN" line at 0.93.
    const top = v.height * 0.24;
    const bottom = v.height * 0.84;
    const gap = vh(v, 1.4);
    const rowH = Math.min(vh(v, 9), (bottom - top + gap) / board.length - gap);
    const w = Math.min(v.width * 0.56, v.width - vh(v, SPACE.xl) * 2);
    const x = (v.width - w) / 2;

    for (let i = 0; i < board.length; i++) {
      const r = board[i]!;
      const y = top + i * (rowH + gap);
      // Rows land one after another rather than all at once: six rows arriving
      // together is a table, six rows arriving in sequence is a result.
      const enter = ramp(this.stateTime - i * 0.08, 0.35);
      if (enter <= 0) continue;

      ctx.save();
      ctx.globalAlpha = Math.min(1, t) * enter;
      // Only the winner's row is accented. Six accented rows is six winners.
      rankedRow(ctx, v, x, y, w, rowH, {
        rank: i + 1,
        name: `PLAYER ${r.slot + 1}`,
        value: String(this.scores[r.slot]?.value ?? r.score),
        ...(i === 0 ? { accent: PLAYER_COLORS[r.slot] ?? COLORS.yellow } : {}),
      });
      ctx.restore();
    }

    // The winner's tag, on the winner's row, once the row has landed.
    const champ = board[0];
    if (champ && this.stateTime > 0.8) {
      const tie = board.filter((r) => r.score === champ.score).length > 1;
      ctx.save();
      ctx.translate(x + w, top + rowH / 2);
      ctx.scale(pop, pop);
      labelPill(ctx, v, vh(v, 1.2), 0, tie ? 'DEAD HEAT' : 'WINNER', rowH * 0.62, {
        size: rowH * 0.26,
        fill: COLORS.yellow,
        color: COLORS.ink,
        outline: COLORS.ink,
        outlineWidth: vh(v, STROKE.base),
        shadow: vh(v, SHADOW.base),
        align: 'left',
        tilt: -6,
      });
      ctx.restore();
    }
  }

  /**
   * PLAN.md §4: "#4 TODAY — 2 OFF THIRD. That line sells more retries than the
   * score does."
   */
  private drawRankLine(fc: FrameContext, rank: RankResult, y: number): void {
    const { ctx, v } = fc;

    if (rank.isFirst) {
      // Nobody has played this game yet. "NEW RECORD" would be a lie, and
      // "#1 of 1" is joyless — being first is its own thing worth celebrating.
      const pulse = 0.75 + idlePulse(fc.time, 7, 1) * 0.25;
      drawText(ctx, '<FIRST ON THE BOARD>', v.width / 2, y, {
        size: vh(v, 4.6),
        color: COLORS.ink,
        alpha: pulse,
        letterSpacing: '0.04em',
        shadow: vh(v, SHADOW.base),
        shadowColor: COLORS.yellow,
      });
      return;
    }

    if (rank.isRecord) {
      const pulse = 0.75 + idlePulse(fc.time, 7, 1) * 0.25;
      // THE YELLOW RULE: yellow is a surface, never text on paper (1.7:1).
      // Ink letterforms with a yellow hard shadow keep the action colour
      // present without asking anyone to read #FBBC04 from 3m.
      drawText(ctx, '<NEW RECORD>', v.width / 2, y, {
        size: vh(v, 5.5),
        color: COLORS.ink,
        shadow: vh(v, SHADOW.lifted),
        shadowColor: COLORS.yellow,
        alpha: pulse,
        letterSpacing: '0.16em',
      });
      return;
    }

    if (rank.rank === null) {
      // OFF THE BOARD, BUT SAY BY HOW MUCH.
      //
      // This used to print a flat "NOT IN THE TOP 10 — N PLAYED" and return,
      // never looking at `pointsToNext`/`nextRank` — which `previewRank` has
      // already computed and which are non-null precisely here. So a player who
      // missed the board by ONE point and a player who missed it by four
      // hundred got the identical, deflating sentence.
      //
      // That matters more than it looks, because it only starts happening once
      // a board has ten entries — which for the queue eater is most of day one
      // and nearly all of day two. In other words the near-miss line, which
      // PLAN.md §2 stakes the entire design on ("near-misses are the addiction,
      // not wins"), was visible only during each game's first ten plays and
      // then switched itself off for the rest of the event.
      if (rank.pointsToNext !== null) {
        // A gap you could close on the next go is the whole point; say it
        // louder. Mirrors the `close` treatment on the live chase line.
        const near = rank.pointsToNext <= 10;
        drawText(ctx, `${rank.pointsToNext} OFF THE BOARD`, v.width / 2, y, {
          size: vh(v, near ? 5.4 : 4.4),
          color: COLORS.ink,
          shadow: vh(v, SHADOW.base),
          shadowColor: COLORS.yellow,
          letterSpacing: '0.1em',
        });
        drawText(ctx, `${rank.total} PLAYED`, v.width / 2, y + vh(v, 4.4), {
          size: vh(v, 2.2),
          color: COLORS.ink,
          font: FONTS.body,
          weight: 600,
          letterSpacing: '0.1em',
        });
        return;
      }

      drawText(ctx, `NOT IN THE TOP 10 — ${rank.total} PLAYED`, v.width / 2, y, {
        size: vh(v, 2.4),
        color: COLORS.ink,
        font: FONTS.body,
        weight: 600,
        letterSpacing: '0.1em',
      });
      return;
    }

    const ordinal = ['', 'FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH'];
    drawText(ctx, `#${rank.rank}`, v.width / 2, y, {
      size: vh(v, 6),
      color: this.config.color,
          });

    if (rank.pointsToNext !== null && rank.nextRank !== null) {
      drawText(
        ctx,
        `${rank.pointsToNext} OFF ${ordinal[rank.nextRank] ?? `#${rank.nextRank}`}`,
        v.width / 2,
        y + vh(v, 5),
        {
          size: vh(v, 2.8),
          color: COLORS.ink,
          shadow: vh(v, SHADOW.base),
          shadowColor: COLORS.yellow,
          font: FONTS.display,
          weight: 800,
          letterSpacing: '0.12em',
        }
      );
    }
  }

  /* ---------------- HUD ---------------- */

  protected slotRect(v: FrameContext['v'], slot: number): SlotRect {
    if (this.playerCount < 2) {
      return { x: 0, y: 0, width: v.width, height: v.height, centerX: v.width / 2 };
    }

    // Party games share one screen — there are no per-player columns to carve,
    // so every slot gets the full width and the game draws its own lanes.
    //
    // Previously this hardcoded two halves and returned the RIGHT half for every
    // slot >= 1. Invisible today only because Red Light's primaryStat ignores
    // the slot and redraws an identical string on top of itself six times; the
    // moment a 3+ player game drew anything slot-specific it would have stacked
    // unreadable garbage in one spot.
    if (this.config.partyMode) {
      return { x: 0, y: 0, width: v.width, height: v.height, centerX: v.width / 2 };
    }

    const half = v.width / 2;
    const x = slot === 0 ? 0 : half;
    return { x, y: 0, width: half, height: v.height, centerX: x + half / 2 };
  }

  /**
   * A faint, mirrored ghost of the camera feed behind the playfield.
   *
   * REPORTED FROM A REAL SESSION: "it's hard to actually see if you're lining
   * up properly". Rig Check draws the feed, and nothing else did — so once a
   * game starts, the only evidence of where your body is are the few landmarks
   * that game happens to render. Fruit Ninja and Balloon Pop draw hands and
   * nothing else, so a player standing half out of frame has no way to know it
   * until things stop responding. They blame themselves, or the game.
   *
   * WHY THIS DOES NOT BREAK THE BRAND. DESIGN.md forbids see-through BRAND
   * COLOUR — flat fills, no tints. A camera frame is a photograph, not a brand
   * colour, and at these alphas it reads as a grey wash behind paper rather
   * than as colour competing with the playfield. It sits under everything, so
   * no ink, sticker or type is drawn on top of a moving image.
   *
   * Live on `game.cameraGhost` because the right value is a property of the
   * ROOM — a bright hall and a dim one want different numbers, and 0 turns it
   * off entirely if it proves distracting on the night.
   */
  protected drawCameraGhost(fc: FrameContext): void {
    if (this.config.cameraGhost === false) return;
    // `camera.isLive()` is the whole condition. An explicit `isSimEnabled()`
    // check was redundant — sim mode has no camera, so `isLive()` is already
    // false — and it made the ghost impossible to exercise without a webcam.
    if (!this.proj || !camera.isLive()) return;

    // Nothing to see behind an opaque results panel.
    if (this.state === 'results') return;

    const base = tunables.get('game.cameraGhost', 0.16);
    if (base <= 0.001) return;

    const video = camera.getVideo();

    // DRAW A CACHED, DOWNSCALED BITMAP — NEVER THE <video> ELEMENT.
    //
    // MEASURED at 1080p: `drawImage(<video>)` costs ~4ms per call because it
    // re-imports the frame every time, against ~0.39ms for identical pixels
    // from an already-decoded source. Drawn every frame that was ~6ms — the
    // single most expensive draw call in the app, about 35% of a 60fps budget
    // on a fast GPU, and worse on the integrated one a stall laptop will have.
    // Half of those imports were of a frame that had not even changed, since
    // the render loop runs at 60 and the camera at 30.
    //
    // So: re-import only when the camera actually advances, at a fraction of
    // the resolution, asynchronously. A ghost is a positioning aid, not a
    // picture — 480x270 is more than enough to see where your body is, and the
    // softness it brings is closer to what this is meant to look like anyway.
    if (!this.ghostPending && video.currentTime !== this.ghostAt) {
      this.ghostAt = video.currentTime;
      this.ghostPending = true;
      void createImageBitmap(video, {
        resizeWidth: GHOST_W,
        resizeHeight: GHOST_H,
        resizeQuality: 'low',
      })
        .then((bmp) => {
          this.ghostBitmap?.close();
          this.ghostBitmap = bmp;
          this.ghostPending = false;
        })
        .catch(() => {
          // A frame that isn't decodable this tick. Keep the previous bitmap.
          this.ghostPending = false;
        });
    }

    if (!this.ghostBitmap) return;

    // STRONGER BEFORE THE ROUND, FAINTER DURING IT.
    //
    // "Am I lined up?" is a question you ask while stepping up, not while
    // playing — and before the round there is no playfield for the feed to
    // compete with. Once play starts it drops back to a hint.
    //
    // Capped at 0.30, not 0.55. MEASURED over a high-contrast feed: by about
    // 0.30 the image is genuinely readable rather than a wash, and muted small
    // type WITHOUT a knockout — the chase line, the waiting tagline, 67's empty
    // arm dots — stops being legible on top of it. The knockout on the score
    // and label survives well past that, which is exactly why they have one.
    const alpha = this.state === 'playing' ? base : Math.min(0.3, base * 2.4);

    fc.ctx.save();
    fc.ctx.shadowBlur = 0;
    this.proj.drawSource(fc.ctx, this.ghostBitmap, alpha);
    fc.ctx.restore();
  }

  /**
   * Bottom of the HUD band, in logical px. Nothing that rises may start above
   * this. The band is: timer (3vh), clock (7.5), score (16), label (23),
   * chase line (26) — so 30 clears it with a margin.
   */
  protected hudBottom(v: FrameContext['v']): number {
    return vh(v, this.hudMetrics().bottom);
  }

  private hudMetrics(): HudMetrics {
    return this.config.hudShelf ? HUD_SHELF : HUD_FULL;
  }

  /**
   * A player's identity colour, made safe for LETTERFORMS on paper.
   *
   * `PLAYER_COLORS[0]` is yellow, which is 1.7:1 on paper — the brand kit's
   * one hard colour rule, and simply gone at 3m. Every versus game routes its
   * score through here, so in a two-player round player one's score was yellow
   * text on white: the single most important number on their half of the
   * screen, invisible from the queue. The versus results screen had it too, on
   * the WINNER's name specifically, since the loser's is muted.
   *
   * The fix is the brand's own, already used on the record-pace line below:
   * ink letterforms with the identity colour as the hard shadow. Legibility
   * comes from ink, identity survives in the shadow, and nothing turns into a
   * generic black number. Colours that already pass (blue, green, red, ink)
   * are returned untouched with the default ink shadow.
   */
  private playerTextStyle(
    preferred: string,
    shadow: number
  ): { color: string; shadow: number; shadowColor?: string } {
    const safe = textColor(preferred);
    // The shadow is what carries the identity in the fallback case, so it is
    // NOT optional here — `drawText` skips the shadow pass entirely when the
    // offset is absent, which would have left a plain ink number.
    return safe === preferred
      ? { color: safe, shadow }
      : { color: safe, shadow, shadowColor: preferred };
  }

  private drawHud(fc: FrameContext): void {
    const { ctx, v } = fc;
    const m = this.hudMetrics();
    // Keep rising popups out of the HUD. One assignment per frame here beats
    // every game remembering the arithmetic at every spawn site.
    this.popups.floorY = this.hudBottom(v);

    // The shelf, if this game asked for one. Paper plate, then the same grid
    // the background uses clipped into it — so the band reads as the SAME
    // surface as the rest of the screen with the playfield passing behind it,
    // not as a grey box someone dropped on top. Hard ink rule, no blur: the
    // edge is what sells "in front".
    if (this.config.hudShelf) {
      const y = vh(v, m.bottom);
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.rect(0, 0, v.width, y);
      ctx.clip();
      graphPaper(ctx, v);
      ctx.restore();

      ctx.save();
      ctx.shadowBlur = 0;
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(0, y, v.width, Math.max(2, vh(v, STROKE.thick)));
      ctx.restore();
    }

    // Timer across the very top — visible from anywhere in the queue.
    const t = this.timeLeft / this.roundTotal;
    const barH = vh(v, m.barH);
    const urgent = this.timeLeft <= 5;
    progressBar(
      ctx, vh(v, 3), vh(v, m.barY), v.width - vh(v, 6), barH,
      t, urgent ? COLORS.red : this.config.color, urgent ? 22 : 12
    );

    drawText(
      ctx,
      this.timeLeft.toFixed(1),
      m.inlineRow ? vh(v, 3) : v.width / 2,
      vh(v, m.clockY),
      {
        size: vh(v, m.clockSize),
        color: urgent ? COLORS.red : COLORS.ink,
        font: FONTS.mono,
        weight: 700,
        align: m.inlineRow ? 'left' : 'center',
      }
    );

    // Party games have one shared HUD, not one per player.
    const hudSlots = this.config.partyMode ? 1 : this.playerCount;
    for (let slot = 0; slot < hudSlots; slot++) {
      const rect = this.slotRect(v, slot);
      const color = this.playerCount > 1 ? PLAYER_COLORS[slot]! : this.config.color;

      drawText(ctx, this.primaryStat(slot), rect.centerX, vh(v, m.statY), {
        size: vh(v, m.statSize),
        // Balloon Pop's balloons stay poppable above the shoulder line, so they
        // rise straight through this band and cannot be culled. Free on paper.
        knockout: true,
        ...this.playerTextStyle(color, vh(v, SHADOW.base)),
      });
      drawText(ctx, this.primaryLabel(), rect.centerX, vh(v, m.labelY), {
        size: vh(v, m.labelSize),
        knockout: true,
        color: COLORS.ink,
        font: FONTS.body,
        weight: 600,
        letterSpacing: '0.24em',
      });

      this.drawChaseLine(fc, slot, rect);
      this.onRenderHud?.(fc, slot, rect);
    }

    if (this.playerCount === 2) {
      ctx.save();
      if (this.config.fullBleedSlots) {
        // A HARD RULE, NOT A HINT. The dashed grid line below is drawn in
        // `COLORS.grid` at 1.18:1 against paper — deliberately, because for
        // every other versus game the two halves are already separated by
        // their own white space and a loud divider would be the noisiest
        // object on screen. The Runner has no white space: two perspective
        // tracks meet in the middle, and without an ink rule they read as one
        // wide track with a kink in it. Full height, because the tracks go all
        // the way to the top of the frame.
        ctx.fillStyle = COLORS.ink;
        const w = vh(v, STROKE.base);
        ctx.fillRect(v.width / 2 - w / 2, 0, w, v.height);
      } else {
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 2;
        ctx.setLineDash([12, 10]);
        ctx.beginPath();
        ctx.moveTo(v.width / 2, vh(v, this.config.hudShelf ? m.bottom : 10));
        ctx.lineTo(v.width / 2, v.height);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /**
   * The live "what you're chasing" line, shown DURING play.
   *
   * PLAN.md §2: "The score to beat is on screen during play. Near-misses are
   * the addiction, not wins." A rank revealed only at the end tells you how you
   * did; a target visible while you play is what makes someone push in the last
   * five seconds, and what makes them step straight back on afterwards.
   *
   * Every game gets this for free, so none of them has to remember to do it.
   */
  private drawChaseLine(fc: FrameContext, slot: number, rect: SlotRect): void {
    const { ctx, v } = fc;
    const m = this.hudMetrics();
    const chase = (size: number): number => vh(v, size * m.chaseScale);
    // Flush to the slot's right edge in a row layout, centred otherwise.
    const chaseX = m.inlineRow ? rect.x + rect.width - vh(v, 3) : rect.centerX;
    const chaseAlign = m.inlineRow ? ('right' as const) : ('center' as const);
    const score = this.scoreFor(slot);

    if (this.config.partyMode) return;

    // In versus the opponent IS the target — a leaderboard line would just be
    // noise next to the person standing beside you.
    if (this.playerCount === 2) {
      const other = this.scoreFor(slot === 0 ? 1 : 0);
      const diff = score - other;
      if (diff === 0) return;
      drawText(ctx, diff > 0 ? `LEADING BY ${diff}` : `DOWN BY ${-diff}`, chaseX, vh(v, m.chaseY), {
        size: chase(2.2),
        align: chaseAlign,
        knockout: true,
        color: diff > 0 ? COLORS.green : COLORS.red,
        font: FONTS.body,
        weight: 700,
        letterSpacing: '0.1em',
      });
      return;
    }

    // A ghost beats a leaderboard line: "3 AHEAD OF YOUR BEST" is a race you
    // can see, where "12 TO #4" is an abstraction.
    //
    // UNTIL IT DOESN'T. This branch ran unconditionally whenever a ghost had
    // loaded, so a player having an off round against a strong personal best
    // watched "106 BEHIND BEST" in red for a minute while an entirely reachable
    // "1 TO #3" sat uncalled on the leaderboard beside it. A race you have
    // visibly lost is the opposite of a chase line.
    //
    // Once the gap is out of reach the ghost line is retired for the rest of
    // the round and the board takes over.
    if (this.ghost && !this.ghostRaceLost) {
      const target = this.ghost.scoreAt(this.roundTotal - this.timeLeft);
      const diff = score - target;
      const ahead = diff >= 0;

      if (!ahead && -diff > Math.max(8, target * 0.45)) {
        this.ghostRaceLost = true;
      }
    }

    if (this.ghost && !this.ghostRaceLost) {
      const target = this.ghost.scoreAt(this.roundTotal - this.timeLeft);
      const diff = score - target;
      const ahead = diff >= 0;
      drawText(
        ctx,
        ahead ? `${diff} AHEAD OF BEST` : `${-diff} BEHIND BEST`,
        chaseX,
        vh(v, m.chaseY),
        {
          size: chase(2.3),
          align: chaseAlign,
        knockout: true,
          color: ahead ? COLORS.green : COLORS.red,
          font: FONTS.body,
          weight: 700,
          letterSpacing: '0.1em',
        }
      );
      return;
    }

    const preview = leaderboard.previewRank(this.config.gameId, score);

    if (preview.isRecord && score > 0) {
      const pulse = 0.7 + idlePulse(fc.time, 8, 1) * 0.3;
      drawText(ctx, '<RECORD PACE>', chaseX, vh(v, m.chaseY), {
        size: chase(2.4),
        align: chaseAlign,
        knockout: true,
        color: COLORS.ink,
        shadow: vh(v, SHADOW.base),
        shadowColor: COLORS.yellow,
        alpha: pulse,
        letterSpacing: '0.14em',
      });
      return;
    }

    // NOTHING TO CHASE YET. On a virgin board `previewRank` has no next rank to
    // report, and this returned silently — leaving the reserved chase slot
    // empty for exactly the first players of the day, who are the ones with
    // least idea what the game wants from them. Name the prize instead.
    if (preview.pointsToNext === null || preview.nextRank === null) {
      drawText(ctx, '<SET THE FIRST SCORE>', chaseX, vh(v, m.chaseY), {
        size: chase(2.2),
        align: chaseAlign,
        knockout: true,
        color: COLORS.ink,
        font: FONTS.body,
        weight: 700,
        letterSpacing: '0.1em',
      });
      return;
    }

    // Closing in is the moment worth selling — brighten as the gap narrows.
    const close = preview.pointsToNext <= 5;
    drawText(
      ctx,
      `${preview.pointsToNext} TO #${preview.nextRank}`,
      chaseX,
      vh(v, m.chaseY),
      {
        size: chase(close ? 2.6 : 2.2),
        align: chaseAlign,
        knockout: true,
        color: COLORS.ink,
        font: FONTS.body,
        weight: 700,
        letterSpacing: '0.1em',
      }
    );
  }

  /** Small helper subclasses use for "beat this" markers. */
  protected drawTargetMarker(fc: FrameContext, x: number, y: number, label: string): void {
    const { ctx, v } = fc;
    const w = vh(v, 18);
    const h = vh(v, 3.2);
    ctx.save();
    // Sticker, not a tint: hard ink shadow, flat yellow fill, ink outline.
    // Flat yellow can't carry text on paper (too low contrast at 3m), so the
    // yellow is the SURFACE and the label on it is ink.
    ctx.fillStyle = COLORS.ink;
    roundRect(ctx, x - w / 2, y - h / 2 + vh(v, SHADOW.base), w, h, vh(v, 0.8));
    ctx.fill();
    ctx.fillStyle = COLORS.yellow;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, vh(v, 0.8));
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, 0.3);
    ctx.stroke();
    ctx.restore();
    drawText(ctx, label, x, y, {
      size: vh(v, 1.9),
      color: COLORS.ink,
      font: FONTS.display,
      weight: 800,
    });
  }

  protected celebrateAt(x: number, y: number): void {
    BURST.celebrate(this.particles, x, y, [COLORS.blue, COLORS.red, COLORS.yellow, COLORS.green]);
  }
}

export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
}
