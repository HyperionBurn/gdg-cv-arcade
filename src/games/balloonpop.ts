/**
 * BALLOON POP — "the accessible one".
 *
 * PLAN.md §3: "Not everyone will flail in front of a crowd — shy people, staff,
 * someone in formal dress, a kid dragged along by a sibling. Every stall needs
 * a game with a zero-embarrassment floor, and it's also the fastest
 * queue-overflow valve."
 *
 * So the design brief is unusual: this game is NOT trying to be the most
 * exciting thing on the roster. It is trying to be the one nobody can refuse.
 * That means:
 *   - playable standing still, hands only, no jumping or big movement
 *   - reachable without stretching (balloons drift through the comfortable zone)
 *   - impossible to be visibly bad at — there is no fail state at all
 *   - still satisfying, because a pop is inherently satisfying
 *
 * It shares the blade layer with Fruit Ninja but uses TOUCH rather than swipe:
 * you do not need to move fast, only to be there. That is the whole difference
 * in accessibility.
 *
 * BRAND: a balloon is a sticker. Flat brand fill, chunky ink outline, hard
 * shadow straight down, and a flat paper highlight — which is what still makes
 * it read as a balloon rather than a disc, and which survives "no gradients"
 * because it was never a gradient in the first place, only a white shape.
 *
 * The arming line is now carried by COLOUR rather than by fading the balloon
 * in. A balloon below your shoulders is flat muted grey; the moment it is live
 * it is flat brand colour. That is a state change instead of a tint, and it is
 * a far clearer signal at three metres than an opacity ramp ever was.
 */

import { BladeTracker, type Blade } from '../core/blades';
import { POSE } from '../core/types';
import type { TrackedPlayer } from '../core/tracker';
import { GameBase, type SlotRect } from './base';
import { BURST } from '../engine/particles';
import { audio } from '../engine/audio';
import {
  drawTabularNumber,
  measureTabularNumber,
  stickerPill,
  vh,
} from '../engine/draw';
import type { Viewport } from '../engine/draw';
import { COLORS, PLAYER_COLORS, FONTS, SHADOW, STROKE, TRACK, WEIGHT } from '../shell/theme';
import { GAME_COLORS } from '../meta/games';
import type { FrameContext } from '../shell/screen';

interface Balloon {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  slot: number;
  /** Horizontal sway. */
  phase: number;
  /** Golden balloons are worth more and drift faster. */
  golden: boolean;
  /** 0..1 squash when a hand is near, telegraphing the pop. */
  squash: number;
}

/**
 * Balloons only become poppable ABOVE THE PLAYER'S SHOULDER LINE.
 *
 * Without an arming rule the game plays itself: balloons spawn at the bottom
 * and rise, and a player standing normally has their hands at hip height —
 * directly in the flight path. Measured in the sim, a player with hands down,
 * not moving at all, scored 36 points in two seconds.
 *
 * The first fix used a fixed fraction of screen height, which was wrong for
 * exactly the reason every other threshold in this codebase is body-relative:
 * where someone's hands rest in frame depends entirely on their height and how
 * far back they stand. A fixed line was still above the sim player's hips.
 *
 * Shoulder-relative is the correct frame. It means the same thing for everyone:
 * lift your hands up. Which is also the motion we want — hands up, in front of
 * you, no jumping, no stretching.
 *
 * Offset is in torso units below the shoulder, so there's a little forgiveness.
 */
const ARM_OFFSET_TORSOS = 0.25;
/** Used when nobody is tracked, purely so balloons render sensibly. */
const ARM_FALLBACK = 0.55;

const BALLOON_COLORS = [COLORS.blue, COLORS.red, COLORS.green, COLORS.yellow] as const;

export class BalloonPopGame extends GameBase {
  private blades = new BladeTracker({
    // Touch, not swipe. Zero activation speed is the entire accessibility
    // decision: a hand resting in the right place still pops.
    activateSpeed: 0,
    deactivateSpeed: 0,
    trailLength: 6,
  });

  private balloons: Balloon[] = [];
  private popped = [0, 0];
  private points = [0, 0];
  private streak = [0, 0];
  private spawnTimer = 0;
  /** Screen-space Y above which balloons are live, per slot. */
  private armLine = [0, 0];

  constructor() {
    super({
      gameId: 'balloonpop',
      title: 'BALLOON POP',
      tagline: '<POP THEM WITH YOUR HANDS>',
      visionMode: 'pose',
      maxPlayers: 2,
      roundSeconds: 30,
      color: GAME_COLORS.balloonpop,
      supportsVersus: true,
    });
  }

