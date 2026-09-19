/**
 * The whole visual language, in one file.
 *
 * SOURCE OF TRUTH: GDG on Campus UOBD brand kit.
 *   design/DESIGN.md  — the rules
 *   kit/css/tokens.css — the values
 *
 * "White graph paper, black ink, four flat Google colours, heavy capitals in
 * code brackets, and chunky sticker pills with hard shadows."
 *
 * This file replaced a neon-on-dark direction. The three things that changed
 * and that everything else follows from:
 *
 *  1. THE BACKGROUND IS PAPER, NOT BLACK. ~70% paper, 20% ink, 10% brand
 *     colour. Ink on paper is also the more legible choice at 3m: white type
 *     on black blooms and smears on the cheap panel a club fair will actually
 *     supply, and black on white does not.
 *  2. NO BLUR AND NO TRANSPARENCY. Shadows are hard, ink-coloured, offset
 *     straight down, zero blur. Brand colours are always flat. `shadowBlur`
 *     is now both off-brand AND the most expensive call in the app, so the
 *     brand and the frame budget finally want the same thing.
 *  3. ARCHIVO, EXCLUSIVELY.
 *
 * ============================ SCALING NOTE ============================
 * The brand kit specifies px against a 1280px-wide web page read at arm's
 * length. This app is a TV read from three metres, and ARCHITECTURE.md rule 7
 * says sizes are `vh`, never raw pixels. Every px token below is therefore
 * expressed in vh, calibrated so it renders at its brand value on a 1080p
 * panel, and the two tokens that carry the brand's "chunky" intent — outline
 * weight and shadow offset — are multiplied by `DISTANCE_GAIN`. A literal 3px
 * outline at 3m subtends a third of what it does on a laptop and reads as the
 * "thin grey outline" the brand explicitly forbids. Honouring the letter there
 * would break the intent.
 * ======================================================================
 */

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/* ------------------------------------------------------------------ */

export const COLORS = {
  /* --- brand tokens, verbatim --- */
  /** Backgrounds. The default surface for everything. */
  paper: '#FFFFFF',
  /** Text, outlines, shadows. */
  ink: '#111111',
  /** 1px graph-paper rule on a 32px grid. */
  grid: '#ECECEC',
  /** Disabled and placeholder states. */
  muted: '#BDBDBD',

  /** Action and selection. Also 1st place. */
  yellow: '#FBBC04',
  /** Info, links, focus. Also 2nd place. */
  blue: '#4285F4',
  /** Success, open, free. */
  green: '#34A853',
  /** Errors, busy, closed. Also 3rd place. */
  red: '#EA4335',

  /* --- legacy aliases ---------------------------------------------
   * Every game imports these names. They are re-pointed at the brand
   * tokens rather than deleted, so the substrate of all seven games flips
   * to paper-and-ink in one move instead of each one being broken until
   * someone gets to it.
   *
   * THEY ARE NOT A SECOND PALETTE. New code uses the names above.
   * The `*Bright` entries existed only to make the brand hexes work as
   * neon on black; there is no neon any more, so they are the flat brand
   * colour and nothing else.
   * ---------------------------------------------------------------- */
  bg: '#FFFFFF',
  bgRaised: '#FFFFFF',
  bgOverlay: '#FFFFFF',
  text: '#111111',
  textDim: '#111111',
  textFaint: '#BDBDBD',

  blueBright: '#4285F4',
  redBright: '#EA4335',
  yellowBright: '#FBBC04',
  greenBright: '#34A853',

  danger: '#EA4335',
  success: '#34A853',
} as const;

/**
 * Per-player / per-faction colours, in order.
 *
 * Four flat brand colours, then ink, then muted. DESIGN.md caps a *component*
 * at two brand colours; a six-player game legitimately needs six identities,
 * which is a different thing — but no screen should ever draw more of these at
 * once than it has players.
 *
 * THE SIXTH IS MUTED AND THAT IS A KNOWN COMPROMISE, not an oversight.
 *
 * The kit has exactly five colours a player can be told apart by — yellow,
 * blue, green, red, ink — and Red Light seats six. All six ARE distinguishable
 * on screen, which is what `brand.test.ts` checks and what actually matters in
 * the lane. What is wrong with it is semantic: muted is this kit's DISABLED
 * colour everywhere else in the app, so the sixth racer's marker reads as
 * switched off to anybody who has learned the rest of the system. The factions
 * hit the identical wall and solved it with `factionSplit` — a four-colour
 * swatch for the one identity with no colour of its own — which works on a
 * faction tile and would be mud on a 2vh lane marker at three metres.
 *
 * Fixing it properly means either a ninth palette token, which is a decision
 * for the club's kit and not for this file, or a second identity axis (a
 * hollow marker, a striped chip) threaded through every call site that takes a
 * colour string. Neither is worth doing days before an event to improve a case
 * that is already legible. Written down so the next person does not have to
 * rediscover the constraint to reach the same answer.
 */
