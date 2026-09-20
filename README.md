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
| Red **&lt;VISION OFFLINE — PRESS F5&gt;** bar at the top | The pose worker died, not the camera. **F5** — the worker does not restart itself. But the SCREEN does: with no poses at all the shell walks itself back to attract in under 30s (round ends, initials times out, attract). So you have a stall that cannot see anybody, not a frozen one — finish serving the person in front of you before you reload. |
| Nothing responds, screen looks frozen | **F5**, then **F**, then **C**. Fullscreen and the hidden pointer do NOT survive a reload. |
| Camera permission was refused | Press **F** to leave fullscreen, click the camera icon in Chrome's address bar, allow, then **F5**. |
| Someone is standing there and it says STAND IN FRAME | They are too far back or cropped. Move them to the tape. Press **`d`** to see why — the `framing` and `headroom` rows say which. |
| Red **NOT SAVING** chip in the operator console, or on the `d` overlay | **Do not reload, and tell someone.** Everything is running from memory — play is unaffected and ranks are correct, but an F5 throws the day away. Go to **DATA** now and press every EXPORT button there, while the data still exists — **EXPORT BRACKET JSON** first if a bracket is running, because scores and tuning can be reconstructed by asking people and who beat whom cannot. Usually a full disk or a locked-down browser profile. The chip names whichever stores are affected — **TUNING** appears first if it is going to, since sliders save on every move, the bracket on every reported match, and scores only on a submit. |
| Replays stopped, or the `replay` / `reel` row on **`d`** says SHED or OFF | **Not urgent, and not your fault.** Capture measures its own cost and gives itself up rather than letting the screen stutter — the attract reel goes first, then the clip resolution, then instant replay. Nothing a player is waiting for is affected. If you want it back, operator console → **DATA** → **REPLAYS & ATTRACT REEL** → **TURN REPLAYS ON**, which also resets the shed and revives the reel. If it sheds again within a few minutes, this laptop cannot afford it — leave it off and stop thinking about it. |
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
| `9` | Back to the menu — the light way out of a game that is misbehaving |
| `F` | Fullscreen on/off |
| `C` | Hide/show the mouse pointer |
| `M` | Mute/unmute |
| `d` | Diagnostic overlay — works in the real build, on purpose |
| `CTRL+SHIFT+` `` ` `` | Operator console (the sliders) |

Number keys only jump screens from attract or the menu. **Mid-round you must
hold SHIFT**, so a bag on the keyboard cannot end somebody's turn.

### Two people can play — say it out loud

**Every game on the roster takes two.** Red Light takes five. The stall's own
signage says so now (the menu tiles carry a `1-2P` badge, Red Light says
`1-5P`), but the single most effective thing a marshal does is say "grab your
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
- The countdown shows **PLAYER 1** and **PLAYER 2** plates, one on each half,
  with a line between them and `ONE EACH SIDE` underneath. Point at it if a
  pair are bunched in the middle — that is the one mistake that makes two
  people share a slot or swap scores mid-round.
- When one of them goes ahead, the screen says so. That is the moment worth
  watching for.
- Only the **winner** enters initials, and that screen says whose name it
  wants. Two name entries per turn would double the slowest part of the flow.
- Anybody who does not want to be on the board can hover **SKIP** — the OK key
  says SKIP until a letter is typed. Their score is still recorded, just
  without a name, and it takes one dwell instead of the 16-second deadline.

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

### The only sliders worth touching mid-event

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

### Packing up — two exports, and one of them is the only copy

`CTRL+SHIFT+` `` ` `` → **DATA**. Do this before the laptop goes anywhere.

1. **EXPORT SCORES JSON.** Every board, every faction total, every play count.
   This is the post-event writeup (PLAN.md §4) and it is **the only copy** — it
   lives in this browser profile on this laptop and nowhere else. A cleared
   profile, a different browser, a borrowed laptop, or somebody pressing
   CLEAR EVERYTHING loses the whole day with no way back. **CLEAR EVERYTHING
   now also wipes the ghost runs**, which is what makes it safe to press
   before the doors open: it used to leave them, so the first real player of
   the day raced an invisible best from the rig check while the board beside
   them said BE THE FIRST!
2. **EXPORT TUNING JSON.** Every threshold as you left it. This is the handover
   between the 24th and the 26th: drop it back in on day 2 and you start where
   day 1 finished instead of re-learning the room.

