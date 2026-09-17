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
      maxPlayers: 1,
      roundSeconds: 30,
      color: COLORS.green,
      supportsVersus: false,
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
progressBar(ctx, x, y, w, h, t, color, glow?)
clearFrame(ctx, v, color?)
vignette(ctx, v, strength?)
scanlines(ctx, v, alpha?)
```

### `shell/theme.ts`
`COLORS` (blue red yellow green + `*Bright` + bg/bgRaised/text/textDim/textFaint/danger/success),
`PLAYER_COLORS[]`, `FONTS` (display/body/mono), `EASE` (out/in/inOut/back/elastic),
`withAlpha(hex, a)`, `lerpColor(a, b, t)`.

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
