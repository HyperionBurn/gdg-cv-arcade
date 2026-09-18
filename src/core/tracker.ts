/**
 * Multi-person identity persistence, and the crowd rejection under it.
 *
 * PLAN.md §2: "MediaPipe's multi-pose output gives you N skeletons per frame
 * with no stable IDs between frames. For any 2P game, player 1 and player 2
 * will swap the moment they cross."
 *
 * MediaPipe hands us an unordered array each frame. Index 0 is not the same
 * human it was last frame. This module:
 *   - matches detections to existing tracks by PREDICTED centroid proximity
 *   - keeps a track alive briefly through occlusion and dropout, and holds its
 *     id and lane in reserve a little longer still
 *   - tracks everyone it can see but ADMITS only people who stopped to play
 *   - computes a per-body scale that holds still when the body does
 *   - runs a dedicated One Euro filter per track
 *
 * THE STALL IS A CORRIDOR. The requirement from the person running it is
 * "ensure passersby don't affect the game", and a club fair is a moving crowd
 * two metres behind the player. Nobody in that crowd may steal the player's
 * identity or lane, be admitted as a player, reorder the slots mid-round, or
 * move `scale.unit` — which is the divisor of every gesture threshold in every
 * game, so moving it moves all of them at once.
 */

import { LandmarkFilter, type FilterPreset } from './filter.ts';
import { POSE_LANDMARK_COUNT, type Landmark, type RawPose } from './types.ts';
import {
  selectCandidates,
  computeScale,
  computeConfidence,
  dist,
  FULL_FRAME_ZONE,
  DEFAULT_MIN_UNIT,
  type BodyScale,
  type Candidate,
  type KeepAnchor,
  type PlayZone,
} from './candidates.ts';

export type { BodyScale } from './candidates.ts';
export type { PlayZone } from './candidates.ts';

export interface TrackedPlayer {
  /** Stable for the lifetime of this human being in frame. */
  id: number;
  /**
   * Screen-ordered slot: 0 is leftmost as the player sees themselves on the TV.
   * This is what 2P split-screen games index by.
   */
  slot: number;
  /** One Euro filtered landmarks. Use these for everything. */
  landmarks: Landmark[];
  /** Unfiltered, for velocity work that needs raw signal (Red Light). */
  raw: Landmark[];
  centroid: { x: number; y: number };
  /** Bounding-box area. Swings with arm spread — see `scale.unit` instead. */
  area: number;
  scale: BodyScale;
  /** Mean visibility of torso landmarks. */
  confidence: number;
  /**
   * Centroid speed over the last ~0.4s, in TORSO UNITS PER SECOND.
   *
   * Body-scale normalised and aspect-correct, so it means the same thing for a
   * child at 2m and an adult at 5m. This is the signal that separates someone
   * walking past from someone standing in front of the camera — see
   * `admitSpeedTorsos` for the distributions.
   */
  speed: number;
  /** Frames this track has existed. */
  age: number;
  /** Consecutive frames without a matching detection. */
  missing: number;
  /** True once the track has been admitted as a player. */
  confirmed: boolean;
}

