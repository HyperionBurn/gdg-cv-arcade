/**
 * Census: count what the app DRAWS and PLAYS, rather than asserting it.
 *
 *   await window.__arcade.census(['sixtyseven', 'fruitninja'])   // batch 1
 *   await window.__arcade.census(['balloonpop', 'redlight'])     // batch 2
 *   window.__arcade.censusReport()                               // the totals
 *
 * This is the highest-yield probe in the repo and it has now been written by
 * hand twice in a dev-console one-liner, so it lives here.
 *
 * ── Why counting beats asserting ─────────────────────────────────────────
 *
 * Every test in `tests/` asks "when X happens, is the result right?". None of
 * them asks "does X ever happen?". Those are different questions, and the
 * second one found five real bugs in a single sweep on the 20th: a duck input
 * no harness had ever used, a `<MAX SPEED>` banner whose streak cap sat above
 * anything a round could reach, a combo clip keyed to a chain length that does
 * not occur, and two strings a replay always covered. All five had passing
 * tests. The tests exercised the mechanism; nothing asked whether the trigger
 * was reachable.
 *
 * So: run the roster, count every `fillText` and every cue id, then read the
 * ZEROES. A string that never draws is a mechanic nobody is testing.
 *
 * ── Two traps this file exists to have already solved ────────────────────
 *
 * 1. PATCH THE PROTOTYPE, NOT THE MODULE. The first attempt patched a
 *    dynamically imported `PopupLayer` and counted zero of everything — the
 *    second-instance trap documented on `__arcade` in main.ts, hit again.
 *    `CanvasRenderingContext2D.prototype` is the real render path no matter
 *    what the module graph is doing.
 *
 * 2. TAKE `audio` FROM THE HOST. Same trap, other half. A dynamic import of
 *    `engine/audio` can hand back a second `AudioEngine` whose `play` the app
 *    never calls, and the counts come back empty in a way that looks like
 *    silence rather than like a bug in the probe. `host.audio` is the
 *    instance main.ts constructed, which is the only one that matters.
 *
 * ── Why the counts accumulate across calls ───────────────────────────────
 *
 * A full-roster sweep runs well past the 45s cap on a single dev-console
 * evaluation, so it has to be split. Rather than make the caller stitch
 * partial results together — which is where the hand-written version got
 * fiddly — the store is module-level and every call adds to it. Call
 * `resetCensus()` to start a fresh sweep.
 */

import { runTurn } from './turn';

export interface CensusReport {
  /** Every distinct string drawn, and how many times. */
  strings: Record<string, number>;
  /** Every distinct cue id played, and how many times. */
  cues: Record<string, number>;
  /** The subset of `strings` shaped like a banner: `<LIKE THIS>`. */
  bracketed: string[];
  /** Which games have been swept into this report so far. */
  swept: string[];
  totalDraws: number;
  totalCues: number;
  /** True if the string store hit `MAX_KEYS` and stopped taking new keys. */
  truncated: boolean;
  capturedAt: string;
}

interface CensusHost {
  audio: { play: (...args: never[]) => unknown };
}

/**
 * A full sweep produced ~5000 distinct strings, nearly all of them scores and
 * clock readings. The cap is there so a probe left running by accident cannot
 * grow without bound; it is far enough above the observed figure that hitting
 * it means something is wrong, which is why `truncated` is reported rather
 * than silently swallowed.
 */
const MAX_KEYS = 20000;

interface CensusStore {
  strings: Map<string, number>;
  cues: Map<string, number>;
  swept: string[];
  truncated: boolean;
}

/**
 * THE STORE HANGS OFF `globalThis`, NOT OFF THE MODULE, AND THAT IS THE POINT.
 *
 * This file is the one most likely to be edited in the middle of the sweep it
 * is running — that is what a probe is for. Under Vite, saving it appends an
 * HMR timestamp to its URL, so the next `import()` builds a SECOND module
 * with its own module-level bindings. A batch-1 count collected before the
 * edit would then vanish, and `censusReport()` would answer with an empty
 * store rather than an error: the failure looks like 'nothing draws', which is
 * the exact wrong conclusion for a probe whose whole job is reading zeroes.
 *
 * Keyed on `globalThis`, every instance of this module shares one store.
 */
const STORE_KEY = '__arcadeCensus';

