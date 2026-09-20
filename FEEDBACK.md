# TESTER FEEDBACK LEDGER

Every report from a human who stood in front of the camera, and where it
landed. Written 20 Sept 2026, four days out.

**This file is tested.** `tests/feedback.test.ts` checks two things for every
row below, and fails the build if either stops being true:

1. **The report still exists in the source.** Each quoted sentence is quoted
   verbatim in a comment at the place it was fixed. Nobody can delete the
   reasoning and leave the constant looking arbitrary.
2. **The fix still exists.** Each anchor is a literal string that must appear
   in the named file. If somebody tunes `POP_SLOP_TORSOS` back to a graze or
   deletes the fair-mode path, this file goes red and names the tester whose
   complaint just came back.

It also refuses to let a NEW report be written into a comment without being
registered here — the test scrapes `src/` for quoted text near the words
*playtest* and *tester*, and every hit must appear in the table. That is the
part that makes "all tester feedback has been implemented" a checkable claim
rather than a promise.

The ignore list for that scrape lives in the test, with a reason per entry.

---

## Why a ledger at all

Feedback from a playtest is the only information in this project that cannot
be re-derived. A measurement can be re-measured; a bug can be re-found by
reading the code. But *"they had to 67 at a certain angle"* is a sentence that
existed for a few seconds in a room, and every one of these rows is a number
somewhere that now looks like an arbitrary magic constant to the next reader.

Three of them — the 67 gate, the Runner lane reference, and the Red Light
stillness calibration — turned out to be **the same class of bug**: a threshold
measured against a reference that was itself moving. None of the three was
found by reading the code. All three were found by somebody saying the game
felt wrong, and two of them were "fixed" once in the wrong direction first.

---

## The ledger

