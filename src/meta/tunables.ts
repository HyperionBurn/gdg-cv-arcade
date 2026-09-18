/**
 * Live-adjustable constants.
 *
 * PLAN.md §4: "Operator console — hidden hotkey. [...] **live-adjust every
 * gesture threshold**. This is the thing that saves the stall when someone's
 * height or the lighting breaks a detector at 11am."
 *
 * PLAN.md §9 lists "thresholds wrong for some body types" as a HIGH risk whose
 * only mitigation is body-scale normalisation plus live tuning. Normalisation
 * is done (`scale.unit`). This file is the other half.
 *
 * README.md, "The numbers that have never seen a real body", names four
 * constants tuned entirely against a noiseless simulator. On the day one of
 * them will be wrong and the choice will be *retune live* or *lose a game for
 * the event*. All four are pre-registered below so they are adjustable before
 * any game has adopted the API.
 *
 * ## Design constraints
 *
 * - **Incremental adoption.** A game keeps its existing constant and passes it
 *   as the fallback: `tunables.get('redlight.moveEnter', DEFAULT.moveEnter)`.
 *   Nothing breaks if the key was never registered — the constant still wins.
 *   Games with a tunables struct already (`redlight.ts`) adopt in one line with
 *   {@link TunableRegistry.overlayOn}.
 * - **Overrides survive a reload.** A tuning session is a person standing at a
 *   stall moving a slider between plays while a queue watches. Losing it to a
 *   crash or an accidental refresh is brutal, so overrides go to localStorage
 *   on every change, exactly like the leaderboard.
 * - **Never throws, never blocks.** Corrupt or unavailable storage degrades to
 *   in-memory. A black screen at the stall is worse than a lost setting.
 *
 * No network, no dependencies — ARCHITECTURE.md hard rules 1 and 3.
 */

export interface TunableSpec {
  /** Dotted key. The prefix before the first dot is the adoption namespace. */
  readonly key: string;
  /** Short, shouty, scannable under pressure. */
  readonly label: string;
  /** UI grouping. Usually the game. */
  readonly group: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** The value baked into the code. `reset` returns here. */
  readonly default: number;
  /**
   * **What breaks if this is wrong**, in the words a stressed marshal needs.
   * Not "the movement threshold" — "too low and everyone is out in two
   * seconds, which is unrecoverable at a stall".
   */
  readonly description: string;
  /** Appended to the readout. 'torso/s', 's', 'shoulder widths'. */
  readonly unit?: string;
  /** True when inferred from a `get()` fallback rather than declared here. */
  readonly inferred?: boolean;
}

export interface TunableGroup {
  readonly name: string;
  readonly specs: readonly TunableSpec[];
}

/** `null` means "several changed" (reset-all, bulk apply). */
export type TunableListener = (key: string | null) => void;

const STORAGE_KEY = 'gdg-arcade:tunables:v1';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Snap to the step grid and scrub float dust.
 *
 * `0.1 + 0.2` artefacts leak into the readout and into the exported tuning
 * file, and "0.7500000000000001" sitting in a handover note is the kind of
 * thing that makes the next person distrust the whole export.
 */
function quantize(value: number, spec: TunableSpec): number {
  if (!Number.isFinite(value)) return spec.default;
  const c = clamp(value, spec.min, spec.max);
  if (!(spec.step > 0)) return c;
  const snapped = spec.min + Math.round((c - spec.min) / spec.step) * spec.step;
  return clamp(Number(snapped.toFixed(6)), spec.min, spec.max);
}

function decimalsFor(step: number): number {
  if (!(step > 0)) return 2;
  if (step >= 1) return 0;
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))));
}

