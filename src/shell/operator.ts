/**
 * The operator console.
 *
 * PLAN.md §4: "Hidden hotkey. Skip round, force-reset, kill a game via feature
 * flag, moderate a score, and **live-adjust every gesture threshold**. This is
 * the thing that saves the stall when someone's height or the lighting breaks
 * a detector at 11am."
 *
 * PLAN.md §10: "Someone on the stall knows the operator hotkeys and can
 * hard-reset in under 10 seconds."
 *
 * ## What this is actually for
 *
 * It is 11:20am, there is a queue of nine people, and Red Light is eliminating
 * everyone two seconds into the first round because the hall lighting is
 * nothing like the simulator. The marshal is a student who has run this twice.
 * They have maybe fifteen seconds of the queue's patience.
 *
 * Every design decision here follows from that:
 *
 * - **DOM, not canvas.** Sliders, selects and scroll behaviour are free and
 *   correct. Nothing here is player-facing so none of the 3m-legibility rules
 *   apply; this is read at arm's length by one person.
 * - **Mounted on `document.body`, not `#overlay`.** `router.go()` calls
 *   `overlay.replaceChildren()` on every screen change, which would silently
 *   delete the console mid-use.
 * - **One level deep.** Four big tabs, no nested menus, and the things that
 *   are needed *while something is wrong* — vision health and PANIC — live in
 *   the header where they are visible from every tab.
 * - **Confirm only where it is destructive.** Deleting a score is two clicks.
 *   Moving a slider is zero, because tuning is a conversation and a confirm
 *   step in the middle of it is worse than useless.
 *
 * ARCHITECTURE.md rule 4 stands: this owns no `requestAnimationFrame`. The
 * live readout is a 200ms interval that exists only while the console is open.
 */

import { camera } from '../core/camera';
import { vision } from '../core/vision';
import type { TrackedPlayer } from '../core/tracker';
import { audio } from '../engine/audio';
import { leaderboard, type GameId } from '../meta/leaderboard';
import { tunables, type TunableSpec } from '../meta/tunables';
import {
  MAX_PLAYERS,
  TOURNAMENT_GAMES,
  roundName,
  tournament,
  type TournamentGameId,
} from '../meta/tournament';
import { router } from './router';

/* ------------------------------------------------------------------ */
/* The toggle combo                                                    */
/* ------------------------------------------------------------------ */

/**
 * `Ctrl + Shift + \`` — the backtick key, checked by physical position
 * (`KeyboardEvent.code`) so it does not move with the keyboard layout.
 *
 * Why this one:
 *
 * - Three keys held at once. A player never touches the laptop; the realistic
 *   accident is a bag, an elbow or a closing lid resting on the keyboard, and
 *   that produces a *fistful* of simultaneous keydowns. See
 *   {@link OperatorOverlay.isComboEvent} — the console refuses to open if any
 *   non-modifier key other than the backtick is already held down, which is
 *   what actually makes a lean impossible rather than merely unlikely.
 * - Auto-repeat is ignored, so resting on it does not toggle repeatedly.
 * - It is not a Chrome or Windows shortcut. `Ctrl+Shift+O` is Chrome's
 *   bookmark manager, `Ctrl+Shift+I`/`J` are DevTools, `Ctrl+Shift+N`/`T`/`W`
 *   are browser-reserved and cannot be intercepted at all. Backtick is free.
 * - It does not collide with any key `main.ts` already binds (`0`–`9`, `F`,
 *   `C`, `M`, and the sim keys), which are all bare keys.
 * - It is one hand, top-left corner, and muscle-memorable in a way a sequence
 *   or a timed hold is not. A marshal under pressure gets exactly one attempt.
 */
const COMBO_CODE = 'Backquote';

/** Human-readable, for the footer and for the runbook. */
export const OPERATOR_COMBO_LABEL = 'CTRL + SHIFT + `';

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
]);

/* ------------------------------------------------------------------ */

type TabId = 'tuning' | 'camera' | 'scores' | 'bracket' | 'data';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'tuning', label: 'TUNING' },
  { id: 'camera', label: 'CAMERA' },
  { id: 'scores', label: 'SCORES' },
  { id: 'bracket', label: 'BRACKET' },
  { id: 'data', label: 'DATA' },
];

/**
 * Runtime list of the boards the console can moderate. `GameId` is a type-only
 * union so it cannot be enumerated at runtime; this is the one place that has
 * to mirror it, and the annotation makes a typo a compile error.
 */
const GAMES: ReadonlyArray<{ id: GameId; name: string }> = [
  { id: 'sixtyseven', name: '67 SPEED DUEL' },
  { id: 'fruitninja', name: 'FRUIT NINJA' },
  { id: 'balloonpop', name: 'BALLOON POP' },
  { id: 'redlight', name: 'RED LIGHT' },
  { id: 'posematch', name: 'POSE MATCH' },
  { id: 'runner', name: 'RUNNER' },
  { id: 'rhythm', name: 'RHYTHM PUNCH' },
];

/** Effect quality PANIC drops to. Matches the watchdog's own floor. */
const PANIC_QUALITY = 0.25;

