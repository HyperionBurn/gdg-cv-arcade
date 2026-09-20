/**
 * ONE LINE PER ROUND, SO THE PLAYTEST PRODUCES NUMBERS AND NOT IMPRESSIONS.
 *
 * FEEDBACK.md's "Still owed to the next playtest" table lists four open
 * questions, and every one of them names the number to watch:
 *
 *   Pose Match  pass rate on the first wall
 *   Runner      first-timer hit rate on `low` (jump) obstacles specifically
 *   Initials    real entry times
 *   Red Light   whether five racers hold their lanes for a full round
 *
 * Nothing recorded any of them. The three exports a marshal can take off the
 * stall are scores, tuning and the bracket, and none of those carry a single
 * fact about HOW a round went — only what it ended on. So the Sept 22 session
 * would have produced four opinions, and the Runner row is not an opinion
 * question: it is a ship decision. That row sets a clear-rate threshold around
 * 60%, below which jump obstacles get weighted to near zero and lanes and
 * slides ship instead. Nobody can count hit rate by obstacle kind by eye while
 * also running a queue.
 *
 * (Paraphrased rather than quoted on purpose. The ledger guard treats a quoted
 * span near the word "playtest" as a tester report, and the allowlist that
 * exempts one is capped so it cannot grow until the completeness check means
 * nothing. Spending an allowlist slot on a line of our own prose would be
 * exactly the erosion the cap exists to stop.)
 *
 * The timing is the whole argument for building it now. Instrumentation added
 * after the playtest measures nothing, and the playtest is in two days.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 *
 * Not analytics, and not a second leaderboard. It never leaves the laptop, it
 * has no network, and nothing in the app READS it back — no ranking, no
 * tuning, no gameplay decision. It is written during a round and read once, by
 * a human, from a JSON file after the stall closes. That one-way property is
 * what makes it safe to add four days out: a counter that nothing consumes
 * cannot change how anything plays.
 *
 * `detail` is deliberately `Record<string, number>` rather than a typed shape
 * per game. A per-game union would have to be edited in three files every time
 * a question changes, and these questions change between playtests — that is
 * what a playtest is for.
 */

import type { GameId } from './leaderboard';

/** One finished round. */
export interface RoundRecord {
  /** `Date.now()` at the end of the round. */
  at: number;
  game: GameId;
  /** Bodies the round was scored for, not bodies in frame. */
  players: number;
  /** The winning score for the round, so a row is readable on its own. */
  score: number;
  /** Seconds of play, which is not the game's nominal length if it was cut short. */
  seconds: number;
  /** Whatever the game wanted to count. See the note above on why it is loose. */
  detail?: Record<string, number>;
}

const STORAGE_KEY = 'gdg-arcade:rounds';

/**
 * A fair day is roughly 360 turns; two days is ~720.
 *
 * 1000 keeps both days whole with room to spare, and a record is small — the
 * biggest `detail` in the app is six counters. At roughly 160 bytes a row that
 * is ~160KB, comfortably inside a 5MB origin quota next to the boards.
 *
 * It drops the OLDEST when full rather than refusing new ones: the interesting
 * rounds are the ones nearest the question being asked, and a log that stops
 * recording halfway through the afternoon fails silently in the direction
 * nobody checks.
 */
const MAX_ROWS = 1000;

/** Rejects anything that is not the shape this was written to hold. */
function validRow(x: unknown): RoundRecord | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Partial<RoundRecord>;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  if (typeof r.game !== 'string' || !r.game) return null;
  if (typeof r.players !== 'number' || !Number.isFinite(r.players)) return null;
  if (typeof r.score !== 'number' || !Number.isFinite(r.score)) return null;
  if (typeof r.seconds !== 'number' || !Number.isFinite(r.seconds)) return null;

  let detail: Record<string, number> | undefined;
  if (r.detail && typeof r.detail === 'object') {
    detail = {};
    for (const [k, v] of Object.entries(r.detail)) {
      if (typeof v === 'number' && Number.isFinite(v)) detail[k] = v;
    }
  }
  return {
    at: r.at,
    game: r.game as GameId,
    players: r.players,
    score: r.score,
    seconds: r.seconds,
    ...(detail && Object.keys(detail).length > 0 ? { detail } : {}),
  };
}

class RoundLog {
  private rows: RoundRecord[] = [];

  /**
   * True once a write has failed, like the other three stores.
   *
   * Same reason as `leaderboard.saveFailed`: a store that fails silently is
   * one somebody discovers by finding the file empty after the session, when
   * re-running it is no longer possible.
   */
  saveFailed = false;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      // Per row, so one corrupt entry costs one round rather than the day.
      this.rows = parsed.map(validRow).filter((r): r is RoundRecord => r !== null).slice(-MAX_ROWS);
    } catch {
      // Corrupt or unavailable storage must not take the kiosk down.
      this.rows = [];
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.rows));
      this.saveFailed = false;
    } catch {
      /* private mode / quota — keep running in memory */
      this.saveFailed = true;
    }
  }

  /**
   * Record a finished round. Never throws: this is called from the end of a
   * round, and a diagnostic that can break a turn is worse than no diagnostic.
   */
  add(record: RoundRecord): void {
    const row = validRow(record);
    if (!row) return;
    this.rows.push(row);
    if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);
    this.save();
  }

  all(): readonly RoundRecord[] {
    return this.rows;
  }

  count(): number {
    return this.rows.length;
  }

  clear(): void {
    this.rows = [];
    this.save();
  }

  /**
   * Rounds per game, for the operator console — so a marshal can see the log
   * is filling up without exporting it.
   */
  countsByGame(): Array<{ game: GameId; rounds: number }> {
    const by = new Map<GameId, number>();
    for (const r of this.rows) by.set(r.game, (by.get(r.game) ?? 0) + 1);
    return [...by.entries()]
      .map(([game, rounds]) => ({ game, rounds }))
      .sort((a, b) => b.rounds - a.rounds);
  }

  exportJSON(): string {
    return JSON.stringify({ exported: Date.now(), rounds: this.rows }, null, 2);
  }
}

export const roundLog = new RoundLog();
