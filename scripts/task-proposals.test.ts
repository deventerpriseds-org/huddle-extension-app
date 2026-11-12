// WHAT:       Offline tests for TASK PROPOSALS (AC section 5): the Tier 1 validator between model output and a
//             stored proposal (as a SPELLING TABLE of model-output shapes), source-text building, due-date
//             resolution, ids, checklist-row mapping and sanitizing, delivery timing, the proposal processor
//             and transcript pass against an in-memory store, Approve/Edit/Mark done/Dismiss, the
//             build_checklist proposals mode, and stream-context labelling. Every check names its AC id.
// WHY:        docs/ac/AC-correspondence-checklist.md section 5 (branch claude_ac-correspondence-checklist);
//             Tier 1 because extracted to-dos become stored claims. Synthetic fixtures only (`.example`).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-task-proposals.md.
// Run: bun scripts/task-proposals.test.ts
import {
  canonicalSpan,
  eveningDeliveryDue,
  eveningDeliveryTurnId,
  isProposalId,
  proposalChecklistRow,
  proposalId,
  proposalSourceFromItem,
  resolveDueDate,
  sanitizeChecklistPayload,
  transcriptProposalText,
  validateCandidates,
  type ProposalRow,
} from "../src/features/huddle/lib/proposals/proposals";
import type { SourceItem } from "../src/features/huddle/lib/correspondence/source-item";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const TZ = "America/New_York";
// Tuesday 2026-11-10 09:00 ET.
const AT = "2026-11-10T14:00:00.000Z";
const SRC = "Hi! Can you send me the Q3 deck by Friday? Also Dana will update the budget sheet by Nov 14. Thanks, see you tomorrow.";
const v = (raw: unknown, src = SRC) => validateCandidates(raw, src, { atIso: AT, tz: TZ });
const one = (o: Record<string, unknown>) => ({ tasks: [{ task: "x", evidence: "x", assignee: null, due_text: null, ...o }] });

