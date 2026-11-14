// WHAT:       A ONE-OFF PREVIEW of what needs the owner, from the owner's REAL work-email snapshot (EMAIL ONLY,
//             owner 2026-11-14: "email report for now, no teams"). Three lists, one row per CONVERSATION (needs-you
//             classifier, lib/correspondence/needs-you.ts): Needs your reply, Action items for you, Meeting action
//             items for you; everything else is counts only (scripts/proposals-preview-render.ts). Runs the shipped
//             extraction + validation (proposeFromSource, the same model call the live feature uses). It WRITES one Markdown file to the owner's OWN OneDrive
//             (/automation/Huddle Preview/task-proposals-preview-<timestamp>.md, a new file every run), WRITES the
//             open-vs-replied report as HTML next to it (open-vs-replied-report-<timestamp>.html, every run, owner
//             2026-11-14) and, with PREVIEW_EMAIL=1, EMAILS the same report as HTML (Graph sendMail from HUDDLE_EMAIL_FROM to the owner's
//             mailbox in the private feed config). Stores nothing in Huddle and creates no task.
// WHY:        Owner 2026-11-13: "give me a preview of the action items you pulled from the email/chat". The
//             feature is still switched off and unmerged; a preview on real data is the cheapest check of its
//             quality before switch-on. THIS REPO'S LOGS ARE PUBLIC: the action items, subjects, senders and
//             ids go ONLY into the owner's OneDrive file / email; the log prints counts, HTTP statuses and the
//             file path. Feed content is never printed, not even inside a parse error (verifier loop 4, 8.3).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run by .github/workflows/proposals-preview.yml; .claude/actions.md ACT:correspondence-checklist;
//             scripts/proposals-preview.test.ts.
// Env: TOKEN (app-only Graph), HUDDLE_ONEDRIVE_FEEDS (the app's config), OPENAI_API_KEY, PREVIEW_DAYS (default 7),
//      PREVIEW_MAX_SOURCES (default 60), PREVIEW_SINCE, PREVIEW_EMAIL=1, PREVIEW_ACCEPT_UNMARKED=1, HUDDLE_EMAIL_FROM.
//      Run: npx -y tsx scripts/proposals-preview.ts
import {
  latestSentByConversation,
  mapFeedMessage,
  mapSentRecords,
  parseFeedsConfig,
  validateEmailSnapshot,
  validateSentSnapshot,
} from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { ledgerEmailItems } from "../src/features/huddle/lib/correspondence/ingest-pass";
import type { SourceItem } from "../src/features/huddle/lib/correspondence/source-item";
import {
  classifyEmailConversations,
  conversationIsTodoSource,
  effectiveOwnerNames,
  ownerAddressSet,
  verdictCounts,
  type NeedsYouContext,
} from "../src/features/huddle/lib/correspondence/needs-you";
import type { NewProposal, ProposalStore } from "../src/features/huddle/lib/proposals/proposals";
import { conversationDoer, conversationSourceFor, proposeFromSource } from "../src/features/huddle/lib/proposals/engine";
import { renderNeedsYouHtml, renderNeedsYouMarkdown, type NeedsYouReport } from "./proposals-preview-render";
import { extract, EXTRACT_MODEL } from "../src/features/huddle/lib/proposals/proposals.server";

/** Parse a feed file WITHOUT ever printing its content: a JSON.parse error message quotes the first characters
 *  of the input (V8: `Unexpected token 'S', "Secret mer"... is not valid JSON`), and these logs are public. A
 *  non-JSON file logs only "<label>: not JSON" and yields undefined (verifier loop 4, 8.3). */
function parseFeedJson(label: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    console.log(`${label}: not JSON`);
    return undefined;
  }
}

