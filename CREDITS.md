# Credits

## Inspiration

Ideas we took. **No code from these projects is in this repository.**

Game mechanics are not copyrightable; source code is. Both of the projects
below are published without a licence granting reuse, and one states the
position explicitly — so the verbs are fair game and the code is not. We
reimplemented independently, and credit the inspiration because it is owed
regardless of what the law requires.

- **Scott Lackey** — [tslackey/kinect-web-game](https://github.com/tslackey/kinect-web-game)
  The two-player-on-one-camera microgame format, and the verb catalogue that
  came with it: *mirror me, tug of war, hot potato, cheers, high five, score a
  goal*. That list named the gap in our own roster better than we had: six
  games where two people play **side by side**, and none where they interact
  with **each other**.
  Its LICENSE reserves all rights ("No license is granted to copy, modify,
  merge, publish, distribute"), so nothing beyond the public README was read,
  and nothing was used.

- **mattypark** — [interactiveswordgame](https://github.com/mattypark/interactiveswordgame)
  For the idea that two people can fight *each other* through one camera
  rather than take turns at a machine. No licence file; concept only.

## Technique references

Apache-2.0, so code here may legitimately be read and adapted — **with the
attribution the licence requires**, which is a real obligation rather than a
courtesy, and applies only where we actually copy.

- **Google / MediaPipe** — [mediapipe-samples](https://github.com/google-ai-edge/mediapipe-samples),
  [mediapipe](https://github.com/google-ai-edge/mediapipe) — the canonical
  reference for the PoseLandmarker, HandLandmarker and GestureRecognizer web
  APIs this project is built on.
- **TensorFlow** — [tfjs-models](https://github.com/tensorflow/tfjs-models) —
  multi-person tracking and frame-to-frame identity assignment. A different
  runtime, but the same problem `src/core/tracker.ts` solves.
- **5of12** — [MediaPipe-Playground](https://github.com/5of12/MediaPipe-Playground) —
  long-range hand and body interaction, which is the regime a stall actually
  runs in: three metres, not arm's length.

## Assets

- **Archivo** (Omnibus Type) — SIL Open Font License 1.1. Fetched at setup by
  `scripts/fetch-fonts.mjs`, not committed.
- **MediaPipe pose and hand models** — Apache-2.0, fetched at setup by
  `scripts/fetch-models.mjs`, not committed.

Everything else — every game, all art, all audio — is original to this
project. There are no downloaded sprites, textures or sound files: the art is
drawn procedurally to canvas and the audio is synthesised through Web Audio.
