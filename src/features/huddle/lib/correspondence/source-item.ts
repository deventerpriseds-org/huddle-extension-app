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
// THIS REPO IS PUBLIC: no addresses, tenant/drive ids or names here. Bodies live only in memory for the
// length of one pass; the ledger stores ids, hashes, statuses and error CATEGORIES only.

import type { InboundMessage } from "../email/inbound-email";
import { FEED_ID_PREFIX } from "../external-feeds/onedrive-feed";

export type CorrespondenceSource = "email" | "teams" | "transcript";
export const CORRESPONDENCE_SOURCES: readonly CorrespondenceSource[] = ["email", "teams", "transcript"];

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
  /** In-memory payload for processors. NEVER persisted by the ledger, never logged. */
  email?: InboundMessage;
  teams?: TeamsMessage;
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
  };
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

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
    ]),
    drivePath: file.path,
    driveItemId: file.itemId ?? null,
    fileEtag: file.etag ?? null,
    internetMessageId,
    email: mapped,
  };
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
  process(item: SourceItem, ctx: { owner: string; nowMs: number }): Promise<ProcessOutcome>;
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