/* ------------------------------------------------------------------ */
/* Tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Two-step confirm on one button. No modal, no second dialog to find — the
 * button becomes the confirmation and disarms itself after four seconds so a
 * half-pressed CLEAR ALL never sits waiting for an accidental second click.
 */
function confirmable(
  className: string,
  text: string,
  confirmText: string,
  run: () => void
): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  let armed = false;
  let timer = 0;

  const disarm = (): void => {
    armed = false;
    window.clearTimeout(timer);
    b.classList.remove('op-armed');
    b.textContent = text;
  };

  b.addEventListener('click', () => {
    if (armed) {
      disarm();
      run();
      return;
    }
    armed = true;
    b.classList.add('op-armed');
    b.textContent = confirmText;
    timer = window.setTimeout(disarm, 4000);
  });

  return b;
}

/** Duck-typed peek at the active screen. Every screen keeps a `PoseTracker`. */
function activePlayers(): TrackedPlayer[] {
  const screen = router.active as unknown as
    | { tracker?: { getPlayers?: () => TrackedPlayer[] } }
    | null;
  const get = screen?.tracker?.getPlayers;
  if (typeof get !== 'function' || !screen?.tracker) return [];
  try {
    return get.call(screen.tracker);
  } catch {
    return [];
  }
}

/**
 * Push an effect-quality cap onto whatever is on screen right now.
 *
 * `ParticleSystem` instances are per-screen (`GameBase.particles`), so there is
 * no global to set. The frame-budget watchdog earns quality back at
 * 0.0008/frame, so this is a nudge that decays over ~16s rather than a latch —
 * `fx.qualityCap` is the durable half, and a one-line clamp in `base.ts` would
 * make it authoritative. See the report.
 */
