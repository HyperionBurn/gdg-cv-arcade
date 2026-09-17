# GDG Motion Arcade

Computer-vision games for the GDG club fair stall, **Sept 24 & 26**.
Design and scope live in [PLAN.md](PLAN.md).

## Setup

```bash
npm install && npm run setup
```

`setup` downloads the MediaPipe models (~22MB), the WASM runtime and the fonts
into `public/`. **This is a one-time step and it matters**: nothing is loaded
from a CDN at runtime, so the stall works with no wifi (PLAN.md §1).

## Run

```bash
npm run dev
```

Then open **http://localhost:5173**.

> The camera only works on `localhost` or over https. On plain `http://` with a
> LAN IP, `getUserMedia` is silently blocked — the app detects this and says so
> rather than showing a dead black screen.

### Without a camera

```
http://localhost:5173/?sim=1
```

Runs a synthetic skeleton instead of camera + MediaPipe. Useful for working on
game logic, and it doubles as a demo mode if the camera dies at the stall.

## Screens

| Key | Screen | |
|---|---|---|
| `0` | **Attract** | live silhouette, leaderboard, faction totals — the kiosk entry point |
| `9` | **Menu** | hand-hover tiles, dwell to select |
| `1` | **Rig Check** | the camera test tool — read the section below |
| `2` | 67 Speed Duel | 20s, 1–2P split screen |
| `3` | Fruit Ninja | 45s, 1–2P split screen |
| `4` | Balloon Pop | 30s, 1–2P, the accessible one |
| `5` | Red Light, Green Light | 45s, up to **6 players**, 10s lobby |
| `6` | Pose Match | 60s, 1–2P |
| `7` | Runner | 60s, 1P, the only 3D game |

| Key | Action |
|---|---|
| `F` | Fullscreen |
| `C` | Toggle cursor (hide for kiosk) |
| `M` | Mute |

Sim only: `A` auto-demo · `P` pump · `↑`/`↓` pump rate · `V` 1P/2P · `Space` jump

The full loop runs itself: **attract → menu → game → results → initials → leaderboard → menu.**

## Rig Check — read this before Sept 18

This is the tool for the camera test in PLAN.md §8, the **first immovable date**.
It answers, in the real room:

- **Is the whole body in frame?** Green/red verdict with a specific fix
  ("too close — step back about a metre", "tilt the lid back").
- **How far back must the player stand?** Live torso-size readout.
- **Laptop cam vs iPhone Continuity?** Switch devices from the panel, compare.
- **Does the tracker hold identities?** Set 2 players, cross over — the box
  colours must not swap.
- **Do gestures fire for different bodies?** Live JUMP / CROUCH / LANE / REPS /
  MOTION readouts. Get several heights in front of it.
- **Is this laptop fast enough?** Inference fps, latency, delegate.

When it reads **FULL BODY ✓**, tape the floor there and fix the lid angle. That
mark is the most valuable artefact of the whole test.

## Layout

```
src/
  core/      camera, MediaPipe worker, tracker, One Euro filter,
             gestures, blades, simulator
  engine/    draw, projection, skeleton, juice, particles, procedural audio
  games/     base (round lifecycle) + 6 games + geometry + poses + runner-world
  meta/      leaderboard, factions
  shell/     theme, router, attract, menu, hover, initials, rigcheck
scripts/     one-time model + font fetch
tests/       node --test, no browser needed
```

`ARCHITECTURE.md` is the contract for adding a game.

## Checks

```bash
npm run typecheck    # strict, noUncheckedIndexedAccess
npm test             # headless unit tests, no browser
npm run build
```

### Regression sweep

With the app open on any `?sim=1` page, in the browser console:

```js
await window.__arcade.smoke()               // every game
await window.__arcade.smoke(['redlight'])   // just one
```

Drives each game through a full round and asserts the things the stall actually
depends on:

- mounts and reaches `playing` without throwing
- **passive scoring is zero** — a player who stands still and does nothing must
  score 0. This is the check that caught Balloon Pop awarding 36 points to a
  motionless player.
- active play scores above idle
- the score is a finite integer (a `NaN` renders as "NaN" on a TV in front of a queue)
- the round terminates in `results` rather than hanging
- nothing hits `console.error`
- frame cost inside budget

Red Light has a closed-loop driver: mashing input there is not competent play,
it is instant elimination, so the probe reads the light and freezes on red.

Baseline (all six passing): 67 0.33ms · Balloon Pop 0.59ms · Runner 0.93ms ·
Red Light 0.98ms · Pose Match 0.49ms · Fruit Ninja 3.52ms per frame.

