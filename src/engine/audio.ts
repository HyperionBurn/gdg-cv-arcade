/**
 * Procedural audio. No sample packs.
 *
 * PLAN.md §5: "Web Audio synthesis instead of sample packs: zero asset
 * sourcing, infinite pitch variation, and the score can drive the music
 * directly."
 *
 * Two constraints from the room shape everything here:
 *
 *  - "Every game fully legible with sound off." Nothing in the app may depend
 *    on hearing anything. Audio is reinforcement, never information.
 *
 *  - "Weight the mix low — bass thumps carry through crowd noise, high dings
 *    don't." A club fair is loud. High-frequency detail is simply gone at 3m,
 *    so every important cue has a low-frequency body to it.
 */

export type SoundName =
  | 'rep'
  | 'slice'
  | 'pop'
  | 'bomb'
  | 'tick'
  | 'go'
  | 'record'
  | 'hover'
  | 'select'
  | 'eliminate'
  | 'greenlight'
  | 'redlight'
  | 'whoosh'
  | 'land'
  | 'heartbeat'
  | 'shatter'
  | 'punch'
  | 'whiff'
  | 'duck'
  | 'wallhit';

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  private musicTimer: number | null = null;
  private musicIntensity = 0;
  private musicStep = 0;
  private musicEnabled = false;

  private _muted = false;

  /**
   * Browsers require a user gesture before audio can start. The kiosk gets one
   * from the operator at setup; after that it stays alive all day.
   */
  init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;

    // Glue compressor. With a dozen overlapping procedural voices the peaks
    // stack badly and clip on TV speakers; this keeps it dense and loud
    // instead of spiky and quiet.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.18;

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 1;

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0;

    this.sfxGain.connect(this.compressor);
    this.musicGain.connect(this.compressor);
    this.compressor.connect(this.master);
    this.master.connect(this.ctx.destination);
  }

  get isReady(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.85;
  }

  get muted(): boolean {
    return this._muted;
  }

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /* ---------------- primitives ---------------- */

  /** Pitched tone with an envelope. The workhorse. */
  private tone(opts: {
    freq: number;
    type?: OscillatorType;
    duration: number;
    attack?: number;
    gain?: number;
    /** Sweep to this frequency over the duration. */
    freqTo?: number;
    detune?: number;
    dest?: AudioNode;
  }): void {
    if (!this.ctx || !this.sfxGain) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqTo), t + opts.duration);
    }
    if (opts.detune) osc.detune.value = opts.detune;

    const peak = opts.gain ?? 0.3;
    const attack = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.duration);

    osc.connect(g);
    g.connect(opts.dest ?? this.sfxGain);
    osc.start(t);
    osc.stop(t + opts.duration + 0.02);
  }

  /** Filtered noise burst. Slices, whooshes, impacts. */
  private noise(opts: {
    duration: number;
    gain?: number;
    filterType?: BiquadFilterType;
    freq: number;
    freqTo?: number;
    q?: number;
  }): void {
    if (!this.ctx || !this.sfxGain) return;
    const t = this.now();
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * opts.duration));
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = opts.filterType ?? 'bandpass';
    filter.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqTo), t + opts.duration);
    }
    filter.Q.value = opts.q ?? 1;

    const g = this.ctx.createGain();
    const peak = opts.gain ?? 0.25;
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.duration);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    src.start(t);
  }

  /** Low sine drop. This is the part that actually carries across a hall. */
  private thump(freq = 110, duration = 0.22, gain = 0.5): void {
    this.tone({ freq, freqTo: freq * 0.35, type: 'sine', duration, gain, attack: 0.002 });
  }

  /* ---------------- sound library ---------------- */

  /**
   * @param pitch multiplier, used for combo ramps
   * PLAN.md §5: "Rising pitch on combo is the highest-value audio investment."
   */
  play(name: SoundName, pitch = 1, gainScale = 1): void {
    if (!this.ctx || this._muted) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    // ±6% random detune so repeated hits don't phase into a single flat tone.
    const p = pitch * (0.97 + Math.random() * 0.06);

    switch (name) {
      case 'rep':
        // 67 arm pump. Short, punchy, pitch climbs with rep rate.
        this.tone({ freq: 220 * p, freqTo: 330 * p, type: 'square', duration: 0.09, gain: 0.18 });
        this.thump(90 * Math.min(p, 1.6), 0.12, 0.35);
        break;

      case 'slice':
        this.noise({ duration: 0.16, freq: 2600 * p, freqTo: 520, gain: 0.22, q: 1.4 });
        this.tone({ freq: 680 * p, freqTo: 240, type: 'triangle', duration: 0.14, gain: 0.16 });
        break;

      case 'pop':
        this.tone({ freq: 480 * p, freqTo: 1100 * p, type: 'sine', duration: 0.07, gain: 0.3 });
        this.noise({ duration: 0.05, freq: 1800, gain: 0.14 });
        break;

      case 'bomb':
        this.noise({ duration: 0.7, freq: 900, freqTo: 60, gain: 0.45, filterType: 'lowpass', q: 3 });
        this.thump(70, 0.6, 0.6);
        break;

      case 'tick':
        this.tone({ freq: 880 * p, type: 'square', duration: 0.05, gain: 0.14 });
        break;

      case 'go':
        this.tone({ freq: 523, freqTo: 1046, type: 'square', duration: 0.3, gain: 0.26 });
        this.thump(130, 0.3, 0.45);
        break;

      case 'record':
        // Rising arpeggio. Deliberately the most elaborate cue in the set.
        [523, 659, 784, 1046, 1318].forEach((f, i) => {
          setTimeout(() => this.tone({ freq: f, type: 'square', duration: 0.26, gain: 0.2 }), i * 70);
        });
        this.thump(110, 0.5, 0.5);
        break;

      case 'hover':
        this.tone({ freq: 700 * p, type: 'sine', duration: 0.05, gain: 0.09 });
        break;

      case 'select':
        this.tone({ freq: 440, freqTo: 880, type: 'triangle', duration: 0.16, gain: 0.22 });
        this.thump(110, 0.18, 0.3);
        break;

      case 'eliminate':
        // HONOURS PITCH, AND IT HAS TO. A red light regularly takes three to
        // five people on the same frame, and redlight.ts steps the pitch down
        // per elimination for exactly that reason — its comment calls the
        // result "an audible cascade, which is both clearer and much funnier".
        // It never happened: these two frequencies were hardcoded, so `p` was
        // discarded and every simultaneous elimination fired the IDENTICAL
        // sawtooth at the same phase. That is the definition of a phase-summed
        // smear, i.e. precisely the thing the caller was trying to avoid.
        //
        // `gainScale` is the other half. Six of these at once is 13 concurrent
        // voices and ~4.7x unity into a compressor with a 4ms attack, which
        // cannot catch six transient onsets; the caller now ducks the later
        // ones, and past a couple drops the tone layer entirely so a mass
        // wipeout stays a row of thumps rather than a crackle.
        if (gainScale > 0.45) {
          this.tone({
            freq: 400 * p,
            freqTo: 80 * p,
            type: 'sawtooth',
            duration: 0.5,
            gain: 0.28 * gainScale,
          });
        }
        this.thump(60 * p, 0.45, 0.5 * gainScale);
        break;

      case 'greenlight':
        this.tone({ freq: 392, freqTo: 587, type: 'triangle', duration: 0.35, gain: 0.26 });
        break;

      case 'redlight':
        this.tone({ freq: 330, freqTo: 165, type: 'sawtooth', duration: 0.45, gain: 0.3 });
        this.thump(80, 0.4, 0.45);
        break;

      case 'whoosh':
        this.noise({ duration: 0.28, freq: 400, freqTo: 2400, gain: 0.16, q: 0.8 });
        break;

      case 'land':
        this.thump(100, 0.16, 0.4);
        this.noise({ duration: 0.09, freq: 700, gain: 0.12 });
        break;

      case 'heartbeat':
        // Red Light freeze phase. Two low thumps, nothing above 60Hz-ish.
        //
        // Sub-bass is the only band that survives a club fair (PLAN.md §5),
        // and a heartbeat is the one rhythm nobody needs told the meaning of.
        // It carries NO information — the screen already says RED — it just
        // makes standing still feel like it costs something.
        this.thump(58 * p, 0.17, 0.42);
        setTimeout(() => this.thump(46 * p, 0.22, 0.3), 125);
        break;

      case 'shatter':
        // Pose Match: the wall breaking. A wideband crack collapsing downward
        // over a low drop, so it reads as something structural giving way
        // rather than a UI ding.
        //
        // The pitch multiplier is driven by the clear streak, and the thump is
        // capped independently of it: the crack is allowed to climb, but the
        // body of the sound has to stay in the band that survives the hall
        // (PLAN.md §5, "weight the mix low").
        this.noise({ duration: 0.34, freq: 3200 * p, freqTo: 240, gain: 0.3, q: 0.9 });
        this.noise({ duration: 0.14, freq: 1400 * p, gain: 0.16, q: 2.2 });
        this.thump(96 * Math.min(p, 1.35), 0.3, 0.5);
        break;

      case 'punch':
        // Rhythm Punch: a glove landing. Three layers doing three jobs — a
        // mid body that `pitch` moves with the combo, a bright transient for
        // the "that was clean" read, and a thump that is the only part
        // guaranteed to survive the hall (PLAN.md §5).
        //
        // The thump's pitch is capped independently of `p`. The transient is
        // allowed to climb all round; letting the body climb with it would
        // turn a 40x combo into a beep, which is the opposite of what a combo
        // is supposed to feel like.
        this.tone({ freq: 340 * p, freqTo: 120, type: 'triangle', duration: 0.1, gain: 0.2 });
        this.noise({ duration: 0.06, freq: 2400 * p, freqTo: 600, gain: 0.13, q: 1.2 });
        this.thump(84 * Math.min(p, 1.4), 0.15, 0.42);
        break;

      case 'whiff':
        // A note gone past. Deliberately soft, short and dull.
        //
        // PLAN.md: "failure should be funny, never punishing". At ~1.2 notes a
        // second a harsh miss cue would simply be the loudest thing in the mix
        // for anyone having a bad round, which is the last person who needs
        // punishing. The screen already says MISS.
        this.noise({ duration: 0.13, freq: 300, freqTo: 90, gain: 0.1, filterType: 'lowpass', q: 1 });
        break;

      case 'duck':
        // The wall passing over your head. Rising and gone, so it reads as
        // something travelling past rather than something landing on you.
        this.noise({ duration: 0.34, freq: 260, freqTo: 3000, gain: 0.19, q: 0.7 });
        this.tone({ freq: 180, freqTo: 520, type: 'sine', duration: 0.26, gain: 0.12 });
        break;

      case 'wallhit':
        // Wall not ducked. A low structural slam — the one moment in this game
        // worth being loud about, because it is the only thing that breaks a
        // combo in a way the player could have avoided by doing nothing fancy.
        this.noise({ duration: 0.3, freq: 700, freqTo: 70, gain: 0.26, filterType: 'lowpass', q: 2 });
        this.thump(52, 0.34, 0.45);
        break;
    }
  }

  /* ---------------- adaptive music ---------------- */

  /**
   * PLAN.md §5: "Adaptive music: layers enter as score climbs, tempo lifts near
   * a record."
   *
   * A simple pentatonic arpeggiator. Pentatonic because it cannot produce a
   * dissonant interval no matter what order it plays in, which means the
   * intensity parameter can add and remove notes freely without ever sounding
   * wrong.
   */
  startMusic(bpm = 120): void {
    if (!this.ctx || !this.musicGain || this.musicEnabled) return;
    this.musicEnabled = true;
    this.musicStep = 0;

    // ANCHOR THE RAMP AT THE CURRENT VALUE FIRST, exactly as `stopMusic` does.
    //
    // `linearRampToValueAtTime` interpolates from the PREVIOUS automation
    // event, not from wherever the parameter happens to be. With no anchor,
    // round two of the day ramps from an event minutes in the past that has
    // long since completed — so the audible value at `now` is already 0.25 and
    // the fade-in simply does not happen. It worked exactly once, in dev, on
    // the first play after a reload.
    this.musicGain.gain.cancelScheduledValues(this.now());
    this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, this.now());
    this.musicGain.gain.linearRampToValueAtTime(0.25, this.now() + 1.2);

    const scale = [261.63, 293.66, 329.63, 392.0, 440.0]; // C major pentatonic
    const stepMs = 60000 / bpm / 2;

    const tick = () => {
      if (!this.musicEnabled || !this.ctx || !this.musicGain) return;
      const i = this.musicStep++;
      const intensity = this.musicIntensity;

      // Bass on the downbeat — always present, this is the layer that carries.
      if (i % 4 === 0) {
        this.tone({
          freq: scale[0]! / 2,
          type: 'triangle',
          duration: 0.4,
          gain: 0.22,
          dest: this.musicGain,
        });
      }

      // Arpeggio layer enters at low intensity.
      if (intensity > 0.15) {
        const note = scale[(i * 2) % scale.length]!;
        this.tone({
          freq: note,
          type: 'square',
          duration: 0.18,
          gain: 0.07 + intensity * 0.05,
          dest: this.musicGain,
        });
      }

      // Octave sparkle only near the top.
      if (intensity > 0.6 && i % 2 === 1) {
        const note = scale[(i * 3) % scale.length]! * 2;
        this.tone({
          freq: note,
          type: 'sine',
          duration: 0.12,
          gain: 0.05,
          dest: this.musicGain,
        });
      }

      // Tempo lifts up to 25% as intensity climbs.
      const scaled = stepMs / (1 + intensity * 0.25);
      this.musicTimer = window.setTimeout(tick, scaled);
    };

    tick();
  }

  /** @param t 0..1 — drive from score/progress/proximity-to-record */
  setMusicIntensity(t: number): void {
    this.musicIntensity = Math.max(0, Math.min(1, t));
  }

  stopMusic(fadeMs = 600): void {
    this.musicEnabled = false;
    if (this.musicTimer !== null) {
      clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.cancelScheduledValues(this.now());
      this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, this.now());
      this.musicGain.gain.linearRampToValueAtTime(0, this.now() + fadeMs / 1000);
    }
  }

  /* ---------------- externally-clocked music ---------------- */

  /**
   * One beat of backing, played on demand from the CALLER's beat clock.
   *
   * `startMusic` above owns its own tempo on a `setTimeout` chain, which is
   * right for six of the seven games — the music is atmosphere and nothing on
   * screen has to agree with it. Rhythm Punch is the exception: every target,
   * every tunnel ring and every judgement is derived from a beat grid, and a
   * backing track running on a separate, drifting clock would be audibly wrong
   * within about fifteen seconds.
   *
   * So the game calls this once per beat off the same clock it renders from,
   * and sync is true by construction rather than something we tune. It also
   * means the "music" and the chart come from ONE tempo source, which is the
   * substitute for the offline onset detection PLAN.md §3 assumed — see the
   * header of games/beatmap.ts.
   *
   * Routed through the SFX bus, not the music bus: the music bus belongs to
   * `startMusic`, and a caller using this will have stopped that first.
   *
   * @param step      beat index since the round started. Bars are 4 beats.
   * @param intensity 0..1, drives which layers are present.
   */
  playBeat(step: number, intensity = 0.5): void {
    if (!this.ctx || this._muted) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    const i = Math.max(0, Math.floor(step));
    const beatInBar = i % 4;
    const bar = Math.floor(i / 4);
    const t = Math.max(0, Math.min(1, intensity));

    // Kick on 1 and 3. Sub-bass is the layer that actually crosses a club fair,
    // so it is the layer that is always present.
    if (beatInBar === 0 || beatInBar === 2) {
      this.thump(beatInBar === 0 ? 62 : 56, 0.2, 0.42 + t * 0.12);
    }

    // Backbeat on 2 and 4. Noise rather than a tone so it never fights the
    // pitched combo cue.
    if (beatInBar === 1 || beatInBar === 3) {
      this.noise({ duration: 0.11, freq: 1700, freqTo: 420, gain: 0.09 + t * 0.06, q: 0.9 });
    }

    // Hat once the round is properly moving.
    if (t > 0.2) {
      this.noise({ duration: 0.04, freq: 7200, gain: 0.03 + t * 0.03, q: 1.6 });
    }

    // Bass. Four roots, one per four bars, so a 60s round has a shape instead
    // of a loop. Minor pentatonic degrees, so no ordering can be dissonant —
    // the same reason startMusic uses a pentatonic scale.
    const ROOTS = [65.41, 77.78, 58.27, 73.42]; // C2, Eb2, Bb1, D2
    const root = ROOTS[Math.floor(bar / 4) % ROOTS.length]!;
    if (beatInBar === 0 || (t > 0.45 && beatInBar === 2)) {
      this.tone({ freq: root, type: 'triangle', duration: 0.34, gain: 0.2 + t * 0.07, attack: 0.006 });
    }

    // A high stab, only at the top of the ramp. This is the layer whose
    // arrival tells the player the round is nearly over.
    if (t > 0.65 && beatInBar === 3) {
      this.tone({ freq: root * 6, freqTo: root * 4, type: 'square', duration: 0.12, gain: 0.05 });
    }
  }
}

export const audio = new AudioEngine();
