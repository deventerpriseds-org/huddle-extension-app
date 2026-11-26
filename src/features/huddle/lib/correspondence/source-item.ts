// WHAT:       Pure, source-neutral model of one correspondence item (an email, a Teams message, a meeting
//             transcript) as the processing ledger sees it, plus the email adapter (feed record -> item),
//             a stable content hash, and the processor seam later passes plug the bell / proposals into.
// WHY:        Owner handoff "Huddle Email and Teams Daily Processing" (2026-11-12) + AC
//             docs/ac/AC-correspondence-checklist.md (branch claude_ac-correspondence-checklist) sections 2
//             and 3: identity is the provider's message id (never a capture date, never a subject), and the
//             domain layer never reads a raw Power Automate field (AC-1.12).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/correspondence-ingest.test.ts; docs/qc-evidence/IMPL-correspondence-ingest.md.
//
// THIS REPO IS PUBLIC: no addresses, tenant/drive ids or names here.
//
// 2026-11-16 (owner decision, verbatim: "A (recommended): store message content in Azure, including Sent Items as a
// fourth kind next to email, Teams and transcripts."): an item now CARRIES its content (`content`, the shapes
// below) and the ledger STORES it in chat.correspondence_ledger.content (JSONB), so Azure is the system of record
// and the OneDrive files are for loads only. LOGS STILL NEVER CARRY CONTENT: no body, subject, address, name, chat
// name, transcript text or token is ever logged -- counts, statuses and error categories only (AC-3.8).
// Sent Items (`sent`) and Fireflies transcripts stored by the minutes flow are STORE-ONLY: never judged, never
// proposed, never on the bell (STORE_ONLY_SOURCES; the ledger inserts them `processed` and never claims `sent`).
// EVIDENCE (2026-11-16): docs/qc-evidence/BUILD-correspondence-content.md.

import type { InboundMessage } from "../email/inbound-email";
import { FEED_ID_PREFIX, feedRecordBody, mapFeedMessage, mapSentRecords, type FeedInboundMessage, type OneDriveFeedsConfig } from "../external-feeds/onedrive-feed";
import { FORWARD_SUBJECT, forwardedPart, type ForwardedPart } from "./forwarded";
import { parseRecipients } from "./needs-you";

export type CorrespondenceSource = "email" | "teams" | "transcript" | "sent";
export const CORRESPONDENCE_SOURCES: readonly CorrespondenceSource[] = ["email", "teams", "transcript", "sent"];
/** Sources that are STORED only (system of record), never processed by the bell / proposals / judge. */
export const STORE_ONLY_SOURCES: readonly CorrespondenceSource[] = ["sent"];

// ---------------------------------------------------------------------------------------------------------
// Stored content shapes (chat.correspondence_ledger.content). One per source; `kind` names it.

export interface EmailContent {
  kind: "email";
  subject: string | null;
  from: { name: string | null; address: string | null };
  to: string[];
  cc: string[];
  receivedAt: string | null;
  conversationId: string | null;
  internetMessageId: string | null;
  /** The SAME visible text the app derives (mapFeedMessage -> htmlToText for an HTML body). */
  bodyText: string | null;
  isForward: boolean;
  /** 2026-11-16: the FORWARDED email of a "Fw:" message, read from the raw body (forwarded.ts forwardedPart).
   *  bodyText is cut at the forward header for Outlook-marker / blockquote forwards, so without this the stored row
   *  held only the cover note. Present only when isForward and a forwarded part was found; ABSENT on rows stored
   *  before this field existed (the back-fill re-writes their content). Not part of the content hash. */
  forwarded?: ForwardedPart;
  /** Outlook category names, preserved exactly for Huddle's manual triage signal. */
  categories?: string[];
  /** True when Outlook carries the owner's custom `Action Needed` category. */
  actionNeeded?: boolean;
  /** Present only when the record carries `hasAttachments`. */
  hasAttachments?: boolean;
}