| # | What a tester said | What changed | Anchor |
|---|---|---|---|
| 1 | "sens is low for selecting, might pick the wrong game" | One Euro `beta` 0.008 → 0.25 on the pointer preset. The cutoff stayed near its 0.6 Hz floor during a fast reach, so the cursor lagged a quarter-second and then overshot. | `src/core/filter.ts` · `beta: 0.25` |
| 2 | selection "might be too fast" | Menu dwell 1.2 s → 1.5 s. A wrong pick costs a whole turn out of a moving queue — the most expensive mistake the shell can make. | `src/shell/hover.ts` · `deliberate: 1.5` |
| 3 | "when I reach up I get height restricted, the pointer doesn't fully go with my hand, it stays a little below." | Reach box 1.15 → 1.0 torso, plus a per-frame measurement of the headroom the camera actually has. Reported twice, the second time as "when I reach up I get height restricted, the pointer stays a little below my hand" on a rig cropped at the knees. 1.15 was the anatomical maximum, so the top pixel cost a locked-out overhead stretch, and on a low laptop camera no fixed value can work — the limit is the frame, not the arm. | `src/shell/hover.ts` · `const REACH_UP = 1.0;` |
| 4 | "tracking is a bit wonky" | Pose model defaults to `full`, not `lite`, and is live-switchable. Every threshold in every game divides by `scale.unit`, so model jitter moves all of them at once. | `src/games/base.ts` · `vision.poseModel` |
| 5 | "text might be doubled" | A shadow the same colour as its glyph is the word printed twice. Guarded centrally in `drawText`, and the offset capped at 8% of type size. | `src/engine/draw.ts` · `if (shadowColor !== color) {` |
| 6 | "they had to 67 at a certain angle." | The rep gate stopped asking WHERE the wrist is. It was never anisotropy — with elbows tucked the forearm is shorter than the upper arm, so the wrist tops out below the shoulder however hard you pump. | `src/games/sixtyseven.ts` · `const REP_GATE = {` |
| 7 | "I can even do a tpose 67" | Same bug as row 6, reported from the opposite side. `ArmPump` now learns the middle of each arm's own stroke and gates on deviation from it, so no fixed anchor has to serve both a tight pump and an overhead one. | `src/core/gestures.ts` · `class ArmPump` |
| 8 | "runner didn't detect movement" | The gate was never the problem; the reference was. The lane baseline adapted every frame, so it chased the player through the movement it existed to measure. It now holds still once the body is past `holdAt`. | `src/core/gestures.ts` · `holdSec` |
| 9 | A tester with a tape measure reported needing 40–50 cm of side-step | Lane entry 0.55 → 0.35 torso — about a lean, 17.8 cm — which only became reachable once row 8 stopped the reference from moving. | `src/games/runner.ts` · `const LANE_ENTER = 0.35;` |
| 10 | "red light freezes too fast" | Gate close ratio 0.55 → 0.75. At 0.55 the close sat at 2.1 against a still-median of 2.01, so one noise spike opened the gate and it hung open. | `src/games/redlight.ts` · `exitRatio: 0.75` |
| 11 | "red light is very buggy" | Stillness calibration ran inside a branch that could never be true, so a player standing perfectly still read 1.95 against a threshold of 0.85 and was eliminated ten seconds into every round. | `src/games/redlight.ts` · `calibrate` |
| 12 | "moving my arms like I'm running without running" | The instruction was the bug. `MOVE ON GREEN` made people WALK, which cannot work when body scale is the denominator of every threshold in the game. It now reads "DON'T WALK — STAY PUT". **And the MENU said `MOVE ON GREEN, FREEZE ON RED` until 2026-09-20** — the fix landed in the game and not at the point of first contact, which is where a stranger reads what a game is before choosing it. | `src/games/redlight.ts` · `STAY PUT` · `src/shell/menu.ts` · `PUMP YOUR ARMS, FREEZE ON RED` |
| 13 | The same confusion, on the state word | `<PUMP>`, not `<MOVE>` — the word names the motion that scores instead of the one that eliminates you. | `src/games/redlight.ts` · `'<PUMP>'` |
| 14 | "it'd keep track of two separate players scores, same thing with hole in the wall and red light" | `laneScore` ignored its `slot` and returned the best progress in the race, so six racers all scored 296 while three were frozen at 26% of the track. Score is now per lane. | `src/games/redlight.ts` · `export function laneScore(` |
| 15 | In a two-player game people "stand in the middle and swap tracks" | The divider is drawn four seconds early, during the countdown, plus a plate per half in that slot's identity colour — so the association is made before it has to be read under pressure. | `src/games/base.ts` · `drawStandingMarks` |
| 16 | Wanted an explicit "step out for the next player" | "NEXT PLAYER IN 5" states a fact about the software. The line now leads with the instruction and carries the number after it. | `src/games/base.ts` · `STEP OUT` |
| 17 | "make it harder, more pose variation", and separately "make the game harder" | Pose library 12 → 19, and the pass gate ramps within a round instead of sitting flat. Seven new poses was the largest mutually distinguishable set the metric could carry. | `src/games/poses.ts` · `export const PASS_THRESHOLD_END = 0.82;` |
| 18 | "decrease the range at which they register as a strikeable object" | Pop slop became a flat 0.04 torso instead of scaling with balloon size. A pop was firing on a 3-pixel graze at 720p. | `src/games/balloonpop.ts` · `const POP_SLOP_TORSOS = 0.04;` |
| 19 | The score was behind a balloon for most of every round | An opaque paper shelf with a hard ink rule, and the playfield culled underneath it — a shelf alone would leave balloons poppable while hidden. | `src/games/balloonpop.ts` · `hudShelf` |
| 20 | "I legit couldn't reach most" of the fruit | Fruit is now placed relative to the player's own body centre within a measured reach band, not at a fraction of the slot rect. | `src/games/fruitninja.ts` · `const REACH_HALF_TORSOS = 1.45;` |
| 21 | "they love combo chains." | The escalation got the budget: a word per chain length, growing type, growing flash, and confetti past a triple. Scoring deliberately untouched. | `src/games/fruitninja.ts` · `CHAIN_WORDS` |
| 22 | Hits registering "to a target that is far away", and inconsistent perfect timing | Both halves were one number. A 0.5-torso hit radius swallowed neighbouring targets (they sit 0.3625 apart) and made the judged time speed-dependent. **Live-tunable since 2026-09-20** — it had no declared slider, so the playtest that produced it could not have retuned it without a rebuild. The slider stops at 0.36, below the 0.3625 cliff. | `src/games/rhythm.ts` · `const HIT_RADIUS_TORSOS = 0.3;` · `src/meta/tunables.ts` · `PUNCH REACH` |
| 23 | "ensure passersby don't affect the game" | Bystander rejection by relative size, plus a reservation that a passer-by can never hold — the distinguishing property of a passer-by is not where they are, it is that they do not stop. | `src/core/tracker.ts` · `minRelativeSize` |
| 24 | "seven dwell tiles slow down every turn in a queue." | Fair mode: `shell.menuSize` trims the menu to the first N available games, with a row shape that gets taller as well as wider. | `src/shell/menu.ts` · `shell.menuSize` |
| 25 | On a fresh install every tile says "BE THE FIRST!" | The operator can type a real target score per game. No auto-seeding — scoring scales are not comparable across these seven games, so any default would be this repo guessing about a hall it has never seen. | `src/shell/operator.ts` · `op-entry-row` |
| 26 | Asked for a way to leave initials entry without typing a name | `SKIP` while the entry is empty, `OK` once there is something to confirm, and never styled green — a green SKIP reads as the recommended choice. | `src/shell/initials.ts` · `'SKIP'` |
| 27 | A marshal needs to drive the screen without walking into frame | Mouse and keyboard for the OPERATOR only. A click commits immediately; nobody in the queue touches the laptop, which is what PLAN.md §6 actually protects. | `src/shell/hover.ts` · `const pointer = {` |

