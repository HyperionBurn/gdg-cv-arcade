/**
 * IS THIS BROWSER GOING TO LET US WRITE ANYTHING DOWN?
 *
 * Three stores persist — tuning, the bracket and the leaderboard — and each
 * one now raises `saveFailed` when a write is refused. That is the right
 * signal, but it arrives at the wrong time: nothing can notice until something
 * has already been lost. Tuning notices on the first slider move, the bracket
 * on the first reported match, the board on the first submitted score.
 *
 * The failure this is actually guarding against is not a disk filling up
 * mid-afternoon. It is a browser profile that was never going to allow storage
 * in the first place — a locked-down or managed profile, or a window somebody
 * opened private without thinking about it. That condition is present from the
 * moment the app loads, and it is trivially fixable at 9am (open a normal
 * window) and not fixable at 3pm without throwing away the morning.
 *
 * So: probe once at boot. A read is not enough, because a private-mode
 * localStorage reads back fine and only throws on write — which is exactly the
 * case that would otherwise stay hidden until the first player finished.
 *
 * ONE PROBE ANSWERS FOR ALL THREE STORES. They share a single localStorage,
 * which is per-origin, so a refusal is a property of the origin and not of any
 * one key. Probing each store's own key separately would be three ways of
 * asking the same question.
 */

/** A key nothing else uses, namespaced so a leftover is obviously ours. */
const PROBE_KEY = 'gdg-arcade:probe';

/**
 * True if a write lands and can be read back.
 *
 * Reads back rather than trusting a silent `setItem`, because the interesting
 * failure mode is storage that ACCEPTS a write and discards it — some
 * locked-down profiles behave that way, and a probe that only checked for a
 * thrown exception would call that healthy.
 *
 * Never throws. A probe that took the kiosk down would be worse than the
 * problem it is looking for.
 */
export function probeStorage(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const token = String(Date.now());
    localStorage.setItem(PROBE_KEY, token);
    const back = localStorage.getItem(PROBE_KEY);
    localStorage.removeItem(PROBE_KEY);
    return back === token;
  } catch {
    return false;
  }
}
