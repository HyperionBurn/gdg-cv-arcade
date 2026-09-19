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
  /**
   * What `submit` actually wrote to the board, after sanitising. Only set by
   * `submit`; absent on a preview. Show THIS on a confirmation screen, so the
   * payoff and the board can never disagree about someone's name.
   */
  storedInitials?: string;
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

/**
 * Every game id that may appear in a persisted store.
 *
 * `GameId` is a compile-time type and `JSON.parse` output is not type-checked,
 * so without a runtime allowlist an `as GameId` cast on a loaded key lets a
 * corrupt or hand-edited store invent games. `getPlayCounts()` then returns
 * ids nothing else recognises, and a consumer doing
 * `MENU_TILES.find((t) => t.id === game)` gets `undefined` — which is the
 * "undefined on a TV in front of a queue" failure this whole file is careful
 * about everywhere else.
 *
 * It also closes a prototype hole: `JSON.parse` produces a real own
 * `"__proto__"` key, and assigning through it on a plain object literal
 * rewrites the accumulator's prototype rather than adding a board.
 */
const GAME_IDS: readonly GameId[] = [
  'sixtyseven',
  'fruitninja',
  'redlight',
  'runner',
  'posematch',
  'rhythm',
  'balloonpop',
];

function isGameId(k: string): k is GameId {
  return (GAME_IDS as readonly string[]).includes(k);
}

/**
 * Three glyphs, A-Z0-9 only. The single definition of what an initials string
 * is allowed to be, applied on the way IN from storage as well as on submit —
 * a loaded entry used to bypass sanitising entirely, so a corrupt store could
 * put a 4KB string or an emoji straight onto the board screen.
 */
function cleanInitials(raw: string): string {
  return (raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'AAA').padEnd(3, '-');
}

interface Store {
  boards: Partial<Record<GameId, Entry[]>>;
  factionTotals: Record<string, number>;
  plays: Partial<Record<GameId, number>>;
}

function emptyStore(): Store {
  return { boards: {}, factionTotals: {}, plays: {} };
}

/**
 * A loaded row, repaired to exactly what `submit` would have written, or null.
 *
 * Returns a NEW object rather than narrowing in place, because the checks
 * `submit` applies (initials sanitising, a positive integer score, a faction
 * that is a string or nothing) were only ever applied on the way in from the
 * keypad. Anything already in storage went straight onto the board.
 */
function readEntry(e: unknown): Entry | null {
  if (!e || typeof e !== 'object') return null;
  const x = e as Partial<Entry>;
  if (typeof x.initials !== 'string') return null;
  if (typeof x.score !== 'number' || !Number.isFinite(x.score) || x.score <= 0) return null;
  if (typeof x.at !== 'number' || !Number.isFinite(x.at)) return null;
  // `faction` was not checked at all. A non-string one survived, and
  // `removeEntry` then keyed `factionTotals` on "[object Object]".
  const faction = typeof x.faction === 'string' ? x.faction : null;
  return {
    initials: cleanInitials(x.initials),
    score: Math.round(x.score),
    faction,
    at: x.at,
  };
}

/** Keeps only boards that are arrays of well-formed, finite-scored entries. */
function validBoards(raw: unknown): Partial<Record<GameId, Entry[]>> {
  const out: Partial<Record<GameId, Entry[]>> = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const [game, board] of Object.entries(raw as Record<string, unknown>)) {
    if (!isGameId(game) || !Array.isArray(board)) continue;
    const clean = board
      .map(readEntry)
      .filter((e): e is Entry => e !== null)
      // RE-SORT AND RE-CAP ON LOAD.
      //
      // `previewRank` breaks on the first entry it beats, `getBest` returns
      // `board[0]` and `getScoreAtRank` indexes positionally — every rank
      // query in this file assumes descending order, and nothing was
      // enforcing it. A store that is corrupt but well-FORMED (hand-edited
      // for the writeup, half-written, pasted in) therefore produced wrong
      // ranks and a wrong "NEW RECORD" on every submission afterwards, which
      // is precisely the "half-works and corrupts everything after it" case
      // the comment in `load()` says we drop things to avoid.
      //
      // Same tie-break as `submit`: equal scores, earlier entry first.
      .sort((a, b) => b.score - a.score || a.at - b.at)
      // `submit` caps at 100; `load` did not, so a grown store never shrank.
      .slice(0, 100);
    if (clean.length > 0) out[game] = clean;
  }
  return out;
}

