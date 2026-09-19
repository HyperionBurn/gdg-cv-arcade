/**
 * Live single-elimination bracket for the 2-player games.
 *
 * PLAN.md §4: "For 67 Duel and Pose Match. Opt in via the menu, bracket
 * displays on the attract screen between rounds, winner's initials go up in
 * lights. Run it as a scheduled thing — 'bracket at 2pm' gives the events team
 * something to post about and creates a crowd spike."
 *
 * Everything below the `Tournament` class is pure, synchronous and DOM-free so
 * it can be unit tested in Node (`tests/tournament.test.ts`). Getting the
 * bracket shape wrong in front of a crowd at 2pm is not recoverable by
 * restarting the app, so the shape is proved rather than eyeballed.
 *
 * Persistence follows the leaderboard pattern exactly: localStorage, wrapped in
 * try/catch at every single access, and a failure degrades to in-memory rather
 * than taking the kiosk down. A bracket that survives a mid-event crash is the
 * whole reason this persists at all.
 */

import type { GameId } from './leaderboard';
import { vh, drawText, roundRect, stickerCard, type Viewport } from '../engine/draw';
import { COLORS, FONTS, PLAYER_COLORS, SHADOW, STROKE, WEIGHT } from '../shell/theme';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** The games that are actually head-to-head. PLAN.md §4 names the first two. */
export const TOURNAMENT_GAMES = ['sixtyseven', 'posematch', 'fruitninja'] as const;
export type TournamentGameId = (typeof TOURNAMENT_GAMES)[number];

export function isTournamentGame(id: GameId): id is TournamentGameId {
  return (TOURNAMENT_GAMES as readonly string[]).includes(id);
}

export interface Player {
  /** Stable for the life of the bracket. Duplicate initials are expected. */
  id: number;
  /** Exactly three glyphs, same normalisation as the leaderboard. */
  initials: string;
  /**
   * Display name, disambiguated when two people enter the same initials — at a
   * club fair that happens within the first twenty entries and an ambiguous
   * bracket is worse than an ugly one.
   */
  label: string;
  /** 1-based, assigned at bracket generation in entry order. */
  seed: number;
}

export type SlotRef =
  | { kind: 'player'; playerId: number }
  | { kind: 'bye' }
  /** Waiting on the winner of another match. */
  | { kind: 'pending'; fromMatch: number };

export interface Match {
  /** Unique across the whole bracket, ascending through the rounds. */
  id: number;
  /** 0-based. Round 0 is the first round played. */
  round: number;
  indexInRound: number;
  slots: [SlotRef, SlotRef];
  /** Which slot won, once decided. */
  winner: 0 | 1 | null;
  /** Reported scores, display only — the bracket never derives a winner from them. */
  scores: [number | null, number | null];
  /** Resolved without being played, because the opponent was a bye. */
  auto: boolean;
  /** Epoch ms the result was reported. */
  at: number | null;
  /** Match this feeds into, and which slot of it. Null for the final. */
  feedsMatch: number | null;
  feedsSlot: 0 | 1;
}

export type TournamentState = 'lobby' | 'running' | 'complete';

/* ---------------- render-ready shapes ---------------- */

export interface RenderSlot {
  label: string;
  playerId: number | null;
  seed: number | null;
  score: number | null;
  won: boolean;
  lost: boolean;
  isBye: boolean;
  pending: boolean;
}

export interface RenderMatch {
  id: number;
  round: number;
  indexInRound: number;
  slots: [RenderSlot, RenderSlot];
  /** Both slots resolved, no winner yet — this is the one to play next. */
  ready: boolean;
  /** The single next match to be played across the whole bracket. */
  live: boolean;
  done: boolean;
  auto: boolean;
}

export interface RenderRound {
  index: number;
  name: string;
  matches: RenderMatch[];
}

export interface RenderBracket {
  game: TournamentGameId | null;
  state: TournamentState;
  playerCount: number;
  /** Power-of-two bracket size. 0 in the lobby. */
  size: number;
  byes: number;
  rounds: RenderRound[];
  champion: Player | null;
  /** The next match to play, or null when the bracket is done. */
  next: RenderMatch | null;
  matchesPlayed: number;
  matchesTotal: number;
}

