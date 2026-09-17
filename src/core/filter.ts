/**
 * One Euro filter.
 *
 * PLAN.md §2: "Raw MediaPipe landmarks jitter. Unfiltered input feels broken
 * even when detection is perfect. This single file is the difference between
 * 'responsive' and 'janky' across every game."
 *
 * The trick: cutoff frequency adapts to speed. When a hand is still we smooth
 * hard (kills jitter). When it's moving fast we barely smooth at all (kills
 * lag). A fixed low-pass filter has to pick one and is wrong half the time.
 *
 * Casiez, Roussel & Vogel (2012).
 */

/** Simple exponential low-pass with explicit alpha. */
class LowPass {
  private y: number | null = null;
  private s = 0;

  filter(x: number, alpha: number): number {
    this.s = this.y === null ? x : alpha * x + (1 - alpha) * this.s;
    this.y = x;
    return this.s;
  }

  get lastRaw(): number | null {
    return this.y;
  }

  reset(): void {
    this.y = null;
    this.s = 0;
  }
}

export interface OneEuroParams {
  /**
   * Minimum cutoff frequency (Hz). Lower = smoother when still, more lag.
   * Tuned per signal type; see PRESETS below.
   */
  minCutoff: number;
  /**
   * Speed coefficient. Higher = filter opens up faster as the signal moves,
   * so less lag on fast motion at the cost of more jitter.
   */
  beta: number;
  /** Cutoff for the derivative estimate. 1.0 is almost always right. */
  dCutoff: number;
}

/**
 * Presets tuned for the different jobs we ask of the vision pipeline.
 * These are exposed in the operator console — expect to adjust them at the
 * Sept 18 camera test once we know the real lighting and framerate.
 */
export const FILTER_PRESETS = {
  /**
   * Hand blade tips for Fruit Ninja / Balloon Pop. Must track fast swipes with
   * minimal lag, so beta is high and we accept some jitter at rest.
   */
  handFast: { minCutoff: 1.7, beta: 0.35, dCutoff: 1.0 },
  /**
   * Hover cursor for the menu. The opposite trade: rock steady when held still
   * so the dwell timer doesn't wobble off a tile. Lag is fine here.
   */
  handPrecise: { minCutoff: 0.6, beta: 0.008, dCutoff: 1.0 },
  /**
   * Body landmarks for gesture detection (jump, crouch, lean).
   *
   * beta is high because a jump is a fast transient and a low beta smears it
   * into nothing — the filter has to open up the moment the signal moves.
   * Measured against the simulator: beta 0.12 attenuated a 4Hz arm swing by
   * ~95%, which silently broke rep detection. Genuinely fast oscillation
   * (RepCounter, MotionEnergy) bypasses this filter entirely and reads raw.
   */
  body: { minCutoff: 1.0, beta: 0.6, dCutoff: 1.0 },
  /**
   * Skeleton drawing for attract mode. Heavy smoothing — it only has to look
   * nice, and jitter is very visible on a big TV.
   */
  cosmetic: { minCutoff: 0.4, beta: 0.02, dCutoff: 1.0 },
} as const satisfies Record<string, OneEuroParams>;

export type FilterPreset = keyof typeof FILTER_PRESETS;

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** One Euro filter over a single scalar channel. */
export class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private lastTime: number | null = null;

  constructor(private params: OneEuroParams) {}

  setParams(p: Partial<OneEuroParams>): void {
    this.params = { ...this.params, ...p };
  }

  /** @param t timestamp in seconds */
  filter(value: number, t: number): number {
    if (this.lastTime === null) {
      this.lastTime = t;
      return this.x.filter(value, 1);
    }

    let dt = t - this.lastTime;
    this.lastTime = t;

    // Guard against a stalled or rewound clock (tab throttling does this).
    if (!(dt > 0) || dt > 0.5) dt = 1 / 30;

    const prev = this.x.lastRaw;
    const rawDerivative = prev === null ? 0 : (value - prev) / dt;
    const edx = this.dx.filter(rawDerivative, alpha(this.params.dCutoff, dt));

    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(edx);
    return this.x.filter(value, alpha(cutoff, dt));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastTime = null;
  }
}

/**
 * One Euro applied across a whole landmark array (x, y and z independently).
 *
 * Reused per tracked person — call reset() when a track is recycled for a new
 * body, otherwise the new player inherits the old one's smoothing state and
 * visibly slides into place from wherever the previous player was standing.
 */
export class LandmarkFilter {
  private channels: OneEuro[] = [];
  private params: OneEuroParams;

  constructor(
    private count: number,
    preset: FilterPreset | OneEuroParams = 'body'
  ) {
    this.params = typeof preset === 'string' ? { ...FILTER_PRESETS[preset] } : { ...preset };
    this.rebuild();
  }

  private rebuild(): void {
    this.channels = [];
    for (let i = 0; i < this.count * 3; i++) {
      this.channels.push(new OneEuro(this.params));
    }
  }

  setParams(p: Partial<OneEuroParams>): void {
    this.params = { ...this.params, ...p };
    for (const c of this.channels) c.setParams(p);
  }

  getParams(): Readonly<OneEuroParams> {
    return this.params;
  }

  /**
   * Filters in place into a reused output array to avoid per-frame allocation.
   * At 30fps x 33 landmarks x N people this matters for GC pauses.
   */
  apply(input: readonly import('./types').Landmark[], t: number, out: import('./types').Landmark[]): void {
    for (let i = 0; i < input.length; i++) {
      const lm = input[i]!;
      const xc = this.channels[i * 3]!;
      const yc = this.channels[i * 3 + 1]!;
      const zc = this.channels[i * 3 + 2]!;

      let o = out[i];
      if (!o) {
        o = { x: 0, y: 0, z: 0, visibility: 0 };
        out[i] = o;
      }

      o.x = xc.filter(lm.x, t);
      o.y = yc.filter(lm.y, t);
      o.z = zc.filter(lm.z, t);
      // Visibility is a confidence, not a position — smoothing it would mask
      // genuine dropouts that games need to react to.
      o.visibility = lm.visibility;
    }
    out.length = input.length;
  }

  reset(): void {
    for (const c of this.channels) c.reset();
  }
}