## Status

| Area | State |
|---|---|
| Core pipeline | done — camera, worker, tracker, filter, gestures, blades |
| Engine | done — juice, particles, procedural audio, projection |
| Shell | done — attract, menu, hover cursor, initials, rig check |
| Leaderboard + factions | done, wired end to end |
| **67 Speed Duel** | playable 1P/2P |
| **Fruit Ninja** | playable 1P/2P, real polygon slicing |
| **Balloon Pop** | playable 1P/2P |
| **Red Light, Green Light** | playable, up to 6, with lobby |
| **Pose Match** | playable 1P/2P, 12 poses |
| **Runner** | playable, 3D, **conditional — see go/no-go below** |
| Rhythm Punch | not started |
| Tournament bracket, ghosts, highlight clips, operator console | not started |
| Photobooth | deferred |

### Verified in the simulator

All driven deterministically via `window.__arcade.tick()`:

- **67**: 4 Hz full reach × 5s = **exactly 40 reps**; 1.5 Hz × 4s = **exactly 12**;
  quarter-height twitching at the same rate = **0** (anti-cheat holds)
- **Fruit Ninja**: hands still = **0** (activation gate); swiping sliced 11 with
  halves in flight. 23 unit tests on the slice geometry — area conserved across
  30 shapes × 12 cut angles, convex across 60 seeds, fast-swipe tunnelling caught
- **Balloon Pop**: hands down = **0**; hand on an armed balloon = **+66**; hand on
  a balloon below the shoulder line = **+0**
- **Red Light**: 0 false eliminations in a full 45s round; freeze at
  0/350/400/500 ms survives, 600/900/1200 ms is out; progress gained only during
  green (0.00% change during red); body-scale fair to ~2% across a 1.6× height ratio
- **Pose Match**: all 12 poses score >0.998 when matched; scale/position
  invariance **5.55e-16** across a 2.19× body-size range; max pose confusion 0.651
- **Runner**: **33,958 generated rows across 600 runs, 0 unclearable**; detection
  latency 0.100s ± 0.001; 48 WebGL mount/unmount cycles never leaked a context
- **Shell**: dwell commits at exactly 1.2s and not before; COMING SOON tiles inert
  after 4× the dwell; initials entry 6.0s new / 4.3s repeat; auto-accept fires at 16s

**None of this replaces human playtesting.** It cannot tell us whether a
threshold is right for a real body under hall lighting. That is what the
Sept 19 / 20 / 22 sessions in PLAN.md §8 are for.

### The numbers that have never seen a real body

Every one of these is tuned against a noiseless simulator and is a playtest job:

| Constant | Where | Risk |
|---|---|---|
| `REACH_X = 1.7` shoulder widths | `shell/hover.ts` | Too generous → corner tiles need a stretch. Too tight → cursor pins to edges. **Highest-value tune on Sept 19.** |
| `moveEnter = 0.85` | `games/redlight.ts` | MediaPipe noise at 3m under hall lighting is unknown. Too low → everyone out in 2s, unrecoverable at a stall. |
| `0.72` match threshold | `games/poses.ts` | Only 0.07 headroom over the worst confusable pair. Real jitter pulls scores down — expect to lower it. |
| `DEFAULT_CLEARANCE` | `games/runner-world.ts` | The clearability proof is exact at the modelled body and no further: a body 20% slower fails 143 of 200 runs. |

### Runner go/no-go — Sept 21

PLAN.md §3 flags the Runner as most likely to be cut. The build is good, but the
jump window is **0.37–0.45s minus 0.10s of unavoidable detection latency**, which
is rhythm-game tight for a body under hall lighting.

**The test:** five people, count hit rate on `low` (jump) obstacles specifically,
not overall. If a first-timer's jump success is under ~60%, **don't cut the
game** — set the `low` weight in `TrackGenerator.pickKind` to near zero and ship
it as lanes + slides. One line, no new art, and both remaining obstacle types
measured comfortable.

### Perf note to re-take on real hardware

Three `shadowBlur` hot spots were found and fixed (`drawPose`, `drawHand`,
`ParticleSystem.drawGlow`) — canvas charges the blur *per stroke*, so attract
mode was costing 92.8 ms/frame at 4 players. Now ~0.8 ms under a worse load.

But every measurement here was taken in a 305px-wide preview pane. **The
full-screen blit and bloom are fill-rate bound and must be re-measured on the
actual laptop driving the actual TV at the Sept 23 rehearsal.** If it bites, the
frame-budget watchdog already sheds bloom automatically.
