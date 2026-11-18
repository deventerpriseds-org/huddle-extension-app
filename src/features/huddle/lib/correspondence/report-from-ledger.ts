// WHAT:       Pure core of the open-items report READ FROM THE AZURE LEDGER (chat.correspondence_ledger): stored rows
//             -> the email messages / Sent Items / Teams chats / meeting action items the report scans, the report
//             WINDOW (since Monday 2026-11-09 by default), the RESOLUTION rule (what the owner already dealt with),
//             and the UNINVOLVED-CHAT rule (Teams group / meeting chats he never wrote in and was never @mentioned
//             in). No I/O: the server loader (report-from-ledger.server.ts) supplies the rows.
// WHY:        Owner 2026-11-16: "this report should be running against the table that has everything since Monday.
//             If it hasn't been signaled to be ignored or added as a task etc it should still be showing up so
//             previous days unresolved items aren't overlooked" and "I'm not checking the report until it is
//             running off azure and has all the data". Owner decision 2026-11-16: hide Teams group/meeting chats
//             where he never sent a message AND was never @mentioned; 1:1 chats always show; skip them BEFORE any
//             AI step.
// SUPERSEDES: nothing (the OneDrive-files path of scripts/reply-scan-preview.ts stays, behind source=files).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/report-from-ledger.test.ts; docs/qc-evidence/BUILD-report-from-ledger.md.
//
// THIS REPO IS PUBLIC: no names, ids, addresses or content here. Nothing in this module logs.

import { FEED_ID_PREFIX, latestSentByConversation, type FeedInboundMessage, type OneDriveFeedsConfig, type SentMessage } from "../external-feeds/onedrive-feed";
import { forwardedPartText, forwardedText } from "./forwarded";
import {
  conversationFacts,
  effectiveOwnerNames,
  emailConversationKey,
  groupEmailConversations,
  ownerAddressSet,
  ownerFullNames,
  personNameWordCount,
  type ConversationFacts,
  type NeedsYouContext,
} from "./needs-you";
import type { CorrespondenceContent, CorrespondenceSource, EmailContent, SentContent, TeamsContent, TranscriptContent } from "./source-item";
import { actionItemsOf, splitActionItems } from "../proposals/meeting-triage";
import { titleKey } from "../proposals/proposals";

/** Owner 2026-11-16: the report covers everything since Monday 2026-11-09 00:00 ET (05:00 UTC), not a rolling N days.
 *  Seeded default; the workflow's `since` input overrides it. */
export const REPORT_SINCE_DEFAULT = "2026-11-09T05:00:00Z";

/** One stored ledger row as the report reads it (content present; purged rows are never loaded). */
export interface LedgerReportRow {
  source: CorrespondenceSource;
  sourceItemId: string;
  threadId: string | null;
  at: string | null;
  content: CorrespondenceContent;
}

const ms = (iso: string | null | undefined): number => {
  const v = Date.parse(String(iso ?? ""));
  return Number.isFinite(v) ? v : NaN;
};

// ── WINDOW ──────────────────────────────────────────────────────────────────────────────────────────

/** Pure, THE WINDOW RULE: a conversation / chat / meeting is in the report when its NEWEST item is at or after
 *  `sinceMs`. Older messages of an in-window conversation are kept as context. An item with no readable time is
 *  OUT (it cannot be placed in the window), and is counted by the caller. */
export function inReportWindow(newestMs: number, sinceMs: number): boolean {
  return Number.isFinite(newestMs) && newestMs >= sinceMs;
}

// ── EMAIL / SENT ────────────────────────────────────────────────────────────────────────────────────

/** Pure: stored email rows -> the same FeedInboundMessage shape mapFeedMessage produces (id "feed:<ledger id>", so a
 *  bell row's graph_message_id matches). Recipients come from the stored arrays; when BOTH are empty the record's
 *  recipients are treated as unknown (undefined), exactly as a record with no recipient fields (fail closed: never
 *  "not addressed"). Header facts are not stored, so headerNames is empty. */
export function emailMessagesFromLedger(rows: readonly LedgerReportRow[]): FeedInboundMessage[] {
  const out: FeedInboundMessage[] = [];
  for (const r of rows) {
    if (r.source !== "email" || r.content?.kind !== "email") continue;
    const c = r.content as EmailContent;
    const known = c.to.length + c.cc.length > 0;
    out.push({
      id: `${FEED_ID_PREFIX}${r.sourceItemId}`,
      subject: c.subject,
      receivedDateTime: c.receivedAt ?? r.at,
      bodyPreview: null,
      bodyText: c.bodyText,
      fromAddress: c.from?.address ?? null,
      fromName: c.from?.name ?? null,
      conversationId: c.conversationId ?? r.threadId,
      inferenceClassification: undefined,
      headerNames: [],
      precedence: null,
      autoSubmitted: null,
      ...(known ? { toRecipients: c.to, ccRecipients: c.cc } : {}),
    });
  }
  return out;
}

