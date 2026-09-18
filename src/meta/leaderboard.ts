/**
 * Local leaderboard with faction totals.
 *
 * PLAN.md §4: persists across both days so Day 2 competes against Day 1;
 * near-miss framing on the rank reveal ("#4 TODAY — 2 OFF THIRD") because
 * that line sells more retries than the score does.
 *
 * Deliberately localStorage-only. No backend, no network, no dependency on
 * anyone else's service — PLAN.md §1, "venue wifi will fail."
 */

export type GameId =
  | 'sixtyseven'
  | 'fruitninja'
  | 'redlight'
  | 'runner'
  | 'posematch'
  | 'rhythm'
  | 'balloonpop';

export interface Entry {
  initials: string;
  score: number;
  faction: string | null;
  /** Epoch ms. Used to separate Day 1 from Day 2 in the UI. */
  at: number;
}

export interface RankResult {
  /** 1-based position in the all-time table, or null if it didn't place. */
  rank: number | null;
  /** Total entries for this game. */
  total: number;
  /** True if this beat an existing #1. */
  isRecord: boolean;
  /**
   * True if the board was EMPTY — nobody has played this game yet.
   *
   * Distinct from `isRecord` on purpose. "NEW RECORD" is a lie when there was
   * no record to break, but "#1 of 1" is a flat, joyless thing to show someone.
   * Day 1 opens with seven empty boards, so this fires seven times in the first
   * ten minutes and each one deserves to feel like an event.
   */
  isFirst: boolean;
  /** Points needed to take the next place up. Null when already #1. */
  pointsToNext: number | null;
  /** The place being chased, for the "2 OFF THIRD" line. */
  nextRank: number | null;
  /** Previous best for these initials, if we've seen them before. */
  personalBest: number | null;
}

const STORAGE_KEY = 'gdg-arcade:leaderboard:v1';
const FACTION_KEY = 'gdg-arcade:factions:v1';
const TOP_N = 10;

/**
 * PLAN.md §11 flags "majors or years?" as an open question for the club.
 * Placeholder list; one edit when they decide.
 */
export const FACTIONS = [
  'ENGINEERING',
  'COMPUTER SCI',
  'BUSINESS',
  'MEDIA',
  'SCIENCE',
  'OTHER',
] as const;

export type Faction = (typeof FACTIONS)[number];

interface Store {
  boards: Partial<Record<GameId, Entry[]>>;
  factionTotals: Record<string, number>;
  plays: Partial<Record<GameId, number>>;
}

function emptyStore(): Store {
  return { boards: {}, factionTotals: {}, plays: {} };
}

function isEntry(e: unknown): e is Entry {
  if (!e || typeof e !== 'object') return false;
  const x = e as Partial<Entry>;
  return (
    typeof x.initials === 'string' &&
    typeof x.score === 'number' &&
    Number.isFinite(x.score) &&
    typeof x.at === 'number' &&
    Number.isFinite(x.at)
  );
}

/** Keeps only boards that are arrays of well-formed, finite-scored entries. */
function validBoards(raw: unknown): Partial<Record<GameId, Entry[]>> {
  const out: Partial<Record<GameId, Entry[]>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [game, board] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(board)) continue;
    const clean = board.filter(isEntry);
    if (clean.length > 0) out[game as GameId] = clean;
  }
  return out;
}

function validTotals(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function validPlays(raw: unknown): Partial<Record<GameId, number>> {
  const out: Partial<Record<GameId, number>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k as GameId] = v;
  }
  return out;
}

class Leaderboard {
  private store: Store = emptyStore();
  private listeners = new Set<() => void>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Store>;

