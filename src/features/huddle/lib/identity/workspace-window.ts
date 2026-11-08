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

/**
 * Should a fired reminder/alarm be added to the end of this huddle's thread?
 * WHY: the reminder poll asks for EVERY reminder ever fired in the huddle (cursor starts at 0) and appends any
 * it can't find in the store. With paged history the old ones are simply not loaded yet, so they were appended
 * to the BOTTOM as if new (owner screenshot 2026-11-08: Aug/Sep alarms under today's messages). A reminder that
 * fired before the oldest loaded message of this huddle is already part of the stored history and arrives with
 * the older pages; only add ones at or after that point. A huddle with nothing loaded takes everything.
 */
export function shouldAppendReminder(
  firedMs: number,
  huddleMessages: readonly WindowableMessage[],
): boolean {
  let oldest = Infinity;
  for (const m of huddleMessages) {
    const t = tsOf(m);
    if (t > 0 && t < oldest) oldest = t;
  }
  if (oldest === Infinity) return true;
  return firedMs >= oldest;
}

/**
 * The reason shown when the history load fails, instead of a bare "server error" for everything.
 * WHY: the owner's app showed "Couldn't load your message history (server error)" while the phone's browser
 * loaded fine (2026-11-08); every failure, including a rejected sign-in, carried the same words, so the
 * cause could not be told apart. Owner approved showing the real reason (option A).
 */
export function describeLoadFailure(e: unknown): string {
  const raw = (e instanceof Error ? e.message : typeof e === "string" ? e : "").replace(/\s+/g, " ").trim();
  const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
  const s = `${code} ${raw}`;
  let label = "server error";
  if (/ERR_JWT_EXPIRED|"exp" claim|token.*expired|expired.*token/i.test(s)) label = "sign-in expired";
  else if (/ERR_JW[STK]|ERR_JWKS_NO_MATCHING|"aud" claim|"iss" claim|"nbf" claim|signature verification|oid\/sub|Invalid Compact JWS/i.test(s))
    label = "sign-in rejected";
  else if (/client id not configured|ENTRA_TENANT_ID/i.test(s)) label = "server sign-in setup";
  else if (/JWKS|Failed to fetch|fetch failed|NetworkError|Load failed|timed? ?out|ECONN|ETIMEDOUT|ENOTFOUND/i.test(s))
    label = "couldn't reach the server";
  else if (/\b50[234]\b|Service Unavailable|Bad Gateway|Gateway Time/i.test(s)) label = "server unavailable";
  if (!raw) return label;
  const detail = raw.length > 90 ? `${raw.slice(0, 87)}…` : raw;
  return `${label}: ${detail}`;
}