/** Pure: stored Sent Items rows -> the {conversationId, sentAt} list reply detection uses. */
export function sentFromLedger(rows: readonly LedgerReportRow[]): SentMessage[] {
  const out: SentMessage[] = [];
  for (const r of rows) {
    if (r.source !== "sent" || r.content?.kind !== "sent") continue;
    const c = r.content as SentContent;
    const cid = c.conversationId ?? r.threadId;
    const at = ms(c.sentAt ?? r.at);
    if (cid && Number.isFinite(at)) out.push({ conversationId: cid, sentAt: new Date(at).toISOString() });
  }
  return out;
}

/** Pure: the forwarded part of each stored "Fw:" email (by feed id). 2026-11-16: the STORED forwarded part
 *  (EmailContent.forwarded, read from the raw body at store time) is used first. A row stored before that field
 *  existed falls back to the stored bodyText, which is htmlToText output that already cut an Outlook-marker forward
 *  block, so only a plain-text forward header can be recovered there; the rest are counted in `missing` (the
 *  back-fill with apply re-writes those rows' content). */
export function forwardsFromLedger(rows: readonly LedgerReportRow[]): { forwards: Map<string, string>; isForward: number; missing: number } {
  const forwards = new Map<string, string>();
  let isForward = 0;
  let missing = 0;
  for (const r of rows) {
    if (r.source !== "email" || r.content?.kind !== "email") continue;
    const c = r.content as EmailContent;
    if (!c.isForward) continue;
    isForward++;
    const stored = c.forwarded && (c.forwarded.body || c.forwarded.from) ? forwardedPartText(c.forwarded) : "";
    const t = stored || forwardedText(c.subject, c.bodyText, false);
    if (t) forwards.set(`${FEED_ID_PREFIX}${r.sourceItemId}`, t);
    else missing++;
  }
  return { forwards, isForward, missing };
}

// ── TEAMS: chat kind + THE UNINVOLVED-CHAT RULE ─────────────────────────────────────────────────────

export type TeamsChatKind = "one_on_one" | "group" | "meeting" | "channel" | "unknown";

/** Pure: the kind of a Teams chat from its Graph id shape (probe P-3): an id ending "unq.gbl.spaces" = 1:1, one
 *  starting "19:meeting_" = a meeting chat, ending "thread.tacv2" = a channel, ending "thread.v2" = a group chat.
 *  (Written without the at-sign so the public-repo address check does not read the suffixes as mail domains.) */
export function teamsChatKind(chatId: string): TeamsChatKind {
  const id = String(chatId ?? "").toLowerCase();
  if (/[\x40]unq\.gbl\.spaces$/.test(id)) return "one_on_one";
  if (/^19:meeting_/.test(id)) return "meeting";
  if (/[\x40]thread\.tacv2$/.test(id)) return "channel";
  if (/[\x40]thread\.v2$/.test(id)) return "group";
  return "unknown";
}

export type ChatInvolvementReason =
  | "one_on_one"
  | "not_group_or_meeting"
  | "owner_sent"
  | "owner_mentioned"
  | "owner_maybe_mentioned"
  | "uninvolved"
  | "cant_tell_owner_unknown"
  | "cant_tell_no_mention_data"
  /** A stored row was malformed in a way the rule did not expect (it threw); the chat shows. */
  | "cant_tell_malformed";

export interface ChatInvolvement {
  hide: boolean;
  kind: TeamsChatKind;
  reason: ChatInvolvementReason;
}

/**
 * UNINVOLVED_CHAT_RULE (owner decision 2026-11-16), pure and reusable by the in-app judge:
 *   A Teams GROUP, MEETING or CHANNEL chat is HIDDEN when the owner never sent a message in it AND was never
 *   @mentioned in it. 1:1 chats ALWAYS show. Chats of unknown kind are not covered by the decision and show.
 *   Team / channel / tag mentions name no user and are not aimed at the owner (owner decision 2026-11-17, below).
 *   ONE implementation: the open-items report and the Actions view (lib/actions) both call this.
 * Identity: the owner's Teams ids are the configured `teams.ownerSenderIds` plus every stored message's line
 * `ownerUserId`; mention ids are the same GUID format; all compared case-insensitively.
 * FAIL TOWARD SHOWING: the chat is hidden only when BOTH facts are known for EVERY message -- whose message it is
 * (`fromOwner` true/false, never null) and who it mentions (`mentionedUserIds` present) -- and the owner's ids are
 * known. Missing data is "can't tell", and a can't-tell chat SHOWS.
 * A mention that names no comparable user -- @Everyone (a conversation/chat mention), a tag, an app, a team or a
 * channel, an empty or malformed entry (stored `unresolvedMention: true`), or, on rows stored before that flag
 * existed, an `<at>` tag left in the stored text with no stored user mention -- MAY address the owner, so the chat
 * SHOWS ("owner_maybe_mentioned"; verifier report-from-ledger-1, finding 1).
 * EXCEPT (owner decision 2026-11-17): a message whose only such mentions are provably team / channel / tag mentions
 * (stored `groupMentionOnly: true, chatWideMention: false`) is not aimed at the owner and does not show the chat.
 * @Everyone (`chatWideMention: true`) IS aimed at him and still shows; rows stored without the kind flags show.
 * Spelling table: docs/qc-evidence/BUILD-actions-cap-tag-rule.md.
 * `messages` = every stored message of the chat (not only the window's): "never sent" means never, in the data held.
 */
