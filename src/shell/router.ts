/**
 * Screen router.
 *
 * One screen active at a time, sharing the single canvas and the single camera
 * stream. Screens are constructed lazily and disposed on exit so a game's
 * particle pools and gesture state don't linger between players.
 */

import type { Screen } from './screen';

export type ScreenFactory = () => Screen;

/**
 * THE MARSHAL'S NUMBER KEYS, WHICH THE DAY-OF CARD PRINTS.
 *
 * README's Keys table is taped to the table and read by somebody who is
 * talking to a queue. It lists `0` attract, `1` rig check, `2`-`8` a game
 * each — and for a long time did not mention `9` at all, which is the one that
 * gets you back to the MENU. That is the key you want when a game is behaving
 * oddly and you would rather not F5 the whole stall.
 *
 * Here rather than in `main.ts` for the same reason the camera backoff moved
 * to core/camera.ts: main.ts boots the app on evaluation, so nothing that
 * lives there can be checked by a test, and a printed card nobody can verify
 * is a card that drifts. `tests/keys.test.ts` compares this map against the
 * table in both directions.
 *
 * Bare number keys only jump from attract or the menu; mid-round they need
 * SHIFT, so a bag on the keyboard cannot end somebody's turn.
 */
export const SCREEN_KEYS: Readonly<Record<string, string>> = {
  '0': 'attract',
  '1': 'rigcheck',
  '2': 'sixtyseven',
  '3': 'fruitninja',
  '4': 'balloonpop',
  '5': 'redlight',
  '6': 'posematch',
  '7': 'runner',
  '8': 'rhythm',
  '9': 'menu',
};

class Router {
  private factories = new Map<string, ScreenFactory>();
  private current: Screen | null = null;
  private currentId = '';
  private overlay: HTMLElement | null = null;
  private switching = false;
  private listeners = new Set<(id: string) => void>();

  attach(overlay: HTMLElement): void {
    this.overlay = overlay;
  }

  register(id: string, factory: ScreenFactory): void {
    this.factories.set(id, factory);
  }

  get activeId(): string {
    return this.currentId;
  }

  get active(): Screen | null {
    return this.current;
  }

  subscribe(fn: (id: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }

  /** Whether a screen exists yet. Lets callers degrade instead of dead-ending. */
  has(id: string): boolean {
    return this.factories.has(id);
  }

  /** First registered id from the list, or null. Used for graceful fallbacks. */
  firstAvailable(...ids: string[]): string | null {
    for (const id of ids) if (this.factories.has(id)) return id;
    return null;
  }

  async go(id: string): Promise<void> {
    if (this.switching || id === this.currentId) return;
    const factory = this.factories.get(id);
    if (!factory) {
      console.warn(`[router] unknown screen: ${id}`);
      return;
    }

    this.switching = true;
    try {
      this.current?.unmount?.();
      this.overlay?.replaceChildren();

      const screen = factory();
      screen.onExit = (next) => void this.go(next);

      this.current = screen;
      this.currentId = id;

      if (this.overlay) await screen.mount?.(this.overlay);

      for (const fn of this.listeners) fn(id);
    } catch (err) {
      console.error(`[router] failed to mount "${id}"`, err);
    } finally {
      this.switching = false;
    }
  }
}

export const router = new Router();