/* ------------------------------------------------------------------ *
 * Pure bracket maths
 * ------------------------------------------------------------------ */

/** Smallest power of two that holds `n`, minimum 2. */
export function bracketSize(n: number): number {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

/**
 * Standard single-elimination seed order.
 *
 * `seedOrder(8)` is `[1,8,4,5,2,7,3,6]`, read as consecutive pairs. Built by
 * doubling: every seed `s` in the half-size order becomes the pair
 * `[s, size + 1 - s]`.
 *
 * The property that matters: in every pair the second element is the WEAKER
 * seed, so when seeds beyond the player count are byes, byes always land in
 * slot 1 and never face each other. That is what makes bye handling a
 * one-pass, provably-terminating operation instead of a cascade.
 */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  let n = 2;
  while (n < size) {
    n *= 2;
    const next: number[] = [];
    for (const s of order) {
      next.push(s, n + 1 - s);
    }
    order = next;
  }
  return order.slice(0, size);
}

/**
 * Builds every match in the bracket, round 0 seeded from `playerIds` (index 0 =
 * seed 1), later rounds pending. Byes are NOT resolved here — call
 * `resolveByes` so the auto-advance is one obvious, testable step.
 */
export function buildMatches(playerIds: readonly number[]): Match[] {
  const n = playerIds.length;
  if (n < 1) return [];

  const size = bracketSize(n);
  const order = seedOrder(size);
  const matches: Match[] = [];
  let nextId = 0;

  const slotFor = (seed: number): SlotRef => {
    const pid = seed <= n ? playerIds[seed - 1] : undefined;
    return pid === undefined ? { kind: 'bye' } : { kind: 'player', playerId: pid };
  };

  const firstRoundCount = size / 2;
  for (let i = 0; i < firstRoundCount; i++) {
    matches.push({
      id: nextId++,
      round: 0,
      indexInRound: i,
      slots: [slotFor(order[i * 2] ?? size + 1), slotFor(order[i * 2 + 1] ?? size + 1)],
      winner: null,
      scores: [null, null],
      auto: false,
      at: null,
      feedsMatch: null,
      feedsSlot: 0,
    });
  }

  let prevStart = 0;
  let prevCount = firstRoundCount;
  let round = 1;
  while (prevCount > 1) {
    const count = prevCount / 2;
    const start = matches.length;
    for (let i = 0; i < count; i++) {
      const a = matches[prevStart + i * 2];
      const b = matches[prevStart + i * 2 + 1];
      if (!a || !b) continue;
      const m: Match = {
        id: nextId++,
        round,
        indexInRound: i,
        slots: [
          { kind: 'pending', fromMatch: a.id },
          { kind: 'pending', fromMatch: b.id },
        ],
        winner: null,
        scores: [null, null],
        auto: false,
        at: null,
        feedsMatch: null,
        feedsSlot: 0,
      };
      a.feedsMatch = m.id;
      a.feedsSlot = 0;
      b.feedsMatch = m.id;
      b.feedsSlot = 1;
      matches.push(m);
    }
    prevStart = start;
    prevCount = count;
    round++;
  }

  return matches;
}

function findMatch(matches: readonly Match[], id: number): Match | null {
  // Ids are assigned densely in array order, so this is almost always O(1).
  const direct = matches[id];
  if (direct && direct.id === id) return direct;
  return matches.find((m) => m.id === id) ?? null;
}

/** Writes a resolved winner into the match it feeds. */
function propagate(matches: Match[], m: Match): void {
  if (m.winner === null || m.feedsMatch === null) return;
  const target = findMatch(matches, m.feedsMatch);
  if (!target) return;
  target.slots[m.feedsSlot] = m.slots[m.winner];
}

/**
 * Auto-advances every match whose opponent is a bye, and propagates the result.
 * Runs to a fixed point; `seedOrder` guarantees that takes exactly one pass,
 * but the loop is cheap insurance against a hand-built bracket.
 */