export interface TrackerOptions {
  /** How many people we care about. 1 for solo, 2 for duels, 6 for Red Light. */
  maxPlayers: number;
  /** Frames a track must survive before it is even eligible. Kills flicker. */
  minAgeToConfirm: number;
  /** Frames a track survives unmatched before deletion. ~0.5s at 30fps. */
  maxMissingFrames: number;
  /**
   * How far a body may move between frames and still be the same person, in
   * TORSO UNITS.
   *
   * WAS 0.25 IN RAW NORMALISED UNITS, WHICH IS NOT A DISTANCE. `dist()` returns
   * fractions of frame HEIGHT, so 0.25 meant 0.25 frame-heights — which is
   * 0.96 torso units for a player at 2.5m but 1.27 at 4m. The radius therefore
   * got LOOSER exactly as people got further away and closer together on
   * screen, which is precisely where identities are confusable.
   *
   * MEASURED — per-frame centroid step of one body, HOSTILE noise, 3m, matched
   * against the PREDICTED position (p99 / max, torso units per frame):
   *
   *   standing still            0.10 / 0.13
   *   lunging +-35cm at 1.2Hz   0.11 / 0.16
   *   jumping 35cm at 2Hz       0.31 / 0.36
   *   dodging +-50cm at 2Hz     0.23 / 0.44
   *
   * 0.6 clears the most violent thing a player can do by 1.4x. It is also
   * tight enough to matter: a stranger walking directly behind a 3m player
   * sits 0.34-0.58 torso units away (MEASURED, walker at 3.5-5m), so under the
   * old radius they were always inside it and under this one they are only
   * inside it while we can still see the player — at which point the player's
   * own detection, 0.02 torso away, wins the greedy match outright.
   */
  matchRadiusTorsos: number;
  /**
   * Extra match radius per frame we have been blind, in torso units.
   *
   * A track we cannot see is a person who could be anywhere, but not really:
   * somebody occluded is standing behind something, not sprinting. 0.12 is the
   * MEASURED median per-frame step of a player actively lunging, so the radius
   * grows at the rate a busy player moves and no faster. Growing it at the
   * worst case instead (0.45) would have the radius swallow the whole frame
   * inside half a second, and handing an identity to the wrong person is worse
   * than issuing a new one.
   */
  matchRadiusBlindTorsos: number;
  /** Hard ceiling on the grown radius, in torso units. */
  matchRadiusMaxTorsos: number;
  /**
   * How different two torso sizes may be and still be one person, as a ratio.
   *
   * Only applied while RE-ACQUIRING (missing > 0), and only when the detection's
   * own scale is `reliable` — because the readings this rejects are exactly the
   * readings a player's own body produces when their hips drop out, and
   * refusing to re-acquire the player is the failure we are trying to prevent.
   *
   * MEASURED: raw unit error against truth under HOSTILE noise is p99 6.8%,
   * max 11.9%. 1.7 is 6x that, so noise cannot trip it, while a body at 5m
   * (unit 0.157) cannot be mistaken for a player at 3m (unit 0.262) — ratio
   * 0.60, just outside 1/1.7.
   */
  matchSizeRatio: number;
  /** Ignore detections smaller than this bbox area — background bystanders. */
  minArea: number;
  /**
   * See SelectOptions.minUnit — the rotation-stable half of the size gate,
   * without which a player turned more than ~80 degrees stops existing.
   */
  minUnit: number;
  /**
   * Mean torso-landmark visibility a detection must reach to count as a person.
   *
   * MediaPipe is asked for up to six poses and will happily return low-quality
   * extras to fill the quota. They arrive as complete skeletons with plausible
   * geometry and poor visibility, so nothing upstream rejects them.
   */
  minConfidence: number;
  /**
   * Two detections whose centroids are closer than this many TORSO UNITS are
   * treated as the same body, and only the larger survives.
   *
   * WHY THIS EXISTS: with `numPoses: 6`, MediaPipe regularly returns several
   * overlapping skeletons for ONE person. Nothing deduplicated them, so Red
   * Light — the only game that asks for six — read a single player as four,
   * gave them four lanes, and eliminated them four times. Reported from the
   * first real-camera session.
   *
   * 0.55 is chosen to separate the two cases with margin rather than to be
   * clever. Duplicate detections of one body sit essentially on top of each
   * other, under ~0.2 torso units apart. Two real people standing side by side
   * are at least a shoulder width apart, which is ~1.0-1.6 torso units. Raising
   * this toward 1.0 starts merging real players standing close together, which
   * is a worse failure than an occasional ghost.
   */
  dedupeTorsos: number;
  /** See SelectOptions.minRelativeSize — bystander rejection, and its limits. */
  minRelativeSize: number;
  /**
   * How long the centroid history used for `speed` spans, in SECONDS, and the
   * shortest span that may be evaluated at all.
   *
   * A TIME window rather than a frame count because the noise in this estimate
   * depends on elapsed time, not sample count: it is a difference of two
   * endpoints divided by the gap between them, so halving the frame rate
   * changes nothing. The inference loop does not hold a steady rate and a
   * frame-count window would silently mean 0.4s on a good laptop and 0.8s on
   * the one that actually turns up.
   *
   * MEASURED — windowed speed in torso units/sec, by window length, HOSTILE:
   *
   *                              0.20s        0.27s        0.40s
   *   standing at 4m   (max)      0.58         0.37         0.25
   *   standing at 5m   (max)      0.59         0.48         0.32
   *   rocking +-8cm    (max)      0.79         0.68         0.60
   *   walking 0.6m/s   (p10)      1.01         1.05         1.08
   *   walking 0.8m/s   (p10)      1.41         1.44         1.47
   *   walking 1.0m/s   (p10)      1.79         1.81         1.85
   *
   * 0.40s is the shortest window where a person standing still and a person
   * dawdling past do not overlap at all. 0.24s is allowed as a minimum span so
   * a player who walks up and stops is admitted 0.16s sooner; the margin there
   * is thinner, which is why admission also requires the speed to STAY low
   * (see `admitStillSec`) rather than dip low once.
   */
  speedWindowSec: number;
  minSpeedSpanSec: number;
  /**
   * Centroid speed, in torso units/sec, below which a body counts as STOPPED.
   *
   * THE POINT OF THE WHOLE EXERCISE. Size-based rejection is a proxy for
   * distance and a weak one: a tall person at 4m subtends the same height as a
   * short person at 3m, so any threshold strict enough to reject the queue also
   * rejects a real player standing a step back. Motion is a different axis
   * entirely and it separates cleanly, because the thing that makes somebody a
   * passer-by is not where they are, it is that they do not stop.
   *
   * From the table on `speedWindowSec`, at a 0.40s window: the worst sample
   * from anyone standing — including a person visibly rocking +-8cm under
   * HOSTILE noise — is 0.60, and the slowest tenth of samples from anyone
   * walking, at a 0.6 m/s dawdle, is 1.08. 0.9 sits between them: 1.5x above
   * everything standing, 1.2x below everything walking. Admission also needs
   * the speed to stay under it for `admitStillSec` CONTINUOUSLY, so a dawdler
   * whose windowed speed dips under 0.9 for a frame gets nothing for it.
   *
   * ADMISSION ONLY. A confirmed player is never un-admitted for moving,
   * because a player mid-game absolutely does exceed this — MEASURED, a player
   * lunging +-35cm reaches 3.57 torso/sec, right in the middle of the walking
   * range (0.8 m/s is 1.57, 2.0 m/s is 3.93). There is no threshold that separates "playing" from "walking past",
   * only one that separates "has stopped" from "has not", and that question is
   * only asked of people who are not playing yet.
   */
  admitSpeedTorsos: number;
  /** How long a body must stay under `admitSpeedTorsos` to be admitted, seconds. */
  admitStillSec: number;
  /**
   * How much NEARER an unadmitted body must be than the weakest admitted one,
   * and for how long, before it takes their place.
   *
   * Without this, whoever stops in front of the camera first owns the only
   * slot a 1P game has until they leave — including a marshal setting up, or
   * somebody who paused to read the sign. With it set too loose, a spectator
   * steals a round in progress.
   *
   * `unit` goes as 1/distance, so 1.25 means "a quarter nearer": at a 3m play
   * spot that is a body at 2.4m, i.e. 60cm IN FRONT of the player, between
   * them and the lens. Nobody reaches that by accident. (attract.ts measured
   * the equivalent on bbox AREA, which goes as 1/distance^2, and landed on
   * 1.25 there; 1.25 on area is 1.12 on unit, so this is the stricter of the
   * two.) 1.0s of it, so leaning through shot does not count.
   */
  takeoverRatio: number;
  takeoverSec: number;
  /**
   * How long a departed player's id and lane are held for them, in seconds,
   * and how near a new body must appear to inherit them, in torso units.
   *
   * `maxMissingFrames` keeps a track alive through half a second of occlusion.
   * That is not enough for the case this is for: somebody walks between the
   * player and the camera, or the player turns far enough that MediaPipe loses
   * them, for a second or more. The track dies, and the player then has to
   * stand still for another 0.44s to be re-admitted — mid-round, with their
   * score on screen, having done nothing wrong.
   *
   * A reservation is just the id, the slot and the size, left where the player
   * was standing. Anyone reappearing there, at the same size, gets it back
   * immediately and skips the stillness gate. A passer-by cannot benefit
   * because a passer-by never had a reservation.
   */
  reclaimSec: number;
  reclaimTorsos: number;
  /**
   * The `scale.unit` stabiliser: median window in frames, maximum change per
   * frame as a fraction, the ratio beyond which a reading is an outlier, and
   * how many outliers in a row before we accept that reality has changed.
   *
   * WHY ANY OF THIS. Every gesture threshold in every game is divided by
   * `scale.unit`, so a bad reading does not break one mechanic, it moves all
   * of them at once — which is exactly what "tracking is a bit wonky" sounds
   * like from in front of the camera. And the readings DO go bad, silently:
   * MediaPipe extrapolates occluded hips rather than omitting them, so a
   * player whose hips are hidden for half a second gets a confident, complete,
   * wrong skeleton.
   *
   * MEASURED — |error| in `scale.unit` against truth, over a 10s HOSTILE run
   * in which the player turns to 70 degrees and loses their hips twice:
   *
   *                  p50      p90      p99      max
   *   raw           2.0%    61.5%    82.9%    84.7%
   *   stabilised    0.7%     1.9%     2.9%     3.6%
   *
   * The rate limit alone is not enough — a wrong reading that PERSISTS drags
   * the held value down 6% a frame until it arrives — which is why the outlier
   * and reliability gates are there to stop it being fed in at all.
   *
   * It must still follow a body that genuinely changes size. MEASURED: a
   * player walking 4.5m -> 2.2m at 1.5 m/s, a 2x change in unit, is tracked
   * with a worst error of 8.1%. Real body size cannot change faster than that:
   * walking straight at the lens at 1.5 m/s from 4m is at most 4.2% per frame,
   * so the 6% limit never binds on anything true.
   */
  unitMedianFrames: number;
  unitRatePerFrame: number;
  unitOutlierRatio: number;
  unitResyncFrames: number;
  /**
   * How far apart two players must be, in torso units, before their slots are
   * allowed to reorder.
   *
   * Slots were re-sorted by centroid x every frame with no memory, so two
   * people standing near each other traded lanes at the noise rate — and in a
   * split-screen game a lane is half the TV. MEASURED: a standing body's
   * centroid moves at most 0.10 torso units per frame under HOSTILE noise at
   * 4m, so 0.5 is 5x the widest jitter, and about 13cm on the floor at 3m.
   * Genuinely walking around each other still reorders; standing next to each
   * other does not.
   */
  slotHysteresisTorsos: number;
  /**
   * How much nearer a challenger must be before `getPrimary()` switches to
   * them. See `takeoverRatio` for where 1.12 comes from: it is attract.ts's
   * MEASURED 1.25x on bounding-box area, converted to torso units.
   */
  primaryTakeover: number;
  /** Where a body must be standing to count as a player. Whole frame by default. */
  zone: PlayZone;
  /** Display is mirrored, so slot ordering has to be flipped to match. */
  mirrored: boolean;
  filterPreset: FilterPreset;
  /**
   * Camera aspect ratio (width / height).
   *
   * MediaPipe normalises x by frame WIDTH and y by frame HEIGHT, so on any
   * non-square frame the landmark space is ANISOTROPIC: 0.1 in x is 1.78x the
   * physical length of 0.1 in y at 16:9. A Euclidean distance computed across
   * both axes in that space is not a distance, and every body measurement here
   * is exactly such a distance.
   *
   * Consequences before this was fixed:
   *   - shoulder width (nearly all horizontal) was under-reported by ~1.78x
   *     relative to torso height (nearly all vertical), so the two were not
   *     comparable even though the code used one as a fallback for the other
   *   - `scale.unit` drifted as a player TURNED, because rotation moves length
   *     between the two axes — and the entire purpose of the unit is to be
   *     invariant to everything except body size
   *
   * Set from `camera.getState()`. 16:9 is the overwhelmingly common webcam
   * default and a safe fallback.
   */
  aspect: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  maxPlayers: 1,
  minAgeToConfirm: 3,
  maxMissingFrames: 15,
  matchRadiusTorsos: 0.6,
  matchRadiusBlindTorsos: 0.12,
  matchRadiusMaxTorsos: 1.8,
  matchSizeRatio: 1.7,
  minArea: 0.02,
  minUnit: DEFAULT_MIN_UNIT,
  minConfidence: 0.45,
  dedupeTorsos: 0.55,
  minRelativeSize: 0.5,
  speedWindowSec: 0.4,
  minSpeedSpanSec: 0.24,
  admitSpeedTorsos: 0.9,
  admitStillSec: 0.2,
  takeoverRatio: 1.25,
  takeoverSec: 1,
  reclaimSec: 1.5,
  reclaimTorsos: 1.2,
  unitMedianFrames: 7,
  unitRatePerFrame: 0.06,
  unitOutlierRatio: 1.6,
  unitResyncFrames: 20,
  slotHysteresisTorsos: 0.5,
  primaryTakeover: 1.12,
  zone: FULL_FRAME_ZONE,
  mirrored: true,
  filterPreset: 'body',
  aspect: 16 / 9,
};