export const PLAYER_COLORS = [
  COLORS.yellow,
  COLORS.blue,
  COLORS.green,
  COLORS.red,
  COLORS.ink,
  COLORS.muted,
] as const;

/** Rank colours from the brand's ranked-list spec: 1st, 2nd, 3rd, then ink. */
export const RANK_COLORS = [COLORS.yellow, COLORS.blue, COLORS.red] as const;

export function rankColor(rank: number): string {
  return RANK_COLORS[rank - 1] ?? COLORS.ink;
}

/**
 * The colour of a faction, by its index in `meta/leaderboard.ts`'s FACTIONS.
 *
 * Centralised so the faction band on attract, the picker on initials and
 * anything the tournament bracket grows later all agree. A team whose colour
 * changes depending on which screen you are looking at is not a team.
 */
export function factionColor(index: number): string {
  return FACTION_COLORS[Math.max(0, index) % FACTION_COLORS.length] ?? COLORS.blue;
}

/**
 * Six faction identities from four brand colours.
 *
 * `PLAYER_COLORS` ends `...ink, muted`, which is correct for a six-player game
 * where the last two slots are transient. It is WRONG for factions: muted is
 * this kit's *disabled* colour, so the sixth faction rendered as greyed-out and
 * unavailable. Nobody picks the option that looks switched off, which would
 * have quietly zeroed a whole faction's score on day one.
 *
 * So: four flat brand colours, then INK — a full-strength kit colour, not an
 * absence — and OTHER gets all four at once, which is also what "other" means.
 */
export const FACTION_COLORS = [
  COLORS.yellow,
  COLORS.blue,
  COLORS.green,
  COLORS.red,
  COLORS.ink,
  COLORS.blue, // OTHER: primary for single-colour contexts; see factionSplit.
] as const;

/**
 * The four-colour split for a faction with no single colour of its own.
 * Returns null for factions that do have one — callers draw a solid swatch.
 */
export function factionSplit(index: number): readonly string[] | null {
  return index === 5 ? [COLORS.yellow, COLORS.blue, COLORS.green, COLORS.red] : null;
}

/* ------------------------------------------------------------------ */
/* Contrast                                                            */
/* ------------------------------------------------------------------ */

/** Relative luminance, WCAG definition. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio between two hex colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Minimum contrast for text a stranger reads from 3m on an unknown TV.
 *
 * 3.0 is WCAG's large-text threshold. Everything player-facing here IS large
 * text, but the viewing distance and the panel are both worse than WCAG
 * assumes, so this is a floor, not a target.
 */
export const MIN_CONTRAST = 3;

/**
 * THE YELLOW RULE.
 *
 * Yellow is the brand's action colour, which makes it the obvious pick for
 * "RECORD PACE", "NEW BEST", a live streak — and on paper it is the one brand
 * pairing that vanishes. #FBBC04 on #FFFFFF is about 1.7:1: legible on a
 * monitor at arm's length, gone on a TV across a hall.
 *
 * So: **yellow is a SURFACE, never a text colour on paper.** Fill a sticker
 * with it and put ink on top. This enforces that mechanically rather than
 * relying on everyone remembering.
 */
export function textColor(preferred: string, on: string = COLORS.paper): string {
  if (contrastRatio(preferred, on) >= MIN_CONTRAST) return preferred;
  return contrastRatio(COLORS.ink, on) >= contrastRatio(COLORS.paper, on)
    ? COLORS.ink
    : COLORS.paper;
}

/* ------------------------------------------------------------------ */
/* Type                                                                */
/* ------------------------------------------------------------------ */