export function chatInvolvement(chatId: string, messages: readonly TeamsContent[], configuredOwnerIds: readonly string[] = [], crossChatOwnerIds: readonly string[] = []): ChatInvolvement {
  // Verifier report-from-ledger-1, finding 2: one malformed stored row must never throw out of the rule (it aborted
  // the whole report). Anything unexpected -> can't tell -> SHOW.
  try {
    return chatInvolvementOf(chatId, messages, configuredOwnerIds, crossChatOwnerIds);
  } catch {
    return { hide: false, kind: teamsChatKind(String(chatId ?? "")), reason: "cant_tell_malformed" };
  }
}

/** `crossChatOwnerIds` (loop-2 D-5): the owner's ids learned from OTHER chats' rows (ownerTeamsIdsAcross). They may
 *  only make a chat SHOW (he sent / was mentioned). Whether the owner's ids count as KNOWN for hiding is decided by
 *  the configured ids and this chat's own rows only, exactly as before the cross-chat lookup: a chat with no owner
 *  id of its own stays `cant_tell_owner_unknown` (shown) even when its rows say `fromOwner: false`. */
function chatInvolvementOf(chatId: string, messages: readonly TeamsContent[], configuredOwnerIds: readonly string[], crossChatOwnerIds: readonly string[]): ChatInvolvement {
  const kind = teamsChatKind(chatId);
  if (kind === "one_on_one") return { hide: false, kind, reason: "one_on_one" };
  // 2026-11-16 (Actions view, owner's accepted answers): team CHANNELS (thread.tacv2) are treated like group chats.
  if (kind !== "group" && kind !== "meeting" && kind !== "channel") return { hide: false, kind, reason: "not_group_or_meeting" };
  const ownIds = teamsOwnerIds(messages, configuredOwnerIds);
  const ownerIds = teamsOwnerIds(messages, [...configuredOwnerIds, ...(crossChatOwnerIds ?? [])]);
  if (messages.some((m) => isOwnerMessage(m, ownerIds))) return { hide: false, kind, reason: "owner_sent" };
  // Array.isArray BEFORE .some (finding 2): a string / object stored in the field is "no mention data" (shows below).
  if (messages.some((m) => m.mentionsOwner === true || mentionsOwnerId(m, ownerIds))) return { hide: false, kind, reason: "owner_mentioned" };
  if (messages.some(maybeMentionsOwner)) return { hide: false, kind, reason: "owner_maybe_mentioned" };
  if (!ownIds.size || messages.some((m) => m.fromOwner === null || m.fromOwner === undefined)) return { hide: false, kind, reason: "cant_tell_owner_unknown" };
  if (!messages.length || messages.some((m) => !Array.isArray(m.mentionedUserIds))) return { hide: false, kind, reason: "cant_tell_no_mention_data" };
  return { hide: true, kind, reason: "uninvolved" };
}

/** THE ONE Teams id normaliser for the uninvolved-chat rule AND the chat facts (verifier report-from-ledger-1,
 *  finding 5: the two sites used to normalise differently): trim + lower-case; anything not a string is "" and
 *  never matches. */
export const normTeamsId = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Pure: the owner's Teams ids for one chat -- the configured ids plus every stored message's line `ownerUserId`,
 *  all through normTeamsId. Shared by chatInvolvement and teamsChatsFromLedger. */
export function teamsOwnerIds(messages: readonly TeamsContent[], configuredOwnerIds: readonly string[] = []): Set<string> {
  const ids = new Set<string>();
  for (const id of configuredOwnerIds ?? []) if (normTeamsId(id)) ids.add(normTeamsId(id));
  for (const m of messages) if (normTeamsId(m.ownerUserId)) ids.add(normTeamsId(m.ownerUserId));
  return ids;
}

/** Pure: is this stored message the owner's -- `fromOwner: true`, or its sender id is one of the owner's ids. */
export function isOwnerMessage(m: TeamsContent, ownerIds: ReadonlySet<string>): boolean {
  const sid = normTeamsId(m.sender?.id);
  return m.fromOwner === true || (!!sid && ownerIds.has(sid));
}

/** Pure: does this stored message's user-mention list name one of the owner's ids (array checked first). */
function mentionsOwnerId(m: TeamsContent, ownerIds: ReadonlySet<string>): boolean {
  return Array.isArray(m.mentionedUserIds) && m.mentionedUserIds.some((id) => !!normTeamsId(id) && ownerIds.has(normTeamsId(id)));
}

/** Pure: does this stored message carry a mention that MAY address the owner but names no comparable user id?
 *  New rows: the parser's `unresolvedMention` flag. Rows stored before the flag existed: an `<at` tag still present
 *  in the stored text (only an escaped `&lt;at&gt;` survives the HTML-to-text step) with no stored user mention. */