/** 'moveEnter' -> 'MOVE ENTER'. Good enough for an inferred label. */
function humanise(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Build a plausible spec for a key a game asked for but nobody declared.
 *
 * This is what makes incremental adoption actually incremental: a game can
 * swap one constant for `tunables.get(...)` and get a working slider with no
 * second edit anywhere. The range is a guess, so it is flagged `inferred` and
 * the UI says so.
 */
function inferSpec(key: string, value: number): TunableSpec {
  const dot = key.indexOf('.');
  const group = dot > 0 ? humanise(key.slice(0, dot)) : 'UNGROUPED';
  const label = humanise(dot > 0 ? key.slice(dot + 1) : key);

  const mag = Math.abs(value) || 1;
  const step = clamp(Math.pow(10, Math.floor(Math.log10(mag)) - 2), 0.0001, 1);
  const span = mag * 4;

  return {
    key,
    label,
    group,
    min: value >= 0 ? 0 : -span,
    max: value >= 0 ? span : 0,
    step,
    default: value,
    description:
      `Adopted at runtime from a code default of ${value}. The range here is ` +
      `inferred, not designed — declare it in meta/tunables.ts to get a sane ` +
      `range and a real description of what breaks.`,
    inferred: true,
  };
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

class TunableRegistry {
  private specs = new Map<string, TunableSpec>();
  /** Registration order, so the console never reshuffles under someone's hand. */
  private order: string[] = [];
  /** Only keys the operator has actually changed. Absent = use the default. */
  private overrides = new Map<string, number>();
  private listeners = new Set<TunableListener>();
  private warned = new Set<string>();

  constructor() {
    this.load();
  }

  /* ---------------- persistence ---------------- */

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) this.overrides.set(k, v);
      }
    } catch {
      // Corrupt or unavailable storage must not take the kiosk down. Losing a
      // tuning session is bad; a boot failure at the stall is worse.
      this.overrides.clear();
    }
  }

  private save(): void {
    try {
      if (this.overrides.size === 0) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toObject()));
    } catch {
      /* private mode / quota — keep running in memory */
    }
  }

  private emit(key: string | null): void {
    for (const fn of this.listeners) fn(key);
  }

  /* ---------------- registration ---------------- */

  /**
   * Declare a tunable. Idempotent: re-registering replaces the spec but keeps
   * any operator override, re-clamped to the new range. Hot module reload and
   * a late-loading game both re-register, and neither should silently throw
   * away a value someone tuned between plays.
   */
  register(spec: TunableSpec): TunableSpec {
    const normalised: TunableSpec = {
      ...spec,
      min: Math.min(spec.min, spec.max),
      max: Math.max(spec.min, spec.max),
      step: spec.step > 0 ? spec.step : 0.01,
    };
    const withDefault: TunableSpec = {
      ...normalised,
      default: clamp(spec.default, normalised.min, normalised.max),
    };

    if (!this.specs.has(spec.key)) this.order.push(spec.key);
    this.specs.set(spec.key, withDefault);

    const existing = this.overrides.get(spec.key);
    if (existing !== undefined) {
      const fixed = quantize(existing, withDefault);
      if (fixed === withDefault.default) this.overrides.delete(spec.key);
      else this.overrides.set(spec.key, fixed);
    }

    this.emit(spec.key);
    return withDefault;
  }

  registerAll(specs: readonly TunableSpec[]): void {
    for (const s of specs) this.register(s);
    this.emit(null);
  }

  has(key: string): boolean {
    return this.specs.has(key);
  }

  getSpec(key: string): TunableSpec | null {
    return this.specs.get(key) ?? null;
  }

  /* ---------------- read / write ---------------- */

  /**
   * Current value.
   *
   * `fallback` is the game's existing constant. Pass it and adoption is a
   * one-line change with no behaviour change until someone moves a slider:
   *
   * ```ts
   * const enter = tunables.get('redlight.moveEnter', DEFAULT_REDLIGHT_TUNABLES.moveEnter);
   * ```
   *
   * An unknown key with a fallback auto-registers (see {@link inferSpec}) so
   * it appears in the console immediately. An unknown key with no fallback is
   * a programming error; it warns once and returns 0 rather than throwing,
   * because a thrown frame at a stall is a black screen.
   *
   * Cheap enough to call per frame — two map lookups after the first call.
   */
  get(key: string, fallback?: number): number {
    let spec = this.specs.get(key);
    if (!spec) {
      if (fallback === undefined) {
        if (!this.warned.has(key)) {
          this.warned.add(key);
          console.warn(`[tunables] unknown key "${key}" and no fallback given`);
        }
        return this.overrides.get(key) ?? 0;
      }
      spec = this.register(inferSpec(key, fallback));
    }
    const override = this.overrides.get(key);
    return override !== undefined ? override : spec.default;
  }

  /**
   * Set a value. Takes effect on the next read, which for anything read in
   * `onTick` means the next frame.
   *
   * Setting a value back to the registered default clears the override rather
   * than storing it, so {@link isOverridden} stays honest — the console uses
   * it to show, at a glance, exactly what has been changed from the shipped
   * build. That list is the handover note between two marshals.
   */
  set(key: string, value: number): number {
    const spec = this.specs.get(key);
    if (!spec) {
      // Unknown key: remember the number anyway so a later register() picks it
      // up. Order of module evaluation should never lose an operator's input.
      if (Number.isFinite(value)) {
        this.overrides.set(key, value);
        this.save();
        this.emit(key);
      }
      return value;
    }

    const next = quantize(value, spec);
    const current = this.overrides.get(key) ?? spec.default;
    if (next === current) return next;

    if (next === spec.default) this.overrides.delete(key);
    else this.overrides.set(key, next);

    this.save();
    this.emit(key);
    return next;
  }

  isOverridden(key: string): boolean {
    return this.overrides.has(key);
  }

  overriddenKeys(): string[] {
    return this.order.filter((k) => this.overrides.has(k));
  }

  reset(key: string): void {
    if (!this.overrides.delete(key)) return;
    this.save();
    this.emit(key);
  }

  resetAll(): void {
    if (this.overrides.size === 0) return;
    this.overrides.clear();
    this.save();
    this.emit(null);
  }

  /* ---------------- bulk adoption ---------------- */

  /**
   * One-line adoption for a game that already keeps its constants in a struct.
   *
   * ```ts
   * this.tun = tunables.overlayOn('redlight.', DEFAULT_REDLIGHT_TUNABLES);
   * ```
   *
   * Every numeric field becomes live, pre-registered fields keep their
   * designed range and description, and anything not declared gets an inferred
   * slider instead of being invisible. Call it per round, not per frame.
   */
  /**
   * Constrained to `object`, not `Record<string, number>`.
   *
   * A TypeScript *interface* gets no implicit index signature, so a hand-written
   * shape like `RedLightTunables` cannot satisfy `Record<string, number>` even
   * though every field is a number. Requiring it would force every adopting
   * game to either restructure its config as a type alias or cast at the call
   * site — friction on exactly the path that is supposed to be one line.
   *
   * Non-numeric fields are passed through untouched, so a config that mixes
   * numbers with flags or strings still works.
   */
  overlayOn<T extends object>(prefix: string, defaults: T): T {
    const out = { ...(defaults as object) } as Record<string, unknown>;
    for (const [k, d] of Object.entries(defaults)) {
      if (typeof d !== 'number' || !Number.isFinite(d)) continue;
      out[k] = this.get(prefix + k, d);
    }
    return out as T;
  }

  /* ---------------- introspection for the UI ---------------- */

  subscribe(fn: TunableListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): TunableSpec[] {
    const out: TunableSpec[] = [];
    for (const key of this.order) {
      const spec = this.specs.get(key);
      if (spec) out.push(spec);
    }
    return out;
  }

  /** Grouped in registration order, which is authored to read top-to-bottom. */
  groups(): TunableGroup[] {
    const byGroup = new Map<string, TunableSpec[]>();
    for (const spec of this.list()) {
      const bucket = byGroup.get(spec.group);
      if (bucket) bucket.push(spec);
      else byGroup.set(spec.group, [spec]);
    }
    return [...byGroup].map(([name, specs]) => ({ name, specs }));
  }

  /** Readout text, e.g. `0.85 torso/s`. */
  format(key: string, value?: number): string {
    const spec = this.specs.get(key);
    const v = value !== undefined ? value : this.get(key, 0);
    if (!spec) return String(v);
    const text = v.toFixed(decimalsFor(spec.step));
    return spec.unit ? `${text} ${spec.unit}` : text;
  }

  /** Overrides only — the deltas from the shipped build. */
  toObject(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of this.order) {
      const v = this.overrides.get(key);
      if (v !== undefined) out[key] = v;
    }
    // Anything stored before its spec registered still belongs in the file.
    for (const [key, v] of this.overrides) {
      if (!(key in out)) out[key] = v;
    }
    return out;
  }

  exportJSON(): string {
    return JSON.stringify(this.toObject(), null, 2);
  }

  /** Restore a tuning file. Used by the console's import, and by tests. */
  applyOverrides(values: Record<string, number>): void {
    let changed = false;
    for (const [key, raw] of Object.entries(values)) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const spec = this.specs.get(key);
      const next = spec ? quantize(raw, spec) : raw;
      if (spec && next === spec.default) this.overrides.delete(key);
      else this.overrides.set(key, next);
      changed = true;
    }
    if (!changed) return;
    this.save();
    this.emit(null);
  }
}