/**
 * DESIGN.md: "Archivo typeface only." All three keys resolve to it — `body`
 * and `mono` are kept because every game imports them, not because there is a
 * second or third family.
 *
 * Numbers want tabular figures. Canvas 2D cannot set `font-feature-settings`,
 * so `drawTabularNumber` in engine/draw.ts fixes the digit advance by hand
 * instead. Use it for anything that counts.
 */
export const FONTS = {
  display: 'Archivo, "Helvetica Neue", Arial, sans-serif',
  body: 'Archivo, "Helvetica Neue", Arial, sans-serif',
  mono: 'Archivo, "Helvetica Neue", Arial, sans-serif',
} as const;

/**
 * Weights, by role. DESIGN.md is specific and the difference between 800 and
 * 900 is visible at 3m, so these are not interchangeable.
 */
export const WEIGHT = {
  /** Display, H1, and every number. */
  black: 900,
  /** H2. */
  extrabold: 800,
  /** Pill labels, buttons. */
  bold: 700,
  /** Body copy. */
  medium: 500,
} as const;

/**
 * Letter-spacing, by role, as a CSS length string for `ctx.letterSpacing`.
 * Negative on the big stuff — heavy Archivo at display size needs tightening
 * or it reads as separate letters rather than a word.
 */
export const TRACK = {
  display: '-0.04em',
  h1: '-0.04em',
  h2: '-0.02em',
  pill: '0.01em',
  body: '0.02em',
  number: '-0.02em',
} as const;

/**
 * TYPE SCALE, in viewport-height units.
 *
 * vh-relative because the only screen that matters is a TV at an unknown
 * resolution, and "readable from 3m" is a proportion of screen height, not a
 * pixel count. Sized from DESIGN.md's px ranges against a 1080p panel:
 * display 64–180px → 6–16.7vh, H1 40–72px → 3.7–6.7vh, H2 26–36px →
 * 2.4–3.3vh, pill 14–28px → 1.3–2.6vh.
 *
 * Pick by ROLE, not by size. One `hero` per screen, at most.
 */
export const TYPE = {
  /** Display. The one number or word that is the whole point. */
  hero: 14,
  /** Display, lower end. The live score, the rank on a reveal. */
  score: 9,
  /** H1. Screen title — `<CHOOSE YOUR GAME>`. */
  title: 6.4,
  /** H1, lower end. Card title. */
  heading: 4.4,
  /** H2. The smallest a stranger is ever asked to read. See MIN_LEGIBLE. */
  subhead: 3.2,
  /** Pill label, large. The supporting line that explains the thing above it. */
  body: 2.8,
  /** Pill label. Kickers and badges — always attached to something bigger. */
  label: 2.2,
  /** Operator, diagnostic and decorative only. Never player-facing content. */
  micro: 1.5,
} as const;

/**
 * The 3-metre floor.
 *
 * ARCHITECTURE.md: legible from 3m with no instructions and no sound. Anything
 * a player actually has to READ to understand what to do sits at or above this
 * size. Anything below it must be a label attached to something above it.
 */
export const MIN_LEGIBLE = 3;

/* ------------------------------------------------------------------ */
/* Space and shape                                                     */
/* ------------------------------------------------------------------ */

/**
 * SPACING SCALE, in vh.
 *
 * The brand's 8px base against a 1080p panel: 4/8/12/16/24/32/48/64/96px →
 * 0.37/0.74/1.1/1.5/2.2/3/4.4/5.9/8.9vh, rounded to a usable rhythm.
 */
export const SPACE = {
  xs: 0.75,
  sm: 1.5,
  md: 2.2,
  lg: 4.4,
  xl: 5.9,
  xxl: 8.9,
} as const;

/**
 * TV overscan safe area, in vh, on every edge.
 *
 * Consumer TVs still crop 3–5% of the signal and the stall will not get to
 * pick the TV. Nothing a player needs may sit outside this margin. Decorative
 * bleed — the graph paper, a shape peeking from behind a card — may.
 */
export const SAFE = 3.5;

/**
 * Graph-paper rule spacing, in vh.
 *
 * The kit specifies a 32px grid (3vh at 1080p). This is 6vh — see the note on
 * `graphPaper` in engine/draw.ts. At three metres a 32px grid of 6%-contrast
 * hairlines resolves as a flat tint rather than as graph paper, while costing
 * twice the draw work; the coarser rule is both more legible at the viewing
 * distance this app is actually used at and half the price.
 */