export function maybeMentionsOwner(m: TeamsContent): boolean {
  // Owner decision 2026-11-17: an unresolved mention that is ONLY team / channel / tag mentions is not aimed at him.
  // Both per-kind flags must be stored and say so; an older row (no kind flags) or @Everyone still SHOWS.
  const groupOnly = m.groupMentionOnly === true && m.chatWideMention === false;
  if (m.unresolvedMention === true && !groupOnly) return true;
  // Finding 4: a stored mention entry that is not a non-empty string (empty id, null, a number) names someone we
  // cannot compare -> unknown -> the chat shows. (The parser no longer writes such entries; older writers might.)
  if (Array.isArray(m.mentionedUserIds) && m.mentionedUserIds.some((id) => typeof id !== "string" || !id.trim())) return true;
  if (m.unresolvedMention === true || m.unresolvedMention === false) return false;
  const users = Array.isArray(m.mentionedUserIds) ? m.mentionedUserIds.length : 0;
  return users === 0 && /<at\b/i.test(typeof m.text === "string" ? m.text : "");
}

export interface TeamsThreadMessage {
  /** The ledger source_item_id of the message. */
  id: string;
  at: string;
  speaker: "OWNER" | "OTHER";
  name: string;
  text: string;
}

export interface TeamsChatFacts {
  chatId: string;
  chatName: string | null;
  kind: TeamsChatKind;
  messages: TeamsThreadMessage[];
  latestOther: TeamsThreadMessage | null;
  /** The owner wrote in the chat AFTER the latest OTHER message. */
  settled: boolean;
  /** Was the owner @mentioned anywhere in the chat (null = no mention data). */
  ownerMentioned: boolean | null;
  involvement: ChatInvolvement;
  webUrl: string | null;
  newestMs: number;
}

/** Pure: a display name folded for comparison: lower-case, whitespace collapsed, and "Last, First" turned into
 *  "first last" (Teams shows many tenants' names as "Last, First"). */
export function foldPersonName(v: unknown): string {
  // 2026-11-18 red-team RT-13 / RT-14: NFC, and zero-width / format characters (\p{Cf}, e.g. U+200B) removed, so an
  // NFD display name or one with an invisible trailing character still folds to his name.
  const s = typeof v === "string" ? v.normalize("NFC").replace(/\p{Cf}/gu, "").trim().replace(/\s+/g, " ").toLowerCase() : "";
  const m = /^([^,]+),\s*([^,]+)$/.exec(s);
  return m ? `${m[2].trim()} ${m[1].trim()}` : s;
}

/**
 * Pure (2026-11-17, owner report "the sender and receiver are wrong"): THE OWNER'S TEAMS IDS ACROSS EVERY STORED
 * TEAMS ROW -- the configured ids plus every row's line `ownerUserId`, through normTeamsId. It used to be built PER
 * CHAT, so a chat whose own rows carried no `ownerUserId` had NO owner id, and the owner's own message was labelled
 * OTHER and judged as someone asking him (live probe 2026-11-17: 37 of 69 recent messages were the owner's, none
 * carried the id). The owner is one person, so an id seen on any of his capture lines is his everywhere.
 * NAMES (F4, 2026-11-18; this used to be a last resort, only when no id was known): a sender whose display name
 * (foldPersonName) is one of the owner's names (`ownerNames` = the resolved "Names that are you", 2+ words) ALWAYS
 * contributes its sender ID, so his second account counts as him too. App senders never count.
 * LOOP-2 D-4 (one bad row must not promote a sender to OWNER in every chat): a row's `ownerUserId` is taken
 * ACROSS chats only when that id is on rows of AT LEAST 2 DIFFERENT chats. When no id reaches that, the single
 * MOST FREQUENT id is taken, only when it is on 2+ rows and strictly ahead of every other id. Configured ids always
 * count. (Within its OWN chat a row's `ownerUserId` still counts, as it did before: teamsOwnerIds in chatFacts.)
 * The real fix is the capture flow writing `ownerUserId` again, or `teams.ownerSenderIds` configured.
 */
