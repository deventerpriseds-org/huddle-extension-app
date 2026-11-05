// WHAT:       The OWED-CORRESPONDENCE DIGEST, pure half: turns the still-owed rows of
//             chat.email_replies into (a) the card items for Iris's 1:1, (b) her directive, and (c) the
//             self-addressed email (subject + HTML + plain text). No pg, no fetch -- testable offline.
// WHY:        Owner, 2026-11-05: "provide me a rich chat and email update on correspondences. if none
//             are due i get nothing ... if 1+ i get a reminder/report on who I still owe correspondence
//             with the ability to dismiss ones I've already settled or don't plan to."
//             The per-email alert (inbound-email.server.ts) says each email ONCE, the moment it lands;
//             nothing ever came back to say "you still owe these". This is that reminder.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:owed-digest; tests: bun scripts/owed-digest.test.ts
//
// EXTENDS, never duplicates: the list IS chat.email_replies (status owed|drafted), the Dismiss IS
// dismissEmailReplyFn, "settled because he replied" IS reconcileRepliedFromSentItems. This file adds
// no new store and no new notion of "owed".

import type { OwedDigestCard, OwedDigestItem } from "../../data/seed";

/** Iris owns it, like the inbound-email alert whose list this is. */
export const OWED_DIGEST_OWNER = "iris-chase";

/** At most this many rows on the card / in the email. The count line still reports the true total. */
export const OWED_DIGEST_MAX_ITEMS = 25;

/** The minimal row shape this module needs (a subset of EmailReplyRow, so tests need no pg types). */
export interface OwedRowLike {
  id: string;
  from_name: string | null;
  from_address: string | null;
  subject: string | null;
  received_at: string | null;
  status: string;
  draft_web_link: string | null;
}

export interface OwedDigest {
  /** Total still owed (may exceed items.length when capped). */
  total: number;
  card: OwedDigestCard;
  directive: string;
  email: { subject: string; html: string; text: string };
}

