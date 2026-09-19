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

Working on the code:

```bash
npm run dev
```

Running the stall:

```bash
npm run kiosk
```

Then open **http://localhost:5173** (dev) or **http://localhost:4173** (kiosk).

`kiosk` builds once and serves the built files. Use it on the day: the dev
server keeps a live-reload socket open to the page, so anything touching a file
on disk reloads the page — mid-round, with a player standing in front of it.

> The camera only works on `localhost` or over https. On plain `http://` with a
> LAN IP, `getUserMedia` is silently blocked — the app detects this and says so
> rather than showing a dead black screen.

### Without a camera

```
http://localhost:5173/?sim=1        # or :4173 under `npm run kiosk`
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
| `5` | Red Light, Green Light | 45s, up to **5 players**, 10s lobby |
| `6` | Pose Match | 60s, 1–2P |
| `7` | Runner | 60s, 1P, the only 3D game |

| Key | Action |
|---|---|
| `F` | Fullscreen |
| `C` | Toggle cursor (hide for kiosk) |
| `M` | Mute |

Sim only: `A` auto-demo · `P` pump · `↑`/`↓` pump rate · `V` 1P/2P · `Space` jump

The full loop runs itself: **attract → menu → game → results → initials → leaderboard → menu.**

## DAY-OF CARD — print this and tape it to the table

Everything a marshal needs. Nobody running the stall should have to read
anything else on this page.

### Cold start, in order

1. Plug the camera in **first**, then open the laptop.
2. Turn **sleep off** and **notifications off**. A notification banner lands on
   the TV; a sleeping laptop ends the stall.
3. Terminal: `npm run kiosk`
4. Chrome → `http://localhost:4173` → **Allow** camera.
5. Press **`1`** for RIG CHECK. Stand where a player will stand. Do not move on
   until the verdict is green and it says a full body is visible.
6. Press **`0`** for attract, then **`F`** (fullscreen), then **`C`** (hide the
   mouse pointer).

### If something is wrong

| What you see | What to do |
|---|---|
| Red **&lt;CAMERA LOST — RECONNECTING&gt;** bar at the top | Push the USB cable back in and **wait**. It is already retrying — 1s, 2s, 4s, 8s, then every 10s, forever. Most USB knocks come back inside two tries. |
| Red **&lt;CAMERA LOST — PRESS F5&gt;** bar at the top | It has been trying for half a minute and it is not coming back on its own. **F5**. If that fails, `?sim=1` (bottom row of this table). |
| Red **&lt;VISION OFFLINE — PRESS F5&gt;** bar at the top | The pose worker died, not the camera. **F5** — there is no auto-recovery for this one. |
| Nothing responds, screen looks frozen | **F5**, then **F**, then **C**. Fullscreen and the hidden pointer do NOT survive a reload. |
| Camera permission was refused | Press **F** to leave fullscreen, click the camera icon in Chrome's address bar, allow, then **F5**. |
| Someone is standing there and it says STAND IN FRAME | They are too far back or cropped. Move them to the tape. Press **`d`** to see why — the `framing` and `headroom` rows say which. |
| A game is behaving strangely and you need it back | **PANIC** in the operator console (below), or just **F5**. |
| Camera is dead and the queue is waiting | `http://localhost:4173/?sim=1` runs a demo with no camera. It starts **muted** — press **`M`**. |

### Prove it runs with no wifi — do this once, before Sept 24

The stall is designed for zero network calls (PLAN.md §1) and
`tests/offline.test.ts` holds that promise against the source on every commit.
But a test reads code, and the hall is a physical place, so prove it physically
**once** on the actual booth laptop:

1. `npm run setup`, then `npm run kiosk`.
2. **Unplug the ethernet and turn wifi off.** Not flight mode with wifi still
   on — off.
3. Hard-reload `http://localhost:4173` (**Ctrl+Shift+R**), so nothing is served
   from a warm cache.