export function ownerTeamsIdsAcross(rows: readonly LedgerReportRow[], configuredOwnerIds: readonly string[] = [], ownerNames: readonly string[] = []): string[] {
  const contents: TeamsContent[] = [];
  for (const r of rows) if (r?.source === "teams" && r.content?.kind === "teams") contents.push(r.content as TeamsContent);
  const ids = new Set<string>();
  for (const id of configuredOwnerIds ?? []) if (normTeamsId(id)) ids.add(normTeamsId(id));
  const seen = new Map<string, { chats: Set<string>; rows: number }>();
  for (const c of contents) {
    const id = normTeamsId(c?.ownerUserId);
    if (!id) continue;
    const e = seen.get(id) ?? seen.set(id, { chats: new Set(), rows: 0 }).get(id)!;
    e.chats.add(String(c?.chatId ?? ""));
    e.rows++;
  }
  const multiChat = [...seen].filter(([, e]) => e.chats.size >= 2).map(([id]) => id);
  if (multiChat.length) for (const id of multiChat) ids.add(id);
  else {
    const ranked = [...seen].sort((a, b) => b[1].rows - a[1].rows);
    if (ranked.length && ranked[0][1].rows >= 2 && (ranked.length === 1 || ranked[0][1].rows > ranked[1][1].rows)) ids.add(ranked[0][0]);
  }
  // F4 (AC-actions-safety-and-invites, owner-approved 2026-11-18): the owner's own names ("Names that are you", the
  // resolved ActionsSettings.ownNames) mark a sender as the OWNER ALWAYS, not only when no id is known: his second
  // account has its own id and his full name. Loop-2 D-3 still holds: FULL names only (two or more name words), so a
  // bare first name never marks a sender as the owner. App senders never count.
  const names = new Set((ownerNames ?? []).filter((n) => personNameWordCount(n) >= 2).map(foldPersonName).filter(Boolean));
  for (const c of contents) {
    const sid = normTeamsId(c?.sender?.id);
    if (sid && c?.sender?.isApp !== true && names.has(foldPersonName(c?.sender?.name))) ids.add(sid);
  }
  return [...ids];
}

/** Pure: stored Teams rows -> one facts object per chat (every stored message, oldest first). The owner's ids are
 *  taken across ALL the rows given (ownerTeamsIdsAcross), never per chat. */
export function teamsChatsFromLedger(rows: readonly LedgerReportRow[], configuredOwnerIds: readonly string[] = [], ownerNames: readonly string[] = []): TeamsChatFacts[] {
  const byChat = new Map<string, { id: string; c: TeamsContent }[]>();
  for (const r of rows) {
    if (r.source !== "teams" || r.content?.kind !== "teams") continue;
    const c = r.content as TeamsContent;
    const k = c.chatId || r.threadId || "";
    if (!k) continue;
    (byChat.get(k) ?? byChat.set(k, []).get(k)!).push({ id: r.sourceItemId, c });
  }
  const ownerIdsAll = ownerTeamsIdsAcross(rows, configuredOwnerIds, ownerNames);
  const out: TeamsChatFacts[] = [];
  for (const [chatId, list] of byChat) {
    // Finding 2: one bad row can never abort the report -- a chat whose facts cannot be built SHOWS, with the
    // defensively-built facts below.
    try {
      out.push(chatFacts(chatId, list, configuredOwnerIds, ownerIdsAll));
    } catch {
      out.push(malformedChatFacts(chatId, list));
    }
  }
  return out.sort((a, b) => b.newestMs - a.newestMs);
}

/** Pure, never throws: the facts of a chat whose stored rows broke the normal path. It SHOWS (fail open); every
 *  message is OTHER unless it is explicitly `fromOwner: true`, and owner-mentioned is unknown. */
function malformedChatFacts(chatId: string, list: readonly { id: string; c: TeamsContent }[]): TeamsChatFacts {
  const kind = teamsChatKind(String(chatId ?? ""));
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  const messages: TeamsThreadMessage[] = list.map((x) => ({
    id: s(x?.id),
    at: s(x?.c?.at),
    speaker: x?.c?.fromOwner === true ? "OWNER" : "OTHER",
    name: (s(x?.c?.sender?.name) || "unknown").slice(0, 120),
    text: s(x?.c?.text).slice(0, 4000),
  }));
  messages.sort((a, b) => (ms(a.at) || 0) - (ms(b.at) || 0));
  const others = messages.filter((m) => m.speaker === "OTHER");
  const newestMs = Math.max(...messages.map((m) => ms(m.at)).filter(Number.isFinite), -Infinity);
  return { chatId, chatName: null, kind, messages, latestOther: others[others.length - 1] ?? null, settled: false, ownerMentioned: null, involvement: { hide: false, kind, reason: "cant_tell_malformed" }, webUrl: null, newestMs };
}

function chatFacts(chatId: string, list: readonly { id: string; c: TeamsContent }[], configuredOwnerIds: readonly string[], crossChatOwnerIds: readonly string[] = []): TeamsChatFacts {
  {
    const sorted = [...list].sort((a, b) => (ms(a.c.at) || 0) - (ms(b.c.at) || 0));
    const contents = sorted.map((x) => x.c);
    const involvement = chatInvolvement(chatId, contents, configuredOwnerIds, crossChatOwnerIds);
    // Finding 5: the SAME owner-id set and normaliser as chatInvolvement (teamsOwnerIds / normTeamsId).
    const ownerIds = teamsOwnerIds(contents, [...configuredOwnerIds, ...crossChatOwnerIds]);
    const isOwner = (c: TeamsContent) => isOwnerMessage(c, ownerIds);
    const messages: TeamsThreadMessage[] = sorted.map((x) => ({
      id: x.id,
      at: x.c.at,
      speaker: isOwner(x.c) ? "OWNER" : "OTHER",
      name: String(x.c.sender?.name || "unknown").slice(0, 120),
      text: String(x.c.text ?? "").slice(0, 4000),
    }));
    const others = messages.filter((m) => m.speaker === "OTHER");
    const latestOther = others[others.length - 1] ?? null;
    const lo = latestOther ? ms(latestOther.at) : NaN;
    const settled = !!latestOther && messages.some((m) => m.speaker === "OWNER" && ms(m.at) > lo);
    const anyMentionData = contents.some((c) => Array.isArray(c.mentionedUserIds));
    const mentioned = contents.some((c) => c.mentionsOwner === true || mentionsOwnerId(c, ownerIds));
    const maybe = contents.some(maybeMentionsOwner);
    const newestMs = Math.max(...sorted.map((x) => ms(x.c.at)).filter(Number.isFinite), -Infinity);
    const named = [...contents].reverse().find((c) => c.chatName)?.chatName ?? null;
    const link = [...contents].reverse().find((c) => c.webUrl)?.webUrl ?? null;
    return { chatId, chatName: named, kind: involvement.kind, messages, latestOther, settled, ownerMentioned: mentioned ? true : maybe ? null : anyMentionData ? false : null, involvement, webUrl: link, newestMs };
  }
}

