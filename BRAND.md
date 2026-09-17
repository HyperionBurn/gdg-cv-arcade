# Brand conversion

Source of truth is the club's own kit, not this file:

- [`gdg-resources/design/DESIGN.md`](https://github.com/UdayAhuja19/gdg-resources/blob/main/design/DESIGN.md) — the rules, written explicitly "for designers, projects and AI assistants"
- [`gdg-resources/kit/css/tokens.css`](https://github.com/UdayAhuja19/gdg-resources/blob/main/kit/css/tokens.css) — the exact values

This file records what the rules mean **for a game kiosk**, which the brand does
not itself cover.

## The eight colours

| Token | Hex | Role |
|---|---|---|
| paper | `#FFFFFF` | backgrounds, pill fills |
| ink | `#111111` | text, outlines, hard shadows |
| grid-line | `#ECECEC` | 32px graph-paper grid |
| muted | `#BDBDBD` | placeholders, disabled, empty slots |
| yellow | `#FBBC04` | action, primary button, **1st place** |
| blue | `#4285F4` | info, focus rings, **2nd place** |
| green | `#34A853` | success, confirmed |
| red | `#EA4335` | error, busy, **3rd place** |

Proportions ~70% paper / 20% ink / 10% brand colour. Max **2 brand colours per
component**. Brand colours are **always flat** — no gradients, no tints, no
transparency.

## The rules we were breaking

Every one of these was in the codebase before the conversion:

1. Near-black `#0B0E14` background everywhere → **paper**
2. `shadowBlur` glow/halo system → **hard shadow, `0 5px 0 ink`, zero blur**
3. Space Grotesk + Inter + JetBrains Mono → **Archivo only**
4. `withAlpha` / `lerpColor` on brand colours → **flat colour**
5. Four-colour palettes per screen → **two brand colours per component**
6. Plain caps headings → **code brackets**, `<STEP IN TO PLAY>`
7. Default figures on scores → **tabular numbers**
8. Motion always on → **respect `prefers-reduced-motion`**

## Kiosk-specific decisions

The brand covers Instagram posts, stories, slides and web pages. It has no rules
for a real-time game canvas, so these are ours:

- **Sizes stay in `vh`, not px.** The brand's px type scale assumes a phone or a
  laptop; ours is a TV at unknown resolution viewed from 3m, where legibility is
  a proportion of screen height. The brand's *ratios* are kept.
- **Hard shadows scale with `vh` too**, so the 5px offset reads correctly at
  1080p and at 4K.
- **Tilt is decoration only.** DESIGN.md: functional elements stay straight.
  Scores, timers, leaderboards and inputs are never tilted; sticker labels and
  celebration badges may be, −14° to +12°.
- **An ink playfield is permitted only where a paper one is measurably less
  legible at 3m**, and must be justified in code. "It looked cooler dark" is not
  a justification. Everything around the playfield stays paper.

## Voice

Short, loud, friendly. Headings and actions in code brackets.

| Use | Not |
|---|---|
| `<STEP IN TO PLAY>` | Step in to play |
| `<PUMP YOUR ARMS>` | Pump your arms as fast as you can |
| `<NEW BEST!>` | New personal record |
| `2 OFF THIRD` | You were close to third place |
