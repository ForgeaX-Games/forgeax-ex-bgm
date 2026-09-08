/**
 * The workspace follows the Studio's active project — this plugin never asks
 * the user to pick a game.
 *
 * Three layers, in order of precedence at boot:
 *   1. `?slug=` on the iframe URL, which the shell rewrites when the active
 *      project changes (a rewrite remounts the frame, so this is authoritative
 *      whenever it is present);
 *   2. `GET /api/projects/active`, for the case where the frame was
 *      created before a project was active, or without the param;
 *   3. the `projects.active.changed` stream, which keeps a long-lived
 *      frame in sync when the shell does not remount it.
 */

const ACTIVE_GAME_URL = '/api/projects/active';
const ACTIVE_GAME_STREAM_URL = '/api/events/stream?topic=projects.active.changed';

/** The shell passes `slug=default` when nothing is open; that is not a game. */
export function normalizeSlug(raw: string | null | undefined): string {
  const slug = (raw ?? '').trim();
  return !slug || slug === 'default' ? '' : slug;
}

export function activeGameFromUrl(search: string = window.location.search): string {
  return normalizeSlug(new URLSearchParams(search).get('slug'));
}

export async function fetchActiveGameSlug(fetcher: typeof fetch = fetch): Promise<string> {
  try {
    const response = await fetcher(ACTIVE_GAME_URL);
    if (!response.ok) return '';
    const payload = (await response.json()) as { activeSlug?: unknown };
    return typeof payload.activeSlug === 'string' ? normalizeSlug(payload.activeSlug) : '';
  } catch {
    return '';
  }
}

/** URL first so a freshly remounted frame never waits on the network. */
export async function resolveActiveGameSlug(fetcher: typeof fetch = fetch): Promise<string> {
  return activeGameFromUrl() || await fetchActiveGameSlug(fetcher);
}

export function activeGameFromEnvelope(raw: string): string | null {
  try {
    const envelope = JSON.parse(raw) as { payload?: { activeSlug?: unknown } };
    const activeSlug = envelope.payload?.activeSlug;
    if (activeSlug === null) return '';
    return typeof activeSlug === 'string' ? normalizeSlug(activeSlug) : null;
  } catch {
    return null;
  }
}

/**
 * Fires only on an actual change, so a reconnect (which re-reads the
 * authority) cannot reset a workspace the user is mid-edit on.
 */
export function subscribeActiveGame(
  current: () => string,
  onChange: (slug: string) => void,
): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const source = new EventSource(ACTIVE_GAME_STREAM_URL);
  const apply = (slug: string | null): void => {
    if (slug === null || slug === current()) return;
    onChange(slug);
  };
  const onEvent = (event: Event): void => {
    apply(activeGameFromEnvelope((event as MessageEvent<string>).data));
  };
  // The stream has no replay cursor: re-read the authority on every connect so
  // a switch that happened while disconnected is not missed.
  const onOpen = (): void => {
    void fetchActiveGameSlug().then((slug) => {
      if (slug) apply(slug);
    });
  };
  source.addEventListener('open', onOpen);
  source.addEventListener('event', onEvent);
  source.addEventListener('message', onEvent);
  return () => {
    source.removeEventListener('open', onOpen);
    source.removeEventListener('event', onEvent);
    source.removeEventListener('message', onEvent);
    source.close();
  };
}