Then **leave the bracket and the boards alone**. Day 2 starting with day 1's
leaderboard is a feature — "the thing to beat" is more interesting on the
second day, and the faction race only means anything if it accumulates.

> If you are moving to a different laptop for day 2, the exports are not enough
> on their own: copy the whole repo folder, `public/` included. That is the
> 55MB of models and fonts, and re-downloading it in the hall is exactly what
> the offline check exists to avoid.

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

### Are the guards real?

`tests/brand.test.ts` and `tests/offline.test.ts` enforce the brand and the
no-network rule by scanning source. A scanning test that matches nothing passes
exactly like one that matches everything, so green is not evidence it works.

```bash
python scripts/verify-guards.py
```

It injects each violation in turn, requires the suite to FAIL, and restores.
Run it after touching either file. Every guard currently reports `CAUGHT`.

This is not hypothetical. Two guards written on Sept 19 passed vacuously, and
one of them was hiding a live bug — a colour map pointing `good` at
`COLORS.muted`, which put Rhythm's `<GOOD>` flash and its `+N` popup at 1.88:1.

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

- **Degraded hardware.** Four camera shapes — 0×0 (what a failed camera
  reports), 640×480, 1920×1080 and an odd 1280×960 — all play a round through
  with a finite score and no errors; the projection's `|| 1280` fallback holds.

  And the one that decides whether a marshal reloads mid-queue: with poses
  stopping dead in the middle of a round, the shell does NOT strand the screen.
  The round reaches results in 3s, initials times out, and it is back on
  attract 28.7s later, with nothing in the console. A dead vision worker leaves
  a stall that cannot see anybody rather than a frozen one.

- **Audio, including its absence.** All twenty sounds played muted and unmuted
  (forty calls, zero throws), music started, ramped, silenced and stopped. Then
  the case that actually matters at a stall: with the `AudioContext` removed
  entirely — no speaker, or a machine that refuses one — a full 67 Speed round
  still plays start to finish and scores, with no errors. PLAN.md §11 has the
  Bluetooth speaker as an open item that "has to be someone's own", so turning
  up without one is a live possibility and it costs nothing but the sound.

- **The two controls a marshal reaches for when it is going wrong**, exercised
  end to end 2026-09-19:

  **The mid-round key guard holds.** A bare number key during a live round does
  nothing — a bag or an elbow on the keyboard cannot end somebody's turn.
  `SHIFT` + the same key jumps as documented.

  **PANIC does what the card says.** From a live Rhythm round: audio muted,
  effects floored, back to attract, console closed so the screen looks
  deliberate again. Reopening shows `PANIC ACTIVE — audio muted, effects at
  minimum, returned to attract`, so the next marshal is never left wondering
  why the stall is silent. RECOVER clears it and leaves no tuning override
  behind.