  protected onStart(): void {
    this.balloons = [];
    this.popped = [0, 0];
    this.points = [0, 0];
    this.streak = [0, 0];
    this.spawnTimer = 0.2;
    this.armLine = [0, 0];
    this.blades.reset();
  }

  protected scoreFor(slot: number): number {
    return this.points[slot] ?? 0;
  }

  protected primaryLabel(): string {
    return 'SCORE';
  }

  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    if (!this.proj) return;
    const { v } = fc;

    const project = (nx: number, ny: number) => this.proj!.point({ x: nx, y: ny });
    const blades = this.blades.update(players, project, dt, fc.now);

    this.updateArmLines(players, v.height);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnWave(fc);
      const progress = 1 - this.timeLeft / this.roundTotal;
      this.spawnTimer = 0.8 - progress * 0.4;
    }

    for (let i = this.balloons.length - 1; i >= 0; i--) {
      const b = this.balloons[i]!;
      b.phase += dt * 1.6;
      b.y += b.vy * dt;
      b.x += b.vx * dt + Math.sin(b.phase) * v.width * 0.02 * dt;
      b.squash = Math.max(0, b.squash - dt * 4);

      if (b.y + b.r < -v.height * 0.05) {
        // A balloon that was LIVE and escaped unpopped breaks the streak.
        //
        // Without this there is no code path that resets it, so "14 STREAK" on
        // the HUD was really "14 pops so far" wearing a streak's clothes — the
        // number could never go down, which makes it meaningless as tension.
        //
        // Deliberately only counts balloons that were armed (above the player's
        // shoulder line). One that drifts past while still grey was never
        // poppable, so missing it is not a miss, and this game's whole promise
        // is that there is no fail state. Losing a streak is not failing — it
        // is the only thing that makes keeping one worth anything.
        if (b.y + b.r < (this.armLine[b.slot] ?? 0)) {
          this.streak[b.slot] = 0;
        }
        this.balloons.splice(i, 1);
      }
    }

    this.resolvePops(fc, blades);
  }

  private spawnWave(fc: FrameContext): void {
    const { v } = fc;
    for (let slot = 0; slot < this.playerCount; slot++) {
      const rect = this.slotRect(v, slot);
      const count = 1 + (Math.random() < 0.45 ? 1 : 0);

      for (let i = 0; i < count; i++) {
        const golden = Math.random() < 0.12;
        const r = v.height * (golden ? 0.035 : 0.045 + Math.random() * 0.018);

        this.balloons.push({
          // Spawn across the middle 70% so balloons rise through the zone where
          // hands naturally are. Edge spawns force a stretch, and stretching in
          // front of a crowd is exactly what this game exists to avoid.
          x: rect.x + rect.width * (0.15 + Math.random() * 0.7),
          y: v.height + r * 2,
          vx: (Math.random() - 0.5) * v.height * 0.05,
          vy: -v.height * (golden ? 0.26 : 0.15 + Math.random() * 0.06),
          r,
          color: golden ? COLORS.yellow : BALLOON_COLORS[Math.floor(Math.random() * 4)]!,
          slot,
          phase: Math.random() * Math.PI * 2,
          golden,
          squash: 0,
        });
      }
    }
  }

  /**
   * Tracks each player's shoulder line in screen space.
   *
   * INDEXED BY THE PLAYER'S OWN SLOT, not by `0..playerCount`.
   *
   * It used to loop `slot < this.playerCount`, so a solo round only ever wrote
   * `armLine[0]`. But the tracker re-sorts slots by screen position every
   * frame while `playerCount` stays frozen for the round — so the moment a
   * bystander stands to the player's left, the PLAYER becomes slot 1, and
   * `armLine[1]` is still its initial 0.
   *
   * The hit test then reads `b.y > (armLine[1] ?? 0)`, and `?? 0` cannot save
   * it because 0 is not nullish. Every balloon on screen is below y=0, so
   * every one is skipped: NOTHING IS POPPABLE. Worse, the draw path uses
   * `|| fallback` instead, so the balloons keep rendering as armed — the
   * player is swiping at bright, live-looking balloons that cannot be hit.
   *
   * At a club fair a friend leaning into frame is a certainty.
   */
  private updateArmLines(players: readonly TrackedPlayer[], screenH: number): void {
    for (const p of players) {
      const slot = Math.max(0, Math.min(this.armLine.length - 1, p.slot));
      if (!this.proj) continue;
      const ls = p.landmarks[POSE.LEFT_SHOULDER];
      const rs = p.landmarks[POSE.RIGHT_SHOULDER];
      if (!ls || !rs) continue;

      const shoulderY = this.proj.y((ls.y + rs.y) / 2);
      const forgiveness = this.proj.len(p.scale.unit) * ARM_OFFSET_TORSOS;
      // Ease toward the target so a momentary tracking wobble doesn't make the
      // whole field flicker between armed and dead.
      const target = shoulderY + forgiveness;
      const cur = this.armLine[slot] || target;
      this.armLine[slot] = cur + (target - cur) * 0.15;
    }

    // Any slot nobody occupies keeps the fallback rather than 0, so a stale or
    // unwritten entry can never read as "the line is at the top of the screen".
    for (let i = 0; i < this.armLine.length; i++) {
      if (!this.armLine[i]) this.armLine[i] = screenH * ARM_FALLBACK;
    }
  }

  private resolvePops(fc: FrameContext, blades: Blade[]): void {
    for (const blade of blades) {
      // Same reason as Fruit Ninja: a snapped blade's position is valid but the
      // motion implied by it is not, and a pop is a statement about a hand
      // having arrived somewhere.
      if (blade.reacquired) continue;
      for (let i = this.balloons.length - 1; i >= 0; i--) {
        const b = this.balloons[i]!;
        if (this.playerCount > 1 && b.slot !== blade.slot) continue;
        // Still below the player's shoulder line — see ARM_OFFSET_TORSOS.
        // `||`, not `??`, and the SAME fallback the draw uses: an armLine of 0
        // is not a line at the top of the screen, it is an unwritten entry, and
        // the two paths disagreeing is what made balloons look armed while
        // being unhittable.
        if (b.y > (this.armLine[blade.slot] || fc.v.height * ARM_FALLBACK)) continue;

        // Generous hit radius. This game is about inclusion, not precision, and
        // a near miss that reads as a hit is far better here than the reverse.
        const hitR = b.r * 1.35;
        const d = Math.hypot(blade.x - b.x, blade.y - b.y);

        if (d < hitR * 2.2) b.squash = Math.min(1, b.squash + 0.5);
        if (d > hitR) continue;

        this.balloons.splice(i, 1);
        this.pop(fc, b, blade.slot);
      }
    }
  }

  private pop(fc: FrameContext, b: Balloon, slot: number): void {
    const { v } = fc;

    const streak = (this.streak[slot] ?? 0) + 1;
    this.streak[slot] = streak;
    this.popped[slot] = (this.popped[slot] ?? 0) + 1;

    const value = b.golden ? 50 : 10;
    const bonus = Math.min(streak - 1, 10) * 2;
    const gained = value + bonus;
    this.points[slot] = (this.points[slot] ?? 0) + gained;
    this.scores[slot]?.set(this.points[slot]!);

    audio.play('pop', 0.9 + Math.min(1.2, streak * 0.045) + (b.golden ? 0.35 : 0));
    this.juice.shake(b.golden ? 0.16 : 0.05);
    if (b.golden) {
      this.juice.flash(COLORS.yellow, 0.22, 6);
      this.juice.hitStop(40);
    }

    BURST.splat(this.particles, b.x, b.y, b.color, b.r / (v.height * 0.045));

    // Popups are ink, because flat yellow type on white paper vanishes at
    // three metres — which is precisely the size of the win this popup is
    // announcing. (The note that used to sit here, about PopupLayer blurring
    // its own fill, is obsolete: no `shadowBlur` survives anywhere in src/.)
    this.popups.spawn(
      b.golden ? `GOLD +${gained}` : `+${gained}`,
      b.x,
      b.y,
      COLORS.ink,
      vh(v, b.golden ? 4 : 2.8)
    );

    if (streak > 0 && streak % 10 === 0) {
      this.popups.spawn(`<${streak} IN A ROW>`, b.x, b.y - vh(v, 5), COLORS.ink, vh(v, 3.6));
      this.juice.shake(0.24);
    }
  }

  protected onRender(fc: FrameContext, _players: TrackedPlayer[]): void {
    const { ctx, v } = fc;

    for (const b of this.balloons) this.drawBalloon(ctx, b, v);

    // Hands are stickers too — a flat brand-colour disc with an ink outline, a
    // hard shadow and a paper centre. It reads as "reach out and touch" the way
    // the old translucent glowing orb did, without the blur or the tint.
    for (const blade of this.blades.all) {
      const color = this.playerCount > 1 ? PLAYER_COLORS[blade.slot]! : COLORS.blue;
      this.drawHand(ctx, v, blade.x, blade.y, color);
    }
  }

  private drawHand(
    ctx: CanvasRenderingContext2D,
    v: Viewport,
    x: number,
    y: number,
    color: string
  ): void {
    const r = vh(v, 2.6);
    const drop = vh(v, SHADOW.base);

    ctx.save();
    ctx.shadowBlur = 0;

    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(x, y + drop, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, STROKE.base);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = COLORS.paper;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawBalloon(ctx: CanvasRenderingContext2D, b: Balloon, v: Viewport): void {
    const screenH = v.height;
    const squash = 1 + b.squash * 0.12;
    const stretch = 1 - b.squash * 0.08;

    // Above the arming line the balloon is live and wears its brand colour;
    // below it, it is flat muted grey. One boolean, two flat states, no ramp —
    // and it only ever crosses once, because balloons rise.
    const line = this.armLine[b.slot] || screenH * ARM_FALLBACK;
    const armed = b.y <= line;
    const fill = armed ? b.color : COLORS.muted;
    const outline = armed ? COLORS.ink : COLORS.muted;
    const stroke = vh(v, armed && b.golden ? STROKE.thick : STROKE.base);
    // Not armed yet = not lifted. Same treatment the brand gives an empty
    // leaderboard place in `rankedRow`: muted, and flat on the page.
    const drop = armed ? vh(v, SHADOW.base) : 0;

    const body = (dy: number): void => {
      ctx.beginPath();
      ctx.ellipse(0, dy, b.r, b.r * 1.16, 0, 0, Math.PI * 2);
    };

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.translate(b.x, b.y);

    // String. Flat ink hairline — the old one was white at 25% on what is now
    // a white page, so it drew nothing at all.
    ctx.strokeStyle = armed ? COLORS.ink : COLORS.muted;
    ctx.lineWidth = Math.max(1, screenH * 0.0016);
    ctx.beginPath();
    ctx.moveTo(0, b.r * 0.95);
    ctx.quadraticCurveTo(
      Math.sin(b.phase) * b.r * 0.4,
      b.r * 1.6,
      Math.sin(b.phase * 0.7) * b.r * 0.2,
      b.r * 2.2
    );
    ctx.stroke();

    ctx.scale(squash, stretch);

    // Hard shadow, straight down, zero blur.
    if (drop > 0) {
      ctx.fillStyle = COLORS.ink;
      body(drop / stretch);
      ctx.fill();
    }

    ctx.fillStyle = fill;
    body(0);
    ctx.fill();

    ctx.strokeStyle = outline;
    ctx.lineWidth = stroke;
    body(0);
    ctx.stroke();

    // Specular highlight — this is what makes it read as a balloon rather than
    // a circle, at basically no cost. A FLAT paper shape, not a gradient and
    // not a translucent white, so it survives the brand unchanged.
    ctx.fillStyle = COLORS.paper;
    ctx.beginPath();
    ctx.ellipse(-b.r * 0.3, -b.r * 0.4, b.r * 0.22, b.r * 0.3, -0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * A number in a sticker pill, with tabular digits.
   *
   * See the identical note in games/sixtyseven.ts: `labelPill` sets its label
   * in proportional figures, so a live counter jitters sideways as it changes.
   * This belongs in engine/draw.ts as a shared `numberPill`.
   */
  private numberPill(
    ctx: CanvasRenderingContext2D,
    v: Viewport,
    cx: number,
    cy: number,
    text: string,
    h: number,
    fill: string
  ): void {
    const size = h * 0.5;
    const w = measureTabularNumber(ctx, text, size, WEIGHT.black, FONTS.body) + h * 0.8;

    stickerPill(ctx, v, cx - w / 2, cy - h / 2, w, h, {
      fill,
      outline: COLORS.ink,
      outlineWidth: vh(v, STROKE.base),
      shadow: vh(v, SHADOW.base),
    });
    drawTabularNumber(ctx, text, cx, cy, {
      size,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });
  }

  protected onRenderHud(fc: FrameContext, slot: number, rect: SlotRect): void {
    const { ctx, v } = fc;
    const streak = this.streak[slot] ?? 0;

    if (streak >= 3) {
      // Yellow action pill, straight: it carries a number, so it never tilts.
      // Below the HUD band — at 27vh this covered the chase line at 26.
      this.numberPill(
        ctx,
        v,
        rect.centerX,
        this.hudBottom(v) + vh(v, 3.2),
        `${streak} STREAK`,
        vh(v, 4.6),
        COLORS.yellow
      );
    }

    drawTabularNumber(ctx, `${this.popped[slot] ?? 0} POPPED`, rect.centerX, v.height - vh(v, 3), {
      size: vh(v, 2),
      // Balloons drift across this line too. `drawTabularNumber` forwards opts
      // straight to `drawText`, so the knockout comes along per glyph.
      knockout: true,
      color: COLORS.muted,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: TRACK.pill,
    });
  }
}
