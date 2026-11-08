// WHAT:       Pure helpers for loading chat history in pages instead of all at once: which messages the
//             app downloads on open (the recent window), and how a save from a client that holds only part
//             of the history merges into the full stored history without losing anything.
// WHY:        The workspace blob holds EVERY message since 2026-07-10 (3,730 messages, 2.55 MB on
//             2026-11-07) and the app downloaded and parsed all of it on every open. After a deploy the
//             owner sat on "Loading your message history…" (2026-11-07). Owner chose: "loading some amount
//             and as i scroll far enough up for it to load more and more as I go indefinitely".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/workspace-window.test.ts; .claude/actions.md ACT:history-load-slow.

export interface WindowableMessage {
  id: string;
  huddleId?: string;
  ts?: number;
}

/** Days of history every huddle gets on open. */
export const RECENT_DAYS = 30;
/** Every huddle also keeps at least its newest N messages, so a quiet thread never opens empty. */
export const MIN_PER_HUDDLE = 40;
/** Messages per scroll-up page fetched from the server. */
export const OLDER_PAGE = 60;

const tsOf = (m: WindowableMessage) => (typeof m.ts === "number" && Number.isFinite(m.ts) ? m.ts : 0);

/** The messages sent to the app on open: last `days` days, plus the newest `minPerHuddle` of every huddle. */
export function windowMessages<M extends WindowableMessage>(
  messages: readonly M[],
  nowMs: number,
  days = RECENT_DAYS,
  minPerHuddle = MIN_PER_HUDDLE,
): { messages: M[]; olderCount: number } {
  const cutoff = nowMs - days * 86_400_000;
  const keep = new Set<string>();
  const byHuddle = new Map<string, M[]>();
  for (const m of messages) {
    if (!m || typeof m.id !== "string") continue;
    if (tsOf(m) >= cutoff) keep.add(m.id);
    const h = String(m.huddleId ?? "");
    const list = byHuddle.get(h);
    if (list) list.push(m);
    else byHuddle.set(h, [m]);
  }
  for (const list of byHuddle.values()) {
    const newest = list.slice().sort((a, b) => tsOf(b) - tsOf(a)).slice(0, minPerHuddle);
    for (const m of newest) keep.add(m.id);
  }
  const out = messages.filter((m) => m && keep.has(m.id));
  return { messages: out, olderCount: messages.length - out.length };
}

/**
 * Merge a save from a client into the stored history. UNION BY ID, ORDER PRESERVED: every stored message
 * survives in its stored position; a message the client also sent replaces the stored copy in place (it may
 * have been edited, e.g. a streamed reply); messages new to the server are appended in the client's order.
 * Safe because the client never deletes messages (store.ts only appends or upserts), so "absent from the
 * client" always means "not loaded yet", never "deleted".
 */
export function mergeMessages<M extends WindowableMessage>(stored: readonly M[], incoming: readonly M[]): M[] {
  const incomingById = new Map<string, M>();
  for (const m of incoming) if (m && typeof m.id === "string") incomingById.set(m.id, m);
  const seen = new Set<string>();
  const out: M[] = [];
  for (const m of stored) {
    if (!m || typeof m.id !== "string" || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(incomingById.get(m.id) ?? m);
  }
  for (const m of incoming) {
    if (!m || typeof m.id !== "string" || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** One page of a huddle's history older than `beforeTs`, oldest first, plus whether more remain. */
export function olderPage<M extends WindowableMessage>(
  messages: readonly M[],
  huddleId: string,
  beforeTs: number,
  limit = OLDER_PAGE,
): { messages: M[]; hasMore: boolean } {
  const older = messages
    .filter((m) => m && String(m.huddleId ?? "") === huddleId && tsOf(m) < beforeTs)
    .sort((a, b) => tsOf(b) - tsOf(a));
  const page = older.slice(0, limit).reverse();
  return { messages: page, hasMore: older.length > limit };
}

/** Insert server-fetched older messages into the client list: skip ids already present. */
export function prependOlder<M extends WindowableMessage>(current: readonly M[], older: readonly M[]): M[] {
  const have = new Set(current.map((m) => m.id));
  const fresh = older.filter((m) => m && typeof m.id === "string" && !have.has(m.id));
  if (!fresh.length) return current as M[];
  // Older pages go in FRONT (oldest first); the existing list keeps its exact order.
  return [...fresh.slice().sort((a, b) => tsOf(a) - tsOf(b)), ...current];
}
