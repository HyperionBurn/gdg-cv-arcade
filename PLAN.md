# GDG Club Fair — CV Games Plan (v2)

**Event:** Welcome Week club fair stall, **Sept 24 & 26**
**Owner:** Tech team (CV games + photobooth)
**Revised:** Sept 17

---

## 0. What changed in v2

v1 was scoped around human dev-days: 3 games, 2 days each, cut everything else. That was the wrong constraint. Code is no longer the bottleneck.

**The new bottleneck is everything that needs a real human in a real room:**

| Compressible (code) | **Not compressible (physical)** |
|---|---|
| Game logic, engine, shell | Tuning detection thresholds on **real bodies** |
| Meta-systems, leaderboards | Camera framing in the **actual space** |
| Juice, procedural audio | Branding decisions, asset approval |
| Tooling, operator console | On-site rehearsal with the actual TV |
| — | Finding out that people don't understand a game |

So this plan inverts. Scope goes way up; **the schedule is now dominated by playtesting and rehearsal, and those dates are immovable.** A gesture threshold that feels right on one person at a desk is wrong for a 6'4" person in a crowded hall, and no amount of compute finds that out.

**Corollary risk:** more games = more surface area to break on the day. Mitigated by a hard freeze date, feature flags on every game, and a designated **core 3** that must work even if everything else is switched off.

---

## 1. The stall is still the spec

Unchanged from v1. The physics of the room don't care how fast we build.

| Reality | What it forces |
|---|---|
| One TV, one laptop, one webcam | Games are *modes* in one app. One camera stream, one owner. |
| A queue of strangers | Hard 60s turn cap. No lives-based rounds. |
| Most people play exactly once | Depth is worthless. Legibility in 3 seconds is everything. |
| Loud, bright hall | Must read perfectly with **sound off**, from 3m away. |
| People are with friends | The loop is social, not solo. Design for the audience. |
| Venue wifi will fail | Everything bundled local. Zero runtime network calls. |

**The one sentence that governs every design call:** someone walking past must understand the game, without reading anything, before they reach the end of the table.

---

## 2. Architecture

A real engine, not seven one-off canvases. Everything below is shared.

```
/src
  /core
    camera.ts       single getUserMedia owner; device pick, mirroring, recovery
    vision.ts       MediaPipe in a Web Worker; pose + hands; 30fps inference
    tracker.ts      multi-person identity persistence across frames
    filter.ts       One Euro filter on every landmark
    gestures.ts     jump/crouch/lean/rep/swipe state machines w/ hysteresis
    calib.ts        play-zone calibration + per-body scale normalisation
  /engine
    loop.ts         fixed-timestep sim, interpolated render
    juice.ts        shake, hit-stop, time dilation, chromatic aberration
    particles.ts    pooled particle system
    audio.ts        Web Audio: procedural SFX + adaptive music
    ui.ts           shared HUD, countdown, score slam, rank reveal
  /games            sixtyseven, fruitninja, runner, posematch,
                    balloonpop, rhythm, redlight
  /meta
    leaderboard.ts  local store, factions, cross-day persistence
    tournament.ts   live bracket + duel queue
    ghosts.ts       deterministic replay record/playback
    highlights.ts   rolling frame buffer, clip export
    analytics.ts    play counts, session length, drop-off
    operator.ts     hidden console, hotkeys, score moderation
  /shell
    attract.ts  menu.ts  initials.ts  router.ts
```

### The four core pieces that make everything else feel good

**`filter.ts` — One Euro filter.** Raw MediaPipe landmarks jitter. Unfiltered input feels broken even when detection is perfect. This single file is the difference between "responsive" and "janky" across every game. Low-latency at speed, heavy smoothing at rest.

**`tracker.ts` — identity persistence.** MediaPipe's multi-pose output gives you N skeletons per frame with **no stable IDs between frames**. For any 2P game, player 1 and player 2 will swap the moment they cross. We need our own tracker: greedy centroid matching frame-to-frame, with a lock on the largest/nearest N skeletons so the crowd behind the player can't hijack the game.

**`gestures.ts` — state machines with hysteresis.** Every gesture is a state machine with separate enter/exit thresholds, never a bare comparison. A naive `wrist.y < shoulder.y` check fires 30 times a second at the boundary. Every threshold in this file is a tunable, exposed in the operator console, because they *will* need adjusting on the day.

