# HANDOFF

Written 19 Sept 2026 and extended on the 20th. The stall runs
**24 and 26 September**. This is the state of things, what is deliberately
unfinished, and the traps that cost me the most time — read the last section
before you change any drawing code.

The authority for everything else is:

| Document | What it owns |
|---|---|
| `README.md` | **The day-of runbook.** Setup, the operator console, the failure table. |
| `ARCHITECTURE.md` | How the code is put together, and the testing contract. |
| `PLAN.md` | What the event is and why each game is on the roster. |
| `BRAND.md` | The eight tokens and the rules for using them. |
| `CREDITS.md` | Attribution. |
| `FEEDBACK.md` | **Every playtest report and where it landed.** Tested — see below. |

---

## State

Green as of the last commit: **687 tests, 157 suites, 0 failures**, typecheck
clean, production build verified to make **zero external requests** — re-checked
on the built bundle, not the dev server, along with all four Archivo weights
reporting `loaded` and `window.__arcade` correctly absent.

Every row of `FEEDBACK.md` now fails a test when its fix is undone, which is a
stronger claim than the anchor check makes and is re-runnable:
`python scripts/verify-guards.py --ledger`.

```bash
npm run setup      # fetch models + fonts — REQUIRED before first run
npm run dev        # http://localhost:5173
npm test           # 687 tests, ~12s
npm run typecheck
npm run kiosk      # production build, served on :4173 — use this on the day
```

`npm run setup` is not optional and not a convenience. The app ships the pose
models and the Archivo faces locally so the stall never depends on the venue
wifi, and `fetch-fonts.mjs` will **fail the build loudly** rather than let a
wrong font through — it verifies the downloaded bytes by reading each file's
own cmap. If it complains, believe it.

### Keys

| Key | Does |
|---|---|
| `0`–`9` | Jump to a screen. Bare during a game is ignored; hold shift to force it. |
| `d` | Debug overlay — the pipeline, stage by stage, in the order a frame travels. |
| `f` / `c` / `m` | Fullscreen / kiosk cursor / mute. |
| `Ctrl+Shift+\`` | Operator console. `Esc` closes. |
| `?sim=1` | Simulator. No camera, synthetic bodies. **This is the day-of fallback if the webcam dies.** |
| `?screen=<id>` | Boot straight to a screen. |

---

## What changed in this session

Fifty commits. Two threads worth knowing about.

**Storage was failing silently, in three different ways.** All three persisted
stores — tuning, the bracket, the leaderboard — could stop writing to disk with
nothing anywhere saying so. Each had the same defect at a different stage: the
leaderboard set a flag nothing read, `tunables` had no flag at all, and
`Tournament.save()` called an `lsSet` that *returned* whether the write landed
and dropped it on the floor. The board keeps working from memory, which is
correct behaviour and exactly why it is invisible: play carries on, scores
appear, ranks are right, and the first reload discards the lot — and the
runbook's answer to four separate problems is F5.

All three now raise `saveFailed`, both readouts (`d` overlay and the operator
chip) report all three, and there is a **boot probe** that writes and reads back
once at startup, because none of the flags can fire until something has already
been lost. The condition actually worth catching is a locked-down or private
browser profile, which is fixable in ten seconds at 9am and not fixable at 3pm.

The bracket also gained an export, which it should always have had: scores and
tuning can be reconstructed by asking people, and who beat whom across an
afternoon cannot.

**Then a visual sweep of every screen found five more bugs**, listed below.

---

## Things the runbook promised that nothing checked

Three more guards went in on the 20th, all the same shape as the slider-name
guard that already existed — a claim printed on a card, read under pressure,
with no way for the reader to verify it:

| Claim | Now guarded by |
|---|---|
| "retrying — 1s, 2s, 4s, 8s, then every 10s" | `tests/recovery.test.ts` parses the sequence out of the README |
| The Keys table (`0`–`9`) | `tests/keys.test.ts`, both directions |
| EXPORT SCORES JSON, PANIC, CLEAR EVERYTHING and five more | `tests/runbook.test.ts` |

Two of those found something. `9` goes to the MENU and the card never said so
— the light way out of a misbehaving game, and marshals were being sent to
PANIC or F5 instead. And the camera backoff and the key map both lived in
`main.ts`, which no test can import because it boots the app on evaluation;
both moved somewhere checkable.

---

## What changed on 20 September

