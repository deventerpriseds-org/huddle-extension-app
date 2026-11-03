// WHAT:       Pure, network-free half of the READ-ONLY inbox tools `search_email` and `read_email`:
//             the shared tool schemas, the Graph query builder, the body cleaner, the time formatter
//             and the Graph error mapper. The network half (fetch + mailbox resolution) lives beside
//             the existing app-only client in graph-email.server.ts.
// WHY:        Agents could draft and reply, and the inbound watch pushes new mail, but nothing could
//             answer "Did Professor Lee email me about the 702 deadline?" on demand.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/BUILD-inbox-read.md, scripts/inbox-read.test.ts
//
// READ-ONLY BY CONSTRUCTION: nothing in this file or its network half issues anything but a GET.
// The mailbox is never a tool parameter: it is resolved from the caller by the dispatcher, so the
// model cannot point these tools at someone else's mailbox.

export const SEARCH_EMAIL_TOOL_NAME = "search_email";
export const READ_EMAIL_TOOL_NAME = "read_email";
export const INBOX_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  SEARCH_EMAIL_TOOL_NAME,
  READ_EMAIL_TOOL_NAME,
]);

export const SEARCH_EMAIL_DEFAULT_TOP = 10;
export const SEARCH_EMAIL_MAX_TOP = 25;
/** With no free-text query, a $filter search is bounded to this many days back when `since` is absent. */
export const SEARCH_EMAIL_DEFAULT_LOOKBACK_DAYS = 90;
export const READ_EMAIL_DEFAULT_MAX_CHARS = 4000;
export const READ_EMAIL_HARD_MAX_CHARS = 12000;
export const SEARCH_PREVIEW_MAX_CHARS = 240;

export const MAIL_READ_CONSENT_ERROR =
  "Reading email needs the Microsoft Graph app to hold the Mail.Read application permission with admin consent. " +
  "It is not granted for this mailbox yet, so the inbox cannot be read until an admin grants it. Nothing in the app needs to change.";

/** Shared schema (Responses/Chat shape). The Realtime path strips `strict` via toRealtimeTool. */
export const SEARCH_EMAIL_TOOL = {
  type: "function" as const,
  name: SEARCH_EMAIL_TOOL_NAME,
  description:
    "Search the user's OWN Outlook mailbox (read-only). Use for 'did X email me', 'any mail about Y', " +
    "'what came in from Z today', 'unread email'. Returns matching messages (id, subject, sender, received time in " +
    "the user's time zone, short preview). Call read_email with an id to read one in full. Reads REAL mail — never " +
    "answer from memory. Never sends anything.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "Free-text words to look for in subject/body/sender (e.g. '702 deadline'). Optional.",
      },
      from: {
        type: "string",
        description: "Sender email address or name (e.g. 'lee@school.edu' or 'Professor Lee'). Optional.",
      },
      since: {
        type: "string",
        description: "Only mail received on/after this ISO date or datetime (e.g. 2026-11-03). Optional.",
      },
      until: {
        type: "string",
        description: "Only mail received on/before this ISO date or datetime. Optional.",
      },
      unread_only: { type: "boolean", description: "Only unread messages. Optional." },
      top: {
        type: "number",
        description: `How many results (1-${SEARCH_EMAIL_MAX_TOP}, default ${SEARCH_EMAIL_DEFAULT_TOP}).`,
      },
    },
    required: [] as string[],
  },
  strict: false,
};

export const READ_EMAIL_TOOL = {
  type: "function" as const,
  name: READ_EMAIL_TOOL_NAME,
  description:
    "Read ONE message from the user's OWN Outlook mailbox by id (an id returned by search_email). Returns subject, " +
    "sender, received time in the user's time zone, and the body as cleaned text (long bodies are truncated). " +
    "Read-only; never sends anything.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      id: { type: "string", description: "The message id from search_email." },
      max_chars: {
        type: "number",
        description: `Optional cap on body length (default ${READ_EMAIL_DEFAULT_MAX_CHARS}, max ${READ_EMAIL_HARD_MAX_CHARS}).`,
      },
    },
    required: ["id"],
  },
  strict: false,
};

export interface SearchEmailArgs {
  query?: string;
  from?: string;
  since?: string;
  until?: string;
  unreadOnly?: boolean;
  top?: number;
}

/** Normalise the model's loose args (snake_case, strings for numbers/booleans) into SearchEmailArgs. */
export function normalizeSearchArgs(a: Record<string, unknown> | undefined): SearchEmailArgs {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const rawUnread = a?.unread_only ?? a?.unreadOnly;
  const unreadOnly = rawUnread === true || rawUnread === "true";
  const topNum = Number(a?.top);
  return {
    query: s(a?.query),
    from: s(a?.from),
    since: s(a?.since),
    until: s(a?.until),
    unreadOnly,
    top: Number.isFinite(topNum) ? topNum : undefined,
  };
}