export interface SentContent extends Omit<EmailContent, "kind"> {
  kind: "sent";
  sentAt: string;
}

export interface TeamsContent {
  kind: "teams";
  chatId: string;
  chatName: string | null;
  messageId: string;
  at: string;
  sender: { id: string; name: string; isApp: boolean };
  fromOwner: boolean | null;
  text: string;
  webUrl: string | null;
  /** 2026-11-16: mentioned USER ids (lower-cased). Present when the source message carried Graph's `mentions` array
   *  (empty = nobody); ABSENT = unknown (rows stored before this field existed). */
  mentionedUserIds?: string[];
  /** 2026-11-16: the line's `ownerUserId` (lower-cased), when the line carried it. */
  ownerUserId?: string;
  /** 2026-11-16: is the owner among mentionedUserIds (present only when both are known). */
  mentionsOwner?: boolean;
  /** Verifier loop 1 (finding 1): a mention named no comparable user (@Everyone / chat, tag, app, team, channel,
   *  empty or malformed entry, or a body <at> tag with no matching user mention) -- the owner MAY be addressed.
   *  Present whenever mentionedUserIds is (rows stored before 2026-11-16 evening lack it). */
  unresolvedMention?: boolean;
  /** 2026-11-17: some mention was a conversation mention of the chat itself (@Everyone) -- aimed at the owner too.
   *  Present whenever the parser had a `mentions` array; ABSENT on rows stored before 2026-11-17 (kind unknown). */
  chatWideMention?: boolean;
  /** 2026-11-17: unresolvedMention is true AND every unresolved mention is a team / channel / tag mention (not aimed
   *  at the owner). ABSENT on older rows: those keep showing (fail open). Not part of the content hash. */
  groupMentionOnly?: boolean;
}

export interface TranscriptContent {
  kind: "transcript";
  title: string | null;
  meetingAt: string | null;
  /** Present when Fireflies returned them. */
  participants?: string[];
  attendees?: { name: string | null; email: string | null }[];
  sentences: { speaker: string; text: string; start: number | string | null; end: number | string | null }[];
  /** Every summary field fetched, including extended_sections when the API returned it. */
  summary: Record<string, unknown> | null;
}

export type CorrespondenceContent = EmailContent | SentContent | TeamsContent | TranscriptContent;

/** How an item's identity was established (AC-2.3: a fallback identity is recorded, never hidden). */
export type IdentityBasis = "provider_id" | "drive_item_etag" | "meeting_id";

/** One Teams message, already mapped OUT of the Power Automate shape by external-feeds/teams-log.ts. */
export interface TeamsMessage {
  chatId: string;
  messageId: string;
  at: string;
  senderId: string;
  senderName: string;
  /** true when the sender is an app/bot (AC-4.8 seam). */
  senderIsApp: boolean;
  /** true/false when the owner's Teams ids are configured; null when they are not (OQ-4). */
  fromOwner: boolean | null;
  text: string;
  chatName?: string;
  webUrl?: string;
  /** Mentioned user ids (lower-cased); present only when the message carried a `mentions` array. */
  mentionedUserIds?: string[];
  /** The line's `ownerUserId` (lower-cased), when present. */
  ownerUserId?: string;
  /** Owner among the mentioned users (present only when the mention list and an owner id are both known). */
  mentionsOwner?: boolean;
  /** A mention that names no comparable user (see TeamsContent.unresolvedMention). */
  unresolvedMention?: boolean;
  /** See TeamsContent.chatWideMention. */
  chatWideMention?: boolean;
  /** See TeamsContent.groupMentionOnly. */
  groupMentionOnly?: boolean;
}