// ── A. SPELLING TABLE: model-output shapes the validator accepts / rejects (AC-5.19, AC-5.20) ───────
// Each row: [id, model output, expected {accepted titles | rejected reason}]. Source text is SRC above.
console.log("\n# A. validator spelling table (Tier 1)");
type Row = [string, unknown, { titles?: string[]; reject?: string }];
const TABLE: Row[] = [
  ["S-P1 verbatim evidence, task words grounded -> ACCEPT", one({ task: "Send the Q3 deck", evidence: "Can you send me the Q3 deck by Friday?" }), { titles: ["Send the Q3 deck"] }],
  ["S-P2 evidence differs only by whitespace/newline -> ACCEPT", one({ task: "Send the Q3 deck", evidence: "Can you send me\n the   Q3 deck by Friday?" }), { titles: ["Send the Q3 deck"] }],
  ["S-P3 named assignee + due words in the span -> ACCEPT", { tasks: [{ task: "Update budget sheet", evidence: "Dana will update the budget sheet by Nov 14.", assignee: "Dana", due_text: "by Nov 14" }] }, { titles: ["Update budget sheet"] }],
  ["S-P4 PARAPHRASED evidence -> REJECT evidence_not_in_source", one({ task: "Send the Q3 deck", evidence: "Please send over the Q3 slides by Friday" }), { reject: "evidence_not_in_source" }],
  ["S-P5 invented task on a real quote -> REJECT task_not_grounded", one({ task: "Book flights to Denver", evidence: "Thanks, see you tomorrow." }), { reject: "task_not_grounded" }],
  ["S-P6 evidence missing -> REJECT", { tasks: [{ task: "Send the Q3 deck", assignee: null, due_text: null }] }, { reject: "evidence_missing" }],
  ["S-P7 evidence a number not a string -> REJECT evidence_missing", one({ task: "Send deck", evidence: 42 }), { reject: "evidence_missing" }],
  ["S-P8 evidence too short ('Friday') -> REJECT", one({ task: "Friday thing", evidence: "Friday" }), { reject: "evidence_too_short" }],
  ["S-P9 task empty -> REJECT task_missing", one({ task: "   ", evidence: "Can you send me the Q3 deck by Friday?" }), { reject: "task_missing" }],
  ["S-P10 task over 200 chars -> REJECT", one({ task: "send deck ".repeat(30), evidence: "Can you send me the Q3 deck by Friday?" }), { reject: "task_too_long" }],
  ["S-P11 top level is an array -> REJECT not_object", [{ task: "Send the Q3 deck", evidence: "Can you send me the Q3 deck by Friday?" }], { reject: "not_object" }],
  ["S-P12 tasks is an object -> REJECT tasks_not_array", { tasks: { task: "Send" } }, { reject: "tasks_not_array" }],
  ["S-P13 item is a string -> REJECT item_not_object", { tasks: ["Send the Q3 deck"] }, { reject: "item_not_object" }],
  ["S-P14 null output -> REJECT not_object", null, { reject: "not_object" }],
  ["S-P15 empty list (FYI) -> nothing", { tasks: [] }, { titles: [] }],
  ["S-P16 same to-do twice (case/punct) -> one", { tasks: [
    { task: "Send the Q3 deck", evidence: "Can you send me the Q3 deck by Friday?", assignee: null, due_text: null },
    { task: "send the Q3 deck.", evidence: "Can you send me the Q3 deck by Friday?", assignee: null, due_text: null },
  ] }, { titles: ["Send the Q3 deck"] }],
  ["S-P17 evidence case-changed -> REJECT (verbatim is case-exact)", one({ task: "Send the Q3 deck", evidence: "CAN YOU SEND ME THE Q3 DECK BY FRIDAY?" }), { reject: "evidence_not_in_source" }],
];
for (const [name, raw, want] of TABLE) {
  const r = v(raw);
  if (want.titles) t(`AC-5.19 ${name}`, r.accepted.map((c) => c.title), want.titles);
  else t(`AC-5.19 ${name}`, { n: r.accepted.length, reason: Object.keys(r.rejected) }, { n: 0, reason: [want.reject] });
}
// The typographic case: model returns curly quotes where the source has straight ones.
{
  const src = "Pat said: \"please file the 'Q3' expense report today\"";
  const r = validateCandidates(one({ task: "File the Q3 expense report", evidence: "please file the ‘Q3’ expense report today" }), src, { atIso: AT, tz: TZ });
  t("AC-5.19 S-P18 curly quotes in model output vs straight in source -> ACCEPT", r.accepted.map((c) => c.title), ["File the Q3 expense report"]);
}

console.log("\n# A2. owner / due only from the evidence (AC-5.20)");
{
  const r = v({ tasks: [{ task: "Send the Q3 deck", evidence: "Can you send me the Q3 deck by Friday?", assignee: "Pat", due_text: "by Friday" }] });
  t("AC-5.20 assignee NOT named in the span -> null (no invented owner)", r.accepted[0]?.assignee, null);
  t("AC-5.20 due words in the span -> kept + resolved (Fri 2026-11-13 ET)", [r.accepted[0]?.dueText, r.accepted[0]?.dueDate], ["by Friday", "2026-11-13"]);
}
{
  const r = v({ tasks: [{ task: "Update the budget sheet", evidence: "Dana will update the budget sheet by Nov 14.", assignee: "Dana", due_text: "by Nov 14" }] });
  t("AC-5.20 named person in the span -> assignee kept", r.accepted[0]?.assignee, "Dana");
  t("AC-5.20 month-day -> 2026-11-14", r.accepted[0]?.dueDate, "2026-11-14");
}
{
  const r = v({ tasks: [{ task: "Send the Q3 deck", evidence: "Can you send me the Q3 deck by Friday?", assignee: "you", due_text: "next Monday" }] });
  t("AC-5.20 model invents a date not in the span -> due null", [r.accepted[0]?.dueText, r.accepted[0]?.dueDate], [null, null]);
  t("AC-5.20 pronoun assignee ('you') -> null", r.accepted[0]?.assignee, null);
}
{
  const src = "Please review the contract.";
  const r = validateCandidates(one({ task: "Review the contract", evidence: "Please review the contract." }), src, { atIso: AT, tz: TZ });
  t("AC-5.20 no date words -> due null, owner null", [r.accepted[0]?.dueDate, r.accepted[0]?.assignee], [null, null]);
}
t("AC-5.20 canonicalSpan straightens quotes/dashes and collapses space", canonicalSpan("“a” —  b\n c"), '"a" - b c');