export function resolveByes(matches: Match[]): void {
  for (let guard = 0; guard < matches.length + 1; guard++) {
    let changed = false;
    for (const m of matches) {
      if (m.winner !== null) continue;
      const [a, b] = m.slots;
      const aBye = a.kind === 'bye';
      const bBye = b.kind === 'bye';
      if (aBye && bBye) {
        // Cannot happen with seedOrder, but a dead match must not wedge the
        // bracket: hand it upward as a bye and let the next round deal with it.
        m.winner = 0;
        m.auto = true;
        changed = true;
        propagate(matches, m);
        continue;
      }
      if (aBye !== bBye) {
        m.winner = aBye ? 1 : 0;
        m.auto = true;
        m.at = null;
        changed = true;
        propagate(matches, m);
      }
    }
    if (!changed) return;
  }
}

/** True when both slots hold a real player and nobody has won yet. */
export function isPlayable(m: Match): boolean {
  return m.winner === null && m.slots[0].kind === 'player' && m.slots[1].kind === 'player';
}

/** The next match to play, in bracket order. */
export function nextPlayable(matches: readonly Match[]): Match | null {
  for (const m of matches) if (isPlayable(m)) return m;
  return null;
}

export function isBracketComplete(matches: readonly Match[]): boolean {
  const final = matches[matches.length - 1];
  return !!final && final.winner !== null;
}

/** Winning player id of the final, or null. */
export function championId(matches: readonly Match[]): number | null {
  const final = matches[matches.length - 1];
  if (!final || final.winner === null) return null;
  const s = final.slots[final.winner];
  return s.kind === 'player' ? s.playerId : null;
}

/**
 * Records a result and advances the winner.
 * Returns false and changes nothing if the match is not currently playable.
 */
export function applyResult(
  matches: Match[],
  matchId: number,
  winner: 0 | 1,
  scores?: [number | null, number | null]
): boolean {
  const m = findMatch(matches, matchId);
  if (!m || !isPlayable(m)) return false;
  m.winner = winner;
  m.auto = false;
  m.at = Date.now();
  if (scores) m.scores = [scores[0], scores[1]];
  propagate(matches, m);
  return true;
}

/**
 * Clears a result and every result downstream of it.
 *
 * The operator console exists because things go wrong live (PLAN.md §4,
 * "moderate a score"). Reporting the wrong winner in a bracket is the most
 * expensive of those mistakes and it must not require nuking the event.
 */
export function clearResult(matches: Match[], matchId: number): boolean {
  const m = findMatch(matches, matchId);
  if (!m || m.winner === null || m.auto) return false;

  const wipe = (target: Match): void => {
    if (target.winner === null) return;
    const feeds = target.feedsMatch;
    target.winner = null;
    target.at = null;
    target.scores = [null, null];
    if (feeds === null) return;
    const down = findMatch(matches, feeds);
    if (!down) return;
    wipe(down);
    down.slots[target.feedsSlot] = { kind: 'pending', fromMatch: target.id };
  };

  wipe(m);
  return true;
}

export function roundName(index: number, totalRounds: number): string {
  const fromEnd = totalRounds - 1 - index;
  if (fromEnd === 0) return 'FINAL';
  if (fromEnd === 1) return 'SEMI-FINAL';
  if (fromEnd === 2) return 'QUARTER-FINAL';
  return `ROUND ${index + 1}`;
}

/** Same normalisation the leaderboard applies, so names match across screens. */
export function normaliseInitials(raw: string): string {
  return (raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'AAA').padEnd(3, '-');
}

/* ------------------------------------------------------------------ *
 * The live tournament
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'gdg-arcade:tournament:v1';
/** A bracket bigger than this stops being readable on a TV from 3m. */
export const MAX_PLAYERS = 32;

interface Persisted {
  v: 1;
  game: TournamentGameId | null;
  players: Player[];
  matches: Match[];
  state: TournamentState;
  startedAt: number | null;
  nextPlayerId: number;
}

