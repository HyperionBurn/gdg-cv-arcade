# Architecture brief

Read this before adding a game or screen. Read [PLAN.md](PLAN.md) for *why* any
of it is shaped this way.

## Hard rules

1. **No new npm dependencies.** Only `@mediapipe/tasks-vision` and `three`.
2. **No downloaded art assets.** Everything procedural — see PLAN.md §5a. No
   images, no models, no sprite sheets, no audio files.
3. **No network calls at runtime, ever.** Venue wifi will fail.
4. **Only `main.ts` may own `requestAnimationFrame`.** Screens get `render(fc)`.
5. **Only `core/camera.ts` may call `getUserMedia`.**
6. **Colours come from `shell/theme.ts`.** Never hardcode a hex.
7. **Sizes are `vh(v, n)`**, never raw pixels — the target is a TV at unknown
   resolution, and "readable from 3m" is a proportion of height.
8. **`npm run typecheck` must pass.** `strict`, `noUncheckedIndexedAccess`, and
   `noUnusedLocals` are all on — index access returns `T | undefined`.

## Making a game

Subclass `GameBase` (`src/games/base.ts`). It owns the entire round lifecycle:
waiting → countdown → playing → results, the timer HUD, the score slam, the
rank reveal with near-miss framing, the idle timeout, and the frame-budget
watchdog. You implement only what makes your game different.

```ts
import { GameBase } from './base';
import type { TrackedPlayer } from '../core/tracker';
import type { FrameContext } from '../shell/screen';

export class MyGame extends GameBase {
  constructor() {
    super({
      gameId: 'balloonpop',        // must exist in meta/leaderboard.ts GameId
      title: 'BALLOON POP',
      tagline: 'POP THEM WITH YOUR HANDS',   // must fully explain the game
      visionMode: 'hands',          // 'pose' | 'hands' | 'both'
      maxPlayers: 2,
      roundSeconds: 30,
      color: COLORS.green,
      supportsVersus: true,         // split screen, one score each
      // Optional:
      // partyMode: true,           // everyone shares one screen (Red Light)
      // gatherSeconds: 10,         // hold a lobby; party games only
      // fullBleedSlots: true,      // playfield fills the slot: hard divider
    });
  }

  protected onStart(playerCount: number): void {}                    // reset state
  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {}
  protected onRender(fc: FrameContext, players: TrackedPlayer[]): void {}
  protected scoreFor(slot: number): number { return 0; }

  // Optional
  protected onRenderBackground?(fc: FrameContext): void;
  protected onRenderHud?(fc: FrameContext, slot: number, rect: SlotRect): void;
  protected primaryStat(slot: number): string;   // big number during play
  protected primaryLabel(): string;              // label under it, e.g. 'REPS'
}
```

Available on `this`: `tracker`, `proj`, `juice`, `particles`, `popups`,
`scores` (RollingNumber[]), `state`, `stateTime`, `timeLeft`, `players`,
`playerCount`, `config`, `slotRect(v, slot)`, `drawTargetMarker(fc, x, y, label)`,
`celebrateAt(x, y)`.

`dt` in `onTick` already has hit-stop and slow-mo applied. `fc.dt` is real time.

### Two players is the default, and it is a state-shape decision

Six of the seven games seat two; Red Light seats six. A game that can only be
played alone is a decision somebody has to write down — `tests/versus.test.ts`
fails the build until they do.

**Every piece of per-player state belongs in a per-slot struct, not on the
class.** This is the whole of what makes a game two-player, and getting it
wrong is invisible until a second body walks up. The Runner was solo-only for
no other reason: one lane detector, one track, one clock, one streak, each a
field on the screen. Nothing about the design was single-player.

```ts
interface MyLane { detector: Thing; score: number; streak: number; }
private slots: MyLane[] = [makeLane(), makeLane()];
protected scoreFor(slot: number): number { return this.slots[slot]?.score ?? 0; }
```

Rules that follow from it:

- **`scoreFor(slot)` must read `slot`.** Ignoring it is the exact bug Red Light
  shipped: six people finished a round and saw six identical numbers.
- **Draw inside `slotRect(v, slot)`.** Clip to it if your playfield can spill —
  Pose Match's two walls punched holes in each other for exactly this reason.
  Width ceilings must be measured against the RECT, not the viewport, or a HUD
  sized for a whole TV overflows its own half.
- **Whose body is this?** `players.find(p => p.slot === slot)` when
  `playerCount > 1`, and ALWAYS `players[0]` when it is 1 — so a bystander
  drifting into slot 1 cannot take the round away from the person playing.
- **Give both players the same game.** If your game generates content, seed it
  once and build it twice; sharing one mutable structure means the leader
  clears the course for whoever is behind.