- **Endurance, Sept 19 (after the day's changes):** `__arcade.turn()` five
  times, **65 full turns**, attract → menu → game → initials → out, alternating
  1P and 2P across all seven games. **0 failures.** JS heap across the five
  passes: **88, 90, 96, 93, 99 MB** — it sawtooths rather than climbing
  monotonically (pass 4 came back down), and one `<canvas>` remains in the DOM
  throughout, so the Runner's WebGL context is not being re-created per round.

  Not flat, and not claimed to be: the band drifts ~11MB over 65 turns. A fair
  day is roughly 360 turns, so a linear extrapolation lands near 150MB, which
  a booth laptop will not notice. Re-take this if anything starts allocating
  per frame.

- **Production build**, `npm run kiosk` on 4173: all four Archivo weights fetch
  and report `loaded`, canvas text measures as Archivo rather than the
  fallback, `?sim=1` and the `d` overlay both work, `window.__arcade` is
  correctly absent, frame time **6.0ms**.

  **And zero external requests.** Re-checked on the final build of the day by
  filtering `performance.getEntriesByType('resource')` for anything not on
  `location.origin`: the list is empty. That is the step-5 check from "Prove it
  runs with no wifi" done programmatically, in the bundle a marshal actually
  runs, rather than by reading the source. It does not replace pulling the
  ethernet out on the booth laptop — a dependency could still reach for the
  network on a code path this session never took — but it is the strongest
  evidence available without the physical test.

- **The failure screen itself, 2026-09-20 — it was unreadable, in production,
  and every automated check was green.** With the camera denied, the built app
  correctly shows `<CAMERA ERROR>`, the cause in plain English, and a
  `<TRY AGAIN>` button. It rendered **#111111 on #000000**: headline
  **1.11:1**, detail line **2.82:1**, against floors of 3:1 and 4.5:1. The
  yellow button was the only legible thing on the screen, which is exactly why
  it read as styled rather than as broken.

  `#stage` is created with `getContext('2d', { alpha: false })`, and an opaque
  2D canvas initialises to SOLID BLACK rather than transparent. It covers the
  paper-white `body` until the render loop paints a screen — and `showBoot()`
  is called on the paths where the render loop never got there.

  **Worth knowing for the next one of these:** walking the DOM for the first
  painted ancestor REPORTS IT AS FINE. The computed cascade says
  `rgb(255, 255, 255)` from BODY and a comfortable 18.88:1, because the black
  is in a `<canvas>` and not in anybody's `background-color`. Sampling the
  canvas with `getImageData` returned `[0, 0, 0, 255]`. Screenshot the thing.

  Fixed by giving `.boot` its own `background: var(--paper)`; guarded by
  "the boot overlay paints its own background" in `tests/brand.test.ts`, which
  reads styles.css and main.ts TOGETHER, because neither file is wrong alone.

- **67**: 4 Hz full reach × 5s = **exactly 40 reps**; 1.5 Hz × 4s = **exactly 12**;
  quarter-height twitching at the same rate = **0** (anti-cheat holds)
- **Fruit Ninja**: hands still = **0** (activation gate); swiping sliced 11 with
  halves in flight. 23 unit tests on the slice geometry — area conserved across
  30 shapes × 12 cut angles, convex across 60 seeds, fast-swipe tunnelling caught.
  Incentive matrix, full rounds at a forced 1280×720: **fast+wide 285,
  medium+wide 165, slow+wide 130, fast+narrow 50, frantic+narrow 45**. Big
  committed swings win, and mashing *harder* pays *less* — which is the shape it
  should be
- **Balloon Pop**: hands down = **0** (re-confirmed 2026-09-19 after the HUD
  shelf landed). The per-hand figures that used to sit here — "+66 on an armed
  balloon, +0 below the shoulder line" — have been replaced by
  `tests/balloonpop.test.ts`, which checks the rule itself rather than one
  sample of it. They could not be re-run: `PoseSimulator` eases a wrist toward
  a target over several seconds and cannot place it at a chosen point, so
  driving a hand onto a specific balloon is not something the harness can do,
  and a measurement nobody can repeat is a claim rather than a check.
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

### Which rules are tested, and which were only ever measured

Surveyed 2026-09-19, game by game, after finding that Balloon Pop's arming
line — the rule that stops the game playing itself — rested on a measurement
nobody could reproduce.

| Game | Core rule | Was |
|---|---|---|
| 67 Speed | anti-cheat: still body, twitching, hostile noise | **tested** (15) |
| Pose Match | the pass decision, at every point on the ramp | **tested** (25) |
| Runner | lane: 20cm lean vs 10cm weight-shift, two minutes still | **tested** (19) |
| Balloon Pop | the arming line | measurement only → **tested** |
| Red Light | elimination | tolerant smoke probe only → **tested** |
| Fruit Ninja | bomb cost | measurement only → **tested** |
| Rhythm | hit judging and latency sign | chart tested, judging not → **tested** |

Four were already sound. Three had real gaps, and in each case the rule was
extracted into a pure function the game itself calls — `isPoppable`,
`judgeRedLight`, `bombPenalty`, `judgeOffset` — so the test and the game
cannot drift apart. Same move as `laneScore`, and for the same reason.

The pattern worth remembering: a rule with a MEASUREMENT next to it reads as
covered and is not. A measurement is a reading taken once, on a build that no
longer exists, by a method that may no longer be possible — Balloon Pop's could
not be re-run at all, because the simulator cannot place a wrist at a chosen
point.

### The numbers that have never seen a real body

Every one of these is tuned against a noiseless simulator and is a playtest job.
**Every one is also a slider** — checked 2026-09-19, none of them needs a
rebuild to change, which is the whole point of them being on this list:

| Constant | Where | Risk |
|---|---|---|
| `REACH_X = 1.7` shoulder widths | `shell/hover.ts` (slider: **REACH — SIDEWAYS**) | Too generous → corner tiles need a stretch. Too tight → cursor pins to edges. **Highest-value tune on Sept 19.** |
| `moveEnter = 1.1` torso/s | `games/redlight.ts` | MediaPipe noise at 3m under hall lighting is unknown. Too low → everyone out in 2s, unrecoverable at a stall. This is the FLOOR in a silent room; the live threshold is this plus STILL MARGIN × the noise the lobby measured, so the other two Red Light sliders track a noisy one. Slider: **MOVE THRESHOLD**. |
| `0.66` match threshold | `games/poses.ts` (sliders: **MATCH THRESHOLD**, **MATCH THRESHOLD — LAST WALL**) | Only **0.009** headroom over the worst confusable pair — GOALPOST/FLEX at 0.651 — which is the tightest margin of any constant in this app. **This row said 0.07 until 2026-09-20, which was the headroom at the OLD gate of 0.72**: the value was lowered after a game-feel review and the risk beside it was not. Lowering it further makes those two poses interchangeable. The direction is still defensible — real jitter pulls scores DOWN, so the error that actually happens is rejecting a pose the player hit — but it is being bought out of 0.009, not 0.07. |
| `inputLatencySec = 0.067` | `games/rhythm.ts` (slider: **PUNCH LATENCY**) | **Measured for the One Euro filter alone** — a real camera adds capture and inference, so the true figure on the night is higher, not lower. It is 61% of the ±110 ms perfect window, so this is the single most sensitive timing number in the app. Tune by punching deliberately early and late and checking the grades come out symmetric. |
| `HIT_RADIUS_TORSOS = 0.3` | `games/rhythm.ts` (slider: **PUNCH REACH**) | Came straight from a playtest: at 0.5 a tester reported hits landing on "a target that is far away" AND inconsistent perfect timing — both halves of one number. Targets for one hand sit **0.3625** apart, so at or above that a single fist position is live for several of them; the slider stops at 0.36 for that reason. It is also a SPEED-DEPENDENT timing error — contact fires the instant the swept segment crosses the circle — so raising it judges a fast punch earlier than a slow one. Raise only if people cannot land anything, and expect the grades to skew early. |
| `DEFAULT_CLEARANCE` | `games/runner-world.ts` (sliders: **ASSUMED LANE-STEP TIME**, **ASSUMED RECOVERY**) | The clearability proof is exact at the modelled body and no further: a body 20% slower fails 143 of 200 runs. |

### Known gaps — decisions, not bugs

Found by review and left deliberately. Each needs a call, not a patch.

- ~~**The tournament bracket is unreachable.**~~ **Wired 2026-09-19** and
  verified end to end through the operator console: four players seeded, a real
  2P round reporting itself into the bracket, the winner propagating, UNDO on a
  played match, the whole thing surviving a reload, and the next pair on the
  attract headline. Started from the BRACKET tab rather than "opt in via the
  menu" — see the amendment in PLAN.md §4 for why. Kept in this list because
  the call it needed has now been made, and that is worth being able to see.
- ~~**Highlight clips never reach a passer-by.**~~ **Built 2026-09-20.** The
  blocker was the one named here: only one clip buffer existed, because capture
  SWAPS the rolling and saved atlases. There is now a four-slot reel in a
  separate, separately-budgeted atlas — half-size cells, two seconds each, all
  four slots in one 8×8 grid at 2.36 MB, for 21.2 MB total against a measured
  cliff at ~20 MB and a measured failure at 28 MB. It is the FIRST thing the
  cost guard sheds, ahead of halving the main cell.

  It draws on attract **only when nobody is in frame**: with a body present the
  live silhouette is the stronger hook and a second moving rectangle weakens
  both. Controls are in the operator console under **DATA → REPLAYS & ATTRACT
  REEL**, and the `d` overlay has `replay` and `reel` rows.
- **Roster redundancy.** Fruit Ninja, Balloon Pop and Rhythm Punch all run on
  the same blade primitive — three of seven games share one input. The game-feel
  review's call, if a cut is forced: trim the **Runner** first (already
  pre-authorised in PLAN.md), because Balloon Pop's zero-coordination floor is a
  niche nothing else on the roster covers.