export function clampTop(top: number | undefined): number {
  if (top === undefined || !Number.isFinite(top)) return SEARCH_EMAIL_DEFAULT_TOP;
  return Math.min(Math.max(Math.trunc(top), 1), SEARCH_EMAIL_MAX_TOP);
}

/** Turn an ISO date ("2026-11-03") or datetime into a full UTC instant string Graph accepts.
 *  `endOfDay` widens a bare date to 23:59:59 so `until: 2026-11-03` includes that day. Returns
 *  undefined for anything that does not parse, so a bad date is dropped rather than sent raw. */
export function toGraphInstant(raw: string | undefined, endOfDay = false): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  const isBareDate = /^\d{4}-\d{2}-\d{2}$/.test(t);
  const candidate = isBareDate ? `${t}T${endOfDay ? "23:59:59" : "00:00:00"}Z` : t;
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** OData string literal: single quotes are doubled. An unescaped `'` would end the literal and let
 *  the rest of the value be parsed as filter syntax. */
export function odataQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** KQL phrase for Graph $search: double quotes and backslashes are stripped (Graph's $search value is
 *  itself wrapped in double quotes, so an inner `"` would end it). */
export function kqlPhrase(v: string): string {
  return v.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}

export function looksLikeAddress(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

export interface BuiltSearch {
  /** "search" = Graph $search (KQL), "filter" = Graph $filter + $orderby. */
  mode: "search" | "filter";
  /** Query string WITHOUT the leading "?", with OData $-params kept literal. */
  qs: string;
  /** Applied after the response when Graph cannot do it in the chosen mode (unread with $search). */
  postFilter: { unreadOnly: boolean };
  top: number;
}

const SEARCH_SELECT =
  "id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink,conversationId";

/**
 * Build the Graph query for /users/{mailbox}/messages.
 *
 * Graph does not let $search and $filter be combined on messages, and $search cannot $orderby. So:
 *  - free text, or a sender NAME (not an address)  -> $search with KQL (`from:`, `received>=`, `received<=`
 *    are documented searchable properties). Unread cannot be expressed there, so it is post-filtered.
 *  - otherwise (address, dates, unread only)        -> $filter + $orderby receivedDateTime desc. Graph
 *    requires an $orderby property to appear first in $filter, so receivedDateTime always leads,
 *    defaulting to SEARCH_EMAIL_DEFAULT_LOOKBACK_DAYS back.
 * Built by hand like listInboxMessagesSince / calendarView: URLSearchParams would write "%24filter".
 */
export function buildInboxSearchQuery(args: SearchEmailArgs, nowMs = Date.now()): BuiltSearch {
  const top = clampTop(args.top);
  const since = toGraphInstant(args.since);
  const until = toGraphInstant(args.until, true);
  const from = args.from?.trim();
  const fromIsAddress = !!from && looksLikeAddress(from);
  const useSearch = !!args.query || (!!from && !fromIsAddress);

  if (useSearch) {
    const parts: string[] = [];
    if (args.query) {
      const q = kqlPhrase(args.query);
      if (q) parts.push(q);
    }
    if (from) {
      const f = kqlPhrase(from);
      if (f) parts.push(fromIsAddress ? `from:${f}` : `from:'${f.replace(/'/g, "")}'`);
    }
    if (since) parts.push(`received>=${since.slice(0, 10)}`);
    if (until) parts.push(`received<=${until.slice(0, 10)}`);
    const kql = parts.join(" AND ");
    // Over-fetch when unread must be post-filtered, so "top 5 unread" still finds up to 5.
    const fetchTop = args.unreadOnly ? Math.min(top * 3, 50) : top;
    const qs =
      `$search=${encodeURIComponent(`"${kql}"`)}` +
      `&$top=${fetchTop}` +
      `&$select=${encodeURIComponent(SEARCH_SELECT)}`;
    return { mode: "search", qs, postFilter: { unreadOnly: !!args.unreadOnly }, top };
  }

  const lower =
    since ??
    new Date(nowMs - SEARCH_EMAIL_DEFAULT_LOOKBACK_DAYS * 86400_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  const clauses = [`receivedDateTime ge ${lower}`];
  if (until) clauses.push(`receivedDateTime le ${until}`);
  if (from && fromIsAddress) clauses.push(`from/emailAddress/address eq ${odataQuote(from.toLowerCase())}`);
  if (args.unreadOnly) clauses.push("isRead eq false");
  const qs =
    `$filter=${encodeURIComponent(clauses.join(" and "))}` +
    `&$orderby=${encodeURIComponent("receivedDateTime desc")}` +
    `&$top=${top}` +
    `&$select=${encodeURIComponent(SEARCH_SELECT)}`;
  return { mode: "filter", qs, postFilter: { unreadOnly: false }, top };
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k.startsWith("#x")) {
      const n = parseInt(k.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    if (k.startsWith("#")) {
      const n = parseInt(k.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

/** HTML -> readable text: drops <style>/<script>/<head> and comments, turns block ends into newlines,
 *  strips remaining tags, decodes entities. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  );
}

export interface CleanedBody {
  text: string;
  truncated: boolean;
  /** Length of the cleaned text before the cap, so the agent can say how much it did not read. */
  fullLength: number;
}

/**
 * Clean an email body for an agent to read: HTML is converted to text (Graph is asked for text, but a
 * mailbox can still return HTML), invisible characters are removed, whitespace is collapsed and runs of
 * blank lines are squeezed, then the result is capped at `maxChars` (clamped to READ_EMAIL_HARD_MAX_CHARS).
 */
export function cleanEmailBody(
  content: string | null | undefined,
  contentType: string | null | undefined,
  maxChars: number = READ_EMAIL_DEFAULT_MAX_CHARS,
): CleanedBody {
  const cap = Math.min(
    Math.max(Number.isFinite(maxChars) ? Math.trunc(maxChars) : READ_EMAIL_DEFAULT_MAX_CHARS, 200),
    READ_EMAIL_HARD_MAX_CHARS,
  );
  const raw = String(content ?? "");
  const isHtml =
    String(contentType ?? "").toLowerCase() === "html" || /<(html|body|div|p|br|table)\b/i.test(raw);
  const text = (isHtml ? htmlToText(raw) : decodeEntities(raw))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b-\u200d\ufeff\u00ad]/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= cap) return { text, truncated: false, fullLength: text.length };
  return { text: `${text.slice(0, cap).trimEnd()}\n...[truncated]`, truncated: true, fullLength: text.length };
}

/** Graph receivedDateTime is always UTC. Render it in the owner's zone ("Mon, Nov 3, 2026, 9:14 AM EST").
 *  An unknown zone falls back to UTC rather than throwing. */
export function formatReceived(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  try {
    return d.toLocaleString("en-US", { ...opts, timeZone });
  } catch {
    return d.toLocaleString("en-US", { ...opts, timeZone: "UTC" });
  }
}

export interface InboxReadFailure {
  ok: false;
  error: string;
  needsConsent?: boolean;
  notFound?: boolean;
  status?: number;
}

/** Map a failed Graph response to an actionable result. 403 = the Mail.Read grant is missing (the
 *  calendar and OneDrive precedent): needsConsent, not a crash and not a code bug. */
export function mapGraphMailError(status: number, bodyText: string, what: string): InboxReadFailure {
  if (status === 403) return { ok: false, needsConsent: true, status, error: MAIL_READ_CONSENT_ERROR };
  if (status === 404) {
    return { ok: false, notFound: true, status, error: `${what}: that message was not found in your mailbox.` };
  }
  let detail = bodyText.slice(0, 200);
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string } };
    if (j?.error?.message) detail = j.error.message;
  } catch {
    /* not JSON: keep the raw slice */
  }
  return { ok: false, status, error: `${what} failed (${status}): ${detail}` };
}