The base class handles the rest. The countdown re-resolves the roster every
frame, so a friend arriving late is adopted and the clock rewinds to give them
a real start (`countdownRoster`); the tracker's slot ordering is frozen for the
duration of `playing`, so two players who walk around each other cannot swap
scores (`lockSlots`); and the results screen picks solo, versus or party
standings off `playerCount` and `partyMode`.

## API reference

### `shell/screen.ts`
```ts
interface FrameContext {
  time: number;   // seconds since app start
  dt: number;     // seconds, clamped to [0, 1/20]
  now: number;    // performance.now()
  v: Viewport;    // { width, height, dpr } in logical px
  ctx: CanvasRenderingContext2D;
  vision: VisionFrame | null;
}
```

### `engine/draw.ts`
```ts
vh(v, units)                                  // vh units -> logical px
drawText(ctx, text, x, y, { size, color?, font?, weight?, align?, baseline?,
                            glow?, glowColor?, letterSpacing?, alpha? })
measureText(ctx, text, size, weight?, font?)
roundRect(ctx, x, y, w, h, r)                 // path only, you fill/stroke
glowLine(ctx, points, { color, width, glow?, alpha?, cap? })
glowCircle(ctx, x, y, r, color, glow?, alpha?)
progressBar(ctx, x, y, w, h, t, color)
clearFrame(ctx, v, color?)

stickerPill / stickerCard / labelPill / rankedRow / decorShape   // the brand kit
```

`vignette()` and `scanlines()` still exist and DO NOTHING. They are gradients
and see-through overlays, which the brand rules out; they are kept as no-ops
only so nothing has to be deleted in a hurry. Do not call them.

### `shell/theme.ts`
`COLORS` — eight tokens, and only eight: `paper` `ink` `grid` `muted` +
`yellow` `blue` `green` `red`. The `bg*` / `text*` / `*Bright` / `danger` /
`success` names are LEGACY ALIASES that resolve to those eight; new code uses
the real names.

`PLAYER_COLORS[]`, `FACTION_COLORS[]`, `FONTS` (display/body/mono),
`EASE` (out/in/inOut/back/elastic), `WEIGHT`, `TYPE`, `TRACK`, `SHADOW`,
`STROKE`, `SPACE`, `RADIUS`, `dur()`, `ramp()`, `idlePulse()`.

`textColor(preferred, on?)` — **use this for any coloured text.** Flat yellow
on paper is 1.7:1 and simply gone at three metres, so yellow is a SURFACE and
never a text colour; this enforces it rather than relying on everyone
remembering.

`muted` is the kit's DISABLED colour at 1.88:1. It is for placeholders, empty
slots and switched-off things. It is not "secondary text" — `brand.test.ts`
fails the build on `color: COLORS.muted`. Secondary text is ink, made secondary
by SIZE and WEIGHT.

`withAlpha` and `lerpColor` exist for non-brand work only. A tint or a blend of
a brand colour is off-brand twice over: `lerpColor(blue, yellow)` renders as a
muddy green that is in no palette at all.

### `engine/juice.ts`
```ts
juice.shake(0..1)            juice.hitStop(ms)        juice.slowMo(scale, recover?)
juice.flash(color, a?, decay?)                        juice.chromatic(amount)
juice.impact(strength?, color?)   // standard "that landed" bundle
juice.celebrate(color)            // "new record", deliberately over the top

new RollingNumber(speed?)    // .set .add .update(dt) .value .isSettled .reset
new PopupLayer()             // .spawn(text, x, y, color, size, life?) .update .draw
```

### `engine/particles.ts`
```ts
particles.emit({ x, y, count, color, speed, speedVariance?, angle?, spread?,
                 size, sizeVariance?, life, lifeVariance?, gravity?, drag?, streak? })
BURST.splat(ps, x, y, color, scale?)      // slice / pop
BURST.celebrate(ps, x, y, colors[], scale?)
BURST.spark(ps, x, y, angle, color, scale?)
BURST.ambient(ps, x, y, color)
```
`particles.quality` (0..1) is managed by the watchdog — never set it yourself.

### `engine/audio.ts`
```ts
audio.play(name, pitch?)   // 'rep' 'slice' 'pop' 'bomb' 'tick' 'go' 'record'
                           // 'hover' 'select' 'eliminate' 'greenlight'
                           // 'redlight' 'whoosh' 'land'
audio.startMusic(bpm?)     audio.setMusicIntensity(0..1)     audio.stopMusic()
```
Add a new sound by extending the `SoundName` union and its `switch` case. Keep
it synthesised, weight it low (bass carries through crowd noise), and **never
gate gameplay information on audio** — the hall is loud.

### `core/tracker.ts`
```ts
interface TrackedPlayer {
  id: number;          // stable while this human is in frame
  slot: number;        // 0 = leftmost as the player sees themselves
  landmarks: Landmark[];  // One Euro filtered — use for positions
  raw: Landmark[];        // unfiltered — use for velocity / fast oscillation
  centroid: { x, y };  area: number;
  scale: { shoulderWidth, torsoHeight, unit, valid };
  confidence: number;  age: number;  missing: number;  confirmed: boolean;
}
```