// ── B. source text (AC-5.18, S-13, AC-4.8 screen reused) ─────────────────────────────────────────
console.log("\n# B. source text");
const MAILBOX = "owner@work.example";
const emailItem = (o: Partial<NonNullable<SourceItem["email"]>>): SourceItem => ({
  source: "email",
  sourceItemId: "owner@work.example:AAA1",
  identityBasis: "provider_id",
  threadId: "conv-1",
  at: AT,
  contentHash: "h",
  drivePath: "/automation/email/emails.json",
  driveItemId: null,
  fileEtag: null,
  internetMessageId: null,
  email: { id: "feed:owner@work.example:AAA1", subject: "Q3 deck", fromAddress: "pat@client.example", fromName: "Pat", bodyText: "Can you send me the Q3 deck by Friday?", receivedDateTime: AT, ...o },
});
{
  const s = proposalSourceFromItem(emailItem({}), MAILBOX);
  t("AC-5.18 email from a person -> source text = subject + new body", "text" in s ? s.text : s, "Q3 deck\nCan you send me the Q3 deck by Friday?");
  const q = proposalSourceFromItem(emailItem({ subject: "Re: Q3 deck", bodyText: "Thanks!\n\nOn Mon, Nov 9, 2026 at 9:00 AM Pat wrote:\n> please send the deck by Friday" }), MAILBOX);
  t("S-13 quoted history and Re: subject are NOT source text", "text" in q ? q.text : q, "Thanks!");
  t("AC-4.8 bulk header -> skipped", proposalSourceFromItem(emailItem({ headerNames: ["list-unsubscribe"] }), MAILBOX), { skip: "bulk-header" });
  t("AC-4.8 automated sender -> skipped", proposalSourceFromItem(emailItem({ fromAddress: "no-reply@vendor.example" }), MAILBOX), { skip: "automated-sender" });
  t("AC-4.8 owner's own mail -> skipped", proposalSourceFromItem(emailItem({ fromAddress: MAILBOX }), MAILBOX), { skip: "self" });
  const noAsk = proposalSourceFromItem(emailItem({ bodyText: "I'll send the contract Friday." , subject: "Contract" }), MAILBOX);
  t("AC-5.18 a stated commitment with no question is still a source (no-ask is not a skip)", "text" in noAsk, true);
}
const teamsItem = (o: Partial<NonNullable<SourceItem["teams"]>>): SourceItem => ({
  source: "teams",
  sourceItemId: "19%3Achat-alpha%40thread.example:1001",
  identityBasis: "provider_id",
  threadId: "19:chat-alpha@thread.example",
  at: AT,
  contentHash: "h",
  drivePath: "/automation/huddle-source-log.jsonl",
  driveItemId: null,
  fileEtag: null,
  internetMessageId: null,
  teams: { chatId: "19:chat-alpha@thread.example", messageId: "1001", at: AT, senderId: "u1", senderName: "Pat", senderIsApp: false, fromOwner: false, text: "Can you send me the Q3 deck by Friday?", chatName: "Alpha", ...o },
});
{
  const s = proposalSourceFromItem(teamsItem({}), MAILBOX);
  t("AC-5.18 Teams message -> source text + chat name context", "text" in s ? [s.text, s.context] : s, ["Can you send me the Q3 deck by Friday?", "Alpha"]);
  t("AC-4.8 Teams app/bot sender -> skipped", proposalSourceFromItem(teamsItem({ senderIsApp: true }), MAILBOX), { skip: "app-sender" });
  t("S-12 owner's own Teams message -> skipped", proposalSourceFromItem(teamsItem({ fromOwner: true }), MAILBOX), { skip: "own-message" });
  t("AC-5.18 empty text -> skipped", proposalSourceFromItem(teamsItem({ text: "  " }), MAILBOX), { skip: "no-text" });
}
t(
  "AC-5.22 transcript text = action items + overview only",
  transcriptProposalText({ action_items: "Von to update the budget\nPat to send notes", overview: "Budget review." }),
  "Von to update the budget\nPat to send notes\n\nBudget review.",
);
t("AC-5.22 transcript with no summary -> empty", transcriptProposalText(null), "");

