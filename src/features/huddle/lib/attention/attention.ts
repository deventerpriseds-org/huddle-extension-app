// WHAT:       Pure rules for the attention bell: which item types exist, which count by default, and
//             how a stored row becomes a bell item. No I/O.
// WHY:        Owner, 2026-11-08: "huddle needs a notifications icon that has a count until I dismiss
//             there or deal with them in the chat -- for things I identify as urgent like communication
//             or meeting or appointments related". A phone push can be missed (it was, 9:31 that morning);
//             the bell is the in-app record that does not depend on the push arriving.
//             Option A (owner-chosen): ONE list -- the existing owed-email ledger (chat.email_replies)
//             gains a `kind`, so emails, meetings and appointments share one open/settled lifecycle.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/attention.test.ts; .claude/actions.md ACT:attention-bell.
// 2026-11-12: a `chat` kind (an unanswered Teams chat, one row per chat thread) -- AC
//             docs/ac/AC-correspondence-checklist.md section 4. A chat row may be UNCERTAIN ("can't tell if
//             answered": the owner's own Teams messages are not available) -- shown, never counted in the
//             badge. Stored settings saved before `chat` existed still count it (AC-4.3).

export const ATTENTION_KINDS = ["email", "meeting", "appointment", "chat"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const ATTENTION_KIND_LABEL: Record<AttentionKind, string> = {
  email: "Emails",
  meeting: "Meetings",
  appointment: "Appointments & reminders",
  chat: "Teams chats",
};

/** Seeded default only -- the owner changes it from the bell itself (config-centric rule). */
export const DEFAULT_URGENT_KINDS: AttentionKind[] = ["email", "meeting", "appointment", "chat"];

/** Kinds added after owners could already save a setting. A saved list that predates one of these did not
 *  choose to exclude it; saving the setting again records an explicit opt-out as "-<kind>". */
export const LATE_KINDS: AttentionKind[] = ["chat"];

export const isAttentionKind = (v: unknown): v is AttentionKind =>
  typeof v === "string" && (ATTENTION_KINDS as readonly string[]).includes(v);

/** Stored setting -> a clean kind list. Unknown values dropped; null/garbage -> the default.
 *  An explicit empty list is honoured (the owner switched every type off). */
export function parseUrgentKinds(raw: unknown): AttentionKind[] {
  if (!Array.isArray(raw)) return [...DEFAULT_URGENT_KINDS];
  const out: AttentionKind[] = [];
  for (const k of raw) if (isAttentionKind(k) && !out.includes(k)) out.push(k);
  return out;
}

/** A STORED setting -> the kinds that count (AC-4.3). Same as parseUrgentKinds, plus: a late kind the saved
 *  list neither names nor opts out of ("-chat") counts, so a setting saved before the kind existed cannot
 *  silently hide it. An explicit empty list (everything switched off) stays empty. */
export function resolveStoredUrgentKinds(raw: unknown): AttentionKind[] {
  const out = parseUrgentKinds(raw);
  if (!Array.isArray(raw) || raw.length === 0) return out;
  const optedOut = new Set(raw.filter((x): x is string => typeof x === "string" && x.startsWith("-")).map((x) => x.slice(1)));
  for (const k of LATE_KINDS) if (!out.includes(k) && !optedOut.has(k)) out.push(k);
  return out;
}

/** The owner's chosen kinds -> what is stored: the kinds, plus "-<kind>" for each late kind left off. */
export function serializeUrgentKinds(kinds: AttentionKind[]): string[] {
  return [...kinds, ...LATE_KINDS.filter((k) => !kinds.includes(k)).map((k) => `-${k}`)];
}

/** Ids of non-email bell items. Prefixed so they can never collide with an email row (a short hash). */
export const attentionId = (kind: Exclude<AttentionKind, "email">, sourceId: string): string =>
  `attn-${kind}-${sourceId}`.slice(0, 120);

export interface AttentionRowLike {
  id: string;
  kind: string | null;
  huddle_id: string | null;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  received_at: string | null;
  created_at?: string | null;
  /** chat rows: why "answered?" cannot be decided (owner_teams_id | owner_messages); null = decided. */
  needs_context?: string | null;
  /** chat rows: the source's own link (Teams webUrl) when the record supplied one. */
  source_link?: string | null;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string | null;
  /** The conversation "Open in chat" switches to. Email alerts are Iris's. */
  huddleId: string;
  at: string | null;
  /** "Can't tell if answered": shown in the list, NOT counted in the badge. */
  uncertain?: boolean;
  /** An external deep link supplied by the source (e.g. open in Teams). Absent => no control rendered. */
  link?: string;
}

/** Owner-readable reason a chat's answered state is unknown. Never says "unanswered". */
export const CHAT_UNCERTAIN_REASON: Record<string, string> = {
  owner_teams_id: "Can't tell if answered: your Teams id isn't configured",
  owner_messages: "Can't tell if answered: your own Teams messages aren't in the log",
};

/** The badge counts only items whose state is known (uncertain chat rows are listed, not counted). */
export const badgeCount = (items: AttentionItem[]): number => items.filter((i) => !i.uncertain).length;

const safeLink = (u: string | null | undefined): string | undefined => {
  const s = String(u ?? "").trim();
  return /^https:\/\/[^\s"<>]+$/i.test(s) ? s : undefined;
};

/** Where an email alert lives: Iris announces every flagged email in her 1:1 (inbound-email.server). */
export const EMAIL_ALERT_HUDDLE = "dm-iris-chase";

export function toAttentionItem(r: AttentionRowLike): AttentionItem | null {
  const kind = r.kind ?? "email";
  if (!isAttentionKind(kind)) return null;
  if (kind === "email") {
    const who = r.from_name || r.from_address || "someone";
    return {
      id: r.id,
      kind,
      title: r.subject?.trim() || "(no subject)",
      detail: `From ${who}`,
      huddleId: r.huddle_id || EMAIL_ALERT_HUDDLE,
      at: r.received_at ?? r.created_at ?? null,
    };
  }
  if (kind === "chat") {
    const uncertain = !!r.needs_context;
    const who = r.from_name?.trim() || "someone";
    const link = safeLink(r.source_link);
    return {
      id: r.id,
      kind,
      title: r.subject?.trim() || "Teams chat",
      detail: uncertain
        ? `Teams · ${who} · ${CHAT_UNCERTAIN_REASON[r.needs_context!] ?? "Can't tell if answered"}`
        : `Teams · ${who} asked and hasn't had your reply`,
      // A chat row opens Iris's chat (coordinator, 2026-11-12); the Teams link is separate.
      huddleId: r.huddle_id || EMAIL_ALERT_HUDDLE,
      at: r.received_at ?? r.created_at ?? null,
      ...(uncertain ? { uncertain: true } : {}),
      ...(link ? { link } : {}),
    };
  }
  return {
    id: r.id,
    kind,
    title: r.subject?.trim() || (kind === "meeting" ? "Meeting" : "Reminder"),
    detail: r.from_name?.trim() || null,
    huddleId: r.huddle_id || EMAIL_ALERT_HUDDLE,
    at: r.received_at ?? r.created_at ?? null,
  };
}

/** The bell's view of the open rows: only the kinds the owner counts, newest first. */
export function bellItems(rows: AttentionRowLike[], urgent: AttentionKind[]): AttentionItem[] {
  const want = new Set(urgent);
  return rows
    .map(toAttentionItem)
    .filter((x): x is AttentionItem => !!x && want.has(x.kind))
    .sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0));
}

/** "Today: 2 meetings — first at 10:00 AM" for the schedule brief's bell item. */
export function meetingBellTitle(
  items: { kind: string; startIso: string | null }[],
  tz: string,
): string | null {
  const n = items.length;
  if (!n) return null;
  const meetings = items.filter((i) => i.kind === "meeting").length;
  const classes = n - meetings;
  const parts = [
    meetings ? `${meetings} meeting${meetings === 1 ? "" : "s"}` : "",
    classes ? `${classes} class${classes === 1 ? "" : "es"}` : "",
  ].filter(Boolean);
  const first = items
    .map((i) => (i.startIso ? Date.parse(i.startIso) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];
  const at =
    first !== undefined
      ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(first))
      : null;
  return `Today: ${parts.join(", ")}${at ? ` — first at ${at}` : ""}`;
}