**The tester-feedback ledger.** Every playtest report was already acted on, and
every one was documented at the site of its fix — which is the good version of
the problem: the reasoning survives, but only as prose, scattered across
seventeen files and load-bearing for nothing. `FEEDBACK.md` is now the ledger,
27 rows, and `tests/feedback.test.ts` makes it bite three ways: every anchor
must still exist in the file it names, every quoted report must still be quoted
at a fix site, and **every tester quote in `src/` must appear in the ledger** —
so a new report cannot be written into a comment without being filed. All three
mutation-tested.

**The attract reel.** PLAN.md §6 asked for looping highlight clips on the
attract screen and they were never built: capture SWAPS the two atlases, so
exactly one clip can exist. There is now a four-slot reel in its own 2.36 MB
atlas, it draws only while nobody is in frame, and it is the first thing the
cost guard sheds. Full reasoning is in the note on `REEL_SLOTS`.

**And the other half of PLAN.md §4's clip rule.** "On a top-5 score OR A BIG
COMBO" — only the score half was ever built. That matters now because captures
feed the reel, and top-5 is common on day-one morning and rare by the afternoon
once boards fill, so a reel fed by scores alone goes stale as the hall gets
busy. Fruit Ninja asks for a clip on a triple chain or better. Mid-round
captures are SPACED and refused near the end of a round, because `capture()`
swaps atlases and would otherwise leave the end-of-round replay with no footage.

**Then the ledger was mutation-swept, and ten of its rows were held up by
nothing but the ledger text.** `tests/feedback.test.ts` proves each anchor still
EXISTS, which is a much weaker claim than the fix working — a constant can sit
in a file nothing reads and the check stays green. Breaking each fix in turn and
requiring something OTHER than the anchor check to notice found ten rows in that
state, and two live bugs:

- **Row 20 had come back.** The reach band SHIFTED rather than shrank at a slot
  edge, which preserves its width — twice the reach — so a body near the edge
  got the whole spread on one side of itself. Measured at 2.51 torso against a
  full stretch of 1.57. The distribution table in the source is not wrong; it
  was measured on a CENTRED body, which is the one case that was always fine.
- **The same bug in Balloon Pop**, which had its own copy and is the game
  somebody plays *because* stretching is what they cannot do. Both now share
  `games/reach.ts`.

Two more things that sweep taught, both of which will outlive it:

- **`REACH_UP` in `hover.ts` decides nothing.** `tunables.get(key, fallback)`
  returns the REGISTRY default whenever the key is registered, so a constant
  edited in a game file can silently do nothing. `tunables.ts` records this
  biting `redlight.graceSec` once already. The guard for it was a `console.warn`
  behind `import.meta.env?.DEV` — invisible in production and under
  `node --test`. There is now a test across all 37 call sites.
- **Two test files drove hand-written COPIES of the constants they claimed to
  test** — the lane gate in `runner-lane.test.ts` and the rep gate in
  `sixtyseven.test.ts`, each labelled as what the game installs. Excellent
  behavioural tests, about numbers the game need not have been shipping. If you
  write `const GATE = { ... }` at the top of a test file, read it out of the
  source instead.

**And the playtest can now produce numbers rather than impressions.**
`meta/roundlog.ts` writes one line per finished round, exported from the DATA
tab, and answers two of the four open questions in FEEDBACK.md — Runner hit rate
by obstacle KIND and Pose Match first-wall pass rate with the gate it was
measured against. It is deliberately write-only to the app: nothing reads it
back, which is what made it safe to add four days out. Wiring it immediately
paid for itself — the first numbers out of it were a 100% hit rate on every
obstacle kind, which turned out to be both harnesses never jumping. The Runner
had no closed-loop driver at all and still scored ~600, because distance accrues
from the world scrolling.

**And the highlight buffer finally reports itself.** It is the largest
allocation in the app and it could shed — or switch off entirely — without a
word anywhere. `d` now has `replay` and `reel` rows; the operator console has
**DATA → REPLAYS & ATTRACT REEL** with buffer size, grab cost, shed level and
switches for both. Exactly the storage-flag problem from the 19th, one layer
down.

---

## Count the things that never happen

The single most productive thing done on the 20th, and it takes one sweep.

Run `await window.__arcade.turn()` with `audio.play` and
`CanvasRenderingContext2D.fillText` patched to COUNT rather than assert, then
look at what came back zero. **A cue that never plays, or a string that never
draws, is a mechanic nobody is testing** — and four of them turned out to be
unreachable by construction rather than merely rare:

| Never happened | Why | Now |
|---|---|---|
| `duck` (15 `wallhit`, 0 `duck`) | Neither harness ever crouched | Both duck; Rhythm scores 1077 → **1864** |
| `<MAX SPEED>` | `STREAK_CAP` 12, above the mean rows a round holds | Cap **8**, confirmed firing |
| `<FINAL STANDINGS>` | Sweep chose JUST ME for a 3-body Red Light, then a replay covered it | Party mode picked; replay no longer takes over a party round |
| `<QUAD!>` / the combo clip | Threshold set to a chain that never occurs | Triple, where the confetti already fires |
| `<FIRST ON THE BOARD>` | Only fires on an empty board — which guarantees a replay covers it | Carried on the replay stamp instead |