4. Play one full turn: attract → menu → a game → initials → back to attract.
5. Open DevTools → Network, filter to `Fetch/XHR` and `Other`, and confirm
   every row is `localhost`.

If step 3 shows unstyled text, the fonts did not vendor — re-run
`npm run fetch-fonts`. If a game hangs on **LOADING VISION**, the wasm or the
models did not — re-run `npm run fetch-models`. Both live in `public/`, which
is deliberately not in git; a fresh clone that skips `npm run setup` has no
models at all.

> The 55MB in `public/` is the entire reason the stall survives venue wifi.
> Copy the folder with the repo if you move to another laptop on the day —
> re-downloading it in the hall is the exact situation this avoids.

### Why `npm run kiosk` and not `npm run dev`

`kiosk` builds once and serves the built files. `dev` runs Vite's development
server, which keeps a live-reload socket open to the page: if anything on disk
changes — an editor autosave, a sync client, somebody pulling a fix between
rounds — **the page reloads mid-round**, and the player loses their turn with
no explanation. It also serves 47 unbundled modules instead of two files.

Everything a marshal needs survives the build: `?sim=1`, the `d` overlay, the
operator console, every key below. The only thing missing is the `__arcade`
test harness, which is a development tool.

`dev` is still the right thing while working on the code.

### Keys

| Key | Does |
|---|---|
| `0` | Attract (the idle screen) |
| `1` | Rig check |
| `2`–`8` | Jump to a game |
| `F` | Fullscreen on/off |
| `C` | Hide/show the mouse pointer |
| `M` | Mute/unmute |
| `d` | Diagnostic overlay — works in the real build, on purpose |
| `CTRL+SHIFT+` `` ` `` | Operator console (the sliders) |

Number keys only jump screens from attract or the menu. **Mid-round you must
hold SHIFT**, so a bag on the keyboard cannot end somebody's turn.

### Two people can play — say it out loud

**Every game on the roster takes two.** Red Light takes six. The stall's own
signage says so now (the menu tiles carry a `1-2P` badge, Red Light says
`1-6P`), but the single most effective thing a marshal does is say "grab your
mate, you can both play".

How it works, so nobody has to explain it twice:

- After picking a game they get **JUST ME** or **VERSUS** (Red Light says
  **ALL OF US**). It answers itself after five seconds if nobody chooses, so
  it can never hold the queue up.
- **JUST ME** is the only one that changes anything: it caps the round at one
  player however many people are in frame. That is the answer to "my mate is
  standing next to me and I want my own score" — which the camera cannot work
  out on its own, and is the only reason the screen exists.
- **VERSUS** is split screen, one score each. If the second person is a beat
  behind, the countdown **waits for them**: a yellow `A FRIEND CAN STEP IN`
  badge is up while there is still time to act on it, and the clock rewinds
  when they arrive.
- When one of them goes ahead, the screen says so. That is the moment worth
  watching for.
- Only the **winner** enters initials, and that screen says whose name it
  wants. Two name entries per turn would double the slowest part of the flow.

Red Light also runs a real lobby before the countdown — it counts people in
and starts when nobody new has joined for a couple of seconds.

**If the queue is out the door**, set `ASK HOW MANY` to 0 in the operator
console. The screen disappears and the games go back to detecting two people
by themselves; they just cannot be told not to.

### Running a bracket

`CTRL+SHIFT+` `` ` `` → **BRACKET**. Type the players in three letters at a
time, pick a game, **START**. Duplicate initials are disambiguated for you
(`WAS`, `WAS·2`), so nobody has to be turned away for having a common name.

From then on the marshal's whole job is calling the next pair up — it is the
yellow line at the top of the tab, and it is also the headline on the attract
screen between rounds. **Results report themselves**: play the match as a
normal versus round and the bracket advances when the round ends.

- **A dead heat is NOT advanced.** The pair replay. Coin-tossing a tie in
  front of a crowd is indefensible.
- **UNDO** on any played match reverses it and everything that followed, for
  when the camera drops somebody mid-round.