        // VALIDATE THE SHAPE, not just the parse.
        //
        // This is the only persisted store with no validation, and it is the
        // one that has to carry Sept 24 into Sept 26 — ghosts.ts and
        // tournament.ts both check theirs. `?? {}` catches a missing key and
        // nothing else: a board that is not an array survives, and then
        // `board.filter` throws or `previewRank` returns `rank: NaN,
        // total: undefined`, which renders on the TV as literal "NaN".
        //
        // Anything that fails is dropped rather than repaired. A missing board
        // costs one game's scores; a malformed one that half-works can corrupt
        // every submission after it.
        this.store = {
          boards: validBoards(parsed.boards),
          factionTotals: validTotals(parsed.factionTotals),
          plays: validPlays(parsed.plays),
        };
      }
    } catch {
      // Corrupt or unavailable storage must not take the kiosk down. Losing
      // scores is bad; a black screen at the stall is worse.
      this.store = emptyStore();
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.store));
    } catch {
      /* private mode / quota — keep running in memory */
    }
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getBoard(game: GameId): Entry[] {
    return this.store.boards[game] ?? [];
  }

  getTop(game: GameId, n = TOP_N): Entry[] {
    return this.getBoard(game).slice(0, n);
  }

  getBest(game: GameId): Entry | null {
    return this.getBoard(game)[0] ?? null;
  }

  /** The score currently at a given 1-based place, for the live "beat this" marker. */
  getScoreAtRank(game: GameId, rank: number): number | null {
    return this.getBoard(game)[rank - 1]?.score ?? null;
  }

  /**
   * What rank a score WOULD get, without committing it. Used to show a live
   * target during play rather than only at the end.
   */
  previewRank(game: GameId, score: number): RankResult {
    const board = this.getBoard(game);
    let rank = board.length + 1;
    for (let i = 0; i < board.length; i++) {
      if (score > board[i]!.score) {
        rank = i + 1;
        break;
      }
    }

    const placed = rank <= TOP_N;
    const nextRank = rank > 1 ? rank - 1 : null;
    const nextScore = nextRank ? board[nextRank - 1]?.score ?? null : null;

    return {
      rank: placed ? rank : null,
      total: board.length,
      isRecord: rank === 1 && board.length > 0,
      isFirst: board.length === 0,
      pointsToNext: nextScore !== null ? Math.max(1, nextScore - score + 1) : null,
      nextRank,
      personalBest: null,
    };
  }

  /**
   * Commits a score and returns where it landed.
   *
   * Zero and negative scores are deliberately dropped. They come from someone
   * who walked away mid-round or never engaged, and a board full of 0s makes
   * the leaderboard — the entire competitive layer — look broken to everyone
   * standing in the queue reading it.
   */
  submit(game: GameId, score: number, initials: string, faction: string | null): RankResult {
    if (!(score > 0)) return this.previewRank(game, score);

    const board = [...this.getBoard(game)];

    // Always three glyphs. The auto-accept deadline can submit a partial entry,
    // and 'P' sitting in a column of 'GDG' looks like a bug rather than a name.
    const cleanInitials =
      (initials.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'AAA').padEnd(3, '-');
    const personalBest =
      board.filter((e) => e.initials === cleanInitials).reduce((m, e) => Math.max(m, e.score), 0) ||
      null;

    const preview = this.previewRank(game, score);

    board.push({ initials: cleanInitials, score, faction, at: Date.now() });
    board.sort((a, b) => b.score - a.score || a.at - b.at);

    // Keep a bit more than we display — useful for the post-event writeup and
    // costs nothing.
    this.store.boards[game] = board.slice(0, 100);
    this.store.plays[game] = (this.store.plays[game] ?? 0) + 1;

    if (faction) {
      this.store.factionTotals[faction] = (this.store.factionTotals[faction] ?? 0) + score;
    }

    this.save();

    return { ...preview, personalBest };
  }

  /* ---------------- factions ---------------- */

  getFactionTotals(): Array<{ name: string; total: number }> {
    return Object.entries(this.store.factionTotals)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total);
  }

  /** Remembers the last faction chosen so repeat players skip the picker. */
  getLastFaction(): string | null {
    try {
      return localStorage.getItem(FACTION_KEY);
    } catch {
      return null;
    }
  }

  setLastFaction(faction: string): void {
    try {
      localStorage.setItem(FACTION_KEY, faction);
    } catch {
      /* ignore */
    }
  }

  /* ---------------- analytics ---------------- */

  getPlayCounts(): Array<{ game: GameId; plays: number }> {
    return (Object.entries(this.store.plays) as Array<[GameId, number]>)
      .map(([game, plays]) => ({ game, plays }))
      .sort((a, b) => b.plays - a.plays);
  }

  getTotalPlays(): number {
    return Object.values(this.store.plays).reduce((s, n) => s + (n ?? 0), 0);
  }

  /** Operator console: remove a bogus score without nuking the board. */
  removeEntry(game: GameId, index: number): void {
    const board = [...this.getBoard(game)];
    const removed = board.splice(index, 1)[0];
    if (removed?.faction) {
      this.store.factionTotals[removed.faction] = Math.max(
        0,
        (this.store.factionTotals[removed.faction] ?? 0) - removed.score
      );
    }
    this.store.boards[game] = board;
    this.save();
  }

  clearGame(game: GameId): void {
    this.store.boards[game] = [];
    this.save();
  }

  clearAll(): void {
    this.store = emptyStore();
    this.save();
  }

  /** JSON dump for the post-event writeup. */
  exportJSON(): string {
    return JSON.stringify(this.store, null, 2);
  }
}

export const leaderboard = new Leaderboard();