---

## What the ledger has caught since it was written

Three things, all on the same day it was created, which is the argument for it:

1. **The menu still said `MOVE ON GREEN`.** Row 12's fix landed in
   `redlight.ts` and the ledger's anchor pointed there, so it passed — while
   the MENU, where a stranger reads what a game is before choosing it, still
   carried the exact wording the playtest rejected. The ledger was checking the
   file the fix landed in rather than the words on the screen. It now checks
   both.
2. **Row 22's constant was not reachable.** The hit radius came straight from a
   tester and had no slider, so the playtest it exists for could not retune it.
3. **Two of my own comments, twice.** Writing a correction note that quoted a
   figure near the word "playtest" reads to the completeness scrape as a new
   unfiled report — and so does a tester quote split across a string
   concatenation. Both are the guard working: a report that cannot be matched
   is a report that has gone missing.

---

## What is deliberately NOT here

Two things testers asked for that were **not** built, so the absence is on the
record rather than forgotten:

- **A replay affordance — "wave to play again".** Results end on a fixed 7 s
  `STEP OUT — NEXT PLAYER IN n` instead. A replay turns a predictable turn
  length into an open-ended one, which is the opposite of what a queue needs,
  and turn length being predictable is what the whole flow is built around.
- **A T-pose to confirm calibration.** Replaced by standing still, because a
  T-pose has to be explained and the entire promise of the shell is "no
  instructions". `TPoseDetector` survives and is used by the rig check, where
  an operator *does* want an unambiguous deliberate shape.

---

## Still owed to the next playtest

Rows above are closed. These are open, and each names the number to watch:

| Game | What to measure | The knob |
|---|---|---|
| Pose Match | Pass rate on the first wall. The gate is expected to want LOWER on real bodies than on the simulator. | **MATCH THRESHOLD** |
| Runner | First-timer hit rate on `low` (jump) obstacles specifically. Under ~60%, weight them to near zero and ship lanes + slides. | `TrackGenerator.pickKind` |
| Initials | Real entry times. The 16 s backstop can shrink if nobody needs it. | `HARD_DEADLINE_SEC` |
| Red Light | Whether five racers in one frame hold their lanes for a full round. | **MOVE THRESHOLD** |
