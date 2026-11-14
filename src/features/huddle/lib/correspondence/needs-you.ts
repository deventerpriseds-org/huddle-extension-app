// WHAT:          The correspondence "needs you" classifier: ONE verdict per email CONVERSATION (keyed by
//                conversationId), deciding whether it needs the owner's reply, plus the rules the to-do side reads
//                (who is the doer). Pure, import-light, no I/O. EMAIL ONLY: owner scope change 2026-11-14 ("email
//                report for now, no teams"); Teams keeps its existing decideChatThread path, untouched.
// WHY:           Owner 2026-11-14, after a preview listed 41 "open" emails: minutes, mass mailings, invites and
//                earlier replies in the same thread were each listed as a separate thing to answer. AC
//                docs/qc-evidence/AC-correspondence-redesign.md (branch claude_ac-correspondence-redesign) sections
//                R1-R4, R6, R8; probe results docs/qc-evidence/PROBES-correspondence-redesign.md.
// SUPERSEDES:    nothing. The preview's per-MESSAGE rule (screenMessage in scripts/proposals-preview.ts) is replaced
//                there by this module; Iris's live screen (inbound-email.ts) is untouched and NOT superseded.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/needs-you.test.ts; docs/qc-evidence/IMPL-needs-you-redesign.md.
//
// RULE 1 (owner): Iris's live email alerts do not change. This module NEVER calls screenMessage and never hands a
// subject to asksSomething (only `{subject:""}`), so the live INVITE_SUBJECT clause can never fire here (AC-R1.5).
// THIS REPO IS PUBLIC: no addresses, names or ids here; config supplies the owner's identity at run time.

import { asksSomething, isAutomatedAddress, newTextOnly } from "../email/inbound-email";
import { parseAddress, parseUtcMs, sentReplySettles, stripReplyPrefixes, type FeedInboundMessage } from "../external-feeds/onedrive-feed";

/** The one verdict per conversation (AC shared definitions). When several apply, the FIRST in this order wins. */
export type NeedsYouVerdict = "automated" | "invite" | "minutes" | "not_addressed" | "replied" | "cant_tell" | "needs_reply" | "fyi";
export const VERDICT_ORDER: readonly NeedsYouVerdict[] = ["automated", "invite", "minutes", "not_addressed", "replied", "cant_tell", "needs_reply", "fyi"];

// ── Recipients (AC-R3, S-A) ───────────────────────────────────────────────────────────────────────────

const ADDR = /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]+$/;

