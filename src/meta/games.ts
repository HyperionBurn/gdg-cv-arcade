/**
 * One identity per game, in one place.
 *
 * WHY THIS EXISTS: the menu tiles picked their colours by rotating through the
 * palette in array order, and each game picked its own `config.color`
 * independently. They disagreed for FIVE of the seven games — you hovered the
 * yellow tile and got a blue game:
 *
 *   67 Speed    menu blue   -> game red
 *   Fruit Ninja menu red    -> game green
 *   Balloon Pop menu green  -> game blue
 *   Runner      menu yellow -> game blue
 *   Rhythm      menu red    -> game yellow
 *
 * Individually invisible; together it was the single clearest "seven projects,
 * not one product" tell in an app that otherwise obsesses over consistency.
 * A player's colour memory is the cheapest navigation aid a kiosk has, and it
 * only works if the colour survives the transition.
 *
 * The menu, the attract rail, the countdown numeral and the in-game HUD all
 * read from here. Changing a game's colour is now one edit.
 *
 * ASSIGNMENT: the four brand colours spread across seven games, with the two
 * strongest games (the ones in the core three) taking the two loudest colours.
 * Duplicates are fine — no two tiles that share a colour sit adjacent in the
 * menu grid, and a game is never on screen next to another game.
 */

import { COLORS } from '../shell/theme';
import type { GameId } from './leaderboard';

export const GAME_COLORS: Record<GameId, string> = {
  /** The queue eater. Red: loudest colour for the loudest game. */
  sixtyseven: COLORS.red,
  /** The crowd-puller. Green reads well against four flat fruit colours. */
  fruitninja: COLORS.green,
  /** The accessible one. Blue is the calmest of the four. */
  balloonpop: COLORS.blue,
  /** Green = go, which is literally the mechanic. */
  redlight: COLORS.green,
  /** Blue, matching the match-quality signal. */
  posematch: COLORS.blue,
  /** Yellow: the only game where the chrome colour never enters the playfield. */
  runner: COLORS.yellow,
  /** Yellow chrome, blue/red playfield — same split as the Runner. */
  rhythm: COLORS.yellow,
};

export function gameColor(id: GameId): string {
  return GAME_COLORS[id] ?? COLORS.blue;
}

/**
 * How many people each game seats — the MENU's copy of it.
 *
 * WHY A SECOND COPY EXISTS AT ALL. The authority is `config.maxPlayers` inside
 * each game class, and the menu cannot read it: importing seven game modules
 * (and through them Three.js, the pose library and the beatmap generator) to
 * put a two-character badge on a tile would pull the entire app into the first
 * screen a visitor sees, on a laptop that has to hold 30fps of inference.
 *
 * So this is a deliberate duplicate, and `tests/versus.test.ts` asserts every
 * entry against the real config. Drift fails the build, not the stall.
 *
 * WHY THE MENU NEEDS IT. Six of the seven games hold two or more people and
 * nothing on the menu said so, so the most-requested feature on the roster was
 * also the least discoverable one. A pair standing in the queue deciding what
 * to play are looking at exactly this screen.
 */
export const GAME_SEATS: Record<GameId, number> = {
  sixtyseven: 2,
  fruitninja: 2,
  balloonpop: 2,
  /** Six lanes. The only game on the roster that takes a whole group. */
  redlight: 6,
  posematch: 2,
  /** One track, one camera, one runner. See PLAN.md and runner-world.ts. */
  runner: 1,
  rhythm: 2,
};

/** `null` for a solo game — the menu draws nothing rather than a "1P" badge. */
export function seatBadge(id: GameId): string | null {
  const n = GAME_SEATS[id] ?? 1;
  return n > 1 ? `1-${n}P` : null;
}