export const GRID_STEP = 6;

/**
 * See the scaling note at the top of this file. Outline weight and shadow
 * offset are multiplied by this so the brand's "chunky" reads as chunky at
 * three metres instead of as a hairline.
 */
export const DISTANCE_GAIN = 1.45;

/** CORNER RADII, in vh. Brand: pill 999px, card 28px, inner 18px. */
export const RADIUS = {
  /** Inner elements — keys, chips, inset panels. */
  inner: 1.7,
  /** Cards and tiles. */
  card: 2.6,
  /** Fully rounded. Any value past half the shorter side. */
  pill: 999,

  /** Legacy aliases, kept because games import them. */
  sm: 1.7,
  md: 2.6,
  lg: 2.6,
} as const;

/** OUTLINE WEIGHTS, in vh. Brand: 3px standard, 4px large pills, 2px thin. */
export const STROKE = {
  /** Thin pill, ranked-list row, rank badge. Brand 2px. */
  thin: 0.185 * DISTANCE_GAIN,
  /** The default. Pills, cards, inputs, buttons. Brand 3px. */
  base: 0.28 * DISTANCE_GAIN,
  /** Large pills and hero cards. Brand 4px. */
  thick: 0.37 * DISTANCE_GAIN,
} as const;

/**
 * HARD SHADOW OFFSETS, in vh. Straight down, ink, ZERO BLUR.
 *
 * This replaces the entire GLOW/HALO system. DESIGN.md: "No blurry drop
 * shadows." Every one of these is a second flat fill offset on Y, which is
 * both on-brand and roughly free — the opposite of `shadowBlur`, which canvas
 * charges per draw call and which made the old menu cost 3.1ms a frame doing
 * nothing.
 */
export const SHADOW = {
  none: 0,
  /** Brand 5px. The default sticker lift. */
  base: 0.46 * DISTANCE_GAIN,
  /** Brand 7px. Hover, and large pills. */
  lifted: 0.65 * DISTANCE_GAIN,
} as const;

/**
 * Decorative tilt range, in degrees. DESIGN.md: −14° to +12° for decoration;
 * anything readable, clickable, or a number stays straight.
 */
export const TILT = { min: -14, max: 12 } as const;

/* ------------------------------------------------------------------ */
/* Motion                                                              */
/* ------------------------------------------------------------------ */

/**
 * ANIMATION DURATIONS, in seconds. Brand: 150ms fast, 220ms standard, 60ms
 * button press.
 *
 * PLAN.md §1: "A queue of strangers. Hard 60s turn cap." Short on purpose. A
 * transition that gets admired is a transition that is too long.
 */
export const DUR = {
  /** Button press down/bounce. */
  press: 0.06,
  /** Brand "fast". Hover state change. */
  fast: 0.15,
  /** Brand "default". Screen wipes, panel entrances. */
  base: 0.22,
  /** A reveal worth watching — a score slam, a rank. */
  slow: 0.45,
  /** How long a result holds before the queue moves on. */
  hold: 2.6,

  /** Legacy alias. */
  instant: 0.06,
} as const;

/** DEFAULT MOTION, by intent. */
export const MOTION = {
  enter: 'spring',
  exit: 'out',
  impact: 'spring',
} as const;

/**
 * Solves a CSS cubic-bezier timing function.
 *
 * The brand specifies its easings as exact cubic-beziers, and "close enough"
 * curves are how a system stops feeling like one system. Newton–Raphson with a
 * bisection fallback; ~4 iterations, called a handful of times a frame.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number): number => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;

  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 5; i++) {
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 12; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v > x) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/** Standard easing. `spring` and `out` are the brand curves, exactly. */
export const EASE = {
  /** cubic-bezier(.34, 1.56, .64, 1) — the brand spring. Overshoots. */
  spring: cubicBezier(0.34, 1.56, 0.64, 1),
  /** cubic-bezier(.22, 1, .36, 1) — the brand exit curve. */
  out: cubicBezier(0.22, 1, 0.36, 1),

  in: (t: number) => t * t * t,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  /** Legacy name for the spring. Kept because games import it. */
  back: cubicBezier(0.34, 1.56, 0.64, 1),
  elastic: (t: number) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
} as const;