// ── C. due dates (AC-5.20) ───────────────────────────────────────────────────────────────────────
console.log("\n# C. due-date resolution (source time, owner zone)");
const due = (s: string, at = AT) => resolveDueDate(s, at, TZ);
t("AC-5.20 'today' -> source day", due("today"), "2026-11-10");
t("AC-5.20 'by EOD' -> source day", due("by EOD"), "2026-11-10");
t("AC-5.20 'tomorrow' -> +1", due("tomorrow"), "2026-11-11");
t("AC-5.20 'by Friday' (Tue source) -> 2026-11-13", due("by Friday"), "2026-11-13");
t("AC-5.20 'Tuesday' on a Tuesday -> same day", due("Tuesday"), "2026-11-10");
t("AC-5.20 'next Friday' is ambiguous -> null", due("next Friday"), null);
t("AC-5.20 'next week' -> null", due("next week"), null);
t("AC-5.20 'soon' / 'ASAP' -> null", [due("soon"), due("ASAP")], [null, null]);
t("AC-5.20 'Jan 5' after November -> next year", due("by Jan 5"), "2027-01-05");
t("AC-5.20 'Feb 30' -> null (not a date)", due("Feb 30"), null);
t("AC-5.20 ISO date kept", due("2026-12-01"), "2026-12-01");
t("AC-5.20 late-evening UTC source uses the ET day (23:30 ET Tue -> 'tomorrow' = Wed)", due("tomorrow", "2026-11-11T04:30:00.000Z"), "2026-11-11");
t("AC-5.20 no source time -> null", resolveDueDate("tomorrow", null, TZ), null);

// ── D. ids, rows, sanitizer (AC-5.1, 5.2, 5.17 prep) ─────────────────────────────────────────────
console.log("\n# D. ids and checklist rows");
const pid = proposalId("Owner@EDS.example", { source: "teams", sourceItemId: "c:1" }, "send the q3 deck");
t("AC-5.2 proposal id is prop- namespaced", isProposalId(pid), true);
t("AC-5.2 a journey uuid is never a proposal id", isProposalId("3f2a9c1e-8d7b-4c2a-9e1f-0a1b2c3d4e5f"), false);
t("AC-5.21 id is stable (owner case-insensitive)", proposalId("owner@eds.example", { source: "teams", sourceItemId: "c:1" }, "send the q3 deck"), pid);
const row: ProposalRow = {
  id: pid,
  owner: "owner@eds.example",
  state: "proposed",
  title: "Send the Q3 deck",
  originalTitle: "Send the Q3 deck",
  normTitle: "send the q3 deck",
  edited: false,
  evidence: "Can you send me the Q3 deck by Friday?",
  assignee: null,
  dueText: "by Friday",
  dueDate: "2026-11-13",
  sources: [
    { source: "teams", sourceItemId: "c:1", at: AT, context: "Alpha" },
    { source: "email", sourceItemId: "m:1", at: AT, context: "Q3 deck" },
  ],
  taskId: null,
  createdAt: AT,
  decidedAt: null,
};
const cr = proposalChecklistRow(row);
t("AC-5.1 proposal row carries kind:'proposal' and the state as status", [cr.kind, cr.status, cr.taskId === pid], ["proposal", "proposed", true]);
t("OQ-9 two sources -> one row labelled 'Teams +1'", cr.proposal.sourceLabel, "Teams +1");
const legacy = { title: "Kids", rows: [{ taskId: "3f2a9c1e-8d7b-4c2a-9e1f-0a1b2c3d4e5f", title: "Pack bag", status: "DOING", tags: ["kids"], extra: "x" }], more: 2 };
t(
  "AC-5.1 a row with no kind sanitizes EXACTLY as the old inline mapping did",
  sanitizeChecklistPayload(legacy),
  { title: "Kids", rows: [{ taskId: "3f2a9c1e-8d7b-4c2a-9e1f-0a1b2c3d4e5f", title: "Pack bag", status: "DOING", tags: ["kids"] }], more: 2 },
);
t("AC-5.1 empty rows -> no widget (old rule)", sanitizeChecklistPayload({ title: "x", rows: [] }), undefined);
t("AC-5.1 missing status -> BACKLOG (old rule)", sanitizeChecklistPayload({ title: "x", rows: [{ taskId: "a", title: "b" }] })?.rows[0].status, "BACKLOG");
{
  const s = sanitizeChecklistPayload({ title: "Proposed tasks", rows: [cr] });
  t("AC-5.1 proposal row survives the sanitizer with its detail", [s?.rows[0].kind, (s?.rows[0].proposal as { evidence: string }).evidence], ["proposal", row.evidence]);
  t("AC-5.2 a 'proposal' row whose id is a task uuid is DROPPED", sanitizeChecklistPayload({ title: "x", rows: [{ ...cr, taskId: "3f2a9c1e-8d7b-4c2a-9e1f-0a1b2c3d4e5f" }] }), undefined);
}