// ── RESOLUTION: what the owner already dealt with ───────────────────────────────────────────────────

/** Proposal states that mean the owner decided the item: added as a task (approved), done (completed), ignored
 *  (dismissed), or passed to someone (delegated, meeting triage "For someone"). `proposed` and `untriaged` are
 *  still WAITING on him and do not resolve anything. */
export const RESOLVED_PROPOSAL_STATES = ["approved", "completed", "dismissed", "delegated"] as const;
/** Bell (chat.email_replies) statuses that mean the owner dealt with it: dismissed. `replied` is NOT a resolution
 *  here -- an answer can still leave something to do, and replies are already read from Sent Items / the chat
 *  itself; `owed` / `drafted` are still open. */
export const RESOLVED_BELL_STATUSES = ["dismissed"] as const;

export interface ProposalSignalRow {
  source: string;
  sourceItemId: string;
  normTitle: string;
  state: string;
  /** decided_at, else updated_at. */
  decidedAt: string | null;
}

export interface BellSignalRow {
  kind: string;
  graphMessageId: string;
  conversationId: string | null;
  status: string;
  receivedAt: string | null;
}

export type ResolvedVia = "task_proposal" | "bell_dismissed";

export interface ResolutionSignal {
  /** email: the conversation key (emailConversationKey); teams: "teams:<chatId>". */
  thread: string;
  /** The signal covers every message up to this time. */
  coversUntilMs: number;
  via: ResolvedVia;
  state: string;
}

export const teamsThreadKey = (chatId: string) => `teams:${chatId}`;

/** Pure: the thread + time of each stored email / Teams message, keyed "<source>\u0000<ledger id>". */
export function messageLookup(rows: readonly LedgerReportRow[], mailbox: string): Map<string, { thread: string; atMs: number }> {
  const m = new Map<string, { thread: string; atMs: number }>();
  for (const r of rows) {
    if (r.source === "email" && r.content?.kind === "email") {
      const c = r.content as EmailContent;
      m.set(`email\u0000${r.sourceItemId}`, {
        thread: emailConversationKey(mailbox, { id: `${FEED_ID_PREFIX}${r.sourceItemId}`, conversationId: c.conversationId ?? r.threadId }),
        atMs: ms(c.receivedAt ?? r.at),
      });
    } else if (r.source === "teams" && r.content?.kind === "teams") {
      const c = r.content as TeamsContent;
      m.set(`teams\u0000${r.sourceItemId}`, { thread: teamsThreadKey(c.chatId || r.threadId || ""), atMs: ms(c.at ?? r.at) });
    }
  }
  return m;
}

/**
 * Pure, THE RESOLUTION RULE. Proposal refs (chat.task_proposal_refs joined to chat.task_proposals) and bell rows
 * (chat.email_replies) -> signals "the owner dealt with this thread up to time T":
 *  - an email proposal keyed by the CONVERSATION (`<mailbox>:conv:<id>` / `<mailbox>:msg:<id>`, the needs-you engine's
 *    key) covers its conversation up to the decision time;
 *  - an email / Teams proposal keyed by ONE ledger message covers that message's thread up to that message's time;
 *  - a dismissed email bell row covers its message's thread up to the message's receipt; a dismissed chat bell row
 *    covers its chat up to the ask it held.
 * Transcript refs are not threads (see meetingItemsFromLedger). Rows in other states produce nothing.
 */