export interface SourceItem {
  source: CorrespondenceSource;
  /** email: "<mailbox>:<outlook id>"; teams: "<enc chatId>:<enc messageId>"; transcript: Fireflies meeting_id. */
  sourceItemId: string;
  identityBasis: IdentityBasis;
  /** email conversationId / Teams chat id / null. */
  threadId: string | null;
  /** The item's OWN timestamp (received / sent) -- never the capture time. */
  at: string | null;
  contentHash: string;
  drivePath: string | null;
  driveItemId: string | null;
  fileEtag: string | null;
  internetMessageId: string | null;
  /** In-memory payload for processors (never logged). */
  email?: InboundMessage;
  teams?: TeamsMessage;
  /** STORED by the ledger in chat.correspondence_ledger.content (owner decision 2026-11-16). Never logged. */
  content?: CorrespondenceContent;
  /** true => stored only: inserted `processed`, never reset to pending, never claimed (STORE_ONLY_SOURCES). */
  storeOnly?: boolean;
}

/**
 * Pure, dependency-free 53-bit string hash (cyrb53), hex. Used only to notice that an item's content
 * changed between reads (AC-3.4/3.5) -- not a security primitive, and it never leaves the server.
 */
export function stableHash(parts: (string | null | undefined)[]): string {
  const s = parts.map((p) => p ?? "").join("\u001f");
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Pure: the Teams identity (AC-1.7). Each half is URI-encoded so a ':' inside a Graph chat id ("19:...")
 *  can never make two different (chat, message) pairs produce the same key. */
export const teamsSourceItemId = (chatId: string, messageId: string) =>
  `${encodeURIComponent(chatId)}:${encodeURIComponent(messageId)}`;

export function teamsSourceItem(m: TeamsMessage, file: { path: string; itemId?: string | null; etag?: string | null }): SourceItem {
  return {
    source: "teams",
    sourceItemId: teamsSourceItemId(m.chatId, m.messageId),
    identityBasis: "provider_id",
    threadId: m.chatId,
    at: m.at,
    // Capture time is deliberately absent: a re-capture of the same message is not a change (AC-1.6).
    contentHash: stableHash([m.text, m.senderId, m.at, m.chatName ?? ""]),
    drivePath: file.path,
    driveItemId: file.itemId ?? null,
    fileEtag: file.etag ?? null,
    internetMessageId: null,
    teams: m,
    content: teamsContent(m),
  };
}

/** Pure: the stored shape of one Teams message (already mapped out of the Power Automate shape). */
export function teamsContent(m: TeamsMessage): TeamsContent {
  return {
    kind: "teams",
    chatId: m.chatId,
    chatName: m.chatName ?? null,
    messageId: m.messageId,
    at: m.at,
    sender: { id: m.senderId, name: m.senderName, isApp: m.senderIsApp },
    fromOwner: m.fromOwner,
    text: m.text,
    webUrl: m.webUrl ?? null,
    ...(m.mentionedUserIds ? { mentionedUserIds: [...m.mentionedUserIds] } : {}),
    ...(m.ownerUserId ? { ownerUserId: m.ownerUserId } : {}),
    ...(typeof m.mentionsOwner === "boolean" ? { mentionsOwner: m.mentionsOwner } : {}),
    ...(typeof m.unresolvedMention === "boolean" ? { unresolvedMention: m.unresolvedMention } : {}),
    ...(typeof m.chatWideMention === "boolean" ? { chatWideMention: m.chatWideMention } : {}),
    ...(typeof m.groupMentionOnly === "boolean" ? { groupMentionOnly: m.groupMentionOnly } : {}),
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Pure: the stored shape of one Outlook record (inbox or Sent Items). `mapped` is the EXISTING mapper's output
 * (mapFeedMessage), so bodyText is the same visible text the app already derives -- no second HTML path. Recipients
 * go through the existing needs-you parseRecipients (both the feed's `;` string and Graph's array shape).
 */
export function emailContent(rec: Record<string, unknown>, mapped: InboundMessage): EmailContent {
  const m = mapped as FeedInboundMessage;
  const to = parseRecipients(m.toRecipients ?? rec.toRecipients).addresses;
  const cc = parseRecipients(m.ccRecipients ?? rec.ccRecipients).addresses;
  const isForward = FORWARD_SUBJECT.test(String(mapped.subject ?? ""));
  // The forwarded part comes from the SAME raw body mapFeedMessage read (feedRecordBody), never from bodyText.
  const raw = isForward ? feedRecordBody(rec) : null;
  const forwarded = raw ? forwardedPart(mapped.subject, raw.raw, raw.isHtml) : null;
  return {
    kind: "email",
    subject: mapped.subject ?? null,
    from: { name: mapped.fromName ?? null, address: mapped.fromAddress ?? null },
    to,
    cc,
    receivedAt: mapped.receivedDateTime ?? null,
    conversationId: mapped.conversationId ?? null,
    internetMessageId: str(rec.internetMessageId) || null,
    bodyText: mapped.bodyText ?? mapped.bodyPreview ?? null,
    isForward,
    ...(forwarded ? { forwarded } : {}),
    ...(m.categories ? { categories: [...m.categories] } : {}),
    ...(typeof m.actionNeeded === "boolean" ? { actionNeeded: m.actionNeeded } : {}),
    ...(typeof rec.hasAttachments === "boolean" ? { hasAttachments: rec.hasAttachments } : {}),
  };
}

/**
 * Pure: Sent Items records -> STORE-ONLY SourceItems (source 'sent'). Eligibility is EXACTLY the existing
 * mapSentRecords rule (conversationId required, sentDateTime/receivedDateTime must parse, synthetic prefix after
 * reply/forward markers while synthetic) -- each record is passed through it, never re-implemented. Identity is
 * (sent, "<mailbox>:<outlook id>"), the same shape as the inbox. A record the rule drops, or one with no id, is
 * counted skipped.
 */
export function sentSourceItems(
  records: Record<string, unknown>[],
  cfg: OneDriveFeedsConfig,
  file: { path: string; itemId?: string | null; etag?: string | null },
): { items: SourceItem[]; skipped: number } {
  const items: SourceItem[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const rec of records) {
    const ok = mapSentRecords([rec], cfg).sent[0];
    const originalId = str(rec.id);
    if (!ok || !originalId) {
      skipped++;
      continue;
    }
    const sourceItemId = `${cfg.mailbox}:${originalId}`;
    if (seen.has(sourceItemId)) {
      skipped++;
      continue;
    }
    seen.add(sourceItemId);
    const mapped = mapFeedMessage(rec, cfg.mailbox);
    const content: SentContent = { ...emailContent(rec, mapped), kind: "sent", sentAt: ok.sentAt };
    items.push({
      source: "sent",
      sourceItemId,
      identityBasis: "provider_id",
      threadId: ok.conversationId,
      at: ok.sentAt,
      contentHash: stableHash([content.subject, content.bodyText, content.to.join(","), content.cc.join(","), ok.sentAt]),
      drivePath: file.path,
      driveItemId: file.itemId ?? null,
      fileEtag: file.etag ?? null,
      internetMessageId: content.internetMessageId,
      content,
      storeOnly: true,
    });
  }
  return { items, skipped };
}

/** Pure: the stored shape of one Fireflies transcript (raw sentences AND every summary field fetched). */
export function transcriptContent(t: {
  title?: unknown;
  date?: unknown;
  dateString?: unknown;
  participants?: unknown;
  meeting_attendees?: unknown;
  sentences?: unknown;
  summary?: unknown;
}, meetingAt: string | null): TranscriptContent {
  const sentences = (Array.isArray(t.sentences) ? t.sentences : []).map((s) => {
    const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" || typeof v === "string" ? v : null);
    return { speaker: str(o.speaker_name), text: typeof o.text === "string" ? o.text : "", start: n(o.start_time), end: n(o.end_time) };
  });
  const out: TranscriptContent = {
    kind: "transcript",
    title: str(t.title) || null,
    meetingAt,
    sentences,
    summary: t.summary && typeof t.summary === "object" && !Array.isArray(t.summary) ? { ...(t.summary as Record<string, unknown>) } : null,
  };
  if (Array.isArray(t.participants)) out.participants = t.participants.map((p) => str(p)).filter(Boolean);
  if (Array.isArray(t.meeting_attendees)) {
    out.attendees = t.meeting_attendees.map((a) => {
      const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
      return { name: str(o.displayName) || str(o.name) || null, email: str(o.email) || null };
    });
  }
  return out;
}

/** Pure: a Fireflies meeting -> its STORE-ONLY ledger item (source 'transcript', identity = meeting_id). */
export function firefliesTranscriptItem(meetingId: string, content: TranscriptContent): SourceItem {
  return {
    source: "transcript",
    sourceItemId: meetingId,
    identityBasis: "meeting_id",
    threadId: null,
    at: content.meetingAt,
    contentHash: stableHash([JSON.stringify(content)]),
    drivePath: null,
    driveItemId: null,
    fileEtag: null,
    internetMessageId: null,
    content,
    storeOnly: true,
  };
}

/**
 * Pure (AC-2.2/2.3): one ORIGINAL Outlook feed record + its already-mapped InboundMessage -> SourceItem.
 * Identity is (email, "<mailbox>:<outlook id>") -- exactly the id mapFeedMessage already builds, minus the
 * "feed:" prefix -- with the Internet Message-ID stored alongside when present. A record with no provider
 * id only gets an identity when the caller supplies a per-record drive item + eTag (a per-file archive,
 * OQ-1); in the snapshot model it returns null and the caller counts it skipped. Never keyed by subject
 * or time.
 */
export function emailSourceItem(
  rec: Record<string, unknown>,
  mapped: InboundMessage,
  file: { path: string; itemId?: string | null; etag?: string | null; perRecordFile?: boolean },
  mailbox: string,
): SourceItem | null {
  const originalId = str(rec.id);
  const internetMessageId = str(rec.internetMessageId) || null;
  let sourceItemId: string;
  let identityBasis: IdentityBasis;
  if (originalId) {
    sourceItemId = mapped.id.startsWith(FEED_ID_PREFIX) ? mapped.id.slice(FEED_ID_PREFIX.length) : `${mailbox}:${originalId}`;
    identityBasis = "provider_id";
  } else if (file.perRecordFile && file.itemId && file.etag) {
    sourceItemId = `${mailbox}:drive:${file.itemId}`;
    identityBasis = "drive_item_etag";
  } else {
    return null;
  }
  return {
    source: "email",
    sourceItemId,
    identityBasis,
    threadId: mapped.conversationId ?? null,
    at: mapped.receivedDateTime ?? null,
    contentHash: stableHash([
      mapped.subject,
      mapped.bodyText ?? mapped.bodyPreview,
      mapped.fromAddress,
      mapped.receivedDateTime,
      identityBasis === "drive_item_etag" ? file.etag : "",
      // Preserve the old hash for ordinary email. A newly added/removed Action Needed label alone
      // changes it, so that one already-processed email is requeued exactly once.
      ...(mapped.actionNeeded === true ? ["outlook-action-needed"] : []),
    ]),
    drivePath: file.path,
    driveItemId: file.itemId ?? null,
    fileEtag: file.etag ?? null,
    internetMessageId,
    email: mapped,
    content: emailContent(rec, mapped),
  };
}

/** What the ledger holds for one stored forward (FLAGS only -- the back-fill never reads stored content to plan). */
export interface StoredForwardFlags {
  source: string;
  sourceItemId: string;
  hasContent: boolean;
  hasForwarded: boolean;
  purged: boolean;
}

export interface ForwardRefillPlan {
  /** Distinct forward items read from the file versions, and how many of them carry a forwarded part. */
  forwardsRead: number;
  forwardsWithPart: number;
  /** Ledger rows flagged as forwards, and how many of them hold no stored forwarded part. */
  storedForwards: number;
  storedMissing: number;
  /** storedMissing rows the back-fill now has a forwarded part for (the content re-write below gives it to them). */
  wouldGain: number;
  /** storedMissing rows with no forwarded part in any version read (not a forward header we can read, or no version). */
  stillMissing: number;
  /** storedMissing rows whose content was purged by retention (never written again). */
  purged: number;
  /** Items to re-write (content only) on apply: one per wouldGain row, its newest version. */
  refill: SourceItem[];
}

/**
 * Pure (2026-11-16): which stored forwards gain their forwarded part from the back-fill. `items` are the email /
 * Sent Items read from every file version, oldest first (the newest copy of an item wins); `stored` are the ledger's
 * flags for rows marked isForward. A row is refilled only when it has content, no `forwarded`, is not purged, and a
 * version yields a forwarded part -- content changed WITHOUT a hash change, so observe alone never rewrites it.
 */
export function planForwardRefill(items: readonly SourceItem[], stored: readonly StoredForwardFlags[]): ForwardRefillPlan {
  const newest = new Map<string, SourceItem>();
  for (const it of items) {
    const c = it.content;
    if (!c || (c.kind !== "email" && c.kind !== "sent") || !c.isForward) continue;
    newest.set(ledgerKey(it), it);
  }
  const withPart = new Map([...newest].filter(([, it]) => !!(it.content as EmailContent).forwarded));
  const plan: ForwardRefillPlan = {
    forwardsRead: newest.size,
    forwardsWithPart: withPart.size,
    storedForwards: stored.length,
    storedMissing: 0,
    wouldGain: 0,
    stillMissing: 0,
    purged: 0,
    refill: [],
  };
  for (const s of stored) {
    if (s.hasForwarded) continue;
    plan.storedMissing++;
    if (s.purged) {
      plan.purged++;
      continue;
    }
    const it = withPart.get(ledgerKey(s));
    if (it) {
      plan.wouldGain++;
      plan.refill.push(it);
    } else plan.stillMissing++;
  }
  return plan;
}

/** Ledger key, as the store and the pass both spell it. */
export const ledgerKey = (i: { source: string; sourceItemId: string }) => `${i.source}\u0000${i.sourceItemId}`;

// ---------------------------------------------------------------------------------------------------------
// Ledger contract (implemented in Azure PG by ledger.server.ts; an in-memory twin lives in the tests).

export type LedgerStatus = "pending" | "processed" | "needs_context" | "failed_retryable" | "failed";
export const LEDGER_STATUSES: readonly LedgerStatus[] = ["pending", "processed", "needs_context", "failed_retryable", "failed"];

export interface ClaimedItem {
  source: CorrespondenceSource;
  sourceItemId: string;
  claimVersion: number;
  attempts: number;
}

export interface ObserveResult {
  inserted: number;
  changed: number;
  unchanged: number;
  /** Unchanged rows whose stored content was NULL and is now filled (2026-11-16). Present only when > 0, so the
   *  result of an observe that fills nothing is exactly the earlier three-field shape. */
  contentFilled?: number;
}

/** Content-only storage (2026-11-16), separate from LedgerStore so the processing contract is unchanged. */
export interface ContentStore {
  /** Store-only upsert for items whose ledger row may ALSO be owned by a processor with its own hash (Fireflies
   *  transcripts: meeting triage observes the same (transcript, meeting_id) row). Inserts a missing row as
   *  `processed`; on an existing row it writes `content` ONLY -- never content_hash, status or the claim columns. */
  storeContent(owner: string, items: SourceItem[]): Promise<{ inserted: number; updated: number }>;
  /** Sets content to NULL (row kept, content_purged_at stamped) where the item's own time is older than
   *  `retentionDays`. A purged row's content is never written again. Returns rows purged. */
  purgeContent(retentionDays: number): Promise<number>;
}

export interface LedgerStore {
  /** Insert first-seen items; on a content-hash change reset the SAME row to pending (AC-3.4); otherwise
   *  only touch last_seen_at (AC-3.5). */
  observe(owner: string, items: SourceItem[]): Promise<ObserveResult>;
  /** A newly published file may carry the missing context: needs_context rows of that source go back to
   *  pending (AC-3.7). */
  reopenNeedsContext(owner: string, source: CorrespondenceSource): Promise<number>;
  /** Is any item of these sources due for (re)processing? */
  hasDue(owner: string, sources: CorrespondenceSource[], maxAttempts: number): Promise<boolean>;
  /** Compare-and-set claim under a lease; two concurrent callers never get the same item (AC-3.9). */
  claimDue(owner: string, sources: CorrespondenceSource[], limit: number, maxAttempts: number): Promise<ClaimedItem[]>;
  /** Each mark applies only if claimVersion is still current; returns whether it applied. */
  markProcessed(c: ClaimedItem, resultIds: Record<string, string[]>): Promise<boolean>;
  markNeedsContext(c: ClaimedItem, missingField: string): Promise<boolean>;
  markFailed(c: ClaimedItem, category: string, maxAttempts: number): Promise<boolean>;
  health(owner: string): Promise<Record<string, Partial<Record<LedgerStatus, number>>>>;
}

/** Per owner + source: the eTag of the source file last ingested, and when the file was last checked. */
export interface SourceCursor {
  etag: string | null;
  checkedAtMs: number | null;
}

export interface CursorStore {
  get(owner: string, source: CorrespondenceSource): Promise<SourceCursor | null>;
  /** `etag` given => a new file version was ingested; omitted => only the check time moves. */
  set(owner: string, source: CorrespondenceSource, etag?: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------
// Processor seam. The bell (AC section 4) and proposals (section 5) are NOT built in this pass; they plug in
// here. A processor MUST be idempotent per (source, sourceItemId): an item is re-run after a crash between
// its commit and the ledger's `processed` mark, and after a content change.

export type ProcessOutcome =
  | { status: "processed"; resultIds?: Record<string, string[]> }
  | { status: "needs_context"; missingField: string };

export interface ItemProcessor {
  name: "bell" | "proposals";
  /** `batch` = every item whose text this pass holds (all sources), for thread context (a chat's other
   *  messages, whether the log carries the owner's own messages at all). Optional: a processor that only
   *  needs the item ignores it. */
  process(item: SourceItem, ctx: { owner: string; nowMs: number; batch?: readonly SourceItem[] }): Promise<ProcessOutcome>;
}

/**
 * Pure: an error -> a short CATEGORY that is safe to store and log (AC-3.8). Only a message that already
 * looks like a code ("graph_429", "journey:timeout") survives; anything else -- which could carry a body,
 * an address or a token -- becomes "processor_error".
 */
export function errorCategory(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /^[a-z][a-z0-9_:.-]{0,59}$/.test(m) ? m : "processor_error";
}

/** Pure: merge one processor's outcome into the item's combined outcome. needs_context wins over processed
 *  (an item is only `processed` when EVERY enabled processor finished it). */
export function combineOutcomes(outcomes: ProcessOutcome[]): ProcessOutcome {
  const nc = outcomes.find((o) => o.status === "needs_context");
  if (nc) return nc;
  const resultIds: Record<string, string[]> = {};
  for (const o of outcomes) {
    if (o.status !== "processed") continue;
    for (const [k, v] of Object.entries(o.resultIds ?? {})) resultIds[k] = [...(resultIds[k] ?? []), ...v];
  }
  return { status: "processed", resultIds };
}
