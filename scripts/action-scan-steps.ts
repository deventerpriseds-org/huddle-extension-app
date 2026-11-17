// WHAT:       TUNING STEPS 2 + 3 of the correspondence redesign, run by scripts/reply-scan-preview.ts with PREVIEW_STEP=action.
//             Step 2: conversations where the owner is ON THE TO LINE (alone or with others) -- "is there an OPEN ITEM for
//             you, reply or not?". Step 3: conversations where he is only CC'd or got it through a list -- "is there an
//             ACTION for you anyway?". One model question per conversation, per step. Writes ONE HTML report to the owner's
//             OneDrive (/automation/Huddle Preview/action-scan-<timestamp>.html), prints its web link, and with
//             PREVIEW_EMAIL=1 also emails it. 2026-11-17: with the ledger source it SAVES (runStoredActionScan below).
// WHY:        Owner 2026-11-14, reviewing step 1: "Some of the items may not require a reply but requires an action. Next
//             ask for all that include me directly, find which of those have an open item. Next ask for all that address
//             me indirectly with an action." He circled six step-1 "no reply" rows that need ACTION (two manager forwards
//             with due dates, a security-account setup, an attachment he asked for, a CC'd hours notice, an intro).
//             Forwarded emails are now given to the model (lib/correspondence/forwarded.ts): the two manager forwards
//             were judged on the signature alone. THIS REPO'S LOGS ARE PUBLIC: counts, file path and web link only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current (its instructions + schema moved to the in-app classifier,
//             lib/correspondence/action-classify.ts, 2026-11-16, and are imported here).
// EVIDENCE:   .github/workflows/proposals-preview.yml step=action.
//
// 2026-11-16 (owner: "this report should be running against the table that has everything since Monday"): with
// `ledger` given (scripts/reply-scan-preview.ts PREVIEW_SOURCE=ledger, the default) the scan also covers TEAMS (one
// question per chat, the step-2 answer schema), lists the Fireflies action items of each meeting ("From meetings",
// no AI), and shows -- collapsed -- what was set aside: resolved by the owner (a decided task proposal or a dismissed
// bell row), Teams group/meeting chats he is not part of (UNINVOLVED_CHAT_RULE, skipped BEFORE any AI call), and
// anything over the model-call cap (listed, never silently dropped). Rules: lib/correspondence/report-from-ledger.ts.
//
// 2026-11-17 (owner-approved: "the report must SAVE its AI verdicts into the same store the in-app Actions view
// reads"): the LEDGER path no longer has a classify loop of its own. runStoredActionScan runs the APP'S OWN pass
// (actions.server.ts runReportPassFor -> pipeline.ts runReportClassify -> runClassify: one admission guard, one key
// scheme, one store, the daily cap's own count) and renders the HTML FROM THE STORED VERDICTS
// (scripts/action-report-html.ts). A thread that already holds a current verdict costs 0 model calls. PREVIEW_SAVE=0
// runs the same pass with its results kept in memory. The loop in runActionScan below is kept ONLY for
// PREVIEW_SOURCE=files (OneDrive files: no ledger rows to store a verdict on), and stores nothing.
// Build notes: docs/qc-evidence/BUILD-report-saves-verdicts.md.
import type { ConversationFacts, NeedsYouContext } from "../src/features/huddle/lib/correspondence/needs-you";
import type { TeamsChatFacts } from "../src/features/huddle/lib/correspondence/report-from-ledger";
import { FORWARD_SUBJECT, forwardedText } from "../src/features/huddle/lib/correspondence/forwarded";
import { mapFeedMessage, type OneDriveFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { EXTRACT_MODEL } from "../src/features/huddle/lib/proposals/proposals.server";
import {
  ACTION_SCHEMA,
  STEP2_INSTRUCTIONS,
  STEP3_INSTRUCTIONS,
  TEAMS_INSTRUCTIONS,
  emailActionInput,
  emailQuoteHaystack,
  quoteIsVerbatim,
  teamsActionInput,
  teamsQuoteHaystack,
} from "../src/features/huddle/lib/correspondence/action-classify";

import { renderActionReportHtml, rowsFromStoredVerdicts, type LedgerScanPart, type Row, type TRow } from "./action-report-html";

// The instructions, schema, inputs and verbatim rule are the in-app classifier's (lib/correspondence/action-classify.ts,
// canonical since 2026-11-16): the report and the Actions view ask the model exactly the same question.
export { STEP2_INSTRUCTIONS, STEP3_INSTRUCTIONS, TEAMS_INSTRUCTIONS };

export type { LedgerScanPart } from "./action-report-html";

const SCHEMA = ACTION_SCHEMA;

/** Categories the owner switched off (owner 2026-11-15: "Meeting invites, time keeping, verification codes can be
 *  toggled off in settings"). Seeded default; PREVIEW_HIDE_CATEGORIES overrides it until the settings screen exists.
 *  Hidden rows are listed collapsed at the end, never dropped. */
const HIDE = new Set(
  (process.env.PREVIEW_HIDE_CATEGORIES ?? "meeting_invite,timekeeping,verification_code").split(",").map((x) => x.trim()).filter(Boolean),
);

export async function runActionScan(a: {
  facts: ConversationFacts[];
  rawRecords: Record<string, unknown>[];
  cfg: OneDriveFeedsConfig;
  ctx: NeedsYouContext;
  token: string;
  drive: string;
  enc: (p: string) => string;
  sinceMs: number;
  maxCalls: number;
  newest: (f: ConversationFacts) => number;
  /** Present when the report reads the Azure ledger (the default source). */
  ledger?: LedgerScanPart;
}) {
  const { facts, cfg, ctx, token, drive, enc, sinceMs, maxCalls, newest, ledger } = a;
  // The forwarded part of every "Fw:" message, keyed by the same id the facts use.
  const fwd = new Map<string, string>(ledger ? ledger.forwards : []);
  const fwdStats = { subjects: 0, marker: 0, emptyBody: 0 };
  for (const r of ledger ? [] : a.rawRecords) {
    const body = r.body as unknown;
    const raw = typeof body === "string" ? body : body && typeof body === "object" ? String((body as Record<string, unknown>).content ?? "") : "";
    const isHtml = r.isHtml === true || (!!body && typeof body === "object" && String((body as Record<string, unknown>).contentType ?? "").toLowerCase() === "html");
    const isFwd = FORWARD_SUBJECT.test(String(r.subject ?? ""));
    if (isFwd) fwdStats.subjects++;
    if (isFwd && /id=["']?(?:divRplyFwdMsg|appendonsend)/i.test(raw)) fwdStats.marker++;
    if (isFwd && !raw.trim()) fwdStats.emptyBody++;
    const t = forwardedText(String(r.subject ?? ""), raw, isHtml);
    if (t) fwd.set(mapFeedMessage(r, cfg.mailbox).id, t);
  }
  // Counts only (public log): how many "Fw:" messages, how many carry Outlook's marker, how many had a readable forward.
  if (ledger) console.log(`forwards (ledger): Fw emails ${ledger.forwardsTotal} | forwarded text read ${fwd.size} | forwarded part not stored ${ledger.forwardsMissing}`);
  else console.log(`forwards: Fw subjects ${fwdStats.subjects} | with Outlook marker ${fwdStats.marker} | empty body ${fwdStats.emptyBody} | forwarded text read ${fwd.size}`);

  const input = (f: ConversationFacts) => emailActionInput(f, ctx.ownerNames, fwd);

  const { callOpenAIRouter } = await import("../src/features/huddle/lib/openai-responses.server");
  let calls = 0;
  let failures = 0;
  let overCap = 0;
  let ownerOnly = 0;
  let settledIndirect = 0;
  const step2: Row[] = [];
  const step3: Row[] = [];
  /** Not sent to the model because of the cap: LISTED in the report, never silently dropped. */
  const overCapEmail: ConversationFacts[] = [];
  const overCapTeams: TeamsChatFacts[] = [];
  for (const f of facts) {
    if (!f.latestOther) {
      ownerOnly++;
      continue;
    }
    const direct = f.ownerPosition === "direct" || f.ownerPosition === "group" || f.ownerPosition === "unknown";
    // Step 2 keeps conversations he already answered: an answer can still leave something for him to do.
    if (!direct && f.settled) {
      settledIndirect++;
      continue;
    }
    if (calls >= maxCalls) {
      overCap++;
      overCapEmail.push(f);
      continue;
    }
    calls++;
    try {
      const raw = (await callOpenAIRouter<unknown>({ model: EXTRACT_MODEL, system: direct ? STEP2_INSTRUCTIONS : STEP3_INSTRUCTIONS, prompt: input(f), schema: SCHEMA as unknown as Record<string, unknown>, schemaName: direct ? "open_item_scan" : "indirect_action_scan" })) as Record<string, unknown>;
      const quote = typeof raw?.quote === "string" && raw.quote.trim() ? raw.quote.trim() : null;
      const haystack = emailQuoteHaystack(f, fwd);
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
      (direct ? step2 : step3).push({
        f,
        yes: raw?.open_item === true,
        kind: String(raw?.kind ?? "?"),
        todo: str(raw?.todo),
        due: str(raw?.due),
        quote,
        quoteFound: quoteIsVerbatim(quote, haystack),
        confidence: String(raw?.confidence ?? "?"),
        reason: String(raw?.reason ?? "").slice(0, 300),
        category: String(raw?.category ?? "other"),
      });
    } catch {
      failures++;
    }
  }
  // ── TEAMS (ledger source only): one question per chat. Chats the owner is not part of were set aside BEFORE this
  // point (planLedgerReport, UNINVOLVED_CHAT_RULE) and never reach the model.
  const teamsRows: TRow[] = [];
  let teamsOwnerOnly = 0;
  const teamsChats = ledger?.plan.teams.scan ?? [];
  const teamsInput = (c: TeamsChatFacts) => teamsActionInput(c, ctx.ownerNames);
  for (const c of teamsChats) {
    if (!c.latestOther) {
      teamsOwnerOnly++;
      continue;
    }
    if (calls >= maxCalls) {
      overCap++;
      overCapTeams.push(c);
      continue;
    }
    calls++;
    try {
      const raw = (await callOpenAIRouter<unknown>({ model: EXTRACT_MODEL, system: TEAMS_INSTRUCTIONS, prompt: teamsInput(c), schema: SCHEMA as unknown as Record<string, unknown>, schemaName: "teams_open_item_scan" })) as Record<string, unknown>;
      const quote = typeof raw?.quote === "string" && raw.quote.trim() ? raw.quote.trim() : null;
      const haystack = teamsQuoteHaystack(c);
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
      teamsRows.push({
        c,
        yes: raw?.open_item === true,
        kind: String(raw?.kind ?? "?"),
        todo: str(raw?.todo),
        due: str(raw?.due),
        quote,
        quoteFound: quoteIsVerbatim(quote, haystack),
        confidence: String(raw?.confidence ?? "?"),
        reason: String(raw?.reason ?? "").slice(0, 300),
        category: String(raw?.category ?? "other"),
      });
    } catch {
      failures++;
    }
  }
  const { html, logLines } = renderActionReportHtml({
    step2,
    step3,
    teamsRows,
    notCheckedEmail: overCapEmail,
    notCheckedTeams: overCapTeams,
    ownerOnly,
    teamsOwnerOnly,
    notAdmitted: 0,
    conversations: facts.length,
    calls,
    failures,
    overCap,
    maxCalls,
    settledIndirect,
    sinceMs,
    forwardsRead: fwd.size,
    model: EXTRACT_MODEL,
    hide: HIDE,
    ledger,
    notCheckedTitle: `Not checked by the AI: over the cap of ${maxCalls}`,
    notCheckedNote: "These were NOT judged. Re-run with a higher max_sources to include them.",
  });
  for (const l of logLines) console.log(l);
  await publishReport(html, { cfg, token, drive, enc, sinceMs });
}

/** Writes the report to the owner's OneDrive (and emails it with PREVIEW_EMAIL=1). Logs HTTP statuses + path only. */
async function publishReport(html: string, a: { cfg: OneDriveFeedsConfig; token: string; drive: string; enc: (p: string) => string; sinceMs: number }) {
  const { cfg, token, drive, enc, sinceMs } = a;
  const sinceLabel = Number.isFinite(sinceMs) ? new Date(sinceMs).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "?";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = `/automation/Huddle Preview/action-scan-${stamp}.html`;
  const put = await fetch(`${drive}${enc(out)}:/content`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/html" }, body: html });
  console.log(`action scan file: HTTP ${put.status} -> OneDrive ${out}`);
  // The web link is NOT printed: it carries the owner's OneDrive path, and this repo's Actions logs are public
  // (verifier loop 9, 3c). The session builds the link from the file path above.
  if (!put.ok) process.exitCode = 1;
  if (process.env.PREVIEW_EMAIL === "1") {
    const from = (process.env.HUDDLE_EMAIL_FROM || "dev@enterpriseds.io").split(",")[0].trim();
    const send = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { subject: `Huddle steps 2+3: what is still open for you since ${sinceLabel}`, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: cfg.driveUser } }] }, saveToSentItems: false }),
    });
    console.log(`email: sendMail HTTP ${send.status}`);
  }
}