export function resolutionSignals(
  proposals: readonly ProposalSignalRow[],
  bell: readonly BellSignalRow[],
  lookup: ReadonlyMap<string, { thread: string; atMs: number }>,
  mailbox: string,
): ResolutionSignal[] {
  const out: ResolutionSignal[] = [];
  const resolvedP = new Set<string>(RESOLVED_PROPOSAL_STATES);
  const resolvedB = new Set<string>(RESOLVED_BELL_STATUSES);
  for (const p of proposals) {
    if (!resolvedP.has(p.state)) continue;
    if (p.source === "email" && (p.sourceItemId.startsWith(`${mailbox}:conv:`) || p.sourceItemId.startsWith(`${mailbox}:msg:`))) {
      const at = ms(p.decidedAt);
      if (Number.isFinite(at)) out.push({ thread: p.sourceItemId, coversUntilMs: at, via: "task_proposal", state: p.state });
      continue;
    }
    if (p.source !== "email" && p.source !== "teams") continue;
    const hit = lookup.get(`${p.source}\u0000${p.sourceItemId}`);
    if (hit && Number.isFinite(hit.atMs)) out.push({ thread: hit.thread, coversUntilMs: hit.atMs, via: "task_proposal", state: p.state });
  }
  for (const b of bell) {
    if (!resolvedB.has(b.status)) continue;
    const received = ms(b.receivedAt);
    if (b.kind === "email") {
      const sid = b.graphMessageId.startsWith(FEED_ID_PREFIX) ? b.graphMessageId.slice(FEED_ID_PREFIX.length) : b.graphMessageId;
      const hit = lookup.get(`email\u0000${sid}`);
      if (hit) {
        const at = Math.max(hit.atMs, Number.isFinite(received) ? received : -Infinity);
        if (Number.isFinite(at)) out.push({ thread: hit.thread, coversUntilMs: at, via: "bell_dismissed", state: b.status });
      } else if (b.conversationId && Number.isFinite(received)) {
        out.push({ thread: `${mailbox}:conv:${b.conversationId}`, coversUntilMs: received, via: "bell_dismissed", state: b.status });
      }
    } else if (b.kind === "chat" && b.conversationId && Number.isFinite(received)) {
      out.push({ thread: teamsThreadKey(b.conversationId), coversUntilMs: received, via: "bell_dismissed", state: b.status });
    }
  }
  return out;
}

/** Pure: is this thread resolved? Only when a signal covers its LATEST message from someone else -- anything newer
 *  than what the owner dealt with brings the thread back. Returns the covering signal, or null. */
export function threadResolution(thread: string, latestOtherMs: number, signals: readonly ResolutionSignal[]): ResolutionSignal | null {
  if (!Number.isFinite(latestOtherMs)) return null;
  let best: ResolutionSignal | null = null;
  for (const s of signals) if (s.thread === thread && s.coversUntilMs >= latestOtherMs && (!best || s.coversUntilMs > best.coversUntilMs)) best = s;
  return best;
}

// ── MEETINGS ────────────────────────────────────────────────────────────────────────────────────────

export interface MeetingItems {
  meetingId: string;
  title: string | null;
  meetingAt: string | null;
  newestMs: number;
  open: string[];
  /** The heading (assignee name, as Fireflies wrote it) each open item sat under; aligned with `open`. */
  openHeadings: (string | null)[];
  resolved: { item: string; state: string }[];
}

/** Pure: stored transcripts -> each meeting's Fireflies action items (the SAME splitter meeting triage uses), with
 *  the items the owner already triaged (a transcript proposal ref for that meeting + item key in a resolved state)
 *  set aside. A meeting with no action items is returned with both lists empty. */
export function meetingItemsFromLedger(rows: readonly LedgerReportRow[], proposals: readonly ProposalSignalRow[]): MeetingItems[] {
  const resolvedP = new Set<string>(RESOLVED_PROPOSAL_STATES);
  const decided = new Map<string, string>();
  for (const p of proposals) if (p.source === "transcript" && resolvedP.has(p.state)) decided.set(`${p.sourceItemId}\u0000${p.normTitle}`, p.state);
  const out: MeetingItems[] = [];
  for (const r of rows) {
    if (r.source !== "transcript" || r.content?.kind !== "transcript") continue;
    const c = r.content as TranscriptContent;
    const split = splitActionItems(actionItemsOf(c.summary as { action_items?: unknown } | null));
    const open: string[] = [];
    const openHeadings: (string | null)[] = [];
    const resolved: { item: string; state: string }[] = [];
    split.items.forEach((item, i) => {
      const st = decided.get(`${r.sourceItemId}\u0000${titleKey(item)}`);
      if (st) resolved.push({ item, state: st });
      else {
        open.push(item);
        openHeadings.push(split.headings[i] ?? null);
      }
    });
    out.push({ meetingId: r.sourceItemId, title: c.title, meetingAt: c.meetingAt ?? r.at, newestMs: ms(c.meetingAt ?? r.at), open, openHeadings, resolved });
  }
  return out.sort((a, b) => (b.newestMs || 0) - (a.newestMs || 0));
}

// ── THE PLAN: what goes to the AI, what is set aside and why ────────────────────────────────────────

export interface LedgerReportPlan {
  email: { scan: ConversationFacts[]; resolved: { f: ConversationFacts; via: ResolutionSignal }[]; outOfWindow: number };
  teams: {
    scan: TeamsChatFacts[];
    /** UNINVOLVED_CHAT_RULE: set aside BEFORE any AI step (owner decision 2026-11-16). */
    hiddenUninvolved: TeamsChatFacts[];
    resolved: { c: TeamsChatFacts; via: ResolutionSignal }[];
    /** Group / meeting chats shown only because the rule could not tell (missing owner id or mention data, or a
     *  mention that names no comparable user, e.g. @Everyone). */
    cantTell: number;
    outOfWindow: number;
  };
  meetings: { inWindow: MeetingItems[]; outOfWindow: number };
}