/** "3h", "2d", "just now". Whole units, floor, so it never overstates how long he has had it. */
export function ageLabel(receivedAt: string | null, nowMs: number): string {
  if (!receivedAt) return "";
  const t = Date.parse(receivedAt);
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.floor((nowMs - t) / 60_000));
  if (mins < 60) return mins < 2 ? "just now" : `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Oldest first: the one he has owed longest is the one to see first. Rows without a date go last. */
function oldestFirst(a: OwedRowLike, b: OwedRowLike): number {
  const ta = a.received_at ? Date.parse(a.received_at) : NaN;
  const tb = b.received_at ? Date.parse(b.received_at) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  if (Number.isFinite(ta)) return -1;
  if (Number.isFinite(tb)) return 1;
  return 0;
}

/**
 * Build the digest. Returns NULL when nothing is owed -- the "if none are due I get nothing" rule
 * lives HERE, in one place, so neither the chat path nor the email path can send an empty report.
 * Only rows whose status is owed|drafted count; anything else passed in is ignored.
 */
export function buildOwedDigest(
  rows: readonly OwedRowLike[],
  opts: { nowMs: number; appUrl?: string; tz?: string },
): OwedDigest | null {
  const owed = rows.filter((r) => r.status === "owed" || r.status === "drafted").sort(oldestFirst);
  if (owed.length === 0) return null;

  const shown = owed.slice(0, OWED_DIGEST_MAX_ITEMS);
  const items: OwedDigestItem[] = shown.map((r) => ({
    emailId: r.id,
    fromName: String(r.from_name ?? "").slice(0, 300),
    fromAddress: String(r.from_address ?? "").slice(0, 320),
    subject: String(r.subject ?? "").slice(0, 500),
    receivedAt: r.received_at ?? null,
    drafted: r.status === "drafted",
    draftWebLink: r.status === "drafted" ? (r.draft_web_link ?? undefined) : undefined,
  }));
  const total = owed.length;
  const drafted = owed.filter((r) => r.status === "drafted").length;
  const who = (i: OwedDigestItem) => i.fromName || i.fromAddress || "(unknown sender)";
  const noun = total === 1 ? "reply" : "replies";

  const lines = items.map((i) => {
    const age = ageLabel(i.receivedAt, opts.nowMs);
    return (
      `- ${who(i)}${i.subject ? ` — "${i.subject}"` : ""}` +
      `${age ? ` (${age})` : ""}${i.drafted ? " [draft saved, not sent]" : ""}`
    );
  });
  const more = total > items.length ? `\n…and ${total - items.length} more.` : "";

  const directive =
    `[Scheduled owed-correspondence digest — not a message from the owner.]\n` +
    `The owner still owes ${total} email ${noun}` +
    `${drafted ? ` (${drafted} already drafted in Outlook, waiting for him to send)` : ""}. ` +
    `Oldest first:\n${lines.join("\n")}${more}\n\n` +
    `Write him a SHORT reminder (2–4 sentences): who he still owes, calling out the one he has owed ` +
    `longest by name. Do NOT list every row — the card under your message lists them with a Dismiss ` +
    `button each. Tell him to tap Dismiss on any he has already handled another way or doesn't plan ` +
    `to answer, and that anything he replies to from Outlook drops off on its own. Do not draft ` +
    `replies, do not call tools, do not create tasks.`;

  const appUrl = (opts.appUrl ?? "").replace(/\/$/, "");
  const link = appUrl ? `${appUrl}/?huddle=dm-${OWED_DIGEST_OWNER}` : "";
  const subject = `You still owe ${total} email ${noun}`;
  const rowsHtml = items
    .map((i) => {
      const age = ageLabel(i.receivedAt, opts.nowMs);
      const status = i.drafted
        ? i.draftWebLink
          ? `<a href="${esc(i.draftWebLink)}">Draft saved — send it</a>`
          : "Draft saved — send it"
        : "Owed";
      return (
        `<tr>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><b>${esc(who(i))}</b>` +
        `${i.fromAddress && i.fromName ? `<br><span style="color:#6b7280;font-size:12px">${esc(i.fromAddress)}</span>` : ""}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${esc(i.subject || "(no subject)")}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap">${esc(age)}</td>` +
        `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap">${status}</td>` +
        `</tr>`
      );
    })
    .join("");
  const html =
    `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827">` +
    `<p>You still owe <b>${total}</b> email ${noun}` +
    `${drafted ? ` (${drafted} drafted in Outlook, waiting to be sent)` : ""}. Oldest first:</p>` +
    `<table style="border-collapse:collapse;width:100%;max-width:720px">` +
    `<tr style="text-align:left;color:#6b7280;font-size:12px">` +
    `<th style="padding:6px 10px">From</th><th style="padding:6px 10px">Subject</th>` +
    `<th style="padding:6px 10px">Waiting</th><th style="padding:6px 10px">Status</th></tr>` +
    `${rowsHtml}</table>` +
    `${more ? `<p style="color:#6b7280">…and ${total - items.length} more.</p>` : ""}` +
    `<p>Anything you reply to from Outlook drops off this list on its own.` +
    `${link ? ` To dismiss one you've settled another way or don't plan to answer, <a href="${esc(link)}">open Iris in Huddle</a> and tap Dismiss.` : " To dismiss one you've settled another way, tap Dismiss on Iris's card in Huddle."}</p>` +
    `<p style="color:#6b7280;font-size:12px">Sent by Iris (Huddle). Nothing is sent when you owe nothing.</p>` +
    `</div>`;
  const text =
    `You still owe ${total} email ${noun}. Oldest first:\n${lines.join("\n")}${more}\n\n` +
    `Replying from Outlook clears it automatically.` +
    `${link ? ` Dismiss the rest in Huddle: ${link}` : " Dismiss the rest on Iris's card in Huddle."}`;

  return { total, card: { items, total }, directive, email: { subject, html, text } };
}