/** Pure: split a recipient STRING on `;` or `,`, never inside a quoted display name ("Doe, Pat" <...>). */
function splitRecipientString(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const ch of s) {
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if ((ch === ";" || ch === ",") && !quoted && !angle) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Pure: one recipient token -> a lower-cased address, or null. The address inside <...> wins over any text in the
 *  display name (S-A13: `"owner@x" <pat@x>` is pat). RFC 5322 group syntax `Name: a@x` drops the group label;
 *  `Undisclosed recipients:` (no member) yields nothing (S-A9). */
function tokenAddress(tok: string): string | null {
  let t = tok.trim();
  if (!t) return null;
  const angle = /<([^<>]*)>\s*$/.exec(t);
  if (angle) t = angle[1].trim();
  else {
    t = t.replace(/^[^"@:]*:\s*/, ""); // group label "Team:" / "Undisclosed recipients:"
    t = t.replace(/^"[^"]*"\s*/, "").trim();
  }
  const a = t.toLowerCase();
  return ADDR.test(a) ? a : null;
}

export interface RecipientList {
  /** false when the record carries no such field at all (unknown -- never read as "not addressed"). */
  present: boolean;
  addresses: string[];
}

/** Pure (AC-R3, R3.6): a recipients field in either shape -- the real feed's `;`-separated STRING (probe P-5) or
 *  Graph's array of {emailAddress:{address}} (each item through onedrive-feed parseAddress) -> whole addresses. */
export function parseRecipients(v: unknown): RecipientList {
  if (v === undefined || v === null) return { present: false, addresses: [] };
  const out: string[] = [];
  if (Array.isArray(v)) {
    for (const it of v) {
      if (typeof it === "string") out.push(...splitRecipientString(it).map(tokenAddress).filter((a): a is string => !!a));
      else {
        const a = parseAddress(it).address;
        if (ADDR.test(a)) out.push(a);
      }
    }
  } else if (typeof v === "string") {
    out.push(...splitRecipientString(v).map(tokenAddress).filter((a): a is string => !!a));
  } else return { present: false, addresses: [] };
  return { present: true, addresses: [...new Set(out)] };
}

/** Where the owner sits on one message. `unknown` = cannot be decided (no owner address configured, or the record
 *  has neither recipients field): never "not addressed" (AC-R3.9, fail closed). */
export type Addressing =
  | { kind: "direct" }
  | { kind: "group"; ownerAloneOnTo: boolean }
  | { kind: "cc_only" }
  | { kind: "none"; reason: "no_recipients" | "not_on_recipients" }
  | { kind: "unknown"; reason: "no_owner_address" | "no_recipient_field" };

/** Pure (AC-R3.1-3.5, S-A): whole-address, case-insensitive comparison with the owner's addresses. */
export function ownerAddressing(m: Pick<FeedInboundMessage, "toRecipients" | "ccRecipients">, ownerAddresses: ReadonlySet<string>): Addressing {
  if (!ownerAddresses.size) return { kind: "unknown", reason: "no_owner_address" };
  const to = parseRecipients(m.toRecipients);
  const cc = parseRecipients(m.ccRecipients);
  if (!to.present && !cc.present) return { kind: "unknown", reason: "no_recipient_field" };
  const toHit = to.addresses.some((a) => ownerAddresses.has(a));
  const ccHit = cc.addresses.some((a) => ownerAddresses.has(a));
  const othersTo = to.addresses.filter((a) => !ownerAddresses.has(a));
  const othersCc = cc.addresses.filter((a) => !ownerAddresses.has(a));
  if (toHit) return othersTo.length + othersCc.length === 0 ? { kind: "direct" } : { kind: "group", ownerAloneOnTo: othersTo.length === 0 };
  if (ccHit) return { kind: "cc_only" };
  if (!to.addresses.length && !cc.addresses.length) return { kind: "none", reason: "no_recipients" };
  return { kind: "none", reason: "not_on_recipients" };
}

/** Pure: the owner's address set -- the work mailbox, the Huddle logins and the optional aliases (AC shared defs). */
export function ownerAddressSet(cfg: { mailbox: string; ownerLogins: string[]; correspondence?: { ownerAliases?: string[] } }): Set<string> {
  return new Set(
    [cfg.mailbox, ...cfg.ownerLogins, ...(cfg.correspondence?.ownerAliases ?? [])].map((a) => String(a ?? "").trim().toLowerCase()).filter((a) => ADDR.test(a)),
  );
}

// ── Calendar items (AC-R4, S-B) ───────────────────────────────────────────────────────────────────────

/** Exchange stamps these on meeting requests, responses and cancellations. Probe P-1 on the real 127 emails:
 *  series-instance-id on 16, originator-id on 15; Content-Class absent on all, "Invitation:" subjects 0. */
export const CALENDAR_HEADERS: readonly string[] = ["x-ms-exchange-calendar-series-instance-id", "x-ms-exchange-calendar-originator-id"];
/** UNVERIFIED subject spellings (AC S-B3..S-B9, probe P-2 counted 0 of them): an ORIGINAL subject only -- a
 *  `Re:` / `Fw:` in front means a person wrote it (S-B10), and the colon form is required (S-B12). */
const CALENDAR_SUBJECT = /^\s*(?:accepted|tentative|declined|canceled|cancelled|new time proposed|invitation|updated invitation)\s*:/i;

/** Pure: is this message a calendar item (invite, update, response, cancellation)? A body marker ("Join the
 *  meeting now") is never enough on its own (AC-R4.6). */
export function isCalendarItem(m: Pick<FeedInboundMessage, "subject" | "headerNames" | "contentClass">): boolean {
  const headers = new Set((m.headerNames ?? []).map((h) => String(h).toLowerCase()));
  if (CALENDAR_HEADERS.some((h) => headers.has(h))) return true;
  if (/calendarmessage/i.test(String(m.contentClass ?? ""))) return true;
  return CALENDAR_SUBJECT.test(String(m.subject ?? ""));
}

// ── Automated / broadcast (AC-R3.8) ──────────────────────────────────────────────────────────────────

/** Header NAMES that mark mail as not-from-a-person. The first two and the Precedence / Auto-Submitted values are
 *  the live screen's own (screenMessage:191-197, read here without calling it); the rest were seen on the real
 *  mailbox by probe P-1: x-servicenow-generated 10, x-ms-exchange-organization-bulkcategory 10,
 *  x-ms-engage-notification 7 (Viva Engage). */
export const BROADCAST_HEADERS: readonly string[] = [
  "list-unsubscribe",
  "list-id",
  "x-servicenow-generated",
  "x-ms-exchange-organization-bulkcategory",
  "x-ms-engage-notification",
];

export function automatedReason(m: Pick<FeedInboundMessage, "headerNames" | "precedence" | "autoSubmitted" | "fromAddress">): "bulk_header" | "auto_submitted" | "automated_sender" | null {
  const headers = new Set((m.headerNames ?? []).map((h) => String(h).toLowerCase()));
  if (BROADCAST_HEADERS.some((h) => headers.has(h))) return "bulk_header";
  if (/^(bulk|list|junk)$/.test(String(m.precedence ?? "").toLowerCase())) return "bulk_header";
  if (m.autoSubmitted && String(m.autoSubmitted).toLowerCase() !== "no") return "auto_submitted";
  if (isAutomatedAddress(m.fromAddress)) return "automated_sender";
  return null;
}

// ── Asks and minutes (AC-R5.1 / R5.4 classification part, S-C) ───────────────────────────────────────

/** Pure: does this NEW text ask something? Body only: the subject is passed as "" so the live screen's
 *  INVITE_SUBJECT clause can never fire (AC-R1.5). An ORIGINAL subject is put in front of the body as text. */
export function textAsks(text: string): boolean {
  return asksSomething({ subject: "", bodyText: text });
}

const sentencesOf = (text: string) => text.split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Pure: does the text name the owner (whole word, case-insensitive)? */
export function namesOwner(text: string, ownerNames: readonly string[]): boolean {
  return ownerNames.some((n) => n.trim() && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n.trim())}(?![\\p{L}\\p{N}])`, "iu").test(text));
}

/** Pure: a DIRECT ask to the owner -- one sentence that both asks something and is aimed at "you" or names the
 *  owner ("Owner, can you take item 3 by Friday?", "Can you approve by Friday?"). "Thank you" is not "you", and
 *  "Please find the notes below" asks nobody (S-C6 / S-C7 vs a recap). */
export function directAsk(text: string, ownerNames: readonly string[]): boolean {
  return sentencesOf(newTextOnly(text)).some((s) => textAsks(s) && (/\byou(?:r|rs)?\b/i.test(s.replace(/\bthanks?\s+you\b|\bthank-you\b/gi, " ")) || namesOwner(s, ownerNames)));
}

/** Huddle's OWN minutes email subject (minutes.ts:280-284, VERIFIED from code). */
const OWN_MINUTES_SUBJECT = /^\s*(?:updated\s+)?meeting minutes\s*:/i;
/** Probe P-2: 13 real subjects carry minutes / notes / recap / summary, mostly from internal senders. UNVERIFIED
 *  exact forms (S-C4, S-C5). A keyword alone yields to a direct ask (AC push-back, S-C7). */
const MINUTES_KEYWORD = /\bmeeting\s+(?:notes|minutes|recap|summary)\b|^\s*(?:recap|summary|notes|minutes)\s+(?:of|from|for)\b/i;
/** UNVERIFIED vendor sender (S-C3; probe P-2 saw 1 "Fireflies-ish" subject). Whole domain or a subdomain. */
const MINUTES_VENDOR = /@(?:[a-z0-9-]+\.)*fireflies\.ai$/i;

/** Pure (S-C): is this email meeting minutes / a recap? Huddle's own subject or the vendor sender, with no
 *  reply/forward prefix, is minutes outright. A keyword subject (forwarded or not) is minutes only when the new
 *  text holds no DIRECT ask to the owner (S-C6: a person forwarding minutes WITH a question still needs a reply). */
export function isMinutesEmail(m: Pick<FeedInboundMessage, "subject" | "fromAddress">, newText: string, ownerNames: readonly string[]): boolean {
  const subject = String(m.subject ?? "");
  const base = stripReplyPrefixes(subject);
  const prefixed = base !== subject;
  if (!prefixed && (OWN_MINUTES_SUBJECT.test(base) || MINUTES_VENDOR.test(String(m.fromAddress ?? "")))) return true;
  if (OWN_MINUTES_SUBJECT.test(base) || MINUTES_KEYWORD.test(base)) return !directAsk(newText, ownerNames);
  return false;
}

// ── CC-only rule and group address (owner scope change 2026-11-14) ─────────────────────────────────────

/** A GROUP ADDRESS: the sender speaks to everyone on the thread ("Hi everyone", "Hi all,", "Team,", "Thanks, folks",
 *  "y'all", "Can everyone ..."). Only in an address POSITION: at the start of a line/sentence followed by
 *  punctuation or the line end, after a closing "thanks," at the end, or as the subject of a group ask. So
 *  "everyone agreed last week", "all the files" and "the Platform Team will ship" are NOT group addresses. */
const GROUP_WORD = String.raw`(?:everyone|everybody|all|team|folks|y['’]?all|you all|all of you)`;
const GROUP_OPENING = new RegExp(String.raw`^(?:(?:hi|hello|hey|dear|greetings|good (?:morning|afternoon|evening)|morning|afternoon|thanks|thank you)[ \t,]+)?${GROUP_WORD}[ \t]*(?:[,!:;.\u2014\u2013-]|$)`, "i");
const GROUP_CLOSING = new RegExp(String.raw`(?:,|\b(?:hi|hello|hey|thanks|thank you|cheers))[ \t]+${GROUP_WORD}[ \t]*[.!?]?$`, "i");
const GROUP_ASK = new RegExp(String.raw`\b(?:can|could|would|will|does|do|did|has|have)\s+(?:everyone|everybody|you all|all of you|y['’]?all)\b`, "i");
const YALL = /(?<![\p{L}])y['’]?all(?![\p{L}])/iu;

/** Pure: does this NEW text address the whole group? Quoted history is dropped first. */
export function addressesGroup(text: string): boolean {
  const lines = newTextOnly(text).split(/\n+/).flatMap((l) => l.split(/(?<=[.?!])\s+/)).map((l) => l.trim()).filter(Boolean);
  return lines.some((l) => GROUP_OPENING.test(l) || GROUP_CLOSING.test(l) || GROUP_ASK.test(l) || YALL.test(l));
}

/** Pure (owner 2026-11-14): being on CC ALONE needs the owner only when the latest message from someone else
 *  (a) names the owner, (b) addresses the whole group, or (c) asks the owner directly (an asking sentence that
 *  names him). Otherwise CC-only is not "needs you". Returns the reason it counts, or null. */
export function ccCallsOnOwner(text: string, ownerNames: readonly string[]): "names_owner" | "group_address" | "direct_ask" | null {
  const nt = newTextOnly(text);
  if (sentencesOfText(nt).some((s) => textAsks(s) && namesOwner(s, ownerNames))) return "direct_ask";
  if (namesOwner(nt, ownerNames)) return "names_owner";
  if (addressesGroup(nt)) return "group_address";
  return null;
}
const sentencesOfText = (text: string) => text.split(/(?<=[.?!])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

/** Pure (owner 2026-11-14): the owner's names -- `correspondence.ownerNames` when configured, else the FIRST token
 *  of each owner login's local part, capitalised (`first.last@...` -> "First"). Tokens under 2 letters or with a
 *  digit are skipped. Matched as whole words, case-insensitive (namesOwner). */
export function effectiveOwnerNames(cfg: { ownerLogins: string[]; correspondence?: { ownerNames?: string[] } }): string[] {
  const configured = (cfg.correspondence?.ownerNames ?? []).map((n) => n.trim()).filter(Boolean);
  if (configured.length) return [...new Set(configured)];
  const out = new Set<string>();
  for (const login of cfg.ownerLogins) {
    const first = String(login ?? "").split("@")[0].split(/[._+-]/)[0] ?? "";
    if (first.length >= 2 && /^\p{L}+$/u.test(first)) out.add(first[0].toUpperCase() + first.slice(1).toLowerCase());
  }
  return [...out];
}

// ── Email conversations (AC-R2) ───────────────────────────────────────────────────────────────────────

export interface NeedsYouContext {
  ownerAddresses: ReadonlySet<string>;
  ownerNames: readonly string[];
  /** Latest Sent Items time per conversationId (onedrive-feed latestSentByConversation). */
  latestSent: ReadonlyMap<string, number>;
  /** false when the Sent Items file is missing, rejected or has no usable times (AC-R2.7). */
  sentKnown: boolean;
}

export interface ConversationVerdict {
  source: "email";
  /** "<mailbox>:conv:<conversationId>" (or "<mailbox>:msg:<message id>" with no conversation id). No NUL separator:
   *  the key is stored as a proposal ref's source_item_id (Postgres text). */
  key: string;
  verdict: NeedsYouVerdict;
  /** A short reason NAME (safe to count/log), or null. */
  reason: string | null;
  /** The deciding message: the latest message not from the owner. */
  deciding: { id: string; at: string | null; fromOwner: false } | null;
  /** How the owner was reached on the deciding message. */
  addressing: Addressing["kind"] | null;
  messageIds: string[];
}

/** Pure: the conversation key of an email (AC shared definitions). */
export function emailConversationKey(mailbox: string, m: Pick<FeedInboundMessage, "id" | "conversationId">): string {
  return m.conversationId ? `${mailbox}:conv:${m.conversationId}` : `${mailbox}:msg:${m.id}`;
}

const msOf = (m: { receivedDateTime?: string | null }) => parseUtcMs(m.receivedDateTime ?? "");
const ownSubjectOf = (subject: string | null | undefined) => {
  const s = String(subject ?? "");
  return stripReplyPrefixes(s) !== s ? "" : s;
};
/** The NEW text of one email: its original subject (never a Re:/Fw: one, which is history) + the body. */
export const emailNewText = (m: Pick<FeedInboundMessage, "subject" | "bodyText" | "bodyPreview">) =>
  [ownSubjectOf(m.subject), String(m.bodyText ?? m.bodyPreview ?? "")].filter((x) => x.trim()).join("\n");

/** Pure: the verdict for ONE email conversation (its inbox messages, any order). */
export function classifyEmailConversation(key: string, msgs: readonly FeedInboundMessage[], ctx: NeedsYouContext): ConversationVerdict {
  const sorted = [...msgs].sort((a, b) => (msOf(a) || 0) - (msOf(b) || 0));
  const isOwner = (m: FeedInboundMessage) => ctx.ownerAddresses.has(String(m.fromAddress ?? "").trim().toLowerCase());
  const base = { source: "email" as const, key, messageIds: sorted.map((m) => m.id) };
  // AC-R3.9: no owner address -> every email can't be told, never not_addressed / needs_reply (fail closed).
  if (!ctx.ownerAddresses.size) return { ...base, verdict: "cant_tell", reason: "no_owner_address", deciding: null, addressing: "unknown" };
  const others = sorted.filter((m) => !isOwner(m));
  const latest = others[others.length - 1];
  if (!latest) return { ...base, verdict: "replied", reason: "owner_only", deciding: null, addressing: null };
  const deciding = { id: latest.id, at: latest.receivedDateTime ?? null, fromOwner: false as const };
  const addr = ownerAddressing(latest, ctx.ownerAddresses);
  const v = (verdict: NeedsYouVerdict, reason: string | null): ConversationVerdict => ({ ...base, verdict, reason, deciding, addressing: addr.kind });
  const auto = automatedReason(latest);
  if (auto) return v("automated", auto);
  if (isCalendarItem(latest)) return v("invite", null);
  const newText = emailNewText(latest);
  if (isMinutesEmail(latest, newText, ctx.ownerNames)) return v("minutes", null);
  if (addr.kind === "none") return v("not_addressed", addr.reason);
  // Owner 2026-11-14: CC alone counts only when the latest message calls on him (names him, speaks to the whole
  // group, or asks him directly). Otherwise it is not "needs you".
  if (addr.kind === "cc_only" && !ccCallsOnOwner(newText, ctx.ownerNames)) return v("not_addressed", "cc_only_not_called_on");
  if (addr.kind === "unknown") return v("cant_tell", addr.reason);
  // A later owner message settles the thread: in the inbox (AC-R2.6) or in Sent Items (AC-R2.4, the EXISTING
  // sentReplySettles -- no second settle rule). Times without a zone are UTC (AC-R2.8).
  const latestAt = msOf(latest);
  const ownerAfter = sorted.some((m) => isOwner(m) && msOf(m) > latestAt);
  const iso = Number.isFinite(latestAt) ? new Date(latestAt).toISOString() : null;
  if (ownerAfter || sentReplySettles({ conversation_id: latest.conversationId ?? null, received_at: iso }, ctx.latestSent as Map<string, number>)) {
    return v("replied", null);
  }
  if (!textAsks(newText)) return v("fyi", null);
  if (!ctx.sentKnown) return v("cant_tell", "no_sent_items");
  return v("needs_reply", null);
}

/** Pure: group a mailbox's messages by conversation (conversationId ONLY, never a cleaned subject: AC-R2.13). */
export function groupEmailConversations(mailbox: string, msgs: readonly FeedInboundMessage[]): Map<string, FeedInboundMessage[]> {
  const by = new Map<string, FeedInboundMessage[]>();
  for (const m of msgs) {
    const k = emailConversationKey(mailbox, m);
    (by.get(k) ?? by.set(k, []).get(k)!).push(m);
  }
  return by;
}

export function classifyEmailConversations(mailbox: string, msgs: readonly FeedInboundMessage[], ctx: NeedsYouContext): ConversationVerdict[] {
  return [...groupEmailConversations(mailbox, msgs)].map(([k, ms]) => classifyEmailConversation(k, ms, ctx));
}

// ── Counts (AC-R7.5/7.6): verdict names and reason names only, never content ──────────────────────────

export function verdictCounts(vs: readonly ConversationVerdict[]): { total: number; byVerdict: Record<NeedsYouVerdict, number>; byReason: Record<string, number> } {
  const byVerdict = Object.fromEntries(VERDICT_ORDER.map((v) => [v, 0])) as Record<NeedsYouVerdict, number>;
  const byReason: Record<string, number> = {};
  for (const c of vs) {
    byVerdict[c.verdict]++;
    if (c.reason) byReason[`${c.verdict}:${c.reason}`] = (byReason[`${c.verdict}:${c.reason}`] ?? 0) + 1;
  }
  return { total: vs.length, byVerdict, byReason };
}


// ── To-dos: the owner is the doer (AC-R6) ─────────────────────────────────────────────────────────────

/** Verdicts whose conversations are never a to-do source (AC-R6.1). cant_tell for lack of an owner address is
 *  also skipped (fail closed); cant_tell for missing Sent Items is about the REPLY only, so to-dos still run. */
export function conversationIsTodoSource(c: Pick<ConversationVerdict, "verdict" | "reason">): boolean {
  if (c.verdict === "not_addressed" || c.verdict === "automated" || c.verdict === "invite" || c.verdict === "minutes") return false;
  if (c.verdict === "cant_tell" && (c.reason === "no_owner_address" || c.reason === "no_recipient_field")) return false;
  return true;
}

/** One message's text as a to-do source segment, with what the doer rule needs to know about it. */
export interface TodoSegment {
  text: string;
  fromOwner: boolean;
  /** How the owner was reached on THIS message. */
  reach: Addressing["kind"];
  ownerAloneOnTo: boolean;
  mentionsOwner: boolean;
}

/** Pure (AC-R6.7): does an extracted assignee name the owner? Equal (case-insensitive) to a configured owner name,
 *  or to the first word of one (the first name). */
export function assigneeIsOwner(assignee: string, ownerNames: readonly string[]): boolean {
  const a = assignee.trim().toLowerCase();
  if (!a) return false;
  return ownerNames.some((n) => {
    const full = n.trim().toLowerCase();
    return !!full && (a === full || a === full.split(/\s+/)[0]);
  });
}

const FIRST_PERSON_COMMITMENT = /(?:^|[^\p{L}])(?:i(?:'|’)ll|i will|i am going to|i'm going to|i’m going to|i can|i shall|let me|i need to|i have to|i must)\b/iu;

export type DoerVerdict = "keep" | "assigned_to_other" | "doer_unclear" | "not_owner_commitment";

/** Pure (AC-R6.3-6.7): may this validated to-do be proposed to the OWNER? `segment` is the message its evidence
 *  came from. The owner's own message counts only as a first-person commitment (AC-R6.6). Someone else's message:
 *  a grounded assignee who is not the owner drops it (assigned_to_other); no assignee keeps it only where the owner
 *  is plainly the one asked -- a direct email / the owner alone on To with "you" in the evidence (AC-R6.4/6.5).
 *  CC-only never counts unless the owner is named (owner decision OQ-3). */
export function doerVerdict(c: { assignee: string | null; evidence: string }, segment: TodoSegment, ownerNames: readonly string[]): DoerVerdict {
  if (segment.fromOwner) {
    if (c.assignee && !assigneeIsOwner(c.assignee, ownerNames)) return "assigned_to_other";
    return FIRST_PERSON_COMMITMENT.test(c.evidence) ? "keep" : "not_owner_commitment";
  }
  if (c.assignee) return assigneeIsOwner(c.assignee, ownerNames) ? "keep" : "assigned_to_other";
  if (namesOwner(c.evidence, ownerNames)) return "keep";
  if (segment.reach === "direct") return "keep";
  if (segment.mentionsOwner) return "keep";
  if (segment.reach === "group" && segment.ownerAloneOnTo && /\byou(?:r|rs)?\b/i.test(c.evidence)) return "keep";
  return "doer_unclear";
}

/** Pure: which segment an evidence span came from (the first whose canonical text contains it). */
export function segmentOf(evidence: string, segments: readonly TodoSegment[], canon: (s: string) => string): TodoSegment | null {
  const ev = canon(evidence);
  return segments.find((s) => canon(s.text).includes(ev)) ?? null;
}