**`calib.ts` — body scale normalisation.** A 5'2" player and a 6'4" player produce wildly different pixel deltas for the same jump. Normalise everything to shoulder-width and torso-height at round start, so thresholds are body-relative, not pixel-absolute. Without this the games are unfair and feel broken to whoever isn't average height.

### Performance

- Inference in a **Web Worker** at 30fps; render on main thread at 60fps with interpolated landmarks between inference frames.
- GPU delegate where available, CPU fallback.
- Frame budget watchdog: auto-drop particle density and effect quality if we miss frame time. The stall must never stutter, even at hour four with a hot laptop.
- **All WASM + `.task` models bundled locally.** No CDN. This is the single most important line in the doc — if wifi dies and we're loading models from a CDN, the entire TV goes dark and there is no recovery.

---

## 3. The games

Seven. Grouped by role at the stall, not by build cost.

### Core 3 — must work or the stall fails

These get the most playtesting, and feature flags let us kill everything else and still run a great stall.

---

#### 1. 67 Speed Duel — *the queue eater*

- **Mechanic:** alternate arms up/down as fast as possible. 20 seconds. Count reps.
- **Score:** one integer.
- **2P:** split screen, `numPoses: 2`, two bars racing live. Two people per turn.
- **Detection:** rep counts only if the wrist crosses **above shoulder** *and* **below elbow** — hysteresis on both edges. Kills the tiny-twitchy-hands exploit, which people *will* find within the first hour.
- **Juice:** bars physically shake as they fill, camera punches on each rep, pitch rises with rep rate, screen goes white on a new record.
- **Ghost mode:** in 1P, race the #1 holder's recorded rep pacing as a translucent second bar.

> **Why build rather than open 67speed.com:** their duels need two devices and accounts. Two people on **one camera, one screen**, with our leaderboard and branding, doesn't exist anywhere. And the crowd energy of two people flailing side by side at a single TV is the whole point.

---

#### 2. Fruit Ninja — *the crowd-puller*