const newestOf = (f: ConversationFacts) => Math.max(...f.messages.map((m) => ms(m.at)).filter(Number.isFinite), -Infinity);

/**
 * Pure: apply, in this order, the WINDOW rule, the UNINVOLVED-CHAT rule (Teams only, before any AI call) and the
 * RESOLUTION rule. Whatever is not set aside is scanned. Owner-only threads (no OTHER message) are never "resolved"
 * here; the scan counts them.
 */
export function planLedgerReport(a: {
  emailFacts: readonly ConversationFacts[];
  teams: readonly TeamsChatFacts[];
  meetings: readonly MeetingItems[];
  signals: readonly ResolutionSignal[];
  sinceMs: number;
}): LedgerReportPlan {
  const plan: LedgerReportPlan = {
    email: { scan: [], resolved: [], outOfWindow: 0 },
    teams: { scan: [], hiddenUninvolved: [], resolved: [], cantTell: 0, outOfWindow: 0 },
    meetings: { inWindow: [], outOfWindow: 0 },
  };
  for (const f of a.emailFacts) {
    if (!inReportWindow(newestOf(f), a.sinceMs)) {
      plan.email.outOfWindow++;
      continue;
    }
    const via = f.latestOther ? threadResolution(f.key, ms(f.latestOther.at), a.signals) : null;
    if (via) plan.email.resolved.push({ f, via });
    else plan.email.scan.push(f);
  }
  for (const c of a.teams) {
    if (!inReportWindow(c.newestMs, a.sinceMs)) {
      plan.teams.outOfWindow++;
      continue;
    }
    if (c.involvement.hide) {
      plan.teams.hiddenUninvolved.push(c);
      continue;
    }
    if (c.involvement.reason === "cant_tell_owner_unknown" || c.involvement.reason === "cant_tell_no_mention_data" || c.involvement.reason === "owner_maybe_mentioned" || c.involvement.reason === "cant_tell_malformed") plan.teams.cantTell++;
    const via = c.latestOther ? threadResolution(teamsThreadKey(c.chatId), ms(c.latestOther.at), a.signals) : null;
    if (via) plan.teams.resolved.push({ c, via });
    else plan.teams.scan.push(c);
  }
  for (const m of a.meetings) {
    if (inReportWindow(m.newestMs, a.sinceMs)) plan.meetings.inWindow.push(m);
    else plan.meetings.outOfWindow++;
  }
  return plan;
}

// ── ASSEMBLY: stored rows -> facts -> the plan (shared by the report script and the Actions view) ────

export interface AssembledLedgerPlan {
  ctx: NeedsYouContext;
  plan: LedgerReportPlan;
  /** Forwarded part of stored "Fw:" emails, by feed id. */
  forwards: Map<string, string>;
  forwardsMissing: number;
  forwardsTotal: number;
  signals: ResolutionSignal[];
}

/** Pure: everything the report script built by hand from loadLedgerReportData's rows, in one place, so the report
 *  and the Actions view (lib/actions) cannot drift. */
export function assembleLedgerPlan(
  data: { rows: readonly LedgerReportRow[]; proposals: readonly ProposalSignalRow[]; bell: readonly BellSignalRow[] },
  cfg: Pick<OneDriveFeedsConfig, "mailbox" | "ownerLogins" | "correspondence" | "teams">,
  sinceMs: number,
  /** F4: the resolved "Names that are you" (ActionsSettings.ownNames). Absent = the configured full names (its seed).
   *  The ONE owner-name input for Teams identity, the source label and the model's owner-name context (X-6). */
  ownNames?: readonly string[],
): AssembledLedgerPlan {
  const sent = sentFromLedger(data.rows);
  const own = [...(ownNames ?? ownerFullNames(cfg))];
  const ctx: NeedsYouContext = { ownerAddresses: ownerAddressSet(cfg), ownerNames: [...new Set([...effectiveOwnerNames(cfg), ...own])], ownerFullNames: own, latestSent: latestSentByConversation(sent), sentKnown: sent.length > 0 };
  const emailFacts = [...groupEmailConversations(cfg.mailbox, emailMessagesFromLedger(data.rows))].map(([k, msgs]) => conversationFacts(k, msgs, ctx));
  const teams = teamsChatsFromLedger(data.rows, cfg.teams.ownerSenderIds, ctx.ownerFullNames ?? []);
  const meetings = meetingItemsFromLedger(data.rows, data.proposals);
  const signals = resolutionSignals(data.proposals, data.bell, messageLookup(data.rows, cfg.mailbox), cfg.mailbox);
  const fw = forwardsFromLedger(data.rows);
  return { ctx, plan: planLedgerReport({ emailFacts, teams, meetings, signals, sinceMs }), forwards: fw.forwards, forwardsMissing: fw.missing, forwardsTotal: fw.isForward, signals };
}
