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

export const ATTENTION_KINDS = ["email", "meeting", "appointment"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const ATTENTION_KIND_LABEL: Record<AttentionKind, string> = {
  email: "Emails",
  meeting: "Meetings",
  appointment: "Appointments & reminders",
};

/** Seeded default only -- the owner changes it from the bell itself (config-centric rule). */
export const DEFAULT_URGENT_KINDS: AttentionKind[] = ["email", "meeting", "appointment"];

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
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string | null;
  /** The conversation "Open in chat" switches to. Email alerts are Iris's. */
  huddleId: string;
  at: string | null;
}

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