export interface RawGraphMessage {
  id?: string;
  subject?: string;
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
  conversationId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string; name?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string; name?: string } }[];
  body?: { contentType?: string; content?: string };
}

export interface InboxSearchHit {
  id: string;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  received: string | null;
  receivedUtc: string | null;
  isRead: boolean;
  hasAttachments: boolean;
  preview: string;
  webLink: string | null;
}

export function shapeSearchHit(r: RawGraphMessage, timeZone: string): InboxSearchHit {
  const preview = (r.bodyPreview ?? "").replace(/\s+/g, " ").trim();
  return {
    id: r.id ?? "",
    subject: r.subject?.trim() || "(no subject)",
    fromName: r.from?.emailAddress?.name ?? null,
    fromAddress: r.from?.emailAddress?.address ?? null,
    received: formatReceived(r.receivedDateTime, timeZone),
    receivedUtc: r.receivedDateTime ?? null,
    isRead: !!r.isRead,
    hasAttachments: !!r.hasAttachments,
    preview:
      preview.length > SEARCH_PREVIEW_MAX_CHARS ? `${preview.slice(0, SEARCH_PREVIEW_MAX_CHARS)}...` : preview,
    webLink: r.webLink ?? null,
  };
}

/** Apply the post-filter, newest first (a $search response is relevance-ordered), then cap. */
export function finishSearchHits(
  raws: RawGraphMessage[],
  built: BuiltSearch,
  timeZone: string,
): InboxSearchHit[] {
  let rows = raws;
  if (built.postFilter.unreadOnly) rows = rows.filter((r) => r.isRead === false);
  const hits = rows.map((r) => shapeSearchHit(r, timeZone));
  if (built.mode === "search") {
    hits.sort((a, b) => Date.parse(b.receivedUtc ?? "") - Date.parse(a.receivedUtc ?? "") || 0);
  }
  return hits.slice(0, built.top);
}