// ── E. delivery timing (owner decision OQ-7) ─────────────────────────────────────────────────────
console.log("\n# E. evening delivery");
const etMs = (iso: string) => Date.parse(iso);
// 2026-11-10 is a Tuesday. 18:45 ET = 23:45Z.
t("OQ-7 18:45 ET weekday, work done, 3 active -> due", eveningDeliveryDue({ nowMs: etMs("2026-11-10T23:45:00Z"), tz: TZ, workPending: false, activeCount: 3 }), true);
t("OQ-7 18:10 ET (before 18:30) -> not yet", eveningDeliveryDue({ nowMs: etMs("2026-11-10T23:10:00Z"), tz: TZ, workPending: false, activeCount: 3 }), false);
t("OQ-7 18:45 ET but extraction still pending -> wait", eveningDeliveryDue({ nowMs: etMs("2026-11-10T23:45:00Z"), tz: TZ, workPending: true, activeCount: 3 }), false);
t("OQ-7 19:35 ET pending past the grace -> post anyway", eveningDeliveryDue({ nowMs: etMs("2026-11-11T00:35:00Z"), tz: TZ, workPending: true, activeCount: 3 }), true);
t("OQ-7 nothing active -> no post", eveningDeliveryDue({ nowMs: etMs("2026-11-10T23:45:00Z"), tz: TZ, workPending: false, activeCount: 0 }), false);
t("OQ-7 Saturday -> no post", eveningDeliveryDue({ nowMs: etMs("2026-11-14T23:45:00Z"), tz: TZ, workPending: false, activeCount: 3 }), false);
t("OQ-7 22:30 ET -> too late, tomorrow", eveningDeliveryDue({ nowMs: etMs("2026-11-11T03:30:00Z"), tz: TZ, workPending: false, activeCount: 3 }), false);
t(
  "AC-5.16 one turn id per owner per local day",
  [eveningDeliveryTurnId("o@eds.example", etMs("2026-11-10T23:45:00Z"), TZ) === eveningDeliveryTurnId("O@eds.example", etMs("2026-11-11T02:00:00Z"), TZ), eveningDeliveryTurnId("o@eds.example", etMs("2026-11-10T23:45:00Z"), TZ).endsWith("2026-11-10")],
  [true, true],
);

// -----------------------------------------------------------------------------------------------
await (globalThis as { __moreProposalTests?: () => Promise<void> }).__moreProposalTests?.();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