- ~~**Every abandoned initials entry defaults to `AAA`.**~~ **Called
  2026-09-20.** It stores `---` now. That is not a new vocabulary: `padEnd(3,
  '-')` already writes it, because the deadline firing on a half-typed `W`
  stores `W--`, so the glyph already means "nothing was given here" everywhere
  else on the board.

  Of the three options listed here, "store nothing" loses a real target from a
  board that has few of them on day-one morning, and "seed the last initials"
  puts one stranger's name on another stranger's score. `---` keeps the score
  as a target and refuses to pretend it belongs to somebody.

  **The option NOT taken, and why:** stop showing the initials screen at all
  for a score that cannot place. It would cut queue time and almost all of
  these rows — but a skip bypasses the FACTION picker too, so gating the
  screen on rank trades every non-placing player's faction contribution for
  queue speed, and PLAN.md §4 calls factions the highest-leverage feature in
  the doc. **Decide that one with the Sept 22 stranger playtest's numbers**:
  count how many players skip, and how many of those would not have placed.

  Fixing it surfaced a second bug that was already there. `personalBest` and
  `factionFor` both identify a player by their initials string, so a shared
  marker makes every anonymous player the same person — the second skipper of
  the afternoon was being told their personal best was the first skipper's
  score. Both now exclude the marker.