Two things make this work that are worth repeating:

- **Patch the prototype, not the module.** A dynamic `import()` of
  `PopupLayer` counted zero of everything — that is the second-instance trap
  below, hit again. `CanvasRenderingContext2D.prototype` is the real render
  path whatever the module graph is doing.
- **Then check the trigger, not just the guard.** Every one of these had
  passing tests. They tested the mechanism and never asked whether the
  condition could occur.

**Re-run later on the 20th, and it is a test now.** The console one-liner had
been retyped twice, so the patching lives in `src/dev/census.ts`
(`__arcade.census()`, counts accumulate across calls because a full roster
exceeds the console's 45s cap) and the result lives in
`tests/fixtures/census.json`. `tests/census.test.ts` holds the discipline:
every banner literal in `src/` must either appear in the recorded census or
carry a written reason. A newly added banner is in neither list, so the suite
fails until somebody sweeps it or explains it, which also stops the fixture
rotting quietly.

**53 banner literals. 34 drew. 19 did not, and all 19 are now explained**
(failure screens 7, rig check 3, rare by construction 3, needs a body to go
missing 2, the replay-covered rank line 3, and `<WALL!>` 1). No new bugs, which
is the point of keeping the baseline: the next sweep is a diff.

Two things the re-run taught that the first sweep did not:

- **Sweep BOTH board states, or the census lies.** The first full sweep
  reported 24 unexplained strings. Five were not dead at all, they were MASKED
  by the leaderboard: months of simulated sweeps had left 67 Speed's best at
  185 and the simulator scores about 183, so no record or first-score path
  could ever be taken. Clearing the board drew four of the five from a SINGLE
  game. A census reads the app in the state you left it, and persisted state
  silently removes branches from the run.
- **A hidden preview pane fails as a menu regression.** With the pane hidden
  the tab reports `visibilityState: hidden`, layout collapses, and the canvas
  goes 0x0. The dwell aims at tile-centre divided by `clientWidth`, so the
  override lands NaN, nothing is ever hovered, and all seven games report
  `picked=false` / `never reached the game` — character for character what the
  real hand-teleport regression looked like, which is the one thing this
  harness exists to tell apart. It cost about ten probes. `runTurn` now
  preflights the canvas and says so in words.

Two of the nineteen were worth chasing past the label, and both paid:

- **`<FACE THE CAMERA>` is not rare, it is undrivable.** It fires when one ARM
  goes unseen, not when a player leaves, and the simulator always shows both
  arms with no way to ask it otherwise. At a stall it is among the most common
  things that happens — a player turns to talk to the friend they are racing,
  a shoulder crosses a wrist, and the reps stop counting for a reason nothing
  on screen explains. The trigger is now `armIsLost` in sixtyseven.ts, pure and
  tested on all four cases, including the one that matters most: an arm that
  was NEVER seen is not lost, because warning somebody about an arm the round
  never had is noise at the moment they are working out what to do.
- **A player walking off mid-round was never tested at all.** Measured on the
  20th, 2P 67 Speed, player 2 dropped mid-round: their score freezes (19),
  player 1 carries on (75), the round terminates normally to initials, and
  **zero console errors**. The seat is NOT re-assigned mid-round, which is
  right — re-seating would hand a walk-off's score to whoever stepped in.

**And the CUES, which the census counted from the first sweep and nobody
read.** 18 of the 20 names in `SoundName` play; both that do not are real and
both are now in the allowlist beside the banners.

`eliminate` is the interesting one. It is Red Light's most dramatic moment
and it never fired in any automated run — because the simulator is a PERFECT
PLAYER. It freezes on red, so nobody is ever caught. Driven by hand with a
body that holds still and moves only on red, it fired three times for three
racers, so the cue and the mechanic are both fine.

Worth knowing while you are there: a player in CONSTANT motion is not
eliminated, and that is deliberate rather than a hole. `calibrateQuiet`
converges on roughly the 10th percentile of what THAT body does, so somebody
who never stops raises their own floor — measured mid-round at energy 3.76
against a learned quiet of 3.06. `quietCeiling` bounds how far that can go.
The alternative is a fixed threshold, which is what eliminated a motionless
player ten seconds into every round (FEEDBACK row 11). If a bouncing kid
proves un-catchable at the rehearsal, **MOVE THRESHOLD** is the knob, and it
is the one FEEDBACK's Red Light row already names.

Also worth knowing: the brackets are not always what draws. `drawRankLine`
writes `<FIRST ON THE BOARD>`, and what appears on screen at that moment is
the instant replay stamp drawing `FIRST ON THE BOARD` unbracketed, 450 times
in the cleared-board run. Checking the wrong one of those two costs an hour.

---

## Every sweep tested the dev build. Now one tests the real one.

`turn()`, `smoke()` and `census()` all hang off `window.__arcade`, and that was
gated on `import.meta.env.DEV` alone — so the artifact that goes to the stall
had never been driven by any of them. Four of the bugs found on the 20th were
production-only, including failure screens at 1.11:1 because an opaque canvas
initialises to solid black, which the dev server cannot reproduce.

```bash
npm run build:probe      # real pipeline, dev handle kept, into dist-probe
npm run preview:probe    # serves it on 4174
```

`vite build --mode probe` is minified, tree-shaken and HMR-free like the real
thing. The SHIPPED `vite build` has MODE 'production', so the comparison folds
to false and the block is eliminated. **Verified by grepping both bundles: 0
occurrences of `__arcade` in `dist`, 6 in `dist-probe`**, and no `runTurn`,
`runSmoke` or `runCensus` in `dist` at all.

Both halves matter. The handle can clear the leaderboard and rewrite every
tunable, and the stall laptop sits in a room full of people who know what
devtools is. `runbook.test.ts` guards the gate, that only one place assigns
it, that the probe build writes somewhere else, and that the shipped script
never selects probe mode.

**First run of it, 20 September: all 13 turns green on the production bundle,
zero console errors.** The canvas preflight fired there too, which is how I
know it reads the same in both.

**And then the census, which is the comparison the fixture was built for.**
Full roster on the production bundle: 43 bracketed strings, 18 cues, 4581
distinct strings, nothing truncated.

Against the dev baseline: **nothing drew in production that the dev build did
not, and the cue sets are identical, 18 for 18.** Two strings drew in the
dev cleared-board run and not in production — `<PICK A SIDE>` and
`<SET THE FIRST SCORE>` — and both are explained without involving the build:
4174 is a separate origin with its own storage, and the 13 verification turns
I had just run populated it with 2-4 rows per game. Both are among the five
banners already known to be masked by a populated leaderboard, so this is the
same effect reproducing rather than a new one.

That is the useful negative result: minification and tree-shaking do not
reach a single player-visible string or cue. The production run is now the
third entry in `tests/fixtures/census.json`, and the guard asks for the two
board states to be PRESENT rather than to be the only ones, so it can stay.

---

## The same trick, pointed at the test suite

The census asks "what does the app never draw?". Point it at `tests/` and it
asks "what does the suite never touch?", which found three inputs on the 20th
that nothing tested at all.

**Do it by MODULE, not by symbol name.** The first pass listed exported
symbols no test file NAMES: 142 of 350, which sounds alarming and mostly is
not. A function covered through its caller never appears by name {DASH}
`isPlayable` is exercised by every `nextPlayable` test in a 28KB tournament
suite, and `GhostPlayback` arrives through `ghosts.load()`. Chasing that list
is chasing false positives.

Modules that NO test imports is the honest signal: **8 of 54**, and five of
those are drawing code or a worker entry, where a source-scanning guard and a
screenshot are the right tools anyway.

What it found, all three of which reach a player:

| Was untested | Why it matters |
|---|---|
| `VerticalGestures` | The Runner's jump and Rhythm's duck. Every sibling detector in that file was covered. FEEDBACK's Runner row is about hit rate on JUMP obstacles specifically. |
| `BladeTracker` | The whole input to Fruit Ninja. Three properties, all failing the same way: one blade harvesting the field at once. |
| `RollingNumber` | Its own comment calls the finite check the last thing between a bad score and "NaN" at 11vh on a television. |
| `Projection` | Every consumer-facing coordinate. Its header says a mistake here "makes a game feel subtly broken in a way that's very hard to debug from a desk". |

And the tests taught the code twice, which is the sign they were worth
writing. A blade test swiping 0.12 of the frame per step cut nothing {DASH} that
is 0.6 torso units, a teleport, and `maxTravelPerFrame` was right to refuse
it. A real arm covers about 0.2 torso units between frames even swung hard.
Both blade tests now assert `reacquired === false` first, so a future draft
fails loudly instead of quietly testing the snap path.

---

## And measure it at 4:3

The second most productive sweep, and it only happened because the pane was
1536×1152 by accident. Every one of these is fine at 16:9 and wrong at 4:3,
and the stall's TV is unknown until setup:

| At 4:3 | Found |
|---|---|
| Menu blurbs | **1.42vh**, below the 1.6vh the file itself calls "unreadable from 3m". Fixed by allowing a third wrapped line, then capping at the title size when that overshot. |
| Attract reel pill | 1.55vh — the `micro` size theme.ts reserves for "operator, diagnostic and decorative only". Now fitted from `TYPE.label`. |
| `<BLADES OUT!>` | Drawn at **x = -45** on a 1536-wide stage. The horizontal clamp was reserving `estimateHalfWidth`, which is 14-31% too narrow on every popup string in the app. |

The method is the same each time: patch `fillText`, record the size and the
left/right extent of every string against the viewport and the overscan safe
area, and read the worst.

**Two traps in doing it.** `#stage` reports **300×150** until the render loop
has run once, and the loop is throttled while the pane is hidden — so drive
`__arcade.tick(3)` first and refuse to measure while the stage looks like that,
or every derived figure is out by the ratio. And `tr.a` includes the device
pixel ratio, so work in stage pixels throughout rather than mixing them with
viewport units.

---

## Numbers that were true when they were written

A whole class of bug turned up once I went looking for it, and it is not a
coding mistake — every one of these sentences was CORRECT on the day somebody
typed it. A constant moved later, its own comment was updated, and the other
places that quoted it were not.

| Where | Said | Is |
|---|---|---|
| README risk table | Pose gate has 0.07 headroom | **0.009** — 0.07 was the headroom at the OLD gate of 0.72 |
| MATCH THRESHOLD slider description | the same 0.07 | the text a marshal reads while dragging that slider |
| redlight.ts header | grace is 400ms | **750ms**, and it calls this the one number that is not tuning |
| `graceSec` note | budget moves 0.85s → 1.05s | **1.00 → 1.20**, computed when breachSec was 0.30 |
| breachSec note | budget is 0.85s | **1.2s** — the same file says 1.2 eleven lines later |
| `judgeOpensAt` | 400ms grace becomes 100ms | **750 → 450** |
| `quietMult` note | "2.4 -> 2.0 … lands at ~3.9" | the constant is **1.6**, and the pure-multiple model it describes was replaced |
| affine note | "1.1 + 1.45x" | the slope is **quietMult = 1.6**, and the hostile figure ignored the ceiling |
| two ceiling notes | `quietCeiling × moveEnter` = 1.615 | **2.53** — 1.615 is 1.9 × 0.85, an earlier pair |

Red Light held six of the nine, which makes sense: it has the most coupled
constants and they were tuned in several passes, each updating its own comment.

**Three sweeps found them, and all three are cheap to re-run.** Compare every
`old -> new` comment against its constant; compare every inline restatement
(`NAME is 0.85`) against the declaration; and evaluate every stated arithmetic
on named constants (`A * B = N`). The last one is clean across all 51 files
now, and the guards added derive their figures instead of restating them.

**The rule that came out of it:** a number derived from constants must be
CURRENT, or say which constants produced it. And if every quote is dated,
something still has to state today's value — otherwise moving the constant
breaks nothing.

---

## Write the guard, then make it fail

Five source-reading guards went in today and **four of them first passed or
failed for a reason other than the one they claimed.** Every single case was a
search that matched somewhere I had not looked:

| The guard | What it actually read |
|---|---|
| "runner.ts asks base.ts" | Its own COMMENT mentioning the function, so the call could be deleted and it stayed green |
| "the capture is not gated on party mode" | Only the text AFTER `captureIfWorthy(`, missing a mutation placed in front of it — then, rewritten, the round-RESET assignment instead, so it failed on correct code |
| "the HUD is inset by SAFE" | `indexOf('progressBar(')` found the OTHER call, 1080 lines earlier |
| "the threshold table is recomputed" | `(clean\|realistic)` matched the PERCENTILE table thirty lines above. redlight.ts has several tables and they all start with the same two words |

Three rules came out of it, and they are cheap:

1. **Strip comments before matching source.** A guard satisfied by the prose
   explaining it is worse than no guard.
2. **Anchor on something unique to the site** — a header line, a distinctive
   string — rather than on a function name that appears more than once. Then
   slice a window from there.
3. **Mutate the fix away and watch it go red, every time.** A green test proves
   nothing about itself. Four of these five were only caught that way, and two
   of them had *already been committed* when the mutation found them.

`scripts/verify-guards.py` exists for step 3. Use it.

`python scripts/verify-guards.py --ledger` does the same for every row of
FEEDBACK.md — it undoes each tester fix and requires a test OTHER than the
ledger's anchor check to object. Run it before claiming the feedback is
implemented: "the anchor is still in the file" and "the fix still works" are
different claims, and on 2026-09-20 ten rows were only the first.

---

## Numbers I got wrong today, and how

Both the same shape, and both caught by re-measuring rather than by review.

- **The combo-clip threshold.** Committed at a quad with a comment saying
  "MEASURED over the chain distribution this game actually produces". No such
  measurement existed. The real distribution is DOUBLE 2120 frames, TRIPLE 320,
  **QUAD 0** — the feature could not fire.
- **The Runner row count.** Measured ONCE, got exactly 12, which made a tidy
  story about the cap sitting precisely on the ceiling. The next round gave 17.
  The real spread is 10, 10, 7, 17.

A single sample of a seeded generator is not a measurement, and **the tidiness
of the first answer is what made it convincing.** Three test guards also passed
or failed for the wrong reason today; each time the cause was a regex reading a
different piece of code than I thought it was. Mutate the fix away and watch
the test go red, every time — a green test proves nothing about itself.

---

## The eight items the goal refers to

The standing goal says "adding whats left including those 8 features you just
mentioned". That list was my answer to "so whats left for us to do?" and it
predates a context compaction, so it had become a reference to something
nobody could read. It is recovered here from the transcript and audited
against the code, because a goal that names eight things should not be
checkable only by whoever happened to be in the room.

| # | The item, as written | Now |
|---|---|---|
| 1 | Two-player exists but is nearly unreachable; give versus games a 4-5s gather window | **Done, and not the way I proposed.** A gather window taxes every SOLO turn 1.5-2.6s at a stall whose problem is throughput. The countdown re-resolves the player count every frame instead, and an arrival rewinds it to `LATE_JOIN_FLOOR_SEC` (1.7s), capped at `MAX_LATE_JOINS`. Solo turns pay nothing. |
| 2 | No mode-select screen | **Done.** `src/shell/mode.ts`; `<HOW MANY PLAYING?>` draws in the census. |
| 3 | Neon Runner is 1P only | **Done.** `maxPlayers: 2`, `supportsVersus: true`; two seeded tracks through a scissor rect. Scored 821 in the 2P sweep on the 20th. |
| 4 | Nothing tells a pair which games they can play together | **Done.** `seatBadge()` in `meta/games.ts` draws `1-2P` / `1-5P`, and `null` for a solo game rather than a pointless "1P". |
| 5 | Zero 2P regression coverage | **Done.** 75 tests across `versus.test.ts` and `runner-versus.test.ts`. |
| 6 | It has never met a real camera and two real bodies | **OPEN — only the rehearsal closes it, but it will now produce a NUMBER.** The fragile part named here was the identity lock across a track loss, and the tracker counts it: `idReserved` / `idReclaimed` / `idLost` on every round row. `idLost` above zero is somebody who became a new person mid-round. This also closed FEEDBACK's fourth owed row, which said lane holding was "an identity question" with no counter — a lane IS an identity. |
| 7 | Faction remembered per kiosk vs asked every turn | **Done, as neither.** Remembered per PLAYER and confirmed (`<STILL PLAYING FOR X?>`), explicitly not one kiosk-wide value — see the note at initials.ts:271. |
| 8 | Rhythm's HUD is the least legible thing at 3m | **Done.** The combo readout was `TYPE.micro`, 1.5vh, about 16px on a 1080p panel. It is `TYPE.label` now; the only `TYPE.micro` left in rhythm.ts is the comment explaining why. |

Seven of eight. The eighth is a rehearsal, not a commit.

---

## Open, and deliberate

Things I looked at and chose not to change. If you disagree, the reasoning is
here so you can overrule it properly.

- ~~**Two chase readouts on one screen.**~~ **Resolved 2026-09-20**, and the
  real defect was sharper than "clutter". With a ghost loaded the two readouts
  are different races and both earn their space. With NO ghost the HUD chase
  line falls through to the board and renders the **identical string** the
  sticker is already showing — `12 TO #4`, twice, a few vh apart. That is most
  of the stall's day: a ghost only exists once somebody has set a top run in
  that game, and it is retired mid-round the moment the gap is out of reach.

  The precedence now lives in one place (`chaseMode` in `base.ts`) and the
  subclasses ASK it (`chaseLineOwnsBoardRank`) instead of re-deriving it. The
  sticker draws only when the HUD is busy saying something else.
- **Popup overlap during the pop — much smaller, not gone.** Measured worst
  case is now **14.1%** of the smaller word, down from 38.9%. The separation
  logic in `PopupLayer.spawn` still reserves the SETTLED width; what changed is
  that the overshoot is 1.35 rather than 1.9, so there is far less to overlap
  with. Reserving the pop width vertically as well would push every clustered
  popup further from its subject to fix 135ms, which is still the wrong trade.

  The 1.9 was worth chasing because it was never a designed number — it is
  where the old inverted ramp happened to end up, and the fix that reversed the
  ramp preserved the peak on trust. It was also **defeating the horizontal
  clamp**: `TOO SLOW!` spawned 35px in reached −62.6 for the first eight
  frames, which is the exact Red Light elimination case the clamp was added
  for. The clamp now reserves the peak, and `tests/popups.test.ts` asserts the
  word is on screen for **every frame of its life**, not just at spawn.
- **`lsGet` / `lsSet` / `lsRemove` are duplicated** verbatim in `ghosts.ts` and
  `tournament.ts`, and `leaderboard.ts` / `tunables.ts` touch `localStorage`
  directly. `src/meta/storage.ts` now exists and is the natural home for all of
  it. A pure move, but a four-file refactor with no user-visible benefit is not
  what I wanted to be doing this close to the event.
- **Historical "six-player" comments.** Red Light seats five now; I corrected
  every present-tense claim but left records of what was *measured* at six
  lanes. Rewriting a measurement to a number nobody measured would falsify the
  record, and `LANES` documents the six-to-five change directly above the
  constant.
- **The HUD shakes with the playfield, and nothing says whether it should.**
  `drawHud` is called from inside `juice.pushTransform`, so the clock, the
  score and the chase line all move with screen shake — up to `height × 0.035`,
  which is 40px on a 1152 stage. At rest they now sit exactly on the overscan
  boundary, so a shake carries them past it, and on a panel that crops 3.5% the
  edge digit of the round timer can clip for those frames. The popups are in
  the same transform, which is the whole of the residual overflow left after
  today's clamp work.

  Moving the HUD outside the transform is a two-line change and a real
  question: information you want readable exactly when things are violent
  against a HUD that looks detached from a world that is moving. It is a FEEL
  judgement and a dev pane cannot settle it — look at it on the TV at the
  rehearsal and decide there.

- **The reel's memory budget wants one real measurement.** Total canvas backing
  store is now 21.2 MB against a cliff measured at roughly 20 MB on THIS
  machine, and a failure measured at 28. The guard sheds the reel first and
  automatically, so the downside is "the reel disappears", not "the stall
  stutters" — but check the `reel` row on `d` after an hour at the rehearsal.
  If it says OFF, this laptop is past the cliff and the reel is not for it.

  **What IS measured, at the real capture cadence:** a grab costs **0.07 ms
  mean, 0.10 p50, 0.30 max** with 30 ms between grabs. The budget is 4 ms, so
  there is 57x of headroom — by far the most reassuring number taken this
  week. Still a hidden dev pane, so re-take it on the booth laptop; but if the
  buffer sheds there, it will be because of the panel size, not this code.

  **Do not read a shed from a `turn()` sweep as a fault.** The harness
  fast-forwards a synthetic clock, which used to drive the guard to shed three
  times in fourteen seconds. `setSynthetic` now suspends the guard's DECISION
  during a fast-forward — capture keeps running. If you see a shed after a
  sweep now, it is real.

  **But `avgGrabMs` on the `d` overlay is NOT clean after a sweep**, and this
  paragraph used to say sampling was suspended, which is narrower than what
  happens. `guard()` returns early, so `window`, `strikes` and `shedLevel` are
  untouched — but `grabs`, `grabTotal` and `grabMax` keep counting, because
  they are the evidence that capture ran at all, which is the other half of
  what the sweep is for. Measured after an eleven-round `turn()`: **7.99 ms
  mean against a 4 ms budget, 402 ms max**, sitting next to `shedLevel 0`. That
  reads exactly like the GPU cliff and is nothing of the kind. Dev-only —
  `synthetic` is never true in the production build, because `__arcade` does
  not exist there.
- **Perf numbers need re-taking on the real rig.** Every measurement in
  `README.md` was taken in this dev pane. The full-screen blit is fill-rate
  bound and scales with the panel, not with the pane. Re-measure at the
  rehearsal.

---

## Bugs fixed this session that you would not have found by reading the code

Listed because each one is a *class* of mistake that can recur, not because the
individual fixes matter now.

1. **The win banner drew its own edge through `STILL IN`.** Red Light's
   final-call band was anchored at `23vh`. `HUD_FULL.labelY` is *also* 23. Two
   numbers chosen independently that happened to be identical, so the band's
   top edge landed exactly on the label's vertical centre. Fixed against a new
   `hudLabelBottom()`.
2. **Elimination taunts were clipped in half.** `floorY` had kept popups out of
   the HUD for ages; nobody ever made the same argument sideways. Every racer
   starts at the left edge, so `GOTCHA!` lost its left half. Fixed in the layer
   (`PopupLayer.width`), not in Red Light — Balloon Pop and Fruit Ninja have the
   same exposure.
3. **`<PLAYER 2 AHEAD>` drew over `REC 184`.** `floorY` protects what is above
   it; 67 Speed owns the strip *below* the HUD. `popupFloor()` is overridable
   now. Note the reserve includes **half the popup**, because `floorY` is a
   popup's centre and not its top — my first version cleared it by luck.
4. **Every boot screen title has been invisible.** `showBoot` built its heading
   with `innerHTML`, and every title is a brand headline in angle brackets, so
   the browser parsed it as a tag: `<h1><startup failed=""></startup></h1>`.
   `<INSECURE CONTEXT>` and `<CAMERA ERROR>` were both blank. `boot()` also had
   no `.catch`, so anything thrown before the first route was a black screen
   with nothing to press.
5. **Every popup swelled to 1.89× and snapped back in one frame.** The comment
   said "Pop in fast, then fade"; the expression did the reverse, because `t`
   runs 1→0. A 47% shrink in a single frame on every popup in the app.

---

## Traps — read this before touching drawing code

I lost more time to bad measurement today than to any bug.

**Screenshots in the dev pane go stale.** Twice I concluded a screen was
"rendering mostly black" when instrumenting `fillText` proved it was painting
full-width and correct. A downscaled 800×450 capture of a 1280×720 viewport
also turns 14px labels into convincing smears. **Do not diagnose a layout from a
screenshot.** Patch `fillText` / `fillRect`, map through `ctx.getTransform()`,
and read the numbers.

**`document.querySelector('canvas')` is not the stage.** It can return a
300×150 scratch buffer, which silently makes every derived coordinate wrong.
Use `#stage`.

**`drawText` emits each glyph twice** — shadow pass, then fill. Any detector
looking for consecutive characters (`R`,`E`,`C`) will never match, and any
overlap detector needs to collapse the pair first.

**`drawTabularNumber` draws glyph by glyph**, so `"REC 184"` never appears as
one string in a capture.

**A dynamic `import()` in the browser gives you a second module instance** with
its own zeroed state. I "verified" a storage flag against a copy the app was not
using. Drive the real UI, or test the module directly in Node.

**Bash heredocs mangle backslashes in this environment.** `\\\\b` arrived as
`\b`, which silently turned a regex guard into a no-op. Write Python to a file
and run the file, or use the editing tools.

**A guard that matches nothing passes exactly like one that works.** Every
guard added this session was mutation-tested: break the fix, confirm the test
fails, restore. There is a `scripts/verify-guards.py` for this. Do the same.

**The versus results screen DECIDES from one number and DRAWS another, and
they agree only because every score is a whole number.** `drawVersusResults`
picks the winner from `res.score` (captured at round end) and draws
`this.scores[slot].value`, which is `Math.round` of a `RollingNumber`'s
animating display. Integers in, and the two always match. Add a fractional
score — a time bonus, an accuracy percentage — and 18.6 against 19.4 puts
**19 and 19 on screen with a `<WINNER>` crown on one of them**, in front of
the two friends who just played. At a club fair that is an argument, and it
would read as a rendering bug rather than a scoring one.

Checked on the 20th: all seven games return integers by construction (Rhythm
rounds both award paths, `laneScore` floors and caps, Runner floors, the rest
are counts), and `smoke.ts` asserts `Number.isInteger` on every game's live
score, which is what actually keeps this true. If you make a score fractional,
decide the winner from the same rounded numbers the screen shows.

---

## If it goes wrong on the day

`README.md` has the real table. The three things worth memorising:

1. **Camera dead** → `?sim=1`. The rig check and every diagnostic knows this is
   deliberate and will say `SIMULATOR — no camera by design` rather than
   reporting a fault.
2. **Red `NOT SAVING` chip** → **do not reload.** Go to the operator console's
   DATA tab and press every EXPORT button, bracket first — scores and tuning
   can be reconstructed by asking people, who beat whom cannot.
   **Except `rounds`.** That row says EXPORT NOW rather than DO NOT RELOAD on
   purpose: it is the playtest log, nobody's turn depends on it, and freezing
   a working stall to protect research data is the wrong trade. Take
   EXPORT ROUNDS JSON and keep serving the queue.
3. **Anything else** → press `d`. The first bad row is the cause; everything
   under it is a consequence.