/**
 * The LEDGER path (2026-11-17): the app's own classify pass over the report's window, verdicts SAVED into the Actions
 * view's store (unless `save` is false), then the HTML rendered FROM the stored verdicts. Counts only in the log.
 */
export async function runStoredActionScan(a: { cfg: OneDriveFeedsConfig; token: string; drive: string; enc: (p: string) => string; sinceMs: number; maxCalls: number; save: boolean }) {
  const { runReportPassFor } = await import("../src/features/huddle/lib/actions/actions.server");
  const p = await runReportPassFor(a.cfg, { sinceMs: a.sinceMs, maxCalls: a.maxCalls, save: a.save });
  const rows = rowsFromStoredVerdicts(p.assembled, p.settings, p.verdicts);
  const r = p.res;
  // Counts only (public log): what the pass did and what the store now holds for the report's threads.
  const rowsOpen = [...rows.step2, ...rows.step3, ...rows.teamsRows].filter((x) => x.yes).length;
  const rowsNone = rows.step2.length + rows.step3.length + rows.teamsRows.length - rowsOpen;
  const rowsNotChecked = rows.notCheckedEmail.length + rows.notCheckedTeams.length;
  console.log(
    `report pass: save ${a.save ? "ON" : "OFF (results kept in memory)"} | model calls ${r.calls} | already judged (0 calls) ${r.alreadyJudged} | ` +
      `verdicts stored this run: open ${r.open} none ${r.none} not_checked ${r.notChecked} | failures ${r.failures} | over cap ${r.overCap} | ` +
      `meeting rows ${r.meetingRows} | uninvolved skipped ${r.uninvolvedSkipped} | calls allowed ${p.callsLeft} | used today before ${p.usedBefore}, after ${p.usedBefore + r.calls} of cap ${p.settings.dailyCap} | ` +
      `in-app sorting ${p.classifyOn ? "on" : "off"} | sources email ${p.settings.sources.email} teams ${p.settings.sources.teams} meeting ${p.settings.sources.meeting}`,
  );
  console.log(`report rows from the store: open ${rowsOpen} | none ${rowsNone} | not checked ${rowsNotChecked} (of which AI answer not admitted ${rows.notAdmitted})`);
  const ledger: LedgerScanPart = { plan: p.assembled.plan, forwards: p.assembled.forwards, forwardsMissing: p.assembled.forwardsMissing, forwardsTotal: p.assembled.forwardsTotal, unavailable: p.unavailable };
  console.log(`forwards (ledger): Fw emails ${ledger.forwardsTotal} | forwarded text read ${ledger.forwards.size} | forwarded part not stored ${ledger.forwardsMissing}`);
  const { html, logLines } = renderActionReportHtml({
    ...rows,
    conversations: p.settings.sources.email ? p.assembled.plan.email.scan.length : 0,
    calls: r.calls,
    failures: r.failures,
    overCap: r.overCap,
    maxCalls: p.callsLeft,
    settledIndirect: 0,
    sinceMs: a.sinceMs,
    forwardsRead: ledger.forwards.size,
    model: EXTRACT_MODEL,
    hide: HIDE,
    ledger,
    notCheckedTitle: "Not checked yet: no current AI verdict is stored",
    notCheckedNote: "Over today's AI limit or this run's max_sources, an AI call failed, or the AI's quote was not found word-for-word (never shown in Huddle). They are judged again on the next run or by Huddle's own sorting.",
    storeNote: a.save
      ? "Verdicts are saved in Huddle: the Actions view lists the same items, and a conversation already judged is not sent to the AI again."
      : "Saving was switched off for this run: nothing new was stored in Huddle.",
  });
  for (const l of logLines) console.log(l);
  await publishReport(html, { cfg: a.cfg, token: a.token, drive: a.drive, enc: a.enc, sinceMs: a.sinceMs });
}