function applyQuality(q: number): void {
  const screen = router.active as unknown as { particles?: { quality: number } } | null;
  if (screen?.particles && typeof screen.particles.quality === 'number') {
    screen.particles.quality = q;
  }
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function clockOf(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* The console                                                         */
/* ------------------------------------------------------------------ */

interface TuneRow {
  spec: TunableSpec;
  row: HTMLElement;
  input: HTMLInputElement;
  value: HTMLElement;
}

export class OperatorOverlay {
  private root: HTMLElement | null = null;
  private liveStrip: HTMLElement | null = null;
  private panicBar: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private tabButtons = new Map<TabId, HTMLButtonElement>();

  private open = false;
  private tab: TabId = 'tuning';
  private panicked = false;

  private tuneRows = new Map<string, TuneRow>();
  private scoresGame: GameId = 'sixtyseven';
  /** The game a bracket will be started on. See `buildBracket`. */
  private bracketGame: TournamentGameId = TOURNAMENT_GAMES[0];

  /** Physical keys currently held. The anti-lean guard reads this. */
  private downKeys = new Set<string>();

  private pollTimer = 0;
  private unsubs: Array<() => void> = [];

  /* ---------------- lifecycle ---------------- */

  /**
   * Mount, hidden. Default parent is `document.body` on purpose: the router
   * wipes `#overlay` on every screen change and would take the console with it.
   */
  mount(parent: HTMLElement = document.body): void {
    if (this.root) return;

    const root = el('div', 'op-root');
    root.setAttribute('aria-hidden', 'true');
    root.hidden = true;

    const scrim = el('div', 'op-scrim');
    scrim.addEventListener('click', () => this.hide());
    root.appendChild(scrim);

    const panel = el('div', 'op-panel');
    panel.appendChild(this.buildHeader());

    const tabs = el('nav', 'op-tabs');
    for (const t of TABS) {
      const b = button('op-tab', t.label, () => this.setTab(t.id));
      this.tabButtons.set(t.id, b);
      tabs.appendChild(b);
    }
    panel.appendChild(tabs);

    this.body = el('div', 'op-body');
    panel.appendChild(this.body);

    panel.appendChild(
      el(
        'footer',
        'op-foot',
        `${OPERATOR_COMBO_LABEL} toggles this console  ·  ESC closes  ·  ` +
          `changes take effect immediately and survive a reload`
      )
    );

    // Keys typed inside the console must not reach main.ts's global handler —
    // otherwise nudging a slider or clicking about can fire a screen change.
    // Capture on the root runs before the event bubbles back out to window.
    panel.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          this.hide();
          e.preventDefault();
        }
        e.stopPropagation();
      },
      true
    );

    root.appendChild(panel);
    parent.appendChild(root);

    this.root = root;

    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
  }

  unmount(): void {
    this.hide();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    this.root?.remove();
    this.root = null;
    this.body = null;
    this.liveStrip = null;
    this.panicBar = null;
    this.tabButtons.clear();
    this.tuneRows.clear();
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    if (!this.root || this.open) return;
    this.open = true;
    this.root.hidden = false;
    this.root.setAttribute('aria-hidden', 'false');
    // Kiosk mode hides the cursor. The operator needs it back.
    document.body.classList.add('op-open');

    this.unsubs.push(vision.subscribeStats(() => this.refreshLive()));
    this.unsubs.push(camera.subscribe(() => this.refreshLive()));
    this.unsubs.push(leaderboard.subscribe(() => this.onLeaderboardChanged()));
    this.unsubs.push(tunables.subscribe((key) => this.onTunableChanged(key)));

    this.setTab(this.tab);
    this.refreshLive();
    this.pollTimer = window.setInterval(() => this.refreshLive(), 200);
  }

  hide(): void {
    if (!this.root || !this.open) return;
    this.open = false;
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('op-open');
    window.clearInterval(this.pollTimer);
    this.pollTimer = 0;
    for (const fn of this.unsubs) fn();
    this.unsubs = [];
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  /* ---------------- the combo ---------------- */

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!e.repeat) this.downKeys.add(e.code);

    if (this.isComboEvent(e)) {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
      return;
    }

    // Escape from anywhere, including when focus is still on the body.
    if (this.open && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.downKeys.delete(e.code);
  };

  /** Losing focus loses the keyups, so assume nothing is held any more. */
  private onBlur = (): void => {
    this.downKeys.clear();
  };

  private isComboEvent(e: KeyboardEvent): boolean {
    if (e.code !== COMBO_CODE) return false;
    // Auto-repeat: something is resting on the key, which is the exact case
    // this whole guard exists for.
    if (e.repeat) return false;
    if (!e.ctrlKey || !e.shiftKey) return false;
    if (e.altKey || e.metaKey) return false;

    // The anti-lean test. A deliberate chord holds three keys. A forearm, a
    // bag or a lid closing on the keyboard holds a dozen, and any one extra
    // non-modifier key disqualifies it.
    for (const code of this.downKeys) {
      if (code === COMBO_CODE) continue;
      if (MODIFIER_CODES.has(code)) continue;
      return false;
    }
    return true;
  }

  /* ---------------- header ---------------- */

  private buildHeader(): HTMLElement {
    const head = el('header', 'op-head');

    const title = el('div', 'op-brand');
    title.appendChild(el('span', 'op-brand-main', 'OPERATOR'));
    title.appendChild(el('span', 'op-brand-sub', 'GDG MOTION ARCADE'));
    head.appendChild(title);

    this.liveStrip = el('div', 'op-live');
    head.appendChild(this.liveStrip);

    const actions = el('div', 'op-head-actions');
    actions.appendChild(button('op-btn op-btn-panic', 'PANIC', () => this.panic()));
    actions.appendChild(button('op-btn op-btn-close', 'CLOSE', () => this.hide()));
    head.appendChild(actions);

    const wrap = el('div', 'op-head-wrap');
    wrap.appendChild(head);

    this.panicBar = el('div', 'op-panicbar');
    this.panicBar.hidden = true;
    const msg = el(
      'span',
      undefined,
      'PANIC ACTIVE — audio muted, effects at minimum, returned to attract.'
    );
    this.panicBar.appendChild(msg);
    this.panicBar.appendChild(button('op-btn op-btn-recover', 'RECOVER', () => this.recover()));
    wrap.appendChild(this.panicBar);

    return wrap;
  }

  /**
   * PANIC. One click, no confirm — a confirm step defeats the entire point,
   * and nothing here destroys data.
   *
   * Kills the audio, floors the effect quality, and puts attract back on the
   * TV. Closes the console as it goes, because the reason to press this is
   * that a queue is watching something go wrong and the screen needs to look
   * deliberate again. Reopening shows the RECOVER bar, so the muted audio is
   * never a mystery to the next marshal.
   */
  panic(): void {
    this.panicked = true;
    try {
      audio.stopMusic(0);
      audio.setMuted(true);
    } catch {
      /* audio context may never have been unlocked */
    }
    tunables.set('fx.qualityCap', PANIC_QUALITY);
    applyQuality(PANIC_QUALITY);
    void router.go('attract');
    if (this.panicBar) this.panicBar.hidden = false;
    this.hide();
  }

  recover(): void {
    this.panicked = false;
    try {
      audio.setMuted(false);
    } catch {
      /* ignore */
    }
    tunables.reset('fx.qualityCap');
    applyQuality(1);
    if (this.panicBar) this.panicBar.hidden = true;
    this.refreshLive();
  }

  /* ---------------- live readout ---------------- */

  private chip(label: string, value: string, tone?: string): HTMLElement {
    const c = el('div', tone ? `op-chip op-chip-${tone}` : 'op-chip');
    c.appendChild(el('span', 'op-chip-k', label));
    c.appendChild(el('span', 'op-chip-v', value));
    return c;
  }

  private refreshLive(): void {
    if (!this.open || !this.liveStrip) return;

    const vs = vision.getStats();
    const cs = camera.getState();
    const players = activePlayers();

    const strip = this.liveStrip;
    strip.replaceChildren();

    strip.appendChild(this.chip('SCREEN', router.activeId.toUpperCase() || '—'));

    if (vs.ready) {
      const fps = vs.inferenceFps;
      strip.appendChild(
        this.chip('INFER', `${fps.toFixed(1)} fps`, fps < 18 ? 'bad' : fps < 24 ? 'warn' : 'good')
      );
      strip.appendChild(
        this.chip(
          'LATENCY',
          `${Math.round(vs.latencyMs)} ms`,
          vs.latencyMs > 160 ? 'bad' : vs.latencyMs > 100 ? 'warn' : 'good'
        )
      );
      strip.appendChild(this.chip('INFER MS', `${vs.inferenceMs.toFixed(1)}`));
      strip.appendChild(
        this.chip('DELEGATE', vs.delegate ?? '—', vs.delegate === 'CPU' ? 'warn' : 'good')
      );
      strip.appendChild(this.chip('DROPPED', String(vs.dropped), vs.dropped > 60 ? 'warn' : ''));
    } else {
      // Sim mode never starts the worker. Say so rather than showing zeros,
      // which read as "the camera is broken".
      strip.appendChild(this.chip('INFER', 'OFFLINE (SIM?)', 'warn'));
    }

    strip.appendChild(
      this.chip(
        'CAMERA',
        cs.status === 'live' ? `${cs.width}×${cs.height}` : cs.status.toUpperCase(),
        cs.status === 'live' ? 'good' : cs.status === 'error' ? 'bad' : 'warn'
      )
    );

    strip.appendChild(
      this.chip('PLAYERS', String(players.length), players.length > 0 ? 'good' : '')
    );
    for (const p of players) {
      strip.appendChild(
        this.chip(
          `P${p.slot + 1} SCALE`,
          p.scale.valid ? p.scale.unit.toFixed(3) : 'INVALID',
          p.scale.valid ? '' : 'bad'
        )
      );
    }

    if (audio.muted) strip.appendChild(this.chip('AUDIO', 'MUTED', 'warn'));
    if (vs.error) strip.appendChild(this.chip('ERROR', vs.error, 'bad'));
    if (cs.error) strip.appendChild(this.chip('CAM ERROR', cs.error, 'bad'));

    const overridden = tunables.overriddenKeys().length;
    if (overridden > 0) strip.appendChild(this.chip('TUNED', `${overridden} changed`, 'warn'));

    if (this.panicBar) this.panicBar.hidden = !this.panicked;
  }

  /* ---------------- tabs ---------------- */

  private setTab(id: TabId): void {
    this.tab = id;
    for (const [tabId, btn] of this.tabButtons) {
      btn.classList.toggle('op-tab-on', tabId === id);
    }
    this.renderTab();
  }

  private renderTab(): void {
    if (!this.body) return;
    this.body.replaceChildren();
    this.tuneRows.clear();

    switch (this.tab) {
      case 'tuning':
        this.body.appendChild(this.buildTuning());
        break;
      case 'camera':
        this.body.appendChild(this.buildCamera());
        break;
      case 'scores':
        this.body.appendChild(this.buildScores());
        break;
      case 'bracket':
        this.body.appendChild(this.buildBracket());
        break;
      case 'data':
        this.body.appendChild(this.buildData());
        break;
    }
    this.body.scrollTop = 0;
  }

  /* ---------------- tuning ---------------- */

  private buildTuning(): HTMLElement {
    const pane = el('div', 'op-pane');

    const bar = el('div', 'op-panebar');
    bar.appendChild(
      el(
        'p',
        'op-hint',
        'Every value takes effect on the next frame and is saved immediately. ' +
          'Changed values are highlighted so the next marshal can see what you did.'
      )
    );
    bar.appendChild(
      confirmable('op-btn op-btn-danger', 'RESET ALL TUNING', 'CONFIRM RESET ALL', () => {
        tunables.resetAll();
      })
    );
    pane.appendChild(bar);

    for (const group of tunables.groups()) {
      const section = el('section', 'op-group');
      section.appendChild(el('h3', 'op-group-title', group.name));
      for (const spec of group.specs) section.appendChild(this.buildTuneRow(spec));
      pane.appendChild(section);
    }

    return pane;
  }

  private buildTuneRow(spec: TunableSpec): HTMLElement {
    const row = el('div', 'op-tune');

    const head = el('div', 'op-tune-head');
    head.appendChild(el('span', 'op-tune-label', spec.label));

    const value = el('span', 'op-tune-val');
    head.appendChild(value);

    head.appendChild(
      button('op-mini', 'RESET', () => {
        tunables.reset(spec.key);
      })
    );
    row.appendChild(head);

    const input = el('input', 'op-slider');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(tunables.get(spec.key));
    // `input`, not `change`: the point is to watch the effect while dragging.
    input.addEventListener('input', () => {
      tunables.set(spec.key, Number(input.value));
    });
    row.appendChild(input);

    const scale = el('div', 'op-tune-scale');
    scale.appendChild(el('span', undefined, String(spec.min)));
    scale.appendChild(el('span', 'op-tune-key', spec.key));
    scale.appendChild(el('span', undefined, String(spec.max)));
    row.appendChild(scale);

    const desc = el('p', 'op-tune-desc', spec.description);
    if (spec.inferred) desc.classList.add('op-inferred');
    row.appendChild(desc);

    const entry: TuneRow = { spec, row, input, value };
    this.tuneRows.set(spec.key, entry);
    this.paintTuneRow(entry);
    return row;
  }

  private paintTuneRow(entry: TuneRow): void {
    const v = tunables.get(entry.spec.key);
    const changed = tunables.isOverridden(entry.spec.key);
    if (entry.input.value !== String(v)) entry.input.value = String(v);
    entry.value.textContent = changed
      ? `${tunables.format(entry.spec.key, v)}  (was ${entry.spec.default})`
      : tunables.format(entry.spec.key, v);
    entry.row.classList.toggle('op-changed', changed);
  }

  private onTunableChanged(key: string | null): void {
    if (!this.open) return;
    if (this.tab !== 'tuning') {
      this.refreshLive();
      return;
    }
    if (key === null) {
      // Bulk change (reset-all, import). Nothing is mid-drag after a click.
      for (const entry of this.tuneRows.values()) this.paintTuneRow(entry);
      this.refreshLive();
      return;
    }
    const entry = this.tuneRows.get(key);
    if (entry) {
      // Repaint in place. Rebuilding the pane here would destroy the input
      // element under the operator's pointer and abort the drag.
      this.paintTuneRow(entry);
    } else {
      // A game just adopted a new key at runtime — it deserves a slider.
      this.renderTab();
    }
    this.refreshLive();
  }

  /* ---------------- camera ---------------- */

  private buildCamera(): HTMLElement {
    const pane = el('div', 'op-pane');

    pane.appendChild(
      el(
        'p',
        'op-hint',
        'PLAN.md §9: laptop cam vs iPhone Continuity is decided by the rig test, ' +
          'and it may need redoing on the day if the framing or the lighting moved. ' +
          'Device names only appear once camera permission has been granted.'
      )
    );

    const state = camera.getState();
    const info = el('div', 'op-kv');
    const addKV = (k: string, v: string): void => {
      const rowEl = el('div', 'op-kv-row');
      rowEl.appendChild(el('span', undefined, k));
      rowEl.appendChild(el('b', undefined, v));
      info.appendChild(rowEl);
    };
    addKV('STATUS', state.status.toUpperCase());
    addKV('RESOLUTION', state.status === 'live' ? `${state.width} × ${state.height}` : '—');
    addKV('CAPTURE FPS', state.fps ? state.fps.toFixed(0) : '—');
    addKV('DEVICE ID', state.deviceId ? `${state.deviceId.slice(0, 12)}…` : '—');
    if (state.error) addKV('ERROR', state.error);
    pane.appendChild(info);

    const select = el('select', 'op-select');
    select.appendChild(new Option('Loading devices…', ''));
    select.disabled = true;
    select.addEventListener('change', () => {
      const id = select.value;
      if (id) void camera.switchTo(id);
    });

    const controls = el('div', 'op-row');
    controls.appendChild(select);
    controls.appendChild(
      button('op-btn', 'REFRESH LIST', () => {
        void this.loadDevices(select);
      })
    );
    controls.appendChild(
      button('op-btn', 'RESTART CAMERA', () => {
        void camera.start();
      })
    );
    pane.appendChild(controls);

    void this.loadDevices(select);
    return pane;
  }

  private async loadDevices(select: HTMLSelectElement): Promise<void> {
    try {
      const devices = await camera.listDevices();
      const current = camera.getState().deviceId;
      select.replaceChildren();
      if (devices.length === 0) {
        select.appendChild(new Option('No video devices found', ''));
        select.disabled = true;
        return;
      }
      for (const d of devices) {
        const label = d.isLikelyExternal ? `★ ${d.label}` : d.label;
        const opt = new Option(label, d.deviceId, false, d.deviceId === current);
        select.appendChild(opt);
      }
      select.disabled = false;
    } catch (err) {
      select.replaceChildren();
      select.appendChild(new Option(`Unavailable: ${String(err)}`, ''));
      select.disabled = true;
    }
  }

  /* ---------------- scores ---------------- */

  private onLeaderboardChanged(): void {
    if (!this.open) return;
    if (this.tab === 'scores' || this.tab === 'data') this.renderTab();
  }

  /* ---------------- bracket ---------------- */

  /**
   * THE ONLY WAY A TOURNAMENT EVER STARTS.
   *
   * `meta/tournament.ts` has been a complete, tested single-elimination engine
   * — seeding, byes, propagation, persistence, `drawBracket` — with nothing in
   * the app able to set it running. PLAN.md §4 wants "bracket at 2pm" to be a
   * scheduled thing the events team can post about; this is the marshal's end
   * of that.
   *
   * Deliberately a console tab rather than a player-facing flow. A bracket is
   * run BY somebody: names get typed in from a clipboard, a late arrival gets
   * added, a match gets replayed because the camera dropped. None of that is a
   * hand-dwell interaction, and putting it on the TV would mean a stranger
   * could wander into it.
   *
   * Results arrive by themselves — `GameBase.finishRound` reports a versus
   * round into the live bracket — so the marshal's job during play is to call
   * the next pair up, which is the line at the top of this pane.
   */
  private buildBracket(): HTMLElement {
    const pane = el('div', 'op-pane');
    const live = tournament.active;

    pane.appendChild(
      el(
        'p',
        'op-hint',
        live
          ? 'Results report themselves when a versus round ends. A dead heat is NOT ' +
            'advanced — the pair replays.'
          : 'Type the players in, pick a game, START. The bracket shows on the attract ' +
            'screen between rounds and survives a reload.'
      )
    );

    /* --- what is on next --- */
    if (live) {
      const [a, b] = tournament.nextMatchPlayers();
      const m = tournament.nextMatch();
      const champ = tournament.champion();
      const now = el('div', 'op-now');
      if (champ) {
        now.appendChild(el('span', 'op-now-label', 'CHAMPION'));
        now.appendChild(el('span', 'op-now-match', champ.label));
      } else if (m && a && b) {
        const rounds = tournament.getMatches().reduce((x, y) => Math.max(x, y.round), 0) + 1;
        now.appendChild(el('span', 'op-now-label', roundName(m.round, rounds)));
        now.appendChild(el('span', 'op-now-match', `${a.label}  vs  ${b.label}`));
      } else {
        now.appendChild(el('span', 'op-now-label', 'WAITING'));
        now.appendChild(el('span', 'op-now-match', 'no playable match'));
      }
      pane.appendChild(now);
    }

    /* --- game picker --- */
    const picker = el('div', 'op-picker');
    for (const id of TOURNAMENT_GAMES) {
      const name = GAMES.find((g) => g.id === id)?.name ?? id.toUpperCase();
      const on = live ? tournament.game === id : this.bracketGame === id;
      const b = button(on ? 'op-pick op-pick-on' : 'op-pick', name, () => {
        if (live) return;
        this.bracketGame = id;
        this.renderTab();
      });
      b.disabled = live;
      picker.appendChild(b);
    }
    pane.appendChild(picker);

    /* --- entry --- */
    if (!live) {
      const row = el('div', 'op-entry-row');
      const input = el('input', 'op-input');
      input.type = 'text';
      input.maxLength = 3;
      input.placeholder = 'ABC';
      input.autocapitalize = 'characters';

      const add = (): void => {
        const added = tournament.addPlayer(input.value);
        input.value = '';
        if (added) this.renderTab();
        input.focus();
      };
      input.addEventListener('keydown', (e) => {
        // The console swallows keys globally so a stray letter cannot mute the
        // stall mid-round; this field needs them back.
        e.stopPropagation();
        if (e.key === 'Enter') add();
      });
      row.appendChild(input);
      row.appendChild(button('op-mini', 'ADD', add));
      pane.appendChild(row);
    }

    /* --- players --- */
    const players = tournament.getPlayers();
    if (!live && players.length >= MAX_PLAYERS) {
      // ADD silently does nothing past the cap, and a marshal typing the
      // thirty-third name into a full bracket would otherwise be left
      // wondering which key they missed.
      pane.appendChild(el('p', 'op-hint', `Bracket is full at ${MAX_PLAYERS}. START it.`));
    }
    const list = el('div', 'op-board');
    if (players.length === 0) {
      list.appendChild(el('p', 'op-empty', 'Nobody entered yet.'));
    } else {
      for (const pl of players) {
        const rowEl = el('div', 'op-entry');
        rowEl.appendChild(el('span', 'op-entry-rank', `#${pl.seed}`));
        rowEl.appendChild(el('span', 'op-entry-initials', pl.label));
        if (!live) {
          rowEl.appendChild(
            button('op-mini op-mini-danger', 'REMOVE', () => {
              tournament.removePlayer(pl.id);
              this.renderTab();
            })
          );
        }
        list.appendChild(rowEl);
      }
    }
    pane.appendChild(list);

    /* --- matches --- */
    if (live) {
      pane.appendChild(el('p', 'op-hint', 'MATCHES'));
      const matches = tournament.getMatches();
      const rounds = matches.reduce((x, y) => Math.max(x, y.round), 0) + 1;
      const board = el('div', 'op-board');
      for (const m of matches) {
        const [a, b] = tournament.matchPlayers(m);
        const rowEl = el('div', 'op-entry');
        // Its own class: `op-entry-rank` is sized for "#12" and a round name
        // wrapped to two lines inside it.
        rowEl.appendChild(el('span', 'op-entry-round', roundName(m.round, rounds)));
        rowEl.appendChild(
          el('span', 'op-entry-initials', `${a?.label ?? '—'} v ${b?.label ?? '—'}`)
        );
        rowEl.appendChild(
          el(
            'span',
            'op-entry-score',
            m.winner === null ? '' : `${m.scores[0] ?? ''}:${m.scores[1] ?? ''}`
          )
        );
        rowEl.appendChild(
          el(
            'span',
            'op-entry-faction',
            m.auto ? 'BYE' : m.winner === null ? '' : ((m.winner === 0 ? a : b)?.label ?? '')
          )
        );
        // A match decided by a camera glitch has to be undoable, in front of a
        // crowd, without resetting the bracket.
        if (m.winner !== null && !m.auto) {
          rowEl.appendChild(
            button('op-mini', 'UNDO', () => {
              tournament.undo(m.id);
              this.renderTab();
            })
          );
        }
        board.appendChild(rowEl);
      }
      pane.appendChild(board);
    }

    /* --- actions --- */
    const actions = el('div', 'op-actions');
    if (!live) {
      const start = button('op-action', `START ${players.length}-PLAYER BRACKET`, () => {
        if (tournament.start(this.bracketGame)) this.renderTab();
      });
      start.disabled = players.length < 2;
      actions.appendChild(start);
    }
    actions.appendChild(
      confirmable('op-action op-action-danger', 'RESET BRACKET', 'CONFIRM?', () => {
        tournament.reset();
        this.renderTab();
      })
    );
    pane.appendChild(actions);

    return pane;
  }

  private buildScores(): HTMLElement {
    const pane = el('div', 'op-pane');

    pane.appendChild(
      el(
        'p',
        'op-hint',
        'Someone will set a joke score. Deleting an entry also takes its points ' +
          'back off that faction total, so the faction race stays honest. ' +
          'ADD puts a score on the board by hand — use it before doors open so ' +
          'the menu has something to beat.'
      )
    );

    const picker = el('div', 'op-picker');
    for (const g of GAMES) {
      const count = leaderboard.getBoard(g.id).length;
      const b = button(
        g.id === this.scoresGame ? 'op-pick op-pick-on' : 'op-pick',
        `${g.name}  ${count}`,
        () => {
          this.scoresGame = g.id;
          this.renderTab();
        }
      );
      picker.appendChild(b);
    }
    pane.appendChild(picker);

    /* --- add one by hand --- */
    //
    // NOTHING TO BEAT IS NOT A LEADERBOARD.
    //
    // Reported from an outside playtest: on a fresh install the menu shows
    // "BE THE FIRST!" on all seven tiles, and a player choosing a game has no
    // idea what a good score looks like, during the one moment they are
    // deciding which game to play. A target is most of what makes an arcade
    // score mean anything.
    //
    // The marshal types the NUMBER, deliberately. Scoring scales here are not
    // comparable — a strong 67 Speed is about 190, a strong Rhythm is about
    // 2400, a strong Pose Match is single digits — so any "seed a sensible
    // default" button would be this repo guessing on behalf of a hall it has
    // never seen. The honest way to get a real target is to play a round
    // before doors open and type what you got.
    const addRow = el('div', 'op-entry-row');
    const initialsInput = el('input', 'op-input');
    initialsInput.type = 'text';
    initialsInput.maxLength = 3;
    initialsInput.placeholder = 'GDG';
    initialsInput.autocapitalize = 'characters';

    const scoreInput = el('input', 'op-input op-input-num');
    scoreInput.type = 'number';
    scoreInput.min = '1';
    scoreInput.placeholder = 'SCORE';

    const addScore = (): void => {
      const value = Number(scoreInput.value);
      const who = initialsInput.value.trim().toUpperCase().slice(0, 3) || 'GDG';
      if (!Number.isFinite(value) || value <= 0) {
        scoreInput.focus();
        return;
      }
      // `null` faction on purpose: a staff target is not a team scoring, and
      // adding it to a faction total would tilt the race that the rest of this
      // tab works to keep honest.
      leaderboard.submit(this.scoresGame, value, who, null);
      scoreInput.value = '';
      this.renderTab();
    };

    for (const input of [initialsInput, scoreInput]) {
      input.addEventListener('keydown', (e) => {
        // The console swallows keys globally so a stray letter cannot mute the
        // stall mid-round; these fields need them back.
        e.stopPropagation();
        if (e.key === 'Enter') addScore();
      });
    }

    addRow.appendChild(initialsInput);
    addRow.appendChild(scoreInput);
    addRow.appendChild(button('op-mini', 'ADD', addScore));
    pane.appendChild(addRow);

    const board = leaderboard.getBoard(this.scoresGame);
    const list = el('div', 'op-board');

    if (board.length === 0) {
      list.appendChild(el('p', 'op-empty', 'No scores on this board yet.'));
    } else {
      board.forEach((entry, index) => {
        const rowEl = el('div', 'op-entry');
        rowEl.appendChild(el('span', 'op-entry-rank', `#${index + 1}`));
        rowEl.appendChild(el('span', 'op-entry-initials', entry.initials));
        rowEl.appendChild(el('span', 'op-entry-score', String(entry.score)));
        rowEl.appendChild(el('span', 'op-entry-faction', entry.faction ?? '—'));
        rowEl.appendChild(el('span', 'op-entry-time', clockOf(entry.at)));
        rowEl.appendChild(
          confirmable('op-mini op-mini-danger', 'DELETE', 'CONFIRM?', () => {
            leaderboard.removeEntry(this.scoresGame, index);
          })
        );
        list.appendChild(rowEl);
      });
    }
    pane.appendChild(list);

    const danger = el('div', 'op-row op-row-danger');
    const name = GAMES.find((g) => g.id === this.scoresGame)?.name ?? this.scoresGame;
    danger.appendChild(
      confirmable('op-btn op-btn-danger', `CLEAR ${name}`, 'CONFIRM — CLEAR THIS BOARD', () => {
        leaderboard.clearGame(this.scoresGame);
      })
    );
    danger.appendChild(
      confirmable(
        'op-btn op-btn-danger',
        'CLEAR EVERYTHING',
        'CONFIRM — WIPE ALL BOARDS + FACTIONS',
        () => {
          leaderboard.clearAll();
        }
      )
    );
    pane.appendChild(danger);

    return pane;
  }

  /* ---------------- data ---------------- */

  private buildData(): HTMLElement {
    const pane = el('div', 'op-pane');

    const total = leaderboard.getTotalPlays();
    const hero = el('div', 'op-hero');
    hero.appendChild(el('span', 'op-hero-n', String(total)));
    hero.appendChild(el('span', 'op-hero-l', 'TOTAL PLAYS'));
    pane.appendChild(hero);

    const counts = leaderboard.getPlayCounts();
    const max = counts.reduce((m, c) => Math.max(m, c.plays), 1);

    const bars = el('div', 'op-bars');
    if (counts.length === 0) {
      bars.appendChild(el('p', 'op-empty', 'No plays recorded yet.'));
    } else {
      for (const c of counts) {
        const name = GAMES.find((g) => g.id === c.game)?.name ?? c.game;
        const rowEl = el('div', 'op-bar');
        rowEl.appendChild(el('span', 'op-bar-l', name));
        const track = el('span', 'op-bar-track');
        const fill = el('span', 'op-bar-fill');
        fill.style.width = `${(c.plays / max) * 100}%`;
        track.appendChild(fill);
        rowEl.appendChild(track);
        rowEl.appendChild(el('b', 'op-bar-n', String(c.plays)));
        bars.appendChild(rowEl);
      }
    }
    pane.appendChild(bars);

    const factions = leaderboard.getFactionTotals();
    pane.appendChild(el('h3', 'op-group-title', 'FACTION TOTALS'));
    const fWrap = el('div', 'op-bars');
    if (factions.length === 0) {
      fWrap.appendChild(el('p', 'op-empty', 'No faction points yet.'));
    } else {
      const fMax = factions.reduce((m, f) => Math.max(m, f.total), 1);
      for (const f of factions) {
        const rowEl = el('div', 'op-bar');
        rowEl.appendChild(el('span', 'op-bar-l', f.name));
        const track = el('span', 'op-bar-track');
        const fill = el('span', 'op-bar-fill op-bar-fill-alt');
        fill.style.width = `${(f.total / fMax) * 100}%`;
        track.appendChild(fill);
        rowEl.appendChild(track);
        rowEl.appendChild(el('b', 'op-bar-n', String(f.total)));
        fWrap.appendChild(rowEl);
      }
    }
    pane.appendChild(fWrap);

    const exports = el('div', 'op-row');
    exports.appendChild(
      button('op-btn op-btn-primary', 'EXPORT SCORES JSON', () => {
        download(`gdg-arcade-scores-${stamp()}.json`, leaderboard.exportJSON());
      })
    );
    exports.appendChild(
      button('op-btn', 'EXPORT TUNING JSON', () => {
        download(`gdg-arcade-tuning-${stamp()}.json`, tunables.exportJSON());
      })
    );
    pane.appendChild(exports);

    pane.appendChild(
      el(
        'p',
        'op-hint',
        'Scores export is the post-event writeup (PLAN.md §4 analytics). The ' +
          'tuning export is the handover between the two days — drop it back in ' +
          'before Day 2 and every threshold is where you left it.'
      )
    );

    const overridden = tunables.overriddenKeys();
    if (overridden.length > 0) {
      pane.appendChild(el('h3', 'op-group-title', 'CHANGED FROM THE SHIPPED BUILD'));
      const list = el('div', 'op-kv');
      for (const key of overridden) {
        const spec = tunables.getSpec(key);
        const rowEl = el('div', 'op-kv-row');
        rowEl.appendChild(el('span', undefined, spec ? `${spec.group} · ${spec.label}` : key));
        rowEl.appendChild(
          el('b', undefined, `${tunables.format(key)}  (was ${spec ? spec.default : '?'})`)
        );
        list.appendChild(rowEl);
      }
      pane.appendChild(list);
    }

    return pane;
  }
}

/* ------------------------------------------------------------------ */

let singleton: OperatorOverlay | null = null;

/**
 * Mount the console once, for the lifetime of the app.
 *
 * This is the whole wiring: one call in `main.ts` after `router.attach`.
 * Everything else is the hotkey.
 */
export function installOperatorConsole(): OperatorOverlay {
  if (!singleton) {
    singleton = new OperatorOverlay();
    singleton.mount();
  }
  return singleton;
}

/** The mounted console, if there is one. For `window.__arcade` and tests. */
export function operatorConsole(): OperatorOverlay | null {
  return singleton;
}