- **Mechanic:** hands are blades. Slice fruit. Bombs end the run.
- **Round:** 45s timer; bombs end it early. Timer gives queue predictability, bombs give drama.
- **Score:** fruit sliced + combo multiplier for multi-slices in one swipe.
- **2P:** split screen, one player per half, symmetric spawns.
- **Now affordable:** real 2D rigid-body physics, actual blade-path polygon intersection (not point sampling), fruit that splits along the **true cut line** with correct halves, shader-based blade trails, juice splatter that persists on a screen-space layer and slowly drips.
- **2D, deliberately.** Splitting a convex polygon along a line segment is ~20 lines and yields two correct halves with correct physics. In 3D the same thing is CSG — hard, and invisible from 3m. The cut-line split *is* the mechanic; don't make it harder for a payoff nobody sees.
- **Base:** read [collidingScopes/fruit-ninja](https://github.com/collidingScopes/fruit-ninja) (MIT), but build ours — it's 3D and point-sampled, which dodges exactly the part worth doing well.

---

#### 3. Red Light, Green Light — *the sleeper hit*

Not on anyone's list. **I think this is the single best addition to the roster.**

- **Mechanic:** everyone advances on green. On red, freeze. Motion above threshold = out. Last one standing, or first to the line.
- **Why it's exceptional here:**
  - **Up to 5 players at once.** It converts the *queue itself* into the game. Nothing else on the list does this.

    > **Amended 2026-09-19, from six.** A lane's identity is its entry in `PLAYER_COLORS`, so the roster can only be as long as that array — and the array only held five real colours. The sixth entry was `COLORS.muted`, which is the *same value* `redlight.ts` uses to draw an ELIMINATED lane, so player six rendered in the game's own colour for YOU ARE OUT beneath a HUD reading `6/6 STILL IN`. The alternatives were a ninth palette token (a decision for the club's kit, not this repo) or a second identity axis — a striped or hollow marker — threaded through every call site that takes a colour string. Five unmistakable players beat six where one cannot tell whether they are playing. `tests/brand.test.ts` now asserts the semantic rule rather than the count.
  - Universally recognisable, zero explanation, zero skill barrier.
  - Peak spectator value — the whole crowd watches people frozen mid-step.
  - Room-scale, which is exactly what the confirmed floor space is for.
- **Detection:** per-player total landmark velocity, normalised by body scale, over a sliding window. Grace period on the red transition so nobody's out for momentum.
- **Juice:** the doll head turn, the sound cue, red screen wash + player highlight on elimination.
- **Risk:** needs the full play area kept clear and someone marshalling. Worth it.

---

### Party tier — variety and repeat plays

---

#### 4. Runner — the "Subway Surfers" slot

- **Mechanic:** 3 lanes. Step left/right, jump, crouch.
- **Score:** distance, with a speed ramp.
- **The only genuine 3D game on the roster.** Three.js, but **fully procedural geometry — no downloaded models.** Neon/Tron aesthetic: glowing wireframe track, emissive obstacles, particle speed lines, all `BufferGeometry` built at runtime. Procedural track generation, difficulty ramped by distance, near-miss bonuses.
- **The player is an abstract glowing form, not a humanoid** — no rigging, no Mixamo, no animation pipeline, and it sidesteps "why does that character look nothing like me."
- **Ghost:** the #1 run plays as a translucent racer beside you.
- **Contingency:** still worth keeping — if it isn't *fun* by the playtest, cut it. Distance-based runners are the hardest thing here to make feel good with noisy body input, and "we built it" is not a reason to ship it.

---

#### 5. Pose Match / Hole in the Wall — *the funniest*

Promoted from stretch. With build cost gone, this is too good to skip.

- **Mechanic:** a silhouette wall approaches. Match the pose before it hits. Survive as many as possible.
- **Score:** walls cleared + match accuracy percentage.
- **2P:** side by side, who matches more.
- **Detection:** cosine similarity on scale- and rotation-normalised landmark vectors, joint-angle weighted so limb position matters more than absolute position.
- **Why:** funniest to watch by a distance, and it produces the best photos — which matters when the photobooth lands later.
- **Cost note:** the pose *library* is the real work. Generate poses procedurally from joint-angle constraints rather than hand-authoring them, then hand-pick the funniest.

---

#### 6. Rhythm Punch — *the spectacle*

- **Mechanic:** targets fly at you on the beat. Punch with the correct hand. Duck the walls.
- **Score:** hits + combo + accuracy.
- **Now affordable:** beat maps generated by offline audio analysis (onset detection) rather than hand-charting, so any CC0 track becomes a level.
- **Why:** the most visually impressive thing on the roster and the best fit for a loud room — it's the one game where the hall's noise doesn't matter because the rhythm is *visual*.
- **2P:** mirrored lanes, side by side.

---

#### 7. Balloon Pop — *the accessible one*

- **Mechanic:** balloons drift up, pop them with your hands. 30 seconds.
- **Why it stays despite overlapping Fruit Ninja:** it works **standing still, hands only**. Not everyone will flail in front of a crowd — shy people, staff, someone in formal dress, a kid dragged along by a sibling. Every stall needs a game with a zero-embarrassment floor, and it's also the fastest queue-overflow valve.

---

## 4. Meta-systems

This is where a good stall becomes a memorable one, and it's almost all cheap now.

### Factions — *the best social hook available*

On first play, pick your **major** (or year) with a hand-hover. Every score contributes to a live faction total on the attract screen.

**Engineering 4,820 · CS 4,190 · Business 3,050**

This is the highest-leverage feature in the doc. It converts a solo score into a team stake, it makes people drag their friends over to close a gap, and it's a running narrative across both days. Near-zero build cost.

### Live tournament bracket

For 67 Duel, Pose Match and Fruit Ninja — short, loud, head-to-head. Bracket displays on the attract screen between rounds, winner's initials go up in lights. Run it as a scheduled thing — "bracket at 2pm" gives the events team something to post about and creates a crowd spike.

> **Amended 2026-09-19: started from the OPERATOR CONSOLE, not "opt in via the menu".**
>
> A bracket is run BY somebody. Names get typed in off a clipboard, a late arrival gets added, a match gets replayed because the camera dropped someone. None of that is a hand-dwell interaction, and putting it on the TV would let a stranger wander into it mid-event. So the marshal seeds it on the BRACKET tab and the only player-facing parts are the ones that should be: the pair called up on the attract headline, and the bracket itself between rounds.
>
> Results still report themselves — play the match as a normal versus round and it advances — so the marshal's job during play is only to call the next pair.

### Ghosts

Deterministic replay of the top run per game, played back translucent alongside the live player. Cheap once the sim is fixed-timestep, and it turns a solo run into a race.

### Highlight clips

Rolling ~8s frame buffer. On a top-5 score or a big combo, export a clip. No email, no QR — it just **plays back instantly on screen** with the score stamped on it while the next player steps up. Feeds the photobooth work later, and the marketing person can film the TV.

> **Extended 2026-09-20 — the attract reel.**
> As written this reaches exactly one person: the player who just set the
> score, who watched it happen in the room a moment earlier. §6 also asked for
> "looping highlight clips" on attract and that half was never built, because
> capture SWAPS the two atlases and only one clip can exist at a time.
>
> There is now a four-slot reel in its own atlas — the last two seconds of each
> captured highlight, half-size cells, all four slots in one 8×8 grid. 2.36 MB
> on top of the 18.87 MB the main buffer already holds, which is a deliberate
> number: the measured GPU cliff is at roughly 20 MB and the configuration that
> actually fell off it was 28 MB, so the reel is the first thing the cost guard
> gives back, ahead of halving the main cell.
>
> It shows **only while nobody is in frame.** With a body present the live
> silhouette is the stronger hook — "that is me on the TV" — and two moving
> rectangles competing makes both weaker.

### Leaderboard

- Per-game top 10, always visible on attract.
- **Persists across both days** — Day 2 competes against Day 1, so the second day is *more* competitive.
- Post-run rank reveal with near-miss framing: **"#4 TODAY — 2 OFF THIRD."** That line sells more retries than the score does.
- **Arcade initials**, 3 letters, hand-hover grid. Keyboard-free, ~4 seconds, and people enjoy it.

### Analytics

Plays per game, average session length, where people drop off, faction distribution. Costs nothing, and gives the club a real post-event writeup.

### Operator console

Hidden hotkey. Skip round, force-reset, kill a game via feature flag, moderate a score, and **live-adjust every gesture threshold**. This is the thing that saves the stall when someone's height or the lighting breaks a detector at 11am.

---

## 5. Juice and sound

A dedicated pass, not leftover hours. Feel is why people play twice.

**Shared juice engine, by impact-per-effort:**

1. **Screen shake** — 0.1–0.3s, randomised direction, eased out.
2. **Hit-stop** — freeze 2–4 frames on impact. Trivial, enormous.
3. **Time dilation** — brief slow-mo on a record or a near-miss.
4. **Particles** on every core action.
5. **Score counters roll**, never snap.
6. **Impact popups** that scale and fade at the point of contact.
7. **Chromatic aberration + bloom** on big moments only.

**Audio — go procedural.** Web Audio synthesis instead of sample packs: zero asset sourcing, infinite pitch variation, and the score can drive the music directly.

- **Every game fully legible with sound off.** The hall will be loud. Never gate feedback on audio.
- Weight the mix **low** — bass thumps carry through crowd noise, high dings don't.
- **Rising pitch on combo** — the highest-value audio investment. Communicates "you're doing well" with zero reading.
- Adaptive music: layers enter as score climbs, tempo lifts near a record.
- CC0 fallback if needed: [Kenney](https://kenney.nl/assets), [Freesound CC0](https://freesound.org/).
- **Get a bluetooth speaker.** TV speakers are bad and it doubles perceived production value.

---

## 5a. Art direction and assets

**Everything is generated in code. No 3D models, no Blender, no asset packs.**

| Game | Renderer | Assets |
|---|---|---|
| 67 Duel | Canvas 2D | None — bars, counter, timer, typography |
| Fruit Ninja | Canvas 2D | None — procedural vector shapes |
| Red Light Green Light | Canvas 2D | One doll figure (hand-drawn SVG) |
| Runner | **Three.js** | None — procedural `BufferGeometry` |
| Pose Match | Canvas 2D | None — poses generated from joint-angle constraints |
| Rhythm Punch | Canvas 2D, faked perspective | None |
| Balloon Pop | Canvas 2D | None |

### Why procedural over CC0 asset packs

1. **Cohesion.** Seven games built from seven asset packs looks like a student project. Seven games from one procedural visual language looks like a product.
2. **Kenney/Quaternius low-poly reads as generic mobile asset-flip** and would clash with six games of sharp vector work.
3. **No pipeline** — no downloads, no file size, no load time, no licensing audit, no GLTF debugging the night before.
4. **Restyleable in four constants.** When the GDG branding md lands, it's a palette swap. Textured models would mean a re-texture job.

### The visual language

**GDG's brand palette is the art direction, free.** Google blue/red/yellow/green is instantly recognisable, already ours, and works beautifully as neon on dark. One palette, one type family, consistent glow and bloom across all seven games.

**Honest failure mode:** "neon on black" is what every hackathon project looks like. Avoid it by committing to the real GDG colours rather than generic cyan/magenta, investing in typography, and keeping silhouette and motion distinct per game so they don't blur together.

### The only things we download

- **Fonts.** The one asset worth sourcing — display type matters enormously on a TV. Google Sans is restricted, so realistically Inter or Space Grotesk, **bundled locally**, unless the branding md says otherwise. **It did:** the kit is Archivo exclusively, and `scripts/fetch-fonts.mjs` vendors four weights of it. Nothing else ships.
- **Audio** — procedural Web Audio is the plan (see §5). CC0 packs are fallback only.

---

## 6. The shell

- **Attract mode** — live silhouette of whoever walks past, rendered with a glow/trail shader, faction totals, scrolling leaderboard, looping highlight clips. This is the foot-traffic engine. It runs whenever nobody's playing, which is most of the time.
- **Hand-hover menu** — dwell 1.2s. No keyboard, no mouse, no operator handoff.
- **Calibration** — auto-detect when someone enters the play zone, guide them into frame with an on-screen outline, confirm with a T-pose. Takes 3 seconds and eliminates most framing failures.
- **Round flow** — countdown, play, score slam, rank reveal, faction contribution, initials, "wave to play again."
- **Idle timeout** back to attract after 20s.

> **Shipped differently — noted 2026-09-19, so the spec and the glass agree.**
> The intent above held; four details did not survive contact.
>
> - **No glow/trail shader on the silhouette.** The brand conversion removed
>   every blur and every see-through colour in the app; the silhouette is flat
>   brand colour with a hard ink shadow. `vignette()` and `scanlines()` survive
>   as no-ops so nothing had to be deleted in a hurry.
> - **The calibration confirm is a HOLD, not a T-pose.** Attract counts a
>   still body in with a ring — `<STAND STILL>` → `<HOLD IT>` → menu. A T-pose
>   has to be explained; standing still does not, and the whole promise is
>   "no instructions". `TPoseDetector` was still built and is not dead: the rig
>   check uses it so an operator can confirm the detectors see a deliberate,
>   unambiguous shape before the doors open.
> - **Menu dwell is 1.5s, not 1.2s.** Testers landed on games they had not
>   chosen. A wrong pick costs a whole turn out of a moving queue, which is the
>   most expensive mistake the shell can make, so it bought the extra 300ms.
> - **No "wave to play again".** Results end with `STEP OUT — NEXT PLAYER IN n`
>   on a fixed 7s window. A replay affordance turns a predictable turn length
>   into an open-ended one, which is the opposite of what a queue needs — and
>   turn length being predictable is what the whole flow is built around.

---

## 7. Licensing

| Source | Use | License |
|---|---|---|
| [mediapipe-samples](https://github.com/google-ai-edge/mediapipe-samples) | Pipeline reference | **Apache-2.0** |
| [collidingScopes/fruit-ninja](https://github.com/collidingScopes/fruit-ninja) | Reference only | **MIT** |
| [hole-in-the-wall-game](https://github.com/davidchoo12/hole-in-the-wall-game) | Pose-similarity reference | **MIT** |
| Google Fonts (Inter / Space Grotesk) | Display type, bundled locally | **OFL** |
| Kenney / Freesound CC0 | Audio fallback only | **CC0** |

No 3D model packs, no textures, no sprite sheets — see §5a. Nothing to audit.

**Do not fork** — no license file, therefore all rights reserved despite being public: `abhinavaby/asthra-motion-arcade`, `steevy-cpu/finn-run`, `collidingScopes/keep-ups`. Worth *reading* — finn-run ships a `BOOTH_TRIAL_CHECKLIST.md` and asthra has a "fest checklist", both real on-site knowledge. DM the authors if we want to use them; they're students and will likely say yes.

---

## 8. Schedule

Sequenced so that **every human-gated milestone happens as early as possible**, because those are the real constraints.

| Date | Build (compressible) | **Human-gated (critical path)** |
|---|---|---|
| **Sep 17–18** | Core: camera, vision worker, tracker, One Euro, gestures, engine, shell skeleton | **Camera hardware test — laptop cam vs iPhone Continuity. Do this first.** Get GDG branding assets from Nawfal. |
| **Sep 19** | 67 Duel, Balloon Pop, leaderboard, initials | **Playtest 1 — 5+ people of varying heights.** Tune every threshold. |
| **Sep 20** | Fruit Ninja, Red Light Green Light | **Playtest 2 — Red Light with 5 people.** Needs a real group; can't be faked. (Was 6; see §3.) |
| **Sep 21** | Pose Match, Rhythm Punch, Runner | **Go/no-go on Runner.** Cut it if it isn't fun. |
| **Sep 22** | Factions, tournament, ghosts, highlights, operator console, juice + audio pass | **Playtest 3 — full roster, strangers not teammates.** The "do people understand it in 3 seconds" test. |
| **Sep 23** | Fixes only | **DRESS REHEARSAL: actual TV, actual laptop, actual room, 2+ hours.** Then **hard freeze.** |
| **Sep 24** | — | **STALL DAY 1** |
| **Sep 25** | Fixes from day 1 only. No new features. | Review analytics, adjust difficulty |
| **Sep 26** | — | **STALL DAY 2** |

**Three dates are immovable: the camera test on the 18th, the stranger playtest on the 22nd, and the rehearsal on the 23rd.** Everything else can move. If we're behind, cut games — never cut testing.

---

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Camera can't frame full body** | **Critical** | Laptop cam is ~40° vertical FOV → needs ~2.5–3m clear depth *and* a near-vertical lid. Tape the lid angle, tape a floor marker, raise the laptop. **iPhone Continuity Camera on top of the TV** is better height + wider lens and needs no uni requisition (which is blocked — 2-week lead time). **Test Sept 18.** |
| Wifi dies → models don't load | **Critical** | Everything bundled local. Zero runtime network calls. Verify with the laptop in airplane mode. |
| Too much surface area to test | High | Feature-flag every game. **Core 3** must stand alone. Hard freeze Sept 23. |
| Crowd behind player gets tracked | High | Largest/nearest lock-on + floor tape + calibration step. |
| Thresholds wrong for some body types | High | Body-scale normalisation + live threshold tuning in the operator console. |
| Laptop throttles over 4h | Medium | 30fps inference cap, frame-budget watchdog auto-degrades effects, keep it off soft surfaces, charger in. |
| Red Light needs marshalling | Medium | Assign a person. It's worth one person's attention. |
| Nobody approaches | Medium | Attract mode + faction totals + one person actively hyping. |

---

## 10. Day-of runbook

- Arrive early: floor tape, lid angle, calibration check **before** the crowd.
- Fullscreen, cursor hidden, notifications off, **sleep disabled**, charger in, airplane-mode test passed.
- Someone on the stall knows the operator hotkeys and can hard-reset in under 10 seconds.
- One person whose actual job is hyping the queue and explaining each game in one sentence.
- Faction totals and leaderboard visible at all times. Read the top score out loud when someone gets close.
- Run the tournament bracket at an announced time to create a crowd spike.

---

## 11. Open

- **GDG branding assets** — Nawfal said the events team built a branding md skill. Needed before the visual pass.
- **Faction categories** — majors, or years? Needs a call from the club.
- **Bluetooth speaker** — has to be someone's own (requisition is closed).
- **Camera** — laptop vs iPhone Continuity. Decided by the Sept 18 test.
- **Photobooth** — deferred, separate doc. The highlight-clip system is deliberately built so it slots straight in.