### Runner go/no-go — Sept 21

PLAN.md §3 flags the Runner as most likely to be cut. The build is good, but the
jump window is **0.37–0.45s minus 0.10s of unavoidable detection latency**, which
is rhythm-game tight for a body under hall lighting.

**Also confirm the streak cap with people.** `STREAK_CAP` was 12 and is now
**8**. Measured over full 60s rounds with momentum forced to MAX — the most
rows a round can possibly hold — a round contains **10, 10, 7, 17** scoring
rows (mean 11). A real run starts slow and accelerates, so it sees fewer than
any of those. Against a cap of 12 that meant `<MAX SPEED>` essentially never
fired and the top of the momentum curve was never felt; it was found by
counting which on-screen strings never get drawn across a full sweep. Eight is
below the minimum of the best case, so it is reachable in a short round too.
**It is still a game-feel number taken from a simulator — watch whether real
players reach it, and whether the speed at the cap is enjoyable or unfair.**

**The test:** five people, count hit rate on `low` (jump) obstacles specifically,
not overall. If a first-timer's jump success is under ~60%, **don't cut the
game** — set the `low` weight in `TrackGenerator.pickKind` to near zero and ship
it as lanes + slides. One line, no new art, and both remaining obstacle types
measured comfortable.

### Perf note to re-take on real hardware

Three `shadowBlur` hot spots were found and fixed (`drawPose`, `drawHand`,
`ParticleSystem.drawGlow`) — canvas charges the blur *per stroke*, so attract
mode was costing 92.8 ms/frame at 4 players. There is no `shadowBlur` left
anywhere in the app now; the brand conversion removed every blurred effect,
which is why the numbers below are what they are.

**Measured 2026-09-19 at 1024x768, two players, 600 deterministic frames each**,
after the field has had 240 frames to fill. Two players because that is the
worst case the shell can be in, and these are per-frame WORK, timed around
`__arcade.tick()`, so they are not affected by the pane throttling rAF:

| | p50 | p99 | over 16.7ms | worst |
|---|---|---|---|---|
| Runner 2P | 0.7ms | 7.9ms | **1 / 600** | 17.8ms |
| Fruit Ninja 2P | 0.2ms | 8.7ms | **3 / 600** | 87.3ms |

Runner is the heavy one by design — two camera rigs through one WebGL context —
and it is comfortably inside budget.

Fruit Ninja's three spikes are scattered mid-run and grow (33ms, 50ms, 87ms),
which is the shape of a GC pause rather than a slow frame: it allocates polygon
arrays on every cut. Three hitches in ten seconds is under the watchdog's
twelve-strike threshold, correctly — the machine is coping, and shedding
quality there would make the game look worse for no reason.

**Still to re-measure at the Sept 23 rehearsal**, because none of the above was
taken on the booth laptop driving the actual TV: the full-screen blit is
fill-rate bound and scales with the panel, not with this pane. If it bites, the
watchdog sheds particle density and effect quality automatically (twelve
frames over 22.2ms, not three — a single slow frame is a GC pause, not a slow
machine).