function store(): CensusStore {
  const g = globalThis as unknown as Record<string, CensusStore | undefined>;
  let live = g[STORE_KEY];
  if (!live) {
    live = { strings: new Map(), cues: new Map(), swept: [], truncated: false };
    g[STORE_KEY] = live;
  }
  return live;
}

function bump(counts: Map<string, number>, key: string): void {
  const seen = counts.get(key);
  if (seen !== undefined) {
    counts.set(key, seen + 1);
    return;
  }
  if (counts.size >= MAX_KEYS) {
    store().truncated = true;
    return;
  }
  counts.set(key, 1);
}

/** Banner-shaped: the strings the games draw as headline words. */
export function isBracketed(text: string): boolean {
  return text.length > 2 && text.startsWith('<') && text.endsWith('>');
}

/**
 * Run the turn sweep with counting installed, adding to whatever previous
 * calls collected. The patches are removed in a `finally` — a probe that
 * leaves a patched `fillText` behind slows every later frame and, worse,
 * keeps counting during manual play, which quietly poisons the report.
 */
export async function runCensus(host: CensusHost, only?: string[]): Promise<CensusReport> {
  const proto = CanvasRenderingContext2D.prototype;
  const origFill = proto.fillText;
  const origPlay = host.audio.play;

  const live = store();
  proto.fillText = function (this: CanvasRenderingContext2D, text: string | number, ...rest: never[]) {
    bump(live.strings, String(text));
    return (origFill as (...a: never[]) => void).call(this, text as never, ...rest);
  } as typeof proto.fillText;

  host.audio.play = function (this: unknown, id: string, ...rest: never[]) {
    bump(live.cues, String(id));
    return (origPlay as (...a: never[]) => unknown).call(this, id as never, ...rest);
  } as typeof host.audio.play;

  try {
    await runTurn(host as never, only);
  } finally {
    proto.fillText = origFill;
    host.audio.play = origPlay;
  }

  for (const game of only ?? ['<all>']) {
    if (!live.swept.includes(game)) live.swept.push(game);
  }
  return censusReport();
}

export function censusReport(): CensusReport {
  const live = store();
  let totalDraws = 0;
  for (const n of live.strings.values()) totalDraws += n;
  let totalCues = 0;
  for (const n of live.cues.values()) totalCues += n;

  return {
    strings: Object.fromEntries([...live.strings.entries()].sort((a, b) => b[1] - a[1])),
    cues: Object.fromEntries([...live.cues.entries()].sort((a, b) => b[1] - a[1])),
    bracketed: [...live.strings.keys()].filter(isBracketed).sort(),
    swept: [...live.swept],
    totalDraws,
    totalCues,
    truncated: live.truncated,
    capturedAt: new Date().toISOString(),
  };
}

export function resetCensus(): void {
  const live = store();
  live.strings.clear();
  live.cues.clear();
  live.swept.length = 0;
  live.truncated = false;
}

/**
 * The census is only useful next to the static list of what COULD draw, and
 * that list lives in `src/`, which a browser cannot read. So the report is
 * meant to be written to `tests/fixtures/census.json`, where
 * `tests/census.test.ts` diffs it against every bracketed literal in the
 * source and demands a reason for each one that never drew.
 *
 * Printing it via `copy()` rather than saving a file keeps the probe free of
 * a download permission prompt mid-sweep.
 */
export function formatCensus(report: CensusReport): string {
  const lines = [
    `census: ${report.totalDraws} draws (${Object.keys(report.strings).length} distinct), ` +
      `${report.totalCues} cues (${Object.keys(report.cues).length} distinct)`,
    `bracketed: ${report.bracketed.length}`,
    `swept: ${report.swept.join(', ')}`,
  ];
  if (report.truncated) lines.push('TRUNCATED — string store hit its cap, counts are incomplete');
  // WHAT GOES IN THE FIXTURE IS THE REDUCED SHAPE, NOT THIS WHOLE REPORT.
  // `strings` holds ~4000 keys, nearly all of them scores and clock readings,
  // and checking that into git would bury the 40-odd lines anybody actually
  // reviews. `tests/census.test.ts` only reads the banners and the cues.
  lines.push(
    '',
    'For tests/fixtures/census.json, record TWO runs (populated board and',
    'cleared board) and keep only the banners:',
    '  copy(JSON.stringify({ bracketed: __arcade.censusReport().bracketed }, null, 2))',
  );
  return lines.join('\n');
}