/* ------------------------------------------------------------------ */
/* Reduced motion                                                      */
/* ------------------------------------------------------------------ */

let reducedQuery: MediaQueryList | null = null;
let reducedParam: boolean | null = null;

/**
 * `?reduce=1` forces reduced motion on, `?reduce=0` forces it off.
 *
 * The OS setting is the real contract, but an operator at a stall cannot open
 * Windows settings mid-queue, and somebody who is photosensitive or just
 * overwhelmed is exactly the person you want to be able to help in five
 * seconds. It also makes the behaviour testable in a browser, which no tool
 * here can do by emulating the media query.
 */
function reducedOverride(): boolean | null {
  if (reducedParam === null) {
    if (typeof location === 'undefined') return null;
    const raw = new URLSearchParams(location.search).get('reduce');
    reducedParam = raw === null ? null : raw !== '0';
  }
  return reducedParam;
}

/**
 * DESIGN.md lists "Respects prefers-reduced-motion" as a rule, not a nicety.
 *
 * Read it every frame — it is a cached MediaQueryList lookup, and the operator
 * may flip the OS setting mid-event to calm the screen down for someone.
 *
 * WHAT IT MUST SUPPRESS: idle pulses and breathing, decorative drift, screen
 * wipes (they become instant cuts), staggered entrances, and screen shake.
 * WHAT IT MUST NOT SUPPRESS: anything that carries information — a dwell
 * timer filling, a countdown, a score changing, the live silhouette. Freezing
 * those would not calm the screen, it would break the game.
 */
export function prefersReducedMotion(): boolean {
  const override = reducedOverride();
  if (override !== null) return override;
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  // The MediaQueryList is cached but `.matches` is live, so flipping the OS
  // setting mid-event takes effect on the next frame without a reload.
  if (!reducedQuery) reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  return reducedQuery.matches;
}

/**
 * Scales an animation duration to zero under reduced motion, so callers can
 * write `dur(DUR.base)` once instead of branching at every call site.
 */
export function dur(seconds: number): number {
  return prefersReducedMotion() ? 0 : seconds;
}

/**
 * A 0→1 entrance ramp that is ALREADY 1 when motion is reduced.
 *
 * The naive form — `elapsed / Math.max(epsilon, dur(d))` — looks equivalent
 * and is not: on the very first frame `elapsed` is 0, so it yields 0, and a
 * screen whose title is drawn at `alpha: 0` for one frame flashes its own
 * header in. Under reduced motion there is no animation to start, so the
 * answer on frame one must be 1, not "a very fast 0".
 */
export function ramp(elapsed: number, seconds: number): number {
  const d = dur(seconds);
  if (d <= 0) return 1;
  return Math.min(1, Math.max(0, elapsed / d));
}

/**
 * An idle oscillation that flattens to `rest` under reduced motion. Use for
 * breathing, pulsing and drift — never for anything a player needs to read.
 */
export function idlePulse(time: number, rate = 2.2, rest = 1): number {
  if (prefersReducedMotion()) return rest;
  return 0.5 + Math.sin(time * rate) * 0.5;
}

/* ------------------------------------------------------------------ */
/* Colour utilities                                                    */
/* ------------------------------------------------------------------ */

/**
 * DESIGN.md: "No gradients or see-through colours." Brand colours are always
 * flat.
 *
 * This is kept because six game files still call it and deleting it would
 * break the build, and because there is one legitimate use left: masking and
 * compositing that never shows a brand colour at partial opacity — clipping,
 * hit-flash overlays, the camera silhouette's echo. Do not reach for it to
 * tint a surface. Reach for `COLORS.grid` or `COLORS.muted`.
 */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** As `withAlpha`: off-brand for surfaces, retained for the games that call it. */
export function lerpColor(a: string, b: string, t: number): string {
  const pa = a.replace('#', '');
  const pb = b.replace('#', '');
  const ar = parseInt(pa.slice(0, 2), 16);
  const ag = parseInt(pa.slice(2, 4), 16);
  const ab = parseInt(pa.slice(4, 6), 16);
  const br = parseInt(pb.slice(0, 2), 16);
  const bg = parseInt(pb.slice(2, 4), 16);
  const bb = parseInt(pb.slice(4, 6), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