**`scale.unit` is the only correct denominator for a threshold.** A distance of
`0.25` means "a quarter of a torso" and behaves identically for a 5'2" and a
6'4" player. Raw pixel or normalised-frame thresholds are a bug.

Landmarks are normalised 0..1 in camera space. **Y grows downward.**

### `core/gestures.ts`
`Hysteresis(enter, exit, invert?)`, `Baseline(rate?)`, `RepCounter`,
`VerticalGestures` (jump/crouch), `LaneDetector`, `MotionEnergy`, `TPoseDetector`.

Two rules, no exceptions:
- **Hysteresis on every gate.** A bare `a < b` fires 30×/sec at the boundary.
- **Every threshold divided by `scale.unit`.**

Fast oscillation (RepCounter, MotionEnergy) reads `player.raw`, not
`player.landmarks` — One Euro is a low-pass filter and removing high-frequency
motion is exactly what it does. This already caused one silent zero-score bug.

### `engine/projection.ts`
`Projection` maps normalised camera space to screen, handling mirroring and
aspect. `proj.x(nx)`, `proj.y(ny)`, `proj.len(n)`, `proj.point(p)`, `proj.rect`.
**The display is mirrored** — the player's right hand appears on the right of
the screen as they look at it.

### `meta/leaderboard.ts`
```ts
leaderboard.getBest(gameId)              leaderboard.getTop(gameId, n?)
leaderboard.previewRank(gameId, score)   // { rank, isRecord, pointsToNext, nextRank }
leaderboard.submit(gameId, score, initials, faction)
leaderboard.getFactionTotals()
```
Add your game's id to the `GameId` union.

## Testing

No camera needed:

```
http://localhost:5173/?sim=1
```

`core/simulator.ts` emits synthetic skeletons. In dev, `window.__arcade` exposes
`{ router, camera, vision, audio, simulator, screen, tick(frames, dt) }`.

`tick()` advances the app with a fixed clock, so game logic can be asserted
deterministically and at far faster than real time:

```js
const A = window.__arcade;
A.simulator.auto = false;
A.tick(240);                       // 4s -> through countdown into play
A.simulator.setPump(4, 1.0);       // 4 Hz, full reach
A.tick(300);                       // 5s
A.screen.scoreFor(0);              // expect exactly 40
```

Extend the simulator if your game needs a motion it can't produce yet. Make it
able to produce a *failing* version of the motion too, so anti-cheat and
rejection paths get exercised.

### Regression sweep

After any change, run the full sweep from the console on a `?sim=1` page:

```js
await window.__arcade.smoke()
```

It drives every game through a round and asserts mounting, **zero passive
score**, active scoring, finite integer scores, round termination, no console
errors, and frame budget. Add a probe in `src/dev/smoke.ts` when you add a game.
If mashing input is not competent play in your game, give the probe a `drive()`
closed-loop function rather than letting it flail.

Then the whole turn, which is the half smoke cannot see — attract, the menu
dwell, play, results, three letters on the initials keyboard, and back out:

```js
await window.__arcade.turn()
```

Every versus game runs TWICE, the second time with two bodies in frame, and
asserts the round opened two seats and that neither seat is stuck at zero.
That second pass exists because the two-player path shipped with three separate
faults — one score for six players, two walls punching holes in each other, and
a countdown that locked the roster before the second person could be admitted —
and not one of them is reachable with a single body.

**The simulator does not replace human playtesting.** It cannot tell us whether
a threshold is right for a real body under hall lighting. That is what the
Sept 19 / 20 / 22 sessions in PLAN.md §8 are for.

## If you change how a game scores

Bump that game's entry in `SCORING_VERSION` in `src/meta/ghosts.ts`.

Ghosts store the scoring version they were recorded under. If you change a
formula without bumping it, players race a ghost measured on a scale that no
longer exists — the number on screen is wrong and nothing errors. A version
mismatch deletes the stale ghost instead.

## Do not touch

- `src/main.ts` — screen registration is wired centrally to avoid conflicts.
  Export your class; it gets registered for you.
- `src/core/camera.ts`, `src/core/vision*.ts` — the camera and worker contract.
- `vite.config.ts`, `package.json`.

## What "good" means here

Every game is played once, for under a minute, by a stranger in a loud room who
is being watched by their friends, and who will not read anything.

- Legible in 3 seconds with **no instructions and no sound**.
- One number as the score. Comparable at a glance, shoutable across a room.
- Feedback on every single action — particles, shake, a popup, a pitch change.
- The thing to beat is visible *during* play, not only at the end.
- Failure should be funny, never punishing.
