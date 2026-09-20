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
 *
 * AND THE WRITE COST, because this re-serialises the whole array every round
 * and `localStorage.setItem` is synchronous — it lands at the end of a round,
 * which is exactly when the results panel is animating in. MEASURED at a full
 * 1000 rows (159.8 KB of JSON): push, trim, stringify and store together cost
 * **0.3-1.2 ms**, ten consecutive samples, against a 16.7 ms frame. Once per
 * round, not per frame. Re-take it if a row ever grows a string field —
 * everything here is a number today, which is most of why it is small.
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

/**
 * INITIALS ENTRY TIMES LIVE HERE TOO, AND THAT NEEDS A WORD.
 *
 * FEEDBACK.md owes the next playtest one number for the initials screen:
 * how long real people actually take to spell three letters, so the 16s
 * `HARD_DEADLINE_SEC` backstop can shrink if nobody needs it. That was left
 * unrecorded because initials is a SCREEN, not a round, and never passes
 * through the round hook.
 *
 * True, but it is not a reason to make somebody hold a stopwatch at a stall
 * they are also running. The times are not rounds, so they are not rows: a
 * `RoundRecord` has a game and a score and this has neither, and widening the
 * row to fit would make every round carry two dead fields.
 *
 * They live in the same store because of the pack-up instruction. FEEDBACK.md
 * says "take the export before you pack up", once, and a second store means a
 * second thing to remember at the one moment of the day when everybody is
 * tired and the laptop is about to be closed.
 *
 * 200 is far more than a distribution needs and about 1.5 KB.
 */
const INITIALS_MAX = 200;

/** Longer than this is somebody walking away, not somebody typing. */
const INITIALS_CEILING_SEC = 120;

/**
 * TWO SHAPES, BECAUSE THE OLD ONE IS ALREADY ON DISK.
 *
 * This key held a BARE ARRAY of rounds before initials entry times joined it,
 * and any laptop that has run a session already has that array sitting in it
 * — including the one going to the stall. Reading only the new shape would
 * silently drop a day of rounds, which is the single failure this store
 * exists to prevent, so the old shape is still accepted and simply carries no
 * entry times.
 *
 * Exported because it is the decision, and a migration that only runs inside
 * a singleton's constructor cannot be tested without reconstructing the
 * singleton. Anything unreadable comes back empty rather than throwing: this
 * runs during boot on a kiosk.
 */
export function parseStored(raw: string): { rows: RoundRecord[]; initials: number[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rows: [], initials: [] };
  }

  const legacy = Array.isArray(parsed);
  // Annotated rather than inferred: `legacy` is a boolean, so it does not
  // narrow `parsed` the way an inline `Array.isArray` would, and the inferred
  // type collapses to `{}`.
  const rowsIn: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { rounds?: unknown })?.rounds)
      ? (parsed as { rounds: unknown[] }).rounds
      : null;
  if (!rowsIn) return { rows: [], initials: [] };

  // Per row, so one corrupt entry costs one round rather than the day.
  const rows = rowsIn.map(validRow).filter((r): r is RoundRecord => r !== null).slice(-MAX_ROWS);

  const secsIn = legacy ? [] : ((parsed as { initials?: unknown }).initials ?? []);
  const initials = Array.isArray(secsIn)
    ? secsIn
        .filter(
          (n): n is number =>
            typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= INITIALS_CEILING_SEC,
        )
        .slice(-INITIALS_MAX)
    : [];

  return { rows, initials };
}

class RoundLog {
  private rows: RoundRecord[] = [];
  private entrySecs: number[] = [];

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
      const { rows, initials } = parseStored(raw);
      this.rows = rows;
      this.entrySecs = initials;
    } catch {
      // Corrupt or unavailable storage must not take the kiosk down.
      this.rows = [];
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ rounds: this.rows, initials: this.entrySecs }));
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
    this.entrySecs = [];
    this.save();
  }

  /**
   * One completed initials entry, in seconds. Never throws, for the same
   * reason `add` does not: this fires as a player leaves the screen.
   *
   * Only CALLED entries count, not abandoned ones. A player who walked away
   * and hit the deadline did not take 16s to type, and averaging those in
   * would argue for keeping a backstop that the walk-aways themselves caused.
   */
  logInitials(seconds: number): void {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return;
    if (seconds < 0 || seconds > INITIALS_CEILING_SEC) return;
    this.entrySecs.push(Math.round(seconds * 10) / 10);
    if (this.entrySecs.length > INITIALS_MAX) {
      this.entrySecs.splice(0, this.entrySecs.length - INITIALS_MAX);
    }
    this.save();
  }

  /**
   * The shape of those times, which is the actual FEEDBACK.md question:
   * can `HARD_DEADLINE_SEC` come down from 16?
   *
   * `p90` is the number to read, not `median`. The backstop exists for the
   * SLOW player, so the only question it answers is how long the slowest
   * tenth take. A median of 6s next to a p90 of 15s means 16 is doing its job.
   */
  initialsStats(): { count: number; median: number; p90: number; max: number } | null {
    if (this.entrySecs.length === 0) return null;
    const sorted = [...this.entrySecs].sort((a, b) => a - b);
    // The `?? 0` never fires: the empty case returned above. It is here
    // because `noUncheckedIndexedAccess` is on, which is the setting that
    // caught a real off-by-one in the chase line earlier.
    const at = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    return {
      count: sorted.length,
      median: at(0.5),
      p90: at(0.9),
      max: sorted[sorted.length - 1] ?? 0,
    };
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
    return JSON.stringify(
      { exported: Date.now(), rounds: this.rows, initialsSeconds: this.entrySecs },
      null,
      2,
    );
  }
}

export const roundLog = new RoundLog();