const cfg0 = parseFeedsConfig(process.env.HUDDLE_ONEDRIVE_FEEDS);
if (!cfg0) {
  console.log("config: OFF / invalid -- nothing to preview");
  process.exit(0);
}
const token = process.env.TOKEN ?? "";
const days = Number(process.env.PREVIEW_DAYS ?? 7) || 7;
const maxSources = Number(process.env.PREVIEW_MAX_SOURCES ?? 60) || 60;
const since = Date.now() - days * 86_400_000;
const drive = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg0.driveUser)}/drive/root:`;
const enc = (p: string) => p.split("/").map((s) => encodeURIComponent(s)).join("/");
const read = async (path: string) => {
  const r = await fetch(`${drive}${enc(path)}:/content`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, text: r.ok ? await r.text() : "" };
};

// Owner scope change 2026-11-14: "email report for now, no teams". The Teams log is not read by this preview.
const cfg = cfg0;

// ── Sources (the ledger's own mappers). Owner 2026-11-14 redesign: ONE row per CONVERSATION, decided by the
// needs-you classifier (lib/correspondence/needs-you.ts) -- never by Iris's live screen (AC-R1.6).
const items: SourceItem[] = [];
const e = await read(cfg.email.path);
// PREVIEW ONLY: PREVIEW_ACCEPT_UNMARKED=1 also reads an email file the flow marked complete:false (the live
// validator still refuses it); the report says so up front.
let emailIncomplete = false;
const eJson = e.status === 200 ? parseFeedJson("email", e.text) : undefined;
let ev = eJson !== undefined ? validateEmailSnapshot(eJson, cfg) : null;
if (ev && !ev.ok && ev.reason === "incomplete" && process.env.PREVIEW_ACCEPT_UNMARKED === "1" && eJson && typeof eJson === "object") {
  ev = validateEmailSnapshot({ ...(eJson as Record<string, unknown>), complete: true }, cfg);
  emailIncomplete = !!ev?.ok;
}
console.log(`email: HTTP ${e.status} | ${ev ? (ev.ok ? (emailIncomplete ? "valid (flow marked it incomplete; read for the preview only)" : "valid") : `REJECTED ${ev.reason}`) : "-"}`);
if (ev?.ok) items.push(...ledgerEmailItems(ev.snapshot.records, cfg, { path: cfg.email.path, etag: null }).items);
// ── Sent Items: what settles an email thread (the EXISTING sentReplySettles, through the classifier).
const sinceIso = process.env.PREVIEW_SINCE || "";
const sinceMs = sinceIso ? Date.parse(sinceIso) : since;
const sentRead = await read("/automation/email/sent.json");
const sentJson = sentRead.status === 200 ? parseFeedJson("sent", sentRead.text) : undefined;
const sv = sentJson !== undefined ? validateSentSnapshot(sentJson, cfg) : null;
const sentMapped = sv?.ok ? mapSentRecords(sv.snapshot.records, cfg) : { sent: [], skipped: 0 };
const latestSent = latestSentByConversation(sentMapped.sent);
console.log(`sent: HTTP ${sentRead.status} | ${sv ? (sv.ok ? "valid" : `REJECTED ${sv.reason}`) : "-"} | usable ${sentMapped.sent.length} | no time ${sentMapped.skipped}`);

// ── One verdict per conversation (AC-R2..R4). A conversation is in the window when its NEWEST message is.
const nyCtx: NeedsYouContext = {
  ownerAddresses: ownerAddressSet(cfg),
  ownerNames: effectiveOwnerNames(cfg),
  latestSent,
  sentKnown: sentMapped.sent.length > 0,
};
const emailMsgs = ev?.ok ? ev.snapshot.records.map((r) => mapFeedMessage(r, cfg.mailbox)) : [];
const newest = (ats: (string | null | undefined)[]) => Math.max(...ats.map((a) => Date.parse(String(a ?? ""))).filter(Number.isFinite), -Infinity);
const emailById = new Map(emailMsgs.map((m) => [m.id, m]));
const convs = classifyEmailConversations(cfg.mailbox, emailMsgs, nyCtx).filter((c) => newest(c.messageIds.map((id) => emailById.get(id)?.receivedDateTime)) >= sinceMs);
const vc = verdictCounts(convs);
console.log(
  `conversations since ${new Date(sinceMs).toISOString().slice(0, 10)}: ${vc.total} | ${Object.entries(vc.byVerdict).map(([k, v]) => `${k} ${v}`).join(" ")}`,
);

// ── To-dos: ONE extraction per conversation that may hold the owner's to-dos (AC-R6), newest first, capped.
const rows: NewProposal[] = [];
const store = {
  async upsert(p: NewProposal) {
    const hit = rows.find((r) => r.normTitle === p.normTitle);
    if (hit) return { kind: "attached" as const, id: hit.id };
    rows.push(p);
    return { kind: "created" as const, id: p.id };
  },
  async priorRelated() {
    return [];
  },
} as unknown as ProposalStore;
const itemByConv = new Map<string, SourceItem[]>();
for (const it of items) {
  if (it.source !== "email" || !it.email) continue;
  const k = `${cfg.mailbox}:${it.email.conversationId ? `conv:${it.email.conversationId}` : `msg:${it.email.id}`}`;
  (itemByConv.get(k) ?? itemByConv.set(k, []).get(k)!).push(it);
}
const todoConvs = convs
  .filter((c) => conversationIsTodoSource(c))
  .sort((a, b) => Date.parse(b.deciding?.at ?? "") - Date.parse(a.deciding?.at ?? ""))
  .slice(0, maxSources);
const rejected: Record<string, number> = {};
let failed = 0;
const perConv = new Map<string, { kind: "Email"; context: string | null; at: string | null; ids: string[] }>();
for (const c of todoConvs) {
  const batch = itemByConv.get(c.key) ?? [];
  if (!batch.length) continue;
  const src = conversationSourceFor(batch[0], batch, cfg.mailbox, nyCtx);
  if ("skip" in src) continue;
  try {
    const before = rows.length;
    const r = await proposeFromSource(cfg.ownerLogins[0] ?? "owner", src, { store, extract, openTitles: async () => null, tz: "America/New_York", doer: conversationDoer(src, nyCtx.ownerNames) });
    for (const [k, v] of Object.entries(r.rejected)) rejected[k] = (rejected[k] ?? 0) + (v ?? 0);
    if (rows.length > before) perConv.set(c.key, { kind: "Email", context: src.context ?? null, at: src.at, ids: rows.slice(before).map((x) => x.id) });
  } catch {
    failed++;
  }
}
console.log(`proposals: ${rows.length} from ${todoConvs.length} conversation(s) (cap ${maxSources}) | rejected ${JSON.stringify(rejected)} | extraction failures ${failed} | model ${EXTRACT_MODEL}`);

// ── The report: three lists (AC-R7.1), everything else counts only (AC-R7.5).
const fmtAt = (s: string | null | undefined) => (s && Number.isFinite(Date.parse(s)) ? new Date(s).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) : "?");
const clipLine = (s: string | null | undefined, k = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, k);
const replies: NeedsYouReport["replies"] = convs
  .filter((c) => c.verdict === "needs_reply")
  .sort((a, b) => Date.parse(b.deciding?.at ?? "") - Date.parse(a.deciding?.at ?? ""))
  .map((c) => {
    const m = emailById.get(c.deciding?.id ?? "");
    return { key: c.key, kind: "Email" as const, who: clipLine(m?.fromName || m?.fromAddress, 60), at: fmtAt(m?.receivedDateTime), title: clipLine(m?.subject, 140) };
  });
const todos: NeedsYouReport["todos"] = [...perConv.values()].map((g, i) => ({
  key: String(i),
  kind: g.kind,
  context: clipLine(g.context ?? "(no subject)", 140),
  at: fmtAt(g.at),
  items: g.ids.map((id) => rows.find((r) => r.id === id)!).map((p) => ({ title: p.title, due: p.dueDate ?? (p.dueText ? `"${p.dueText}"` : null), evidence: clipLine(p.evidence, 300) })),
}));
const counts: Array<[string, number]> = [
  ...(["fyi", "invite", "minutes", "not_addressed", "automated", "replied", "cant_tell"] as const).map((v) => [v, vc.byVerdict[v]] as [string, number]),
  ...Object.entries(vc.byReason).filter(([k]) => k.startsWith("cant_tell:")).map(([k, n]) => [k.replace(":", " ") as string, n] as [string, number]),
  ["assigned_to_other", rejected.assigned_to_other ?? 0],
  ["doer_unclear", rejected.doer_unclear ?? 0],
  ["untriaged", 0],
  ["delegated", 0],
];
const lastEmail = ev?.ok ? ev.snapshot.records.map((r) => String(r.receivedDateTime ?? "")).sort().pop() ?? null : null;
const coverage = [
  `Work email received up to ${fmtAt(lastEmail)} ET`,
  `Sent Items: ${sentMapped.sent.length} message(s) with a sent time, ${sentMapped.skipped} without`,
  ...(emailIncomplete ? ["the email flow marked its file incomplete, so some emails may be missing"] : []),
  ...(sentMapped.sent.length ? [] : ["no usable Sent Items, so email threads that ask something are counted as cant_tell, not listed"]),
];
const report: NeedsYouReport = {
  sinceLabel: fmtAt(new Date(sinceMs).toISOString()),
  generatedLabel: fmtAt(new Date().toISOString()),
  coverage,
  replies,
  todos,
  // Part B (meeting triage) stores the owner's "Mine" items; until it exists there is nothing to read here.
  meeting: null,
  counts,
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = `/automation/Huddle Preview/task-proposals-preview-${stamp}.md`;
const put = await fetch(`${drive}${enc(out)}:/content`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
  body: renderNeedsYouMarkdown(report),
});
console.log(`preview file: HTTP ${put.status} -> OneDrive ${out}`);
if (!put.ok) process.exitCode = 1;

// ── HTML of the same report: written next to the Markdown every run (owner 2026-11-14), and emailed with
// PREVIEW_EMAIL=1 from Huddle's sender mailbox (HUDDLE_EMAIL_FROM) to the owner's EDS mailbox from the PRIVATE
// feed config (driveUser). Nothing about it is printed but HTTP status.
{
  const body = renderNeedsYouHtml(report);
  const htmlOut = `/automation/Huddle Preview/open-vs-replied-report-${stamp}.html`;
  const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Huddle: what needs you since ${esc(report.sinceLabel)}</title></head><body style="margin:16px;background:#ffffff">${body}</body></html>`;
  const hput = await fetch(`${drive}${enc(htmlOut)}:/content`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/html" },
    body: html,
  });
  console.log(`html report file: HTTP ${hput.status} -> OneDrive ${htmlOut}`);
  if (!hput.ok) process.exitCode = 1;
  if (process.env.PREVIEW_EMAIL === "1") {
    const from = (process.env.HUDDLE_EMAIL_FROM || "dev@enterpriseds.io").split(",")[0].trim();
    const send = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: `Huddle: what needs you since ${report.sinceLabel} (preview)`,
          body: { contentType: "HTML", content: body },
          toRecipients: [{ emailAddress: { address: cfg.driveUser } }],
        },
        saveToSentItems: false,
      }),
    });
    console.log(`email: sendMail HTTP ${send.status}`);
    if (!send.ok) process.exit(1);
  }
}
