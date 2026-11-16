// WHAT:       The `bell` processor for correspondence ingest: decides, per Teams chat thread, whether the
//             owner owes a reply, and keeps ONE row per chat in the EXISTING attention bell
//             (chat.email_replies, kind 'chat'). Pure decision + an injected store.
// WHY:        AC docs/ac/AC-correspondence-checklist.md section 4 + owner decisions (2026-11-12): unanswered
//             correspondence in the existing bell; a chat settles when the owner later posts in THAT chat
//             (or on Dismiss); "can't tell" (listed, not counted) when the owner's own messages are not
//             available -- never "unanswered". No second bell, no new table.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/correspondence-ingest.test.ts section J; scripts/correspondence-ledger-sql.test.ts (bell SQL).
//
// Email items are NOT announced here: the existing inbox watch already announces each feed email once
// (AC-2.7), and work emails settle from the Sent Items snapshot in reconcileRepliedFromSentItems.
// Nothing is ever sent: no email, no Teams message, no draft (AC-4.12).

import { asksSomething, isAutomatedAddress, shortHash } from "../email/inbound-email";
import { attentionId, EMAIL_ALERT_HUDDLE } from "../attention/attention";
import type { ItemProcessor, ProcessOutcome, SourceItem, TeamsMessage } from "./source-item";

export type ChatDecision =
  | { state: "open"; ask: TeamsMessage; missing: "owner_teams_id" | "owner_messages" | null }
  | { state: "answered"; ownerReplyAt: string }
  | { state: "nothing" };

/** Pure (AC-4.8): a chat message that could need the owner -- a person (not an app/bot, not an automated
 *  address), not the owner, whose own new text asks something (quoted history already stripped). */
export function chatMessageAsks(m: TeamsMessage): boolean {
  if (m.senderIsApp || m.fromOwner === true) return false;
  if (m.senderId.includes("@") && isAutomatedAddress(m.senderId)) return false;
  // Red-team F17: a link's "?" is a query string, not a question -- URLs are removed before the heuristic
  // whatever path produced the text (the HTML converter already does this; plain text did not).
  return asksSomething({ subject: "", bodyText: m.text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]") });
}

/**
 * Pure: one chat thread's messages -> the bell decision.
 *  - the newest asking message LATER than the owner's last message in the chat is the open ask (AC-4.9:
 *    four questions in a row are one item, the newest);
 *  - no such ask and an owner message exists => answered at that time (AC-4.5 / 4.13);
 *  - an open ask when the owner's ids are not configured => missing owner_teams_id; when the log carries no
 *    owner message in THIS chat => missing owner_messages (per chat, red-team S2). Both are "can't tell" (AC-4.6), never owed.
 */
export function decideChatThread(messages: readonly TeamsMessage[], ownerMessagesExported: boolean): ChatDecision {
  const sorted = [...messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let lastOwner: TeamsMessage | null = null;
  for (const m of sorted) if (m.fromOwner === true) lastOwner = m;
  const ownerAt = lastOwner ? Date.parse(lastOwner.at) : -Infinity;
  let ask: TeamsMessage | null = null;
  for (const m of sorted) if (Date.parse(m.at) > ownerAt && chatMessageAsks(m)) ask = m;
  if (ask) {
    const configured = sorted.every((m) => m.fromOwner !== null);
    return { state: "open", ask, missing: !configured ? "owner_teams_id" : !ownerMessagesExported ? "owner_messages" : null };
  }
  if (lastOwner) return { state: "answered", ownerReplyAt: lastOwner.at };
  return { state: "nothing" };
}

export interface ChatAttentionStore {
  upsert(r: {
    id: string;
    ownerEmail: string;
    chatId: string;
    askSourceId: string;
    askAt: string;
    senderName: string | null;
    chatName: string | null;
    link: string | null;
    needsContext: string | null;
    huddleId: string;
  }): Promise<boolean>;
  settle(id: string, ownerEmail: string, ownerReplyAt: string): Promise<boolean>;
}

/** The bell row id of a chat thread for an owner: `attn-chat-<hash>` -- cannot equal an email row (a bare
 *  16-hex short hash) or a meeting/appointment row (`attn-meeting-` / `attn-appointment-`). */
export const chatAttentionId = (owner: string, chatId: string) => attentionId("chat", shortHash(`${owner.toLowerCase()}\u0000${chatId}`));

/**
 * The bell processor. One instance per pass: a chat is decided once per pass however many of its
 * messages are claimed (each message reuses the chat's outcome). Idempotent across passes (the store's
 * upsert/settle are no-ops when nothing changed).
 */
export function makeBellProcessor(store: ChatAttentionStore): ItemProcessor {
  const decided = new Map<string, Promise<ProcessOutcome>>();
  return {
    name: "bell",
    async process(item: SourceItem, ctx): Promise<ProcessOutcome> {
      if (item.source !== "teams" || !item.teams) return { status: "processed" };
      const chatId = item.teams.chatId;
      const prior = decided.get(chatId);
      if (prior) return prior;
      const run = (async (): Promise<ProcessOutcome> => {
        const batch = ctx.batch ?? [item];
        const teams = batch.filter((b) => b.source === "teams" && b.teams).map((b) => b.teams!);
        const thread = teams.filter((m) => m.chatId === chatId);
        // Red-team S2: owner presence is decided PER CHAT. A chat whose owner messages the log does not
        // carry (a channel, a chat the flow skips, or one the owner has never posted in) is "can't tell",
        // not owed, even when the owner appears in some other chat.
        const ownerMessagesExported = thread.some((m) => m.fromOwner === true);
        const d = decideChatThread(thread.length ? thread : [item.teams!], ownerMessagesExported);
        const id = chatAttentionId(ctx.owner, chatId);
        if (d.state === "open") {
          await store.upsert({
            id,
            ownerEmail: ctx.owner,
            chatId,
            askSourceId: `${d.ask.chatId}:${d.ask.messageId}`,
            askAt: d.ask.at,
            senderName: d.ask.senderName || null,
            chatName: d.ask.chatName ?? null,
            link: d.ask.webUrl ?? null,
            needsContext: d.missing,
            huddleId: EMAIL_ALERT_HUDDLE,
          });
          return d.missing ? { status: "needs_context", missingField: d.missing } : { status: "processed", resultIds: { bell: [id] } };
        }
        if (d.state === "answered") {
          await store.settle(id, ctx.owner, d.ownerReplyAt);
          return { status: "processed", resultIds: { bell: [id] } };
        }
        return { status: "processed" };
      })();
      decided.set(chatId, run);
      // A failed write must not be cached as the chat's answer for the rest of the pass.
      run.catch(() => decided.delete(chatId));
      return run;
    },
  };
}