export const tunables = new TunableRegistry();

/* ------------------------------------------------------------------ */
/* Pre-registered: the numbers that have never seen a real body        */
/* ------------------------------------------------------------------ */

/**
 * README.md's four risky constants, plus the knobs sitting immediately next to
 * them and a few purely operational levers.
 *
 * These are registered here rather than in each game deliberately: they are
 * adjustable on day one, before any game file has been touched. Wiring a game
 * up is then a separate, safe, one-line change per call site.
 */
tunables.registerAll([
  /* ---- shell/hover.ts: the hand cursor ---- */
  {
    key: 'hover.reachX',
    label: 'REACH — SIDEWAYS',
    group: 'HAND CURSOR',
    min: 0.8,
    max: 3,
    step: 0.05,
    default: 1.7,
    unit: 'shoulder widths',
    description:
      'Half-width of the box a player reaches across to drive the cursor. Too ' +
      'generous and the corner tiles need a full stretch nobody will do in ' +
      'front of a queue. Too tight and the cursor pins itself to the screen ' +
      'edges and nothing can be selected. README: highest-value tune on Sept 19.',
  },
  {
    key: 'hover.reachUp',
    label: 'REACH — ABOVE SHOULDER',
    group: 'HAND CURSOR',
    min: 0.5,
    max: 2.5,
    step: 0.05,
    default: 1.15,
    unit: 'torso heights',
    description:
      'How far above the shoulder line counts as the top of the screen. Too ' +
      'small and the top row of tiles is unreachable; too large and the top ' +
      'of the screen needs an overhead stretch.',
  },
  {
    key: 'hover.reachDown',
    label: 'REACH — BELOW SHOULDER',
    group: 'HAND CURSOR',
    min: 0.5,
    max: 2.5,
    step: 0.05,
    default: 1.05,
    unit: 'torso heights',
    description:
      'How far below the shoulder line counts as the bottom of the screen. ' +
      'Raise this and arms at rest park the cursor on a live tile, which ' +
      'self-selects a game nobody asked for.',
  },
  {
    key: 'hover.dwellDeliberate',
    label: 'DWELL TO SELECT',
    group: 'HAND CURSOR',
    min: 0.4,
    max: 2.5,
    step: 0.05,
    default: 1.2,
    unit: 's',
    description:
      'How long a hand must rest on a menu tile to commit. Drop it when the ' +
      'queue is long. Below about 0.6s people select things by accident while ' +
      'reaching across the board, and a wrong pick costs a whole turn.',
  },

  /* ---- games/redlight.ts: the detector most likely to break ---- */
  {
    key: 'redlight.moveEnter',
    label: 'MOVE THRESHOLD',
    group: 'RED LIGHT',
    min: 0.15,
    max: 3,
    step: 0.05,
    default: 0.85,
    unit: 'torso/s',
    description:
      'Mean landmark speed that counts as moving during a red light. ' +
      'MediaPipe noise at 3m under hall lighting is unknown and this is tuned ' +
      'against a noiseless simulator. TOO LOW AND EVERYONE IS OUT IN TWO ' +
      'SECONDS, which is unrecoverable at a stall — raise this first if the ' +
      'lobby empties the instant the light turns.',
  },
  {
    key: 'redlight.exitRatio',
    label: 'HYSTERESIS GAP',
    group: 'RED LIGHT',
    min: 0.2,
    max: 0.95,
    step: 0.05,
    default: 0.55,
    description:
      'Where the gate closes again, as a fraction of the move threshold. ' +
      'Push it near 1 and the gate chatters at the boundary 30 times a second ' +
      'and eliminations become random.',
  },
  {
    key: 'redlight.graceSec',
    label: 'STOPPING GRACE',
    group: 'RED LIGHT',
    min: 0,
    max: 1.5,
    step: 0.05,
    default: 0.4,
    unit: 's',
    description:
      'Nothing is judged for this long after the light turns red. THE feel ' +
      'knob. Raise it if people are being caught while they are visibly ' +
      'already stopping — that reads as cheating to the whole queue.',
  },
  {
    key: 'redlight.breachSec',
    label: 'MOVE MUST PERSIST',
    group: 'RED LIGHT',
    min: 0,
    max: 0.6,
    step: 0.01,
    default: 0.12,
    unit: 's',
    description:
      'How long movement has to hold before it counts. Raise it if the ' +
      'detector is flickering people out on single noisy frames under bad ' +
      'lighting. Too high and the game stops catching real movement.',
  },

  /* ---- games/poses.ts ---- */
  {
    key: 'posematch.passThreshold',
    label: 'MATCH THRESHOLD',
    group: 'POSE MATCH',
    min: 0.35,
    max: 0.95,
    step: 0.01,
    default: 0.72,
    description:
      'Score a pose must reach to clear the wall. Only 0.07 of headroom over ' +
      'the worst confusable pair, and real jitter pulls scores DOWN — expect ' +
      'to lower this, not raise it. Below about 0.66 poses start passing for ' +
      'each other and the game stops meaning anything.',
  },

  /* ---- games/runner-world.ts: the clearance model ---- */
  {
    key: 'runner.laneStepTime',
    label: 'ASSUMED LANE-STEP TIME',
    group: 'RUNNER',
    min: 0.25,
    max: 1.2,
    step: 0.05,
    default: 0.5,
    unit: 's',
    description:
      'Seconds the track generator assumes a body needs to change lane. The ' +
      'clearability proof is exact at the modelled body and no further — a ' +
      'body 20% slower fails 143 runs in 200. Raise it to generate roomier ' +
      'track for slower players.',
  },
  {
    key: 'runner.recoveryTime',
    label: 'ASSUMED RECOVERY',
    group: 'RUNNER',
    min: 0.1,
    max: 1,
    step: 0.02,
    default: 0.36,
    unit: 's',
    description:
      'Seconds assumed between two consecutive actions. Raise it if players ' +
      'are clearing the first obstacle of a pair and eating the second.',
  },
  {
    key: 'runner.lowBandTop',
    label: 'JUMP OBSTACLE SHARE',
    group: 'RUNNER',
    min: 0.42,
    max: 0.95,
    step: 0.01,
    default: 0.75,
    description:
      'Upper edge of the "low" (jump) band in the track generator. SET THIS ' +
      'TO 0.42 to remove jump obstacles entirely and ship the Runner as lanes ' +
      '+ slides — that is the README Sept 21 go/no-go fallback, and it is this ' +
      'one value rather than cutting the game.',
  },

  /* ---- operational levers ---- */
  {
    key: 'fx.qualityCap',
    label: 'EFFECT QUALITY CAP',
    group: 'STALL CONTROL',
    min: 0.25,
    max: 1,
    step: 0.05,
    default: 1,
    description:
      'Hard ceiling on particle and effect density. PANIC drops this to 0.25. ' +
      'Use it if the laptop is thermally throttling after a few hours and the ' +
      'frame-budget watchdog is fighting to keep up.',
  },
  {
    key: 'game.roundScale',
    label: 'ROUND LENGTH',
    group: 'STALL CONTROL',
    min: 0.5,
    max: 1.5,
    step: 0.05,
    default: 1,
    unit: '×',
    description:
      'Multiplier on every round length. Drop to 0.7 when the queue is out ' +
      'the door; raise it if people are not getting a proper go.',
  },
  /* ---- games/rhythm.ts: the only game judged in milliseconds ---- */
  {
    key: 'rhythm.inputLatencySec',
    label: 'PUNCH LATENCY',
    group: 'RHYTHM PUNCH',
    min: 0,
    max: 0.2,
    step: 0.005,
    default: 0.067,
    unit: 's',
    description:
      'How long after a real fist lands the game sees it, and therefore how ' +
      'far the judgement is shifted back to compensate. MEASURED at 0.067s ' +
      'for the One Euro filter alone, by cross-correlating the filtered wrist ' +
      'against the raw one at a 2Hz sweep. A real camera adds capture and ' +
      'inference on top, so the true figure on the night is HIGHER, not ' +
      'lower. This matters more than any other timing number here because ' +
      'the perfect window is only 0.11s wide: uncompensated, a player who ' +
      'punches dead on the beat spends 61% of it before being judged and ' +
      'gets GREAT for a PERFECT. Tune it by punching deliberately early and ' +
      'late and checking the grades come out symmetric.',
  },
  {
    key: 'game.idleTimeoutSec',
    label: 'IDLE TIMEOUT',
    group: 'STALL CONTROL',
    min: 5,
    max: 60,
    step: 1,
    default: 20,
    unit: 's',
    description:
      'Seconds with nobody in frame before a game bails back to attract. ' +
      'Lower it when the stall is busy so an abandoned round frees the screen ' +
      'for the next person instead of holding it.',
  },
]);