function validTotals(raw: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function validPlays(raw: unknown): Partial<Record<GameId, number>> {
  const out: Partial<Record<GameId, number>> = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isGameId(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
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

  /**
   * True once a write has failed. Surfaced so the operator console can say so.
   *
   * The quota path used to be entirely silent: scores kept accumulating in
   * memory and vanished on the next reload, on the one store that has to carry
   * Sept 24 into Sept 26.
   */
  saveFailed = false;

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.store));
      this.saveFailed = false;
    } catch {
      /* private mode / quota — keep running in memory */
      this.saveFailed = true;
    }

    // EVERY LISTENER IN ITS OWN TRY.
    //
    // This loop was outside the try above, so a throwing subscriber propagated
    // out of `save()` -> `submit()` -> `InitialsScreen.finish()`. That screen
    // sets its `submitted` latch BEFORE the call and its `phase = 'done'`
    // AFTER, so a throw here left it latched in the 'letters' phase with every
    // exit — the hard deadline, the abandon timer, and OK — reduced to a
    // no-op. The kiosk sat on "SAVING IN 0" until someone reloaded it.
    //
    // A broken observer must never be able to take down the thing it observes.
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error('[leaderboard] listener threw', err);
      }
    }
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
  previewRank(game: GameId, rawScore: number): RankResult {
    // NOTHING NON-FINITE GETS PAST HERE.
    //
    // There was no input guard at all, and `Math.max(1, NaN)` is NaN — so a
    // NaN score propagated into `pointsToNext` and rendered on the results
    // screen as the literal string "NaN OFF #3". A fractional score rendered
    // "3.5 OFF #2". Both are reachable from `setScore`, from `?screen=initials`
    // and from the operator console.
    const score = Number.isFinite(rawScore) ? Math.round(rawScore) : 0;

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
  submit(game: GameId, rawScore: number, initials: string, faction: string | null): RankResult {
    const score = Number.isFinite(rawScore) ? Math.round(rawScore) : 0;

    // A DROPPED SCORE MUST NOT REPORT A PLACE.
    //
    // This returned a bare `previewRank`, and on a board with fewer than TOP_N
    // entries `previewRank` hands back a NON-NULL rank — so a score that was
    // deliberately never stored still came back as `#4`, with a
    // "2 OFF THIRD" chase line and a green faction-points pill for points that
    // were never added. On an empty board it reported `#1`. `GameBase` guards
    // its own call with `best.score > 0`, but `setScore`, `?screen=initials`
    // and the operator console all reach this directly.
    if (!(score > 0)) {
      return {
        ...this.previewRank(game, score),
        rank: null,
        isRecord: false,
        isFirst: false,
        pointsToNext: null,
        nextRank: null,
      };
    }

    const board = [...this.getBoard(game)];

    // Always three glyphs. The auto-accept deadline can submit a partial entry,
    // and 'P' sitting in a column of 'GDG' looks like a bug rather than a name.
    const stored = cleanInitials(initials);
    const personalBest =
      board.filter((e) => e.initials === stored).reduce((m, e) => Math.max(m, e.score), 0) || null;

    const preview = this.previewRank(game, score);

    board.push({ initials: stored, score, faction, at: Date.now() });
    board.sort((a, b) => b.score - a.score || a.at - b.at);

    // Keep a bit more than we display — useful for the post-event writeup and
    // costs nothing.
    this.store.boards[game] = board.slice(0, 100);
    this.store.plays[game] = (this.store.plays[game] ?? 0) + 1;

    if (faction) {
      this.store.factionTotals[faction] = (this.store.factionTotals[faction] ?? 0) + score;
    }

    this.save();

    // `storedInitials` so the payoff sticker can show what the BOARD shows.
    // A deadline-triggered partial entry of "W" is stored as "W--", and the
    // done screen used to display the raw "W" while the leaderboard a few
    // seconds later displayed "W--".
    return { ...preview, personalBest, storedInitials: stored };
  }

  /* ---------------- factions ---------------- */

  getFactionTotals(): Array<{ name: string; total: number }> {
    return Object.entries(this.store.factionTotals)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total);
  }

  /**
   * Remembers the last faction chosen so repeat players skip the picker.
   *
   * VALIDATED AGAINST THE CURRENT LIST. `FACTIONS` is flagged above as a
   * placeholder the club will edit once they decide majors-or-years, and that
   * edit lands between Day 1 and Day 2. A returning player whose stored
   * faction no longer exists used to have the picker SKIPPED and their points
   * credited to a bucket the standings screen can never look up — the points
   * simply vanished, with no error anywhere. An unknown value now means
   * "ask again", which is the right answer for a changed list.
   */
  getLastFaction(): Faction | null {
    try {
      const v = localStorage.getItem(FACTION_KEY);
      return v !== null && (FACTIONS as readonly string[]).includes(v) ? (v as Faction) : null;
    } catch {
      return null;
    }
  }

  /**
   * The faction THESE INITIALS played for last time, or null.
   *
   * `getLastFaction` is one value for the whole kiosk, and using it as the
   * default is how the attract screen ended up reading
   * "BUSINESS 9,357 · ENGINEERING 0 · CS 0 · MEDIA 0": the first person of the
   * day picks, and every player after them is silently credited to that same
   * faction unless they notice a small "hover to change" line and act on it.
   * A faction competition whose totals are decided by whoever played first is
   * not a competition.
   *
   * The comment on `getLastFaction` says the point is that "repeat players
   * skip the picker". This is that, meant literally: a repeat player is
   * somebody whose initials are already on a board, and what they skip is
   * being asked a question they have already answered.
   *
   * Newest entry wins, so somebody who switched allegiance keeps the switch.
   * Validated against the live FACTIONS list for the same reason
   * `getLastFaction` is — the club edits that list between Day 1 and Day 2,
   * and an unknown value has to mean "ask again" rather than "credit points
   * to a bucket nothing can look up".
   */
  factionFor(initials: string): Faction | null {
    const key = initials.trim().toUpperCase();
    if (!key) return null;

    let best: { faction: string; at: number } | null = null;
    for (const board of Object.values(this.store.boards)) {
      for (const e of board) {
        if (e.initials !== key || !e.faction) continue;
        if (!best || e.at > best.at) best = { faction: e.faction, at: e.at };
      }
    }
    if (!best) return null;
    return (FACTIONS as readonly string[]).includes(best.faction)
      ? (best.faction as Faction)
      : null;
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
    // BOUNDS FIRST. `splice` takes a negative index from the END, so a stale
    // or mistyped -1 silently deleted the LAST row and debited the wrong
    // faction — on a console whose entire job is correcting a bogus score.
    if (!Number.isInteger(index) || index < 0 || index >= board.length) return;

    const removed = board.splice(index, 1)[0];
    if (removed?.faction) {
      this.store.factionTotals[removed.faction] = Math.max(
        0,
        (this.store.factionTotals[removed.faction] ?? 0) - removed.score
      );
    }
    this.store.boards[game] = board;
    // `plays` was left alone, so every correction drifted the play counts
    // further from the boards they are reported next to.
    this.store.plays[game] = Math.max(0, (this.store.plays[game] ?? 1) - 1);
    this.save();
  }

  clearGame(game: GameId): void {
    this.store.boards[game] = [];
    this.save();
  }

  clearAll(): void {
    this.store = emptyStore();
    // The remembered faction lives under its own key and survived a reset, so
    // after a between-days wipe a returning player still skipped the picker
    // and credited points to a faction the freshly-empty standings showed as
    // new. A reset that leaves state behind is not a reset.
    try {
      localStorage.removeItem(FACTION_KEY);
    } catch {
      /* private mode — nothing was persisted anyway */
    }
    this.save();
  }

  /** JSON dump for the post-event writeup. */
  exportJSON(): string {
    return JSON.stringify(this.store, null, 2);
  }
}

export const leaderboard = new Leaderboard();