- The bracket **survives a reload**, so an F5 mid-event costs nothing.

Three games are eligible — 67 Speed Duel, Pose Match and Fruit Ninja — because
a bracket wants short, loud, head-to-head matches.

### The mouse works too

Move the trackpad and the hand cursor follows the mouse for 2.5 seconds, then
hands back to the player. A click selects immediately, with no dwell. On the
initials screen you can just **type** — A–Z, Backspace, Enter.

### Fair mode — when the queue is out the door

**GAMES ON THE MENU** in the operator console (STALL CONTROL) cuts the menu
down. 0 is all seven; set **3** or **4** on a busy afternoon.

Choosing is dwell time and dwell time is time nobody is playing, so this buys
back a few seconds on every single turn. It also makes each tile more than
twice the area, which makes a mis-pick — the thing that costs a *whole* turn —
much less likely.

It shows the first N games in menu order, playable ones only, and re-shapes the
grid (4 games become 2x2, 3 become one row of 3). Put it back to 0 between
rushes.

### The only three sliders worth touching

Open the operator console (`CTRL+SHIFT+` `` ` ``), **STALL CONTROL** group:

- **ROUND LENGTH** — drop it to 0.7 when the queue is long. This is the biggest
  lever on throughput by a distance.
- **IDLE TIMEOUT** — how long a deserted game waits before going back to attract.
- **MIN BODY SIZE** — raise it if people standing in the queue behind the player
  are being picked up as players.
- **ASK HOW MANY** — set it to 0 when the queue is out the door. It drops the
  JUST ME / VERSUS screen and saves a few seconds a turn; the games still
  detect two people by themselves, they just cannot be told NOT to.

If Red Light specifically is misbehaving: **MOVE THRESHOLD** (raise it if people
are eliminated while standing still) and **STOPPING GRACE** (raise it if people
are caught while visibly already stopping).

**Before the doors open, press RESET ALL TUNING** — and **RESET BRACKET** if
one was ever started. Both are saved in the browser and survive a reload, so a
laptop used for tuning last week will otherwise still be running last week's
numbers, and a half-finished bracket from a rehearsal will sit on the attract
screen all morning.

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
  games/     base (round lifecycle) + 7 games + geometry + poses + runner-world
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
| **Red Light, Green Light** | playable, up to 5, with lobby |
| **Pose Match** | playable 1P/2P, 12 poses |
| **Runner** | playable, 3D, **conditional — see go/no-go below** |
| **Rhythm Punch** | playable 1P/2P, generated beat maps |
| Ghosts, highlight clips, operator console | done |
| Tournament bracket | **built but unreachable — see Known gaps** |
| Photobooth | deferred |

### Verified in the simulator

All driven deterministically via `window.__arcade.tick()`:

- **67**: 4 Hz full reach × 5s = **exactly 40 reps**; 1.5 Hz × 4s = **exactly 12**;
  quarter-height twitching at the same rate = **0** (anti-cheat holds)
- **Fruit Ninja**: hands still = **0** (activation gate); swiping sliced 11 with
  halves in flight. 23 unit tests on the slice geometry — area conserved across
  30 shapes × 12 cut angles, convex across 60 seeds, fast-swipe tunnelling caught.
  Incentive matrix, full rounds at a forced 1280×720: **fast+wide 285,
  medium+wide 165, slow+wide 130, fast+narrow 50, frantic+narrow 45**. Big
  committed swings win, and mashing *harder* pays *less* — which is the shape it
  should be
- **Balloon Pop**: hands down = **0**; hand on an armed balloon = **+66**; hand on
  a balloon below the shoulder line = **+0**
- **Red Light**: 0 false eliminations in a full 45s round; progress gained only
  during green (0.00% change during red); body-scale fair to ~2% across a 1.6×
  height ratio.

  **Reaction time: the survive/eliminate cliff is 500–650 ms** — 500 survives,
  650 is out, measured over full rounds rather than single transitions (a round
  has 10+ transitions and you only have to be slow once). Simple visual
  reaction is ~250 ms *before* recognising the change and stopping a moving
  body, so most first-timers clear this.

  This figure is newer than it looks. `graceSec` was widened 0.4 → 0.55 days
  ago and documented here as being in effect, but `tunables.get()` returns the
  registry default and ignores the caller's fallback for any registered key —
  so the game went on reading 0.4, and every earlier reaction figure in this
  file was measured against a grace window the code no longer claimed to have.
  Reconciled and re-measured; the old cliff was 400–500 ms.

- **Pose Match**: all 12 poses score >0.998 when matched; scale/position
  invariance **5.55e-16** across a 2.19× body-size range; max pose confusion 0.651.
  Closed-loop, feeding each wall's own angles back to the simulator: **16 of 17
  walls cleared at 100% accuracy**. Reaction tolerance, delaying the pose after
  each wall spawns: **0–1500 ms loses nothing, 2500 ms clears 12/17, 3500 ms
  clears 4/16** — forgiving for a first-timer, punishing only if you dawdle
- **Rhythm Punch**: the filtered wrist trails the raw one by **4 frames / 67 ms**
  with amplitude attenuated to **65.5%**, measured by cross-correlation over 600
  frames of a 2 Hz sweep. Judgement is now shifted back by that latency; the
  note's drawn position is not, so notes still cross the strike line on the beat
- **Runner**: **33,958 generated rows across 600 runs, 0 unclearable**; detection
  latency 0.100s ± 0.001; 48 WebGL mount/unmount cycles never leaked a context.
  **Lane change fires at 0.6 torso units of side-step (~30 cm)** — a normal
  step. Before the aspect correction the same threshold demanded 0.55 × 1.78 =
  0.98 torso (~49 cm), a lunge, which is why it read as "didn't detect
  movement" on a real body
- **Shell**: dwell commits at exactly 1.2s and not before; COMING SOON tiles inert
  after 4× the dwell; initials entry 6.0s new / 4.3s repeat; auto-accept fires at 16s.
  Menu now escapes a present-but-non-gesturing player to attract at **31.7s**
  (measured); solo Red Light's lobby is **2.63s**, down from a flat 10s
- **One Euro lag and attenuation**, cross-correlating the filtered wrist against
  the raw one over 600 frames. This is the number that matters for anything
  judged in time rather than space:

  | Sweep rate | Lag | Amplitude kept |
  |---|---|---|
  | 1.0 Hz | 83 ms | 0.84 |
  | 2.0 Hz | 67 ms | 0.66 |
  | 3.5 Hz | 50 ms | 0.46 |

  Beta is doing its job on lag — faster motion is tracked with *less* delay. But
  attenuation gets worse with speed, so a fast slash's blade tip travels under
  half the distance the real hand does. That is survivable because the drawn
  trail and the hit test read the *same* filtered data, so the game stays
  internally consistent and players aim with the on-screen blade. It is NOT
  survivable in Rhythm Punch, where judgement is in milliseconds — hence
  `rhythm.inputLatencySec`.

### Testing hazards

Two things in this repo will hand you a confident wrong answer. Both cost real
time; neither is a bug.

- **The simulator's neutral arms are RAISED.** A sim body at rest puts its
  wrists **0.21–0.24 torso units below the shoulder** — roughly chest height. A
  real person's resting wrist is nearer 1.0. `hover.ts`'s raise gate opens at
  0.35, so the default sim pose drives a live cursor and will dwell-select a
  menu tile in a few seconds. That looks exactly like the idle-select bug fixed
  in `a815650` and is not. To test anything that depends on arms being DOWN,
  pin them: `simulator.setWristTargetAll('left', {x: 0.40, y: 0.66})` and the
  same for `'right'`. Remember to `clearWristTargets()` afterwards — pinned
  wrists override pump and swipe, and will fail the whole smoke sweep.
- **A HIDDEN browser pane invalidates `smoke()`.** The sweep `await`s between
  phases, and the app's own rAF loop keeps advancing the round during those
  waits. With the pane visible that is a few frames; hidden, the browser
  throttles rAF and each wait costs seconds of wall clock, so a long round can
  finish before the probe measures it. The Runner fails first — 60s round, and
  it accrues score on its own — presenting as `reaches playing: state=results`
  and `active scores above idle: 578 -> 578`. `tick()` itself is exact (60
  ticks = 1.000s, verified); it is the real time BETWEEN ticks that leaks.
  Bring the pane forward before trusting a sweep, or drive the probe phases in
  a single uninterrupted call.
- **`import('/src/meta/highlights.ts')` from the dev console is a DIFFERENT
  module.** Vite appends an HMR timestamp to module URLs it has reloaded, so a
  bare dynamic import constructs a second instance: `source` null, every counter
  zero. It reads precisely like "instant replay is dead". The live instances are
  on `window.__arcade` — use those.

**None of this replaces human playtesting.** It cannot tell us whether a
threshold is right for a real body under hall lighting. That is what the
Sept 19 / 20 / 22 sessions in PLAN.md §8 are for.

### The numbers that have never seen a real body

Every one of these is tuned against a noiseless simulator and is a playtest job:

| Constant | Where | Risk |
|---|---|---|
| `REACH_X = 1.7` shoulder widths | `shell/hover.ts` | Too generous → corner tiles need a stretch. Too tight → cursor pins to edges. **Highest-value tune on Sept 19.** |
| `moveEnter = 0.85` | `games/redlight.ts` | MediaPipe noise at 3m under hall lighting is unknown. Too low → everyone out in 2s, unrecoverable at a stall. |
| `0.66` match threshold | `games/poses.ts` | Only 0.07 headroom over the worst confusable pair (was 0.72; lowered after a game-feel review, because real jitter pulls scores DOWN and the error that actually happens is rejecting a pose the player hit). |
| `inputLatencySec = 0.067` | `games/rhythm.ts` | **Measured for the One Euro filter alone** — a real camera adds capture and inference, so the true figure on the night is higher, not lower. It is 61% of the ±110 ms perfect window, so this is the single most sensitive timing number in the app. Tune by punching deliberately early and late and checking the grades come out symmetric. |
| `DEFAULT_CLEARANCE` | `games/runner-world.ts` | The clearability proof is exact at the modelled body and no further: a body 20% slower fails 143 of 200 runs. |

### Known gaps — decisions, not bugs

Found by review and left deliberately. Each needs a call, not a patch.

- **The tournament bracket is unreachable.** `src/meta/tournament.ts` is ~710
  lines, fully built and covered by 56 tests, and `drawBracket` has exactly one
  reference in the whole tree: its own definition. No `'tournament'` screen is
  registered in `main.ts`, and nothing calls `start()` or `addPlayer()`.
  PLAN.md §4's "opt in via the menu, bracket on the attract screen" was never
  wired. Either wire it or cut it — but it currently ships as dead weight.
- **Highlight clips never reach a passer-by.** `attract.ts` imports nothing from
  `meta/highlights.ts`, so a clip only ever replays on the same player's own
  results screen, seconds after their own round. PLAN.md §6 wanted them looping
  on attract to pull foot traffic. Only one clip buffer exists at a time, so
  this needs a small backlog before it can be built.
- **Roster redundancy.** Fruit Ninja, Balloon Pop and Rhythm Punch all run on
  the same blade primitive — three of seven games share one input. The game-feel
  review's call, if a cut is forced: trim the **Runner** first (already
  pre-authorised in PLAN.md), because Balloon Pop's zero-coordination floor is a
  niche nothing else on the roster covers.
- **Every abandoned initials entry defaults to `AAA`.** A queue that mostly
  walks away after seeing its score will fill the boards with indistinguishable
  rows, which undercuts the rivalry the leaderboard exists to create.

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
