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

Green as of the last commit: **483 tests, 97 suites, 0 failures**, typecheck
clean, production build verified to make **zero external requests**.

```bash
npm run setup      # fetch models + fonts — REQUIRED before first run
npm run dev        # http://localhost:5173
npm test           # 483 tests, ~10s
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

**And the highlight buffer finally reports itself.** It is the largest
allocation in the app and it could shed — or switch off entirely — without a
word anywhere. `d` now has `replay` and `reel` rows; the operator console has
**DATA → REPLAYS & ATTRACT REEL** with buffer size, grab cost, shed level and
switches for both. Exactly the storage-flag problem from the 19th, one layer
down.

---

## Open, and deliberate

Things I looked at and chose not to change. If you disagree, the reasoning is
here so you can overrule it properly.

- **Two chase readouts on one screen.** Pose Match and Runner each draw an
  in-playfield "N TO #4" marker while the HUD simultaneously shows a ghost race
  ("N AHEAD OF BEST"). Both are true and they are different races, but it is
  clutter, and `base.ts` already has a documented rule about which one wins.
  Changing it is a design call with real trade-offs, so it is a judgement call
  I left to you rather than churn five days out.
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
- **The reel's memory budget wants one real measurement.** Total canvas backing
  store is now 21.2 MB against a cliff measured at roughly 20 MB on THIS
  machine, and a failure measured at 28. The guard sheds the reel first and
  automatically, so the downside is "the reel disappears", not "the stall
  stutters" — but check the `reel` row on `d` after an hour at the rehearsal.
  If it says OFF, this laptop is past the cliff and the reel is not for it.
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

---

## If it goes wrong on the day

`README.md` has the real table. The three things worth memorising:

1. **Camera dead** → `?sim=1`. The rig check and every diagnostic knows this is
   deliberate and will say `SIMULATOR — no camera by design` rather than
   reporting a fault.
2. **Red `NOT SAVING` chip** → **do not reload.** Go to the operator console's
   DATA tab and press every EXPORT button, bracket first.
3. **Anything else** → press `d`. The first bad row is the cause; everything
   under it is a consequence.