/**
 * How many bodies beyond `maxPlayers` we keep identities for.
 *
 * THE TRACKER FOLLOWS EVERYONE; ONLY SOME OF THEM ARE PLAYERS. It used to
 * refuse to create a track once it held `maxPlayers` of them, which for the 1P
 * games and every shell screen means one — so the single body selection handed
 * up each frame WAS the tracker's whole world, and a stranger who out-ranked
 * the player for a moment did not merely appear, they replaced them.
 *
 * Keeping a few shadow tracks costs a One Euro filter each and buys the
 * admission logic the thing it needs to make a decision: a stable identity and
 * a motion history for every body in shot, including the ones it is going to
 * reject. 3 covers a player, a friend beside them and two people at the tape.
 */
const TRACK_SLACK = 3;

/**
 * The real camera aspect, published once per frame by `main.ts`.
 *
 * Every tracker that has not been told otherwise reads this. The alternative —
 * each owner calling `setOptions({aspect})` every frame — is what we had, and
 * only ONE of the five trackers in the app actually did it. `GameBase` did;
 * attract, menu, initials and rigcheck all silently ran at the 16:9 default.
 *
 * On a 4:3 webcam (still common on laptops and the likeliest thing to be
 * plugged in on the day) that is a 33% error in every horizontal body
 * measurement those four screens make — including `scale.shoulderWidth`, which
 * is the denominator of the hand cursor's reach box. The cursor people use to
 * choose a game would have been a third too twitchy sideways, on a rig nobody
 * had tested, with a queue watching.
 *
 * A module-level ambient value rather than an import of `camera` because
 * `src/core` must stay free of browser singletons — it is unit-tested in Node.
 */
