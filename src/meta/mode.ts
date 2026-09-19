/**
 * How many people are playing this turn, when the machine should not guess.
 *
 * WHAT THE MACHINE ALREADY KNOWS. Everything about the number of players is
 * detected: the menu tiles carry a seat badge, the waiting screen names the
 * capacity, the countdown re-resolves the roster every frame and offers a
 * late-arriving friend a way in. Two people who step up together get a versus
 * round with no decision to make and no time spent making one.
 *
 * WHAT IT CANNOT KNOW. Two friends standing side by side, where only ONE of
 * them wants to play and the other is watching from inside the play zone. To
 * the camera that is a versus round; to them it is a solo run being ruined by
 * a spectator holding half the screen. The only fix available to them today is
 * folklore — "step back off the tape" — which nothing on screen says.
 *
 * So the choice that is worth a screen is not "single player or multiplayer".
 * It is JUST ME, and it is the only mode that changes what the round does:
 * `versus` and `party` are what the auto-detection already produces.
 *
 * Kept in `meta/` and free of every DOM import so `games/base.ts` can read it
 * without pulling a screen in behind it.
 */

/**
 * `solo` caps the round at one seat however many bodies are in frame.
 * `open` is the auto-detected behaviour: versus for a two-seat game, the whole
 * group for a party one.
 */
export type PlayMode = 'solo' | 'open';

let pending: PlayMode | null = null;

/** Set by the mode screen, consumed by the game it routed to. */
export function setPlayMode(mode: PlayMode | null): void {
  pending = mode;
}

/**
 * Read and clear.
 *
 * Cleared on read so a choice can never outlive the turn it was made for: a
 * player who picks JUST ME and then walks away must not hand the next person
 * a solo round they never asked for.
 */
export function takePlayMode(): PlayMode | null {
  const m = pending;
  pending = null;
  return m;
}