/** Every storage touch is guarded — private mode must not take the kiosk down. */
function lsGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function lsRemove(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export class Tournament {
  private players: Player[] = [];
  private matches: Match[] = [];
  private _game: TournamentGameId | null = null;
  private _state: TournamentState = 'lobby';
  private startedAt: number | null = null;
  private nextPlayerId = 1;
  private listeners = new Set<() => void>();
  private storageKey: string;

  // Written out rather than a parameter property: `node --test` strips TS types
  // rather than compiling them, and parameter properties are the one common
  // TS-ism it cannot handle. This file has to be unit-testable.
  constructor(storageKey: string = STORAGE_KEY) {
    this.storageKey = storageKey;
    this.load();
  }

  /* ---------------- persistence ---------------- */

  private load(): void {
    const raw = lsGet(this.storageKey);
    if (!raw) return;
    try {
      const p = JSON.parse(raw) as Persisted;
      if (!p || p.v !== 1 || !Array.isArray(p.players) || !Array.isArray(p.matches)) return;
      this.players = p.players;
      this.matches = p.matches;
      this._game = p.game ?? null;
      this._state = p.state ?? 'lobby';
      this.startedAt = p.startedAt ?? null;
      this.nextPlayerId =
        p.nextPlayerId ?? this.players.reduce((m, pl) => Math.max(m, pl.id + 1), 1);
      // Recompute rather than trust the stored flag: a crash mid-report could
      // have persisted a bracket whose completion state is a frame stale.
      if (this.matches.length > 0) {
        this._state = isBracketComplete(this.matches) ? 'complete' : 'running';
      }
    } catch {
      // A corrupt bracket is a bad afternoon; a corrupt bracket that throws on
      // boot is a dead stall. Drop it and start clean.
      this.reset();
    }
  }

  private save(): void {
    const payload: Persisted = {
      v: 1,
      game: this._game,
      players: this.players,
      matches: this.matches,
      state: this._state,
      startedAt: this.startedAt,
      nextPlayerId: this.nextPlayerId,
    };
    try {
      lsSet(this.storageKey, JSON.stringify(payload));
    } catch {
      /* JSON.stringify cannot realistically throw here, but never block the event */
    }
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /* ---------------- lobby ---------------- */

  get state(): TournamentState {
    return this._state;
  }

  get game(): TournamentGameId | null {
    return this._game;
  }

  /** True when a bracket is in progress and the attract screen should show it. */
  get active(): boolean {
    return this._state !== 'lobby';
  }

  getPlayers(): readonly Player[] {
    return this.players;
  }

  /**
   * Adds an entrant. Returns null when the lobby is closed or full.
   *
   * Duplicate initials are allowed and disambiguated for display — at a club
   * fair two people will collide inside the first twenty entries, and refusing
   * the second one means turning a queuing human away.
   */
  addPlayer(initials: string): Player | null {
    if (this._state !== 'lobby') return null;
    if (this.players.length >= MAX_PLAYERS) return null;

    const clean = normaliseInitials(initials);
    const dupes = this.players.filter((p) => p.initials === clean).length;
    const player: Player = {
      id: this.nextPlayerId++,
      initials: clean,
      label: dupes === 0 ? clean : `${clean}·${dupes + 1}`,
      seed: this.players.length + 1,
    };
    this.players.push(player);
    this.save();
    return player;
  }

  removePlayer(id: number): boolean {
    if (this._state !== 'lobby') return false;
    const i = this.players.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.players.splice(i, 1);
    this.players.forEach((p, idx) => {
      p.seed = idx + 1;
    });
    this.save();
    return true;
  }

  /**
   * Generates the bracket and closes the lobby. Needs at least two entrants —
   * a one-person tournament is a bug on a screen a crowd is reading.
   */
  start(game: TournamentGameId): boolean {
    if (this._state !== 'lobby') return false;
    if (this.players.length < 2) return false;

    this.matches = buildMatches(this.players.map((p) => p.id));
    resolveByes(this.matches);
    this._game = game;
    this._state = isBracketComplete(this.matches) ? 'complete' : 'running';
    this.startedAt = Date.now();
    this.save();
    return true;
  }

  reset(): void {
    this.players = [];
    this.matches = [];
    this._game = null;
    this._state = 'lobby';
    this.startedAt = null;
    this.nextPlayerId = 1;
    lsRemove(this.storageKey);
    for (const fn of this.listeners) fn();
  }

  /* ---------------- running ---------------- */

  getMatches(): readonly Match[] {
    return this.matches;
  }

  getPlayer(id: number | null): Player | null {
    if (id === null) return null;
    return this.players.find((p) => p.id === id) ?? null;
  }

  /** The two humans who should step up next, in slot order. */
  nextMatch(): Match | null {
    return nextPlayable(this.matches);
  }

  nextMatchPlayers(): [Player | null, Player | null] {
    const m = this.nextMatch();
    if (!m) return [null, null];
    return this.matchPlayers(m);
  }

  matchPlayers(m: Match): [Player | null, Player | null] {
    const pick = (s: SlotRef): Player | null =>
      s.kind === 'player' ? this.getPlayer(s.playerId) : null;
    return [pick(m.slots[0]), pick(m.slots[1])];
  }

  /**
   * Reports a result by slot. `scores` is display-only and optional — a game
   * that ends on a disconnect still has a winner the operator can name.
   */
  report(matchId: number, winner: 0 | 1, scores?: [number | null, number | null]): boolean {
    if (!applyResult(this.matches, matchId, winner, scores)) return false;
    this._state = isBracketComplete(this.matches) ? 'complete' : 'running';
    this.save();
    return true;
  }

  /** Convenience for a game screen that only knows the two final scores. */
  reportScores(matchId: number, scoreA: number, scoreB: number): boolean {
    if (scoreA === scoreB) return false; // a dead heat needs a replay, not a coin toss
    return this.report(matchId, scoreA > scoreB ? 0 : 1, [scoreA, scoreB]);
  }

  /** Reports the currently-live match. What a game screen will normally call. */
  reportCurrent(scoreA: number, scoreB: number): boolean {
    const m = this.nextMatch();
    if (!m) return false;
    return this.reportScores(m.id, scoreA, scoreB);
  }

  /** Operator console: undo a mis-reported result and everything after it. */
  undo(matchId: number): boolean {
    if (!clearResult(this.matches, matchId)) return false;
    this._state = isBracketComplete(this.matches) ? 'complete' : 'running';
    this.save();
    return true;
  }

  undoLast(): boolean {
    let latest: Match | null = null;
    for (const m of this.matches) {
      if (m.winner === null || m.auto || m.at === null) continue;
      if (!latest || (latest.at ?? 0) <= m.at) latest = m;
    }
    return latest ? this.undo(latest.id) : false;
  }

  isComplete(): boolean {
    return isBracketComplete(this.matches);
  }

  champion(): Player | null {
    return this.getPlayer(championId(this.matches));
  }

  /* ---------------- render ---------------- */

  toRender(): RenderBracket {
    const totalRounds = this.matches.length > 0 ? this.matches[this.matches.length - 1]!.round + 1 : 0;
    const live = this.nextMatch();
    const size = this.matches.length > 0 ? this.matches.length + 1 : 0;
    const byes = this.matches.reduce(
      (n, m) => n + (m.slots[0].kind === 'bye' ? 1 : 0) + (m.slots[1].kind === 'bye' ? 1 : 0),
      0
    );

    const slotOf = (m: Match, i: 0 | 1): RenderSlot => {
      const s = m.slots[i];
      const p = s.kind === 'player' ? this.getPlayer(s.playerId) : null;
      return {
        label: s.kind === 'bye' ? 'BYE' : p ? p.label : '—',
        playerId: p?.id ?? null,
        seed: p?.seed ?? null,
        score: m.scores[i] ?? null,
        won: m.winner === i,
        lost: m.winner !== null && m.winner !== i,
        isBye: s.kind === 'bye',
        pending: s.kind === 'pending',
      };
    };

    const rounds: RenderRound[] = [];
    for (const m of this.matches) {
      let r = rounds[m.round];
      if (!r) {
        r = { index: m.round, name: roundName(m.round, totalRounds), matches: [] };
        rounds[m.round] = r;
      }
      r.matches.push({
        id: m.id,
        round: m.round,
        indexInRound: m.indexInRound,
        slots: [slotOf(m, 0), slotOf(m, 1)],
        ready: isPlayable(m),
        live: live !== null && live.id === m.id,
        done: m.winner !== null,
        auto: m.auto,
      });
    }

    const liveRender =
      live === null
        ? null
        : rounds[live.round]?.matches.find((rm) => rm.id === live.id) ?? null;

    return {
      game: this._game,
      state: this._state,
      playerCount: this.players.length,
      size,
      byes,
      rounds,
      champion: this.champion(),
      next: liveRender,
      matchesPlayed: this.matches.filter((m) => m.winner !== null && !m.auto).length,
      matchesTotal: this.matches.filter((m) => !m.auto).length,
    };
  }
}

export const tournament = new Tournament();

/* ------------------------------------------------------------------ *
 * Draw helper
 * ------------------------------------------------------------------ */

export interface BracketDrawOptions {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Seconds since app start — drives the live-match pulse only. */
  time?: number;
  accent?: string;
}

/**
 * Draws the bracket as columns of match cards with elbow connectors.
 *
 * PERFORMANCE: not one `shadowBlur` inside a loop. Canvas charges the blur per
 * draw call, and a 16-player bracket is 15 cards × 2 slots × (fill + stroke +
 * text) — a glow on each would be ~90 blurred operations every frame on the
 * screen that runs for eight hours. The "this one is live" emphasis is done
 * with three layered translucent strokes instead, the same trick `drawPose`
 * uses in engine/skeleton.ts. Exactly one glowed call is made per frame, for
 * the champion banner.
 */
export function drawBracket(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  bracket: RenderBracket,
  opts: BracketDrawOptions = {}
): void {
  const x0 = opts.x ?? vh(v, 4);
  const y0 = opts.y ?? vh(v, 4);
  const w = opts.width ?? v.width - vh(v, 8);
  const h = opts.height ?? v.height - vh(v, 8);
  const time = opts.time ?? 0;
  const accent = opts.accent ?? COLORS.yellow;

  if (bracket.rounds.length === 0) {
    drawText(ctx, 'NO BRACKET YET', x0 + w / 2, y0 + h / 2, {
      size: vh(v, 3),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.2em',
    });
    return;
  }

  const cols = bracket.rounds.length;
  const colW = w / cols;
  const cardW = Math.min(colW * 0.84, vh(v, 26));
  const firstCount = bracket.rounds[0]?.matches.length ?? 1;

  const headerH = vh(v, 4.2);
  const bodyTop = y0 + headerH;
  const bodyH = h - headerH;
  const rowH = bodyH / firstCount;
  const cardH = Math.min(vh(v, 7.2), rowH * 0.78);
  const slotH = cardH / 2;
  const fontSize = Math.min(vh(v, 2.2), slotH * 0.62);

  const colX = (r: number): number => x0 + colW * r + (colW - cardW) / 2;
  const centreY = (r: number, i: number): number => {
    // A round-r match sits centred between the two matches feeding it.
    const span = rowH * Math.pow(2, r);
    return bodyTop + span * (i + 0.5);
  };

  /* --- connectors, drawn first so cards sit on top --- */
  ctx.save();
  ctx.lineWidth = Math.max(1, vh(v, 0.18));
  // GRID, not ink at 14%. A see-through brand colour is the first thing the
  // kit rules out, and `grid` is the exact weight this wants: structure you
  // read past rather than structure you read.
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  for (let r = 0; r + 1 < cols; r++) {
    const round = bracket.rounds[r];
    if (!round) continue;
    const rightX = colX(r) + cardW;
    const midX = colX(r + 1) - (colX(r + 1) - rightX) / 2;
    for (const m of round.matches) {
      const y = centreY(r, m.indexInRound);
      const ny = centreY(r + 1, Math.floor(m.indexInRound / 2));
      ctx.moveTo(rightX, y);
      ctx.lineTo(midX, y);
      ctx.lineTo(midX, ny);
      ctx.lineTo(colX(r + 1), ny);
    }
  }
  ctx.stroke();
  ctx.restore();

  /* --- round headers --- */
  for (let r = 0; r < cols; r++) {
    const round = bracket.rounds[r];
    if (!round) continue;
    // FITTED TO ITS OWN COLUMN. At eight players the columns are narrow
    // enough that "QUARTER-FINAL" and "SEMI-FINAL" ran into each other and
    // read as one word.
    drawText(ctx, round.name, colX(r) + cardW / 2, y0 + headerH * 0.4, {
      size: vh(v, 1.9),
      maxWidth: cardW,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.12em',
    });
  }

  /* --- cards --- */
  const pulse = 0.55 + Math.sin(time * 5) * 0.45;

  for (let r = 0; r < cols; r++) {
    const round = bracket.rounds[r];
    if (!round) continue;
    const cx = colX(r);

    for (const m of round.matches) {
      const cy = centreY(r, m.indexInRound);
      const top = cy - cardH / 2;

      // A STICKER, like every other card in the app. The original drew a few
      // percent of ink as a surface and a 12% stroke as an edge — a
      // see-through colour twice over, written before the paper/ink pass and
      // never converted because nothing ever drew this.
      //
      // The match that is ON NEXT is the only thing on a bracket anybody is
      // looking for across a room, so it gets the full lift: thick outline and
      // a hard shadow. Everything else sits flat on the page.
      const radius = vh(v, 0.7);
      stickerCard(ctx, v, cx, top, cardW, cardH, {
        radius,
        fill: COLORS.paper,
        outline: COLORS.ink,
        outlineWidth: vh(v, m.live ? STROKE.thick : STROKE.thin),
        shadow: m.live ? vh(v, SHADOW.lifted) : 0,
        shadowColor: COLORS.ink,
      });

      // Live match: a full-width accent bar along the top edge, the same
      // object the menu tiles use. Replaces three concentric translucent
      // strokes pretending to be a glow — which is a blur with extra steps,
      // and invisible on paper anyway.
      if (m.live) {
        ctx.save();
        roundRect(ctx, cx, top, cardW, cardH, radius);
        ctx.clip();
        ctx.fillStyle = accent;
        ctx.fillRect(cx, top, cardW, vh(v, 0.9) * (0.75 + pulse * 0.25));
        ctx.restore();
      }

      // Divider between the two slots.
      ctx.save();
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = Math.max(1, vh(v, STROKE.thin));
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + cardW, cy);
      ctx.stroke();
      ctx.restore();

      for (let i = 0; i < 2; i++) {
        const s = m.slots[i as 0 | 1];
        const sy = top + slotH * (i + 0.5);

        // THREE STATES, THREE TREATMENTS, NO ALPHA.
        //
        // A bye or a "winner of match 3" is genuinely a placeholder, which is
        // the one thing `muted` is for. A LOSER is not a placeholder — they
        // played — so they stay ink and are told apart from the winner by the
        // winner being on a flat brand-colour surface. The original used 42%
        // alpha for a loser and 18% alpha behind a winner, which on paper is
        // two shades of nearly-white and the one mistake a bracket on a wall
        // cannot afford.
        const placeholder = s.isBye || s.pending;

        if (s.won) {
          ctx.save();
          roundRect(ctx, cx, top + slotH * i, cardW, slotH, vh(v, 0.5));
          ctx.clip();
          ctx.fillStyle = PLAYER_COLORS[i] ?? COLORS.blue;
          ctx.fillRect(cx, top + slotH * i, cardW, slotH);
          ctx.restore();
        }

        drawText(ctx, s.label, cx + vh(v, 0.9), sy, {
          size: fontSize,
          color: placeholder ? COLORS.muted : COLORS.ink,
          font: FONTS.display,
          weight: s.won ? WEIGHT.black : WEIGHT.medium,
          align: 'left',
        });

        if (s.score !== null) {
          drawText(ctx, String(s.score), cx + cardW - vh(v, 0.9), sy, {
            size: fontSize * 0.95,
            color: COLORS.ink,
            font: FONTS.mono,
            weight: WEIGHT.bold,
            align: 'right',
          });
        }
      }
    }
  }

  /* --- champion banner: the only glowed call in the whole helper --- */
  if (bracket.champion) {
    const lastRound = bracket.rounds[cols - 1];
    const fx = colX(cols - 1) + cardW / 2;
    const fy = centreY(cols - 1, (lastRound?.matches[0]?.indexInRound ?? 0)) + cardH;
    // Yellow can't carry text on paper (1.7:1). Ink letterforms, yellow lift.
    drawText(ctx, bracket.champion.label, fx, fy + vh(v, 3), {
      size: vh(v, 3.4),
      color: COLORS.ink,
      shadow: vh(v, 0.6),
      shadowColor: COLORS.yellow,
      letterSpacing: '0.12em',
    });
    drawText(ctx, 'CHAMPION', fx, fy + vh(v, 6), {
      size: vh(v, 1.8),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.3em',
    });
  }
}