let ambientAspect = 16 / 9;

/** Called by the frame loop. Ignores nonsense so a 0x0 camera cannot poison it. */
export function setCameraAspect(aspect: number): void {
  if (Number.isFinite(aspect) && aspect > 0.2 && aspect < 5) ambientAspect = aspect;
}

export function getCameraAspect(): number {
  return ambientAspect;
}

interface Sample {
  x: number;
  y: number;
  t: number;
}

interface InternalTrack extends TrackedPlayer {
  filter: LandmarkFilter;
  /** Where we expect this body to be NOW. Advances by velocity while blind. */
  pred: { x: number; y: number };
  /** Smoothed centroid velocity, normalised units per SECOND. */
  vel: { x: number; y: number };
  /** Observed centroids inside `speedWindowSec`. */
  history: Sample[];
  /** Raw `unit` readings that survived the gates, for the median. */
  units: number[];
  /** The published, stabilised unit. */
  heldUnit: number;
  /** Consecutive readings rejected as unreliable or outlying. */
  unitStale: number;
  /** Seconds spent continuously under `admitSpeedTorsos`. */
  stillFor: number;
  /** Seconds spent continuously clearly nearer than the weakest player. */
  nearerFor: number;
}

/** An id and a lane, left where a player was last seen. See `reclaimSec`. */
interface Reservation {
  id: number;
  slot: number;
  x: number;
  y: number;
  unit: number;
  /** Seconds left before the identity is released for good. */
  ttl: number;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class PoseTracker {
  private tracks: InternalTrack[] = [];
  private reservations: Reservation[] = [];
  private nextId = 1;
  private opts: TrackerOptions;
  private lastT = -1;
  /** Which player `getPrimary()` is currently holding. See `primaryTakeover`. */
  private primaryId: number | null = null;

  /**
   * True once an owner has passed an explicit `aspect`. Until then this
   * tracker follows the live camera — see `setCameraAspect`.
   */
  private aspectPinned = false;

  constructor(options: Partial<TrackerOptions> = {}) {
    this.opts = { ...DEFAULT_TRACKER_OPTIONS, ...options };
    if (options.aspect !== undefined) this.aspectPinned = true;
  }

  setOptions(patch: Partial<TrackerOptions>): void {
    this.opts = { ...this.opts, ...patch };
    if (patch.aspect !== undefined) this.aspectPinned = true;
  }

  /** The aspect body measurements are taken in. See `setCameraAspect`. */
  private get aspect(): number {
    return this.aspectPinned ? this.opts.aspect : ambientAspect;
  }

  getOptions(): Readonly<TrackerOptions> {
    return this.opts;
  }

  /** Wipe all identities. Call between rounds so a new player starts clean. */
  reset(): void {
    this.tracks = [];
    this.reservations = [];
    this.primaryId = null;
    this.lastT = -1;
  }

  /**
   * @param poses raw detections for this frame
   * @param t     timestamp in SECONDS (One Euro wants seconds)
   */
  update(poses: readonly RawPose[], t: number): TrackedPlayer[] {
    const o = this.opts;
    const aspect = this.aspect;

    // Elapsed time, not frames. Clamped: a tab that was backgrounded hands us
    // a multi-second gap, and integrating velocity across it would fling every
    // prediction out of frame.
    const dt = this.lastT < 0 ? 0 : Math.min(0.5, Math.max(0, t - this.lastT));
    this.lastT = t;

    // 1. Advance every prediction, so matching asks "where should this person
    //    be NOW", not "where were they last time we saw them". Two players
    //    crossing are equidistant from both of last frame's centroids at the
    //    moment they meet; they are not equidistant from where their own
    //    momentum says they should be.
    for (const tr of this.tracks) {
      tr.pred.x += tr.vel.x * dt;
      tr.pred.y += tr.vel.y * dt;
      if (tr.missing > 0) {
        // Confidence in a remembered velocity decays fast once we stop seeing
        // the body it came from.
        tr.vel.x *= 0.85;
        tr.vel.y *= 0.85;
      }
    }
    for (const r of this.reservations) r.ttl -= dt;
    this.reservations = this.reservations.filter((r) => r.ttl > 0);

    // 2. Ask selection for the bodies in frame, telling it which of them we
    //    already know. Without `keep`, a stranger with a bigger bounding box
    //    displaces the player from a one-slot list before matching ever runs.
    const anchors: KeepAnchor[] = this.tracks.map((tr) => ({
      x: tr.pred.x,
      y: tr.pred.y,
      r: this.matchRadiusFor(tr),
    }));
    for (const r of this.reservations) {
      anchors.push({ x: r.x, y: r.y, r: r.unit * o.reclaimTorsos });
    }

    const chosen = selectCandidates(poses, {
      maxPlayers: o.maxPlayers + TRACK_SLACK,
      minArea: o.minArea,
      minUnit: o.minUnit,
      minConfidence: o.minConfidence,
      dedupeTorsos: o.dedupeTorsos,
      minRelativeSize: o.minRelativeSize,
      aspect,
      keep: anchors,
      zone: o.zone,
    });

    // 3. Greedy nearest-prediction matching. O(n*m), and n,m <= 9 here, so the
    //    Hungarian algorithm would be ceremony for no gain.
    const unmatchedTracks = new Set(this.tracks);
    const used = new Set<number>();

    interface Pair {
      track: InternalTrack;
      idx: number;
      d: number;
    }
    const pairs: Pair[] = [];

    for (const track of this.tracks) {
      const radius = this.matchRadiusFor(track);
      for (let i = 0; i < chosen.length; i++) {
        const c = chosen[i]!;
        const d = dist(track.pred.x, track.pred.y, c.centroid.x, c.centroid.y, aspect);
        if (d > radius) continue;
        if (!this.sizeCompatible(track, c)) continue;
        pairs.push({ track, idx: i, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);

    for (const pair of pairs) {
      if (!unmatchedTracks.has(pair.track) || used.has(pair.idx)) continue;
      unmatchedTracks.delete(pair.track);
      used.add(pair.idx);
      this.updateTrack(pair.track, chosen[pair.idx]!, t, dt);
    }

    // 4. Unmatched detections become new tracks — or reclaim an old identity,
    //    if one is waiting where they appeared.
    for (let i = 0; i < chosen.length; i++) {
      if (used.has(i)) continue;
      if (this.tracks.length >= o.maxPlayers + TRACK_SLACK) continue;
      this.tracks.push(this.createTrack(chosen[i]!, t));
    }

    // 5. Age out tracks that didn't match. Keeping them alive briefly is what
    //    lets someone survive a moment of occlusion without losing their run;
    //    the reservation left behind is what lets them survive a longer one
    //    without losing their id and their half of the screen.
    for (const track of unmatchedTracks) {
      track.missing++;
      track.age++;
      track.speed = 0;
      track.stillFor = 0;
      track.nearerFor = 0;
    }
    const survivors: InternalTrack[] = [];
    for (const tr of this.tracks) {
      if (tr.missing <= o.maxMissingFrames) {
        survivors.push(tr);
        continue;
      }
      if (tr.confirmed) this.reserve(tr);
    }
    this.tracks = survivors;

    this.admit(dt);
    this.assignSlots();

    return this.getPlayers();
  }

  /* ---------------- matching ---------------- */

  private matchRadiusFor(tr: InternalTrack): number {
    const o = this.opts;
    const torsos = Math.min(
      o.matchRadiusMaxTorsos,
      o.matchRadiusTorsos + o.matchRadiusBlindTorsos * tr.missing
    );
    return Math.max(0.02, tr.heldUnit) * torsos;
  }

  /**
   * Is this detection the same SIZE of person as the track expects?
   *
   * Only asked while re-acquiring, and only of detections whose own scale is
   * believable — see `matchSizeRatio`. Asking it every frame would break the
   * one case it exists to protect: a player whose hips drop out reports a
   * collapsed unit, and refusing to match them to their own track is far worse
   * than anything a stranger can do.
   */
  private sizeCompatible(tr: InternalTrack, c: Candidate): boolean {
    if (tr.missing === 0 || !c.reliable || tr.heldUnit <= 0 || c.unit <= 0) return true;
    const ratio = c.unit / tr.heldUnit;
    return ratio <= this.opts.matchSizeRatio && ratio >= 1 / this.opts.matchSizeRatio;
  }

  /* ---------------- admission ---------------- */

  /**
   * Decide who counts as a player this frame.
   *
   * The asymmetry is the whole design: getting IN is hard and staying in is
   * easy. A body must have stopped, and stayed stopped, before it is admitted;
   * once admitted it may move however it likes, because a player mid-game
   * moves exactly as fast as somebody walking past and no threshold can tell
   * those apart. The question "has this person stopped in front of us" is only
   * ever asked of people who are not playing yet.
   */
  private admit(dt: number): void {
    const o = this.opts;
    const confirmed = this.tracks.filter((tr) => tr.confirmed);
    let room = o.maxPlayers - confirmed.length;

    const eligible = this.tracks
      .filter(
        (tr) =>
          !tr.confirmed &&
          tr.missing === 0 &&
          tr.age >= o.minAgeToConfirm &&
          tr.stillFor >= o.admitStillSec
      )
      .sort((a, b) => b.heldUnit - a.heldUnit);

    for (const tr of eligible) {
      if (room <= 0) break;
      tr.confirmed = true;
      room--;
    }

    // Somebody who stopped in front of the camera first should not own the
    // only slot forever. A body a quarter nearer than the weakest player, for
    // a full second, has physically stepped in front of them.
    //
    // Re-read the confirmed set: the loop above may have just added to it, and
    // a player admitted this very frame is as eligible to be the weakest as
    // anyone else.
    const players = this.tracks.filter((tr) => tr.confirmed);
    if (room <= 0 && players.length > 0) {
      let weakest = players[0]!;
      for (const p of players) if (p.heldUnit < weakest.heldUnit) weakest = p;
      for (const tr of eligible) {
        if (tr.confirmed) continue;
        if (tr.heldUnit >= weakest.heldUnit * o.takeoverRatio) tr.nearerFor += dt;
        else tr.nearerFor = 0;
        if (tr.nearerFor >= o.takeoverSec) {
          weakest.confirmed = false;
          weakest.slot = -1;
          tr.confirmed = true;
          tr.nearerFor = 0;
          break;
        }
      }
    }
  }

  /* ---------------- slots ---------------- */

  /**
   * Screen order, with memory.
   *
   * Every confirmed track gets a slot, INCLUDING ones we cannot currently see:
   * a player occluded by somebody walking past must keep their half of the
   * screen, not hand it over for the half-second they are invisible and take a
   * different one back afterwards.
   */
  private assignSlots(): void {
    const o = this.opts;
    const aspect = this.aspect;
    const players = this.tracks.filter((tr) => tr.confirmed);
    const key = (tr: InternalTrack): number => (o.mirrored ? -tr.pred.x : tr.pred.x);

    // Start from the order we already had, so the sort has something to be
    // hysteretic ABOUT. New arrivals go to the end, in screen order.
    players.sort((a, b) => {
      const as = a.slot < 0 ? 1e6 + key(a) : a.slot;
      const bs = b.slot < 0 ? 1e6 + key(b) : b.slot;
      return as - bs;
    });

    // Bubble, swapping only on a decisive separation. A full sort here would
    // reorder on a millimetre; this reorders on half a torso.
    for (let pass = 0; pass < players.length; pass++) {
      let moved = false;
      for (let i = 0; i + 1 < players.length; i++) {
        const a = players[i]!;
        const b = players[i + 1]!;
        const margin =
          Math.max(a.heldUnit, b.heldUnit, 0.02) * o.slotHysteresisTorsos;
        if ((key(b) - key(a)) * aspect < -margin) {
          players[i] = b;
          players[i + 1] = a;
          moved = true;
        }
      }
      if (!moved) break;
    }

    players.forEach((tr, i) => {
      tr.slot = i;
    });
  }

  /* ---------------- track lifecycle ---------------- */

  private reserve(tr: InternalTrack): void {
    this.reservations = this.reservations.filter((r) => r.id !== tr.id);
    this.reservations.push({
      id: tr.id,
      slot: tr.slot,
      x: tr.pred.x,
      y: tr.pred.y,
      unit: tr.heldUnit,
      ttl: this.opts.reclaimSec,
    });
  }

  /** The reservation, if any, this detection is entitled to inherit. */
  private claimFor(c: Candidate): Reservation | null {
    const o = this.opts;
    let best: Reservation | null = null;
    let bestD = Infinity;
    for (const r of this.reservations) {
      const d = dist(r.x, r.y, c.centroid.x, c.centroid.y, this.aspect);
      if (d > Math.max(0.02, r.unit) * o.reclaimTorsos) continue;
      if (c.reliable && r.unit > 0 && c.unit > 0) {
        const ratio = c.unit / r.unit;
        if (ratio > o.matchSizeRatio || ratio < 1 / o.matchSizeRatio) continue;
      }
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }

  private createTrack(c: Candidate, t: number): InternalTrack {
    const filter = new LandmarkFilter(POSE_LANDMARK_COUNT, this.opts.filterPreset);
    const landmarks: Landmark[] = [];
    filter.apply(c.pose.landmarks, t, landmarks);

    const scale = computeScale(landmarks, this.aspect);
    const claim = this.claimFor(c);
    if (claim) this.reservations = this.reservations.filter((r) => r !== claim);

    const track: InternalTrack = {
      id: claim ? claim.id : this.nextId++,
      slot: claim ? claim.slot : -1,
      landmarks,
      raw: c.pose.landmarks,
      centroid: c.centroid,
      area: c.area,
      scale,
      confidence: computeConfidence(c.pose.landmarks),
      speed: 0,
      age: 1,
      missing: 0,
      // A reclaimed identity is a player we already admitted once. Making them
      // stand still again to get their own lane back, mid-round, with their
      // score on screen, is the bug this exists to prevent.
      confirmed: !!claim,
      filter,
      pred: { x: c.centroid.x, y: c.centroid.y },
      vel: { x: 0, y: 0 },
      history: [{ x: c.centroid.x, y: c.centroid.y, t }],
      units: [],
      heldUnit: 0,
      unitStale: 0,
      stillFor: 0,
      nearerFor: 0,
    };
    this.pushUnit(track, scale);
    track.scale = this.publishedScale(track, scale);
    return track;
  }

  private updateTrack(track: InternalTrack, c: Candidate, t: number, dt: number): void {
    const aspect = this.aspect;
    const prev = track.centroid;

    track.raw = c.pose.landmarks;
    track.filter.apply(c.pose.landmarks, t, track.landmarks);
    track.centroid = c.centroid;
    track.area = c.area;
    track.confidence = computeConfidence(c.pose.landmarks);

    const scale = computeScale(track.landmarks, aspect);
    this.pushUnit(track, scale);
    track.scale = this.publishedScale(track, scale);

    // Velocity, lightly smoothed. Raw frame differences are half noise — see
    // the per-frame step distributions on `matchRadiusTorsos` — and an
    // unsmoothed velocity makes the prediction worse than no prediction.
    if (dt > 0) {
      const vx = (c.centroid.x - prev.x) / dt;
      const vy = (c.centroid.y - prev.y) / dt;
      const a = track.missing > 0 ? 1 : 0.35;
      track.vel.x += (vx - track.vel.x) * a;
      track.vel.y += (vy - track.vel.y) * a;
    }
    track.pred.x = c.centroid.x;
    track.pred.y = c.centroid.y;

    // Windowed speed. See `speedWindowSec` for why the window is in seconds.
    const o = this.opts;
    track.history.push({ x: c.centroid.x, y: c.centroid.y, t });
    // TRIM STRICTLY BY TIME, DOWN TO A SINGLE SAMPLE.
    //
    // Keeping a floor of two entries looks harmless and is not: after a gap
    // longer than the window, the oldest survivor is stale, and a body that
    // vanished and came back near where it left reads as a tiny displacement
    // over a very long span — which is a stranger being handed, for free, the
    // one thing admission asks for. Trimming to one sample instead costs a
    // re-acquired body 0.24s before its speed is known again, which is the
    // honest answer: we do not know yet.
    //
    // A SHORT gap is deliberately kept. Somebody half-hidden behind a queue is
    // seen in bursts, and the endpoints either side of a 0.1s gap still give
    // their true average speed — they were walking during it. Dropping the
    // history on every miss would mean such a player could never be admitted
    // at all, which is the worse failure.
    while (track.history.length > 1 && t - track.history[0]!.t > o.speedWindowSec) {
      track.history.shift();
    }
    const a = track.history[0]!;
    const span = t - a.t;
    if (span >= o.minSpeedSpanSec) {
      const unit = Math.max(0.02, track.heldUnit);
      track.speed = dist(a.x, a.y, c.centroid.x, c.centroid.y, aspect) / unit / span;
      if (track.speed < o.admitSpeedTorsos) track.stillFor += dt;
      else track.stillFor = 0;
    } else {
      track.speed = 0;
    }

    track.age++;
    track.missing = 0;
  }

  /* ---------------- scale stability ---------------- */

  /** Feed one raw reading into the stabiliser. See the `unit*` options. */
  private pushUnit(track: InternalTrack, scale: BodyScale): void {
    const o = this.opts;
    const u = scale.unit;
    const usable = Number.isFinite(u) && u > 0;

    if (track.heldUnit <= 0) {
      // Nothing held yet: take whatever we have so thresholds are never
      // divided by zero, but only start the median once a reading is worth
      // believing.
      if (usable) track.heldUnit = u;
      if (usable && scale.reliable) track.units = [u];
      return;
    }
    if (!usable || !scale.reliable) {
      track.unitStale++;
      return;
    }

    const ratio = u / track.heldUnit;
    if (ratio > o.unitOutlierRatio || ratio < 1 / o.unitOutlierRatio) {
      // One wild reading is a landmark glitch. Twenty in a row is the truth,
      // and refusing it forever would strand the track at a stale size.
      if (++track.unitStale < o.unitResyncFrames) return;
      track.units = [u];
      track.heldUnit = u;
      track.unitStale = 0;
      return;
    }

    track.unitStale = 0;
    track.units.push(u);
    while (track.units.length > o.unitMedianFrames) track.units.shift();
    const m = median(track.units);
    track.heldUnit = Math.min(
      track.heldUnit * (1 + o.unitRatePerFrame),
      Math.max(track.heldUnit * (1 - o.unitRatePerFrame), m)
    );
  }

  /**
   * What games actually see.
   *
   * `shoulderWidth` and `torsoHeight` stay as measured this frame — a consumer
   * asking for those is asking about this frame's geometry. `unit` is the
   * stabilised one, because it is a property of the PERSON, not of the frame,
   * and everything divides by it.
   */
  private publishedScale(track: InternalTrack, scale: BodyScale): BodyScale {
    return {
      ...scale,
      unit: track.heldUnit,
      valid: track.heldUnit > 0.04,
    };
  }

  /* ---------------- accessors ---------------- */

  /** All confirmed players, in screen-slot order. */
  getPlayers(): TrackedPlayer[] {
    return this.tracks.filter((tr) => tr.confirmed).sort((x, y) => x.slot - y.slot);
  }

  /**
   * The nearest player. What every solo game uses.
   *
   * WAS "the largest bounding box, recomputed from scratch every frame", which
   * is wrong twice. The bounding box spans every visible landmark, so it
   * doubles when somebody raises their arms — MEASURED: a stranger at 4m with
   * their arms out has 51% more bbox area than a 3m player standing normally,
   * and still wins out to 4.7m. And with no hysteresis the answer changed up
   * to 38 times a second between people at similar distances (attract.ts
   * measured that, then worked around it locally; this is the same fix, one
   * level down, where the rest of the app gets it too).
   *
   * Torso size instead, which is monotone in distance and nothing else, plus a
   * takeover margin a challenger has to actually earn.
   */
  getPrimary(): TrackedPlayer | null {
    const players = this.getPlayers();
    if (players.length === 0) {
      this.primaryId = null;
      return null;
    }
    let nearest = players[0]!;
    for (const p of players) if (p.scale.unit > nearest.scale.unit) nearest = p;

    const held = players.find((p) => p.id === this.primaryId);
    if (!held) {
      this.primaryId = nearest.id;
      return nearest;
    }
    if (nearest.scale.unit > held.scale.unit * this.opts.primaryTakeover) {
      this.primaryId = nearest.id;
      return nearest;
    }
    return held;
  }

  /** The player occupying a given split-screen half. */
  getBySlot(slot: number): TrackedPlayer | null {
    return this.getPlayers().find((p) => p.slot === slot) ?? null;
  }
}
