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
  groundedAssignee,
  titleKey,
  type ProposalRow,
  type ProposalStore,
} from "../src/features/huddle/lib/proposals/proposals";
import { htmlToText, parseUtcMs, parseFeedsConfig as parseCfg } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import {
  approveProposal,
  decideProposal,
  deliverEveningProposals,
  editProposal,
  proposalChecklistResult,
  proposalsProcessor,
  proposeFromSource,
  runTranscriptProposals,
  type ExtractFn,
  type MeetingRef,
} from "../src/features/huddle/lib/proposals/engine";
import {
  errorCategory,
  ledgerKey,
  teamsSourceItem,
  type ClaimedItem,
  type CorrespondenceSource,
  type CursorStore,
  type LedgerStatus,
  type LedgerStore,
  type SourceItem,
} from "../src/features/huddle/lib/correspondence/source-item";
import { runIngestPass, type PassDeps } from "../src/features/huddle/lib/correspondence/ingest-pass";
import { parseFeedsConfig, validateEmailSnapshot } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// ── F. in-memory twins (the SQL itself is proved by scripts/task-proposals-sql.test.ts) ──────────
const memStore = () => {
  const rows = new Map<string, ProposalRow & { lease: number }>();
  const refs = new Map<string, string>();
  let clock = Date.parse("2026-11-10T23:00:00Z");
  const own = (owners: string[], r?: { owner: string }) => !!r && owners.map((o) => o.toLowerCase()).includes(r.owner);
  const out = (r: (ProposalRow & { lease: number }) | undefined) => (r ? (({ lease: _l, ...x }) => structuredClone(x))(r) : null);
  const store: ProposalStore & { rows: typeof rows; refs: typeof refs; tick(ms: number): void } = {
    rows,
    refs,
    tick: (ms) => (clock += ms),
    async upsert(p) {
      const owner = p.owner.toLowerCase();
      const rk = [owner, p.ref.source, p.ref.sourceItemId, p.normTitle].join("|");
      if (refs.has(rk)) return { kind: "seen", id: refs.get(rk)! };
      const active = [...rows.values()].find((r) => r.owner === owner && r.normTitle === p.normTitle && r.state === "proposed");
      if (active) {
        refs.set(rk, active.id);
        active.sources.push({ ...p.ref, context: p.ref.context ?? null });
        return { kind: "attached", id: active.id };
      }
      rows.set(p.id, { id: p.id, owner, state: "proposed", title: p.title, originalTitle: p.title, normTitle: p.normTitle, edited: false, evidence: p.evidence, assignee: p.assignee, dueText: p.dueText, dueDate: p.dueDate, sources: [{ ...p.ref, context: p.ref.context ?? null }], taskId: null, createdAt: new Date(clock).toISOString(), decidedAt: null, lease: 0 });
      refs.set(rk, p.id);
      return { kind: "created", id: p.id };
    },
    async priorRelated(owners, ref, norm) {
      const same = (r: ProposalRow) => r.sources.some((s) => s.source === ref.source && s.sourceItemId === ref.sourceItemId);
      return [...rows.values()]
        .filter((r) => own(owners, r) && (same(r) || (r.normTitle === norm && r.state === "dismissed")))
        .map((r) => ({ id: r.id, normTitle: r.normTitle, state: r.state, sameItem: same(r) }));
    },
    async listActive(owners) {
      return [...rows.values()].filter((r) => own(owners, r) && r.state === "proposed").map((r) => out(r)!);
    },
    async getMany(owners, ids) {
      return ids.map((i) => rows.get(i)).filter((r) => own(owners, r)).map((r) => out(r)!);
    },
    async claimApprove(owners, id, secs) {
      const r = rows.get(id);
      if (!own(owners, r)) return { claimed: false, row: null };
      if (r!.state !== "proposed" || r!.lease > clock) return { claimed: false, row: out(r) };
      r!.lease = clock + secs * 1000;
      return { claimed: true, row: out(r) };
    },
    async finishApprove(id, taskId) {
      const r = rows.get(id);
      if (!r || r.state !== "proposed") return null;
      Object.assign(r, { state: "approved", taskId, decidedAt: new Date(clock).toISOString(), lease: 0 });
      return out(r);
    },
    async releaseApprove(id) {
      const r = rows.get(id);
      if (r && r.state === "proposed") r.lease = 0;
    },
    async decide(owners, id, state) {
      const r = rows.get(id);
      if (!own(owners, r)) return { applied: false, row: null };
      if (r!.state !== "proposed" || r!.lease > clock) return { applied: false, row: out(r) };
      Object.assign(r!, { state, decidedAt: new Date(clock).toISOString() });
      return { applied: true, row: out(r) };
    },
    async edit(owners, id, title) {
      const r = rows.get(id);
      if (!own(owners, r)) return { applied: false, row: null };
      if (r!.state !== "proposed" || r!.lease > clock) return { applied: false, row: out(r) };
      Object.assign(r!, { title, edited: true });
      return { applied: true, row: out(r) };
    },
  };
  return store;
};

type LRow = { owner: string; hash: string; status: LedgerStatus; attempts: number; v: number; leased: boolean; missing: string | null; cat: string | null; result: Record<string, string[]>; source: CorrespondenceSource; id: string };
const memLedger = () => {
  const rows = new Map<string, LRow>();
  const ledger: LedgerStore = {
    async observe(owner, items) {
      const o = { inserted: 0, changed: 0, unchanged: 0 };
      for (const i of items) {
        const k = ledgerKey(i);
        const r = rows.get(k);
        if (!r) {
          rows.set(k, { owner, hash: i.contentHash, status: "pending", attempts: 0, v: 0, leased: false, missing: null, cat: null, result: {}, source: i.source, id: i.sourceItemId });
          o.inserted++;
        } else if (r.hash !== i.contentHash) {
          Object.assign(r, { hash: i.contentHash, status: "pending", attempts: 0, v: r.v + 1, leased: false });
          o.changed++;
        } else o.unchanged++;
      }
      return o;
    },
    async reopenNeedsContext() {
      return 0;
    },
    async hasDue(owner, sources, max) {
      return [...rows.values()].some((r) => r.owner === owner && sources.includes(r.source) && (r.status === "pending" || r.status === "failed_retryable") && r.attempts < max && !r.leased);
    },
    async claimDue(owner, sources, limit, max) {
      const c: ClaimedItem[] = [];
      for (const r of rows.values()) {
        if (c.length >= limit) break;
        if (r.owner !== owner || !sources.includes(r.source) || !(r.status === "pending" || r.status === "failed_retryable") || r.attempts >= max || r.leased) continue;
        r.attempts++;
        r.v++;
        r.leased = true;
        c.push({ source: r.source, sourceItemId: r.id, claimVersion: r.v, attempts: r.attempts });
      }
      return c;
    },
    async markProcessed(c, ids) {
      const r = rows.get(ledgerKey(c))!;
      if (r.v !== c.claimVersion) return false;
      Object.assign(r, { status: "processed", result: ids, leased: false });
      return true;
    },
    async markNeedsContext(c, f) {
      const r = rows.get(ledgerKey(c))!;
      if (r.v !== c.claimVersion) return false;
      Object.assign(r, { status: "needs_context", missing: f, leased: false });
      return true;
    },
    async markFailed(c, cat, max) {
      const r = rows.get(ledgerKey(c))!;
      if (r.v !== c.claimVersion) return false;
      Object.assign(r, { status: r.attempts >= max ? "failed" : "failed_retryable", cat, leased: false });
      return true;
    },
    async health() {
      return {};
    },
  };
  // Lets a test re-run a failed_retryable row without waiting out the backoff.
  const unlease = () => rows.forEach((r) => (r.leased = false));
  return { rows, ledger, unlease };
};
const memCursor = (): CursorStore => {
  const m = new Map<string, { etag: string | null; checkedAtMs: number | null }>();
  return {
    async get(o, s) {
      return m.get(`${o}|${s}`) ?? null;
    },
    async set(o, s, etag) {
      m.set(`${o}|${s}`, { etag: etag ?? m.get(`${o}|${s}`)?.etag ?? null, checkedAtMs: 0 });
    },
  };
};

/** Stub model: returns a canned extraction per source text (keyed by a substring), records every call. */
const stubModel = (table: Array<[string, unknown]>) => {
  const calls: string[] = [];
  const extract: ExtractFn = async (_i, input) => {
    calls.push(input);
    if (input.includes("MODEL-DOWN")) throw new Error("OpenAI Responses 500: upstream said something with an address a@b.example");
    for (const [k, v] of table) if (input.includes(k)) return v;
    return { tasks: [] };
  };
  return { extract, calls };
};

// ── G. the processor through the data layer's REAL pass, against the dummy fixtures (AC-7.1, 5.18-5.21, 3.3) ─
console.log("\n# G. processor via runIngestPass + fixtures");
const FIX = join(import.meta.dir, "fixtures/onedrive");
const teamsFixture = readFileSync(join(FIX, "huddle-source-log.sample.jsonl"), "utf8");
const emailFixture = JSON.parse(readFileSync(join(FIX, "emails.sample.json"), "utf8"));
const feedsJson = {
  enabled: true,
  ownerLogins: ["owner@eds.example"],
  driveUser: "owner@eds.example",
  mailbox: "owner@work.example",
  sourceLogin: "login@work.example",
  synthetic: true,
  subjectPrefix: "HUDDLE-PA-SBX-",
  teams: { path: "/automation/huddle-source-log.jsonl", ownerIds: ["USER-OWNER-1"] },
};
const cfgWith = (cc: Record<string, unknown>) => parseFeedsConfig(JSON.stringify({ ...feedsJson, correspondence: { ingest: true, ...cc } }))!;
const MODEL_TABLE: Array<[string, unknown]> = [
  // Teams 1001: a stated request with date words.
  ["Can you send me the Q3 deck by Friday?", { tasks: [{ task: "Send the Q3 deck", evidence: "Can you send me the Q3 deck by Friday?", assignee: null, due_text: "by Friday" }] }],
  // Teams 3001: a request (blockquoted history already stripped by the adapter).
  ["Please update the budget sheet", { tasks: [{ task: "Update the budget sheet", evidence: "Please update the budget sheet before the review.", assignee: null, due_text: null }] }],
  // Email sample-1: same kind of ask, with a paraphrase the validator must refuse plus a real one.
  ["Can you review the draft by Monday?", { tasks: [
    { task: "Review the draft", evidence: "Can you review the draft by Monday?", assignee: null, due_text: "by Monday" },
    { task: "Approve the budget", evidence: "Please approve the budget for next quarter", assignee: null, due_text: null },
  ] }],
  // FYI: the model (wrongly) invents a to-do on a pleasantry; the grounding rule must drop it.
  ["FYI the nightly build is green", { tasks: [{ task: "Schedule a celebration lunch", evidence: "FYI the nightly build is green.", assignee: null, due_text: null }] }],
];
const OWNER = "owner@eds.example";
const runPass = async (tw: ReturnType<typeof memLedger>, store: ReturnType<typeof memStore>, model: ReturnType<typeof stubModel>, cc: Record<string, unknown> = { proposals: true }, openTitles: Set<string> | null = new Set()) => {
  const cfg = cfgWith(cc);
  const processor = proposalsProcessor({ store, extract: model.extract, openTitles: async () => openTitles, tz: TZ, owner: () => OWNER, mailbox: () => cfg.mailbox });
  const pd: PassDeps = {
    ledger: tw.ledger,
    cursor: memCursor(),
    async readTeams() {
      return { ok: true, changed: true, etag: '"{t},1"', itemId: "drive-item-t", path: "/automation/huddle-source-log.jsonl", text: teamsFixture };
    },
    async recordTeamsStatus() {},
    async readEmail(c) {
      const vv = validateEmailSnapshot(emailFixture, c, Date.parse("2026-11-12T00:00:00Z"));
      return vv.ok ? { ok: true, etag: '"{e},1"', path: c.email.path, records: vv.snapshot.records } : { ok: false, reason: `rejected:${vv.reason}` };
    },
    processors: [processor],
    now: () => Date.parse("2026-11-12T23:05:00Z"),
    log: () => {},
  };
  return runIngestPass(cfg, pd);
};
{
  const tw = memLedger();
  const store = memStore();
  const model = stubModel(MODEL_TABLE);
  const r = await runPass(tw, store, model);
  const titles = [...store.rows.values()].map((x) => x.title).sort();
  t("AC-7.1 full pass adapter -> ledger -> proposals: expected to-dos only", titles, ["Review the draft", "Send the Q3 deck", "Update the budget sheet"]);
  t("AC-5.19 paraphrased evidence never stored (0 'Approve the budget')", titles.includes("Approve the budget"), false);
  t("AC-5.18 FYI with an invented to-do -> 0 proposals from it", titles.includes("Schedule a celebration lunch"), false);
  t("AC-3.3 every claimed item processed, none failed", [r.failed, r.processed > 0], [0, true]);
  const deck = [...store.rows.values()].find((x) => x.title === "Send the Q3 deck")!;
  t("AC-5.19 proposal keeps source kind + id + time", [deck.sources[0].source, deck.sources[0].sourceItemId, deck.sources[0].at], ["teams", "19%3Achat-alpha%40thread.example:1001", "2026-11-10T14:00:00.000Z"]);
  t("AC-5.20 due from the span ('by Friday', Tue 2026-11-10 source) -> 2026-11-13; owner null", [deck.dueDate, deck.assignee], ["2026-11-13", null]);
  t("AC-4.8 newsletter (bulk header) never reached the model", model.calls.some((c) => c.includes("widgets")), false);
  t("AC-4.8 Teams app sender never reached the model", model.calls.some((c) => c.includes("Build 42")), false);
  t("S-13 blockquoted history never reached the model", model.calls.some((c) => c.includes("echo: please send the deck")), false);
  const ledgerRow = [...tw.rows.values()].find((x) => x.id === "19%3Achat-alpha%40thread.example:1001")!;
  t("AC-3.2 ledger row records the proposal ids as its result", ledgerRow.result, { proposals: [deck.id] });

  // AC-1.5 / AC-3.5 / AC-5.21: the same file again -> nothing new, no model calls (ledger: processed).
  const before = model.calls.length;
  await runPass(tw, store, model);
  t("AC-3.5 re-reading the same files -> zero extraction calls, zero new proposals", [model.calls.length - before, store.rows.size], [0, 3]);

  // AC-3.4 + AC-5.21: an item re-processed (crash before `processed`, or a content change) -> no duplicate.
  for (const x of tw.rows.values()) x.status = "pending";
  await runPass(tw, store, model);
  t("AC-5.21 forced re-extraction of every item -> still 3 proposals (refs dedup)", store.rows.size, 3);

  // AC-5.12: a dismissed proposal is not reopened by a re-read.
  await decideProposal([OWNER], deck.id, "dismissed", store);
  for (const x of tw.rows.values()) x.status = "pending";
  await runPass(tw, store, model);
  t("AC-5.12 / AC-3.4 a decided proposal is never reopened by a re-read", store.rows.get(deck.id)!.state, "dismissed");
}
{
  // AC-6.3 proposals switch OFF -> processor never runs, items stay pending in the ledger.
  const tw = memLedger();
  const store = memStore();
  const model = stubModel(MODEL_TABLE);
  await runPass(tw, store, model, { proposals: false });
  t("AC-6.3 proposals:false -> zero model calls, zero proposals", [model.calls.length, store.rows.size], [0, 0]);
  t("AC-6.1 ingest itself OFF -> nothing at all", (await runIngestPass(parseFeedsConfig(JSON.stringify(feedsJson)), { ...({} as PassDeps) })).reason, "ingest_off");
}
{
  // AC-5.21: a to-do already open on the board is not proposed.
  const tw = memLedger();
  const store = memStore();
  await runPass(tw, store, stubModel(MODEL_TABLE), { proposals: true }, new Set(["send the q3 deck"]));
  t("AC-5.21 to-do equal to an open board title -> not proposed", [...store.rows.values()].some((x) => x.normTitle === "send the q3 deck"), false);
}
{
  // AC-3.3: a failing model -> the item is NOT processed; failed_retryable with a CODE (no free text).
  const tw = memLedger();
  const store = memStore();
  const down = stubModel([]);
  const failing: ExtractFn = async () => {
    throw new Error("OpenAI Responses 500: owner@work.example said Can you send me the Q3 deck");
  };
  const cfg = cfgWith({ proposals: true });
  const proc = proposalsProcessor({ store, extract: failing, openTitles: async () => new Set(), tz: TZ, owner: () => OWNER, mailbox: () => cfg.mailbox });
  const item = teamsSourceItem({ chatId: "19:c@thread.example", messageId: "9", at: AT, senderId: "u", senderName: "P", senderIsApp: false, fromOwner: false, text: "Can you send me the Q3 deck by Friday?" }, { path: "/x.jsonl" });
  let msg = "";
  try {
    await proc.process(item, { owner: OWNER, nowMs: 0 });
  } catch (e) {
    msg = errorCategory(e);
  }
  t("AC-3.3/3.8 extraction failure throws a short code (ledger -> failed_retryable, no content)", msg, "proposals:extract_failed");
  t("AC-3.3 nothing stored on failure", store.rows.size, 0);
  void down;
}
{
  // Second processor seam check: a skipped source (owner's own message) is processed with no ids.
  const store = memStore();
  const proc = proposalsProcessor({ store, extract: stubModel(MODEL_TABLE).extract, openTitles: async () => new Set(), tz: TZ, owner: () => OWNER, mailbox: () => MAILBOX });
  const item = teamsSourceItem({ chatId: "19:c@thread.example", messageId: "10", at: AT, senderId: "me", senderName: "Me", senderIsApp: false, fromOwner: true, text: "I will send the Q3 deck by Friday" }, { path: "/x.jsonl" });
  t("S-12 owner's own message -> processed, no proposal", await proc.process(item, { owner: OWNER, nowMs: 0 }), { status: "processed", resultIds: {} });
}

// ── H. transcripts (AC-5.22) ─────────────────────────────────────────────────────────────────────
console.log("\n# H. Fireflies transcripts (read-only, same ledger)");
{
  const tw = memLedger();
  const store = memStore();
  const model = stubModel([["Von to update the budget", { tasks: [{ task: "Update the budget", evidence: "Von to update the budget", assignee: "Von", due_text: null }] }]]);
  let fetches = 0;
  const meetings: MeetingRef[] = [
    { meetingId: "ff-1", title: "Test-Budget sync", meetingAt: AT, contentHash: "h1" },
    { meetingId: "ff-2", title: "Test-Standup", meetingAt: AT, contentHash: "h2" },
  ];
  const td = {
    store,
    extract: model.extract,
    openTitles: async () => new Set<string>(),
    tz: TZ,
    ledger: tw.ledger,
    listFinishedMeetings: async () => meetings,
    fetchSummaryText: async (id: string) => {
      fetches++;
      return id === "ff-1" ? transcriptProposalText({ action_items: "Von to update the budget", overview: "Budget sync." }) : "";
    },
    maxAttempts: 5,
    now: () => 0,
    budgetMs: 10_000,
  };
  const r1 = await runTranscriptProposals(OWNER, td);
  const p = [...store.rows.values()];
  t("AC-5.18 Fireflies action item 'Von to update the budget' -> one proposal, named assignee kept", [p.length, p[0]?.title, p[0]?.assignee], [1, "Update the budget", "Von"]);
  t("AC-5.22 transcript ref = meeting_id", p[0]?.sources[0], { source: "transcript", sourceItemId: "ff-1", at: AT, context: "Test-Budget sync" });
  t("AC-5.22 both meetings processed (empty summary -> processed, no proposal)", [r1.processed, r1.failed], [2, 0]);
  await runTranscriptProposals(OWNER, td);
  t("AC-3.5 second run -> no re-fetch, no new proposals", [fetches, store.rows.size], [2, 1]);
  meetings[0] = { ...meetings[0], contentHash: "h1-reprocessed" };
  await runTranscriptProposals(OWNER, td);
  t("AC-3.4 a re-processed meeting re-extracts but does not duplicate", [fetches, store.rows.size], [3, 1]);
  const unavailable = { ...td, ledger: memLedger().ledger, fetchSummaryText: async () => null };
  t("AC-3.7 summary unavailable -> needs_context, not failed", (await runTranscriptProposals(OWNER, unavailable)).needsContext, 2);
}

// ── I. owner actions (AC-5.3, 5.7-5.13) ──────────────────────────────────────────────────────────
console.log("\n# I. Approve / Edit / Mark done / Dismiss");
const seed = async (store: ReturnType<typeof memStore>, title: string, sid: string, dueDate: string | null = null) => {
  const norm = title.toLowerCase();
  const id = proposalId(OWNER, { source: "email", sourceItemId: sid }, norm);
  await store.upsert({ id, owner: OWNER, title, normTitle: norm, evidence: `please ${norm}`, assignee: null, dueText: null, dueDate, ref: { source: "email", sourceItemId: sid, at: AT } });
  return id;
};
const journeyStub = () => {
  const created: Array<{ title: string; due: string | null }> = [];
  let fail = false;
  return {
    created,
    setFail: (f: boolean) => (fail = f),
    createTask: async (title: string, due: string | null) => {
      if (fail) return { ok: false as const, error: "journey /tool 503" };
      created.push({ title, due });
      return { ok: true as const, taskId: `11111111-0000-4000-8000-${String(created.length).padStart(12, "0")}` };
    },
  };
};
{
  const store = memStore();
  const j = journeyStub();
  const id = await seed(store, "Test-Send the Q3 deck", "m1", "2026-11-13");
  const deps = { store, openTasks: async () => [] as Array<{ id: string; title: string }>, createTask: j.createTask };
  const [a1, a2] = await Promise.all([approveProposal([OWNER], id, deps), approveProposal([OWNER], id, deps)]);
  t("AC-5.8 Approve tapped twice -> ONE journey create", j.created.length, 1);
  t("AC-5.8 ...the loser gets ok (alreadyDone) or 'being approved', never a second task", [a1.ok || a2.ok, [a1, a2].some((x) => x.ok && x.alreadyDone) || [a1, a2].some((x) => !x.ok)], [true, true]);
  t("AC-5.7 Approve passes the proposal title + its extracted due date to the create path", j.created[0], { title: "Test-Send the Q3 deck", due: "2026-11-13" });
  const row = store.rows.get(id)!;
  t("AC-5.9 approved row stores the journey task id", [row.state, row.taskId], ["approved", "11111111-0000-4000-8000-000000000001"]);
  t("AC-5.8 approving again later -> alreadyDone, still one task", [(await approveProposal([OWNER], id, deps)).ok, j.created.length], [true, 1]);
}
{
  const store = memStore();
  const j = journeyStub();
  const id = await seed(store, "Test-Call the vendor", "m2");
  const r = await approveProposal([OWNER], id, { store, openTasks: async () => [{ id: "existing-task-1", title: "test-call the vendor." }], createTask: j.createTask });
  t("AC-5.10 title already OPEN on the board -> no second task, linked to the existing one", [r.ok, j.created.length, store.rows.get(id)!.taskId, r.ok && r.alreadyOnBoard], [true, 0, "existing-task-1", true]);
}
{
  const store = memStore();
  const j = journeyStub();
  j.setFail(true);
  const id = await seed(store, "Test-Renew the permit", "m3");
  const r = await approveProposal([OWNER], id, { store, openTasks: async () => [], createTask: j.createTask });
  t("AC-5.3 journey failure -> error returned, row still proposed and claimable", [r.ok, store.rows.get(id)!.state, (await store.claimApprove([OWNER], id, 1)).claimed], [false, "proposed", true]);
}
{
  const store = memStore();
  const j = journeyStub();
  const id = await seed(store, "Test-Book the room", "m4");
  const r = await approveProposal([OWNER], id, { store, openTasks: async () => { throw new Error("pg down"); }, createTask: j.createTask });
  t("AC-64 open-task read failed -> create proceeds, said out loud", [r.ok, j.created.length, r.ok && r.note], [true, 1, "Added (the duplicate check could not run)."]);
}
{
  const store = memStore();
  const j = journeyStub();
  const id = await seed(store, "Groom and triage the backlog", "m5");
  const r = await approveProposal([OWNER], id, { store, openTasks: async () => [], createTask: j.createTask });
  t("AC-5.7 create-task-core meta-task guard runs on Approve (no card for another agent's exclusive job)", [r.ok, j.created.length, store.rows.get(id)!.state], [false, 0, "proposed"]);
}
{
  const store = memStore();
  const id = await seed(store, "Test-Pay the invoice", "m6");
  t("AC-5.4 another owner's Approve -> not in your list", (await approveProposal(["intruder@eds.example"], id, { store, openTasks: async () => [], createTask: journeyStub().createTask })).ok, false);
  const e = await editProposal([OWNER], id, "  Test-Pay the March invoice  ", store);
  t("AC-5.11 Edit stores the trimmed text", [e.ok, store.rows.get(id)!.title], [true, "Test-Pay the March invoice"]);
  const j = journeyStub();
  await approveProposal([OWNER], id, { store, openTasks: async () => [], createTask: j.createTask });
  t("AC-5.11 Approve creates the EDITED title", j.created[0]?.title, "Test-Pay the March invoice");
  t("AC-5.11 Edit after a decision -> refused", (await editProposal([OWNER], id, "x", store)).ok, false);
  t("AC-5.11 empty edit refused", (await editProposal([OWNER], await seed(store, "Test-x y", "m7"), "   ", store)).ok, false);
}
{
  const store = memStore();
  const j = journeyStub();
  const id = await seed(store, "Test-File the report", "m8");
  const d = await decideProposal([OWNER], id, "completed", store);
  t("AC-5.13 / OQ-8 Mark done -> completed, NO task created", [d.ok, store.rows.get(id)!.state, j.created.length], [true, "completed", 0]);
  t("AC-5.5 completed row leaves the active queue", (await store.listActive([OWNER])).some((r) => r.id === id), false);
  const id2 = await seed(store, "Test-Ping the lawyer", "m9");
  await store.claimApprove([OWNER], id2, 60);
  t("AC-5.8 Dismiss while an Approve is in flight -> refused, row unchanged", [(await decideProposal([OWNER], id2, "dismissed", store)).ok, store.rows.get(id2)!.state], [false, "proposed"]);
  t("AC-5.12 Dismiss on an already-decided row -> ok alreadyDone", (await decideProposal([OWNER], id, "dismissed", store)).ok, true);
}

// ── J. build_checklist proposals mode + delivery (AC-5.15, 5.16, OQ-7) ───────────────────────────
console.log("\n# J. checklist result + evening delivery");
{
  const store = memStore();
  for (let i = 0; i < 50; i++) await seed(store, `Test-Item number ${i}`, `s${i}`);
  const res = JSON.parse(proposalChecklistResult(await store.listActive([OWNER])));
  t("AC-5.15 every proposed row is in the checklist (no cap: 50)", res.checklist.rows.length, 50);
  t("AC-5.1 rows are kind:'proposal' with prop- ids", res.checklist.rows.every((r: { kind: string; taskId: string }) => r.kind === "proposal" && isProposalId(r.taskId)), true);
  t("AC-5.17 the model is told these are PROPOSED, not board tasks", /PROPOSED task\(s\).*NOT tasks on the board/.test(res.message), true);
  t("AC-5.15 none waiting -> a plain 'no proposals' result, no empty widget", JSON.parse(proposalChecklistResult([])).error, "no_proposals");

  const turns = new Map<string, Record<string, unknown>>();
  const ran: string[] = [];
  const dd = (nowIso: string, pending = false) => ({
    store,
    enqueue: async (id: string, p: Record<string, unknown>) => (turns.has(id) ? false : (turns.set(id, p), true)),
    run: async (id: string) => void ran.push(id),
    now: () => Date.parse(nowIso),
    tz: TZ,
    workPending: async () => pending,
  });
  t("OQ-7 before 18:30 ET -> nothing", (await deliverEveningProposals(OWNER, [OWNER], dd("2026-11-10T23:00:00Z"))).delivered, false);
  const d1 = await deliverEveningProposals(OWNER, [OWNER], dd("2026-11-10T23:40:00Z"));
  t("OQ-7 18:40 ET weekday -> ONE turn in Iris's 1:1", [d1.delivered, turns.size, ran.length], [true, 1, 1]);
  const p = [...turns.values()][0] as { huddleId: string; targetAgentId: string; internal: boolean; agents: Record<string, { journey: { enabled: boolean } }>; checklist: { rows: unknown[] } };
  t("AC-5.16 payload: dm-iris-chase, internal, journey disabled (turn writes no task)", [p.huddleId, p.targetAgentId, p.internal, p.agents["iris-chase"].journey.enabled], ["dm-iris-chase", "iris-chase", true, false]);
  t("OQ-7 the posting carries ALL open proposals", p.checklist.rows.length, 50);
  const d2 = await deliverEveningProposals(OWNER, [OWNER], dd("2026-11-11T00:30:00Z"));
  t("AC-5.16 a second tick the same evening sends nothing twice", [d2.delivered, d2.reason, ran.length], [false, "already_delivered", 1]);
  const d3 = await deliverEveningProposals(OWNER, [OWNER], dd("2026-11-11T23:40:00Z"));
  t("OQ-7 next weekday evening -> a new posting", [d3.delivered, turns.size], [true, 2]);
  const empty = memStore();
  t("OQ-7 nothing open -> no posting", (await deliverEveningProposals(OWNER, [OWNER], { ...dd("2026-11-12T23:40:00Z"), store: empty })).reason, "none_active");
}

// ── K. stream-context labelling (AC-5.17) + build_checklist proposals mode OFF (AC-6.1) ──────────
console.log("\n# K. stream-context + build_checklist proposals mode");
{
  const { streamItemSummary } = await import("../src/features/huddle/lib/stream-context");
  const taskOnly = { title: "Kids", rows: [{ taskId: "3f2a9c1e-8d7b-4c2a-9e1f-0a1b2c3d4e5f", title: "Pack bag", status: "DOING", tags: [] }] };
  t("AC-5.1/5.17 a task-only checklist summarises EXACTLY as before", streamItemSummary({ checklist: taskOnly } as never), '[Checklist "Kids" shown: 1. Pack bag (DOING)]');
  const mixed = { title: "Proposed tasks", rows: [...taskOnly.rows, cr] };
  const s = streamItemSummary({ checklist: mixed } as never, { live: { [pid]: { status: "approved", tags: [] } } });
  t("AC-5.17 proposal rows are on their own line, labelled with state, as NOT board tasks", s, '[Checklist "Proposed tasks" shown: 1. Pack bag (DOING)]\n[Proposed tasks "Proposed tasks" shown — suggestions found in email/Teams/meetings, NOT tasks on the board unless approved: 1. approved: Send the Q3 deck]');
  const onlyProps = streamItemSummary({ checklist: { title: "Proposed tasks", rows: [cr] } } as never);
  t("AC-5.17 proposals-only payload -> no empty task line", onlyProps.startsWith("[Proposed tasks") && !onlyProps.includes("[Checklist"), true);
}
{
  const prev = process.env.HUDDLE_ONEDRIVE_FEEDS;
  delete process.env.HUDDLE_ONEDRIVE_FEEDS;
  const { dispatchBuildChecklist } = await import("../src/features/huddle/lib/tasks/tools");
  t("AC-6.1 build_checklist proposals:true with the feature OFF -> not_enabled, no widget", JSON.parse(await dispatchBuildChecklist("owner@eds.example", { title: "x", proposals: true })).error, "not_enabled");
  process.env.HUDDLE_ONEDRIVE_FEEDS = JSON.stringify({ ...feedsJson, correspondence: { ingest: true, proposals: false } });
  t("AC-6.3 proposals:false in config -> still not_enabled", JSON.parse(await dispatchBuildChecklist("owner@eds.example", { title: "x", proposals: true })).error, "not_enabled");
  const { proposalsDeliverAt } = await import("../src/features/huddle/lib/proposals/proposals.server");
  t("OQ-7 deliver time: valid HH:MM kept, junk -> default", [proposalsDeliverAt(JSON.stringify({ correspondence: { proposalsDeliverAt: "19:15" } })), proposalsDeliverAt(JSON.stringify({ correspondence: { proposalsDeliverAt: "25:00" } })), proposalsDeliverAt("not json")], ["19:15", undefined, undefined]);
  if (prev === undefined) delete process.env.HUDDLE_ONEDRIVE_FEEDS;
  else process.env.HUDDLE_ONEDRIVE_FEEDS = prev;
}

// ── L. public-repo hygiene for this feature's files (AC-8.1, 8.2) ────────────────────────────────
console.log("\n# L. hygiene");
{
  const { readdirSync } = await import("node:fs");
  const ROOT = join(import.meta.dir, "..");
  const mine = [
    ...readdirSync(join(ROOT, "src/features/huddle/lib/proposals")).map((f) => `src/features/huddle/lib/proposals/${f}`),
    "src/features/huddle/components/ProposalChecklistItem.tsx",
    "scripts/task-proposals.test.ts",
    "scripts/task-proposals-sql.test.ts",
  ];
  const bad: string[] = [];
  for (const f of mine) {
    const txt = readFileSync(join(ROOT, f), "utf8");
    for (const m of txt.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) if (!/\.example$/.test(m)) bad.push(`${f}: ${m}`);
  }
  t("AC-8.1 every address in this feature's files is a .example placeholder", bad, []);
  const ui = readFileSync(join(ROOT, "src/features/huddle/components/ProposalChecklistItem.tsx"), "utf8");
  t("AC-8.2 no source path or mailbox in client code", /automation\/|@/.test(ui.replace(/@\/(lib|components)/g, "")), false);
}

// ── L. red-team fix pass (2026-11-12): over-match negatives + the fixes the red-team suite does not drive ──
console.log("\n# L. red-team fix pass");
{
  // F3: one candidate's failed write does not lose the others; the item is retried with a short code.
  const store = memStore();
  const flaky: ProposalStore = { ...store, upsert: async (p) => (p.normTitle === "send the q3 deck" ? Promise.reject(new Error("boom")) : store.upsert(p)) };
  const src = { source: "email" as const, sourceItemId: "m:iso", at: AT, context: null, text: "Can you send me the Q3 deck by Friday? Also please update the budget sheet by Nov 14." };
  const raw = { tasks: [
    { task: "Send the Q3 deck", evidence: "Can you send me the Q3 deck by Friday?", assignee: null, due_text: "by Friday" },
    { task: "Update the budget sheet", evidence: "please update the budget sheet by Nov 14", assignee: null, due_text: "by Nov 14" },
  ] };
  let err = "";
  try {
    await proposeFromSource(OWNER, src, { store: flaky, extract: async () => raw, openTitles: async () => new Set(), tz: TZ });
  } catch (e) {
    err = e instanceof Error ? e.message : "";
  }
  t("F3 a failed row write -> the item throws a short code (ledger retries it)", err, "proposals:store_failed");
  t("F3 ...and the OTHER to-do of the same item was still stored", [...store.rows.values()].map((r) => r.title), ["Update the budget sheet"]);
}
{
  // S4: create succeeded, recording it failed -> the lease is released at once; a retry links, never re-creates.
  const store = memStore();
  const r = await proposeFromSource(OWNER, { source: "email", sourceItemId: "m:s4", at: AT, context: null, text: "Please review the vendor contract today." }, {
    store,
    extract: async () => ({ tasks: [{ task: "Review the vendor contract", evidence: "Please review the vendor contract today.", assignee: null, due_text: "today" }] }),
    openTitles: async () => new Set(),
    tz: TZ,
  });
  const id = r.ids[0];
  let creates = 0;
  let finishCalls = 0;
  const board: Array<{ id: string; title: string }> = [];
  const broken: ProposalStore = { ...store, finishApprove: async () => { finishCalls++; return null; } };
  const deps = (st: ProposalStore) => ({
    store: st,
    openTasks: async () => board,
    createTask: async (title: string) => {
      creates++;
      board.push({ id: `task-${creates}`, title });
      return { ok: true as const, taskId: `task-${creates}` };
    },
    metaGuard: () => null,
  });
  const a1 = await approveProposal([OWNER], id, deps(broken));
  t("S4 finishApprove fails -> error, retried once (2 calls)", [a1.ok, finishCalls], [false, 2]);
  t("S4 ...and the lease is RELEASED (claimable again right away)", (await store.claimApprove([OWNER], id, 90)).claimed, true);
  await store.releaseApprove(id);
  const a2 = await approveProposal([OWNER], id, deps(store));
  t("S4 a retry links the task just created instead of creating a second", [a2.ok, a2.ok && a2.alreadyOnBoard, creates], [true, true, 1]);
}
{
  // F14 negative: the same item re-extracted with a genuinely DIFFERENT to-do (a different number) is proposed.
  const store = memStore();
  const src = { source: "email" as const, sourceItemId: "m:f14", at: AT, context: null, text: "Can you send me the Q3 deck and the Q4 deck by Friday?" };
  let task = "Send the Q3 deck";
  const deps = { store, extract: async () => ({ tasks: [{ task, evidence: "Can you send me the Q3 deck and the Q4 deck by Friday?", assignee: null, due_text: null }] }), openTitles: async () => new Set<string>(), tz: TZ };
  const r1 = await proposeFromSource(OWNER, src, deps);
  await decideProposal([OWNER], r1.ids[0], "dismissed", store);
  task = "Send the Q4 deck";
  const r2 = await proposeFromSource(OWNER, src, deps);
  t("F14 over-match negative: a different to-do from the same item (Q4 vs dismissed Q3) is still proposed", [r2.created, r2.suppressed], [1, 0]);
}
{
  const ok = (task: string, evidence: string, src: string) => validateCandidates({ tasks: [{ task, evidence, assignee: null, due_text: null }] }, src, { atIso: AT, tz: TZ }).accepted.map((c) => c.evidence);
  t("F7 over-match negative: \"Don't forget to send ...\" is NOT a negation", ok("Send the deck", "send the deck by Friday", "Don't forget to send the deck by Friday."), ["Don't forget to send the deck by Friday."]);
  t("F7 over-match negative: \"Not sure ..., but can you send ...\" is NOT a negation", ok("Send the deck", "can you send the deck by Friday", "Not sure if you saw it, but can you send the deck by Friday?").length, 1);
  t("F7 the stored evidence is the whole enclosing sentence (not the fragment)", ok("Send the contract", "send the contract to the client", "Hi team.\nPlease send the contract to the client today. Thanks!"), ["Please send the contract to the client today."]);
  const why = (task: string, evidence: string, src: string) => Object.keys(validateCandidates({ tasks: [{ task, evidence, assignee: null, due_text: null }] }, src, { atIso: AT, tz: TZ }).rejected);
  t("F4 majority: one shared verb + an invented object (no numbers) -> task_not_grounded", why("Send the signed lease to Morgan", "Please send the invoice to Dana by Friday", "Please send the invoice to Dana by Friday."), ["task_not_grounded"]);
  t("F4 numbers: majority grounded but an invented number ('Q4' vs 'Q3') -> task_number_not_grounded", why("Send the Q4 deck", "Can you send me the Q3 deck by Friday?", "Can you send me the Q3 deck by Friday?"), ["task_number_not_grounded"]);
  t("F5 size: a 3-word fragment is refused even when every word matches the title", why("Send the deck", "send the deck", "Thanks for offering to send the deck."), ["evidence_too_short"]);
  // Isolating checks (fix-pass mutation proofs): the 3-word case above is ALSO under 15 chars, so each
  // floor masked the other. One check per floor: 4 words but 13 chars; 22 chars but 2 words.
  t("F5 size (chars): 4 words but under 15 characters is refused", why("Pay 3 tabs", "pay my 3 tabs", "Can you pay my 3 tabs today?"), ["evidence_too_short"]);
  t("F5 size (words): over 15 characters but only 2 words is refused", why("Approve reimbursements", "approve reimbursements", "Please approve reimbursements today."), ["evidence_too_short"]);
  t("F4 over-match negative: a fully grounded imperative title is accepted",ok("Update the budget sheet", "Dana will update the budget sheet", "Dana will update the budget sheet by Nov 14.").length, 1);
}
// Isolating checks: each one fails if ONLY its own guard is removed (the red-team probes are also caught
// by a second guard, so they cannot prove these alone -- see the mutation table in IMPL-task-proposals.md).
t("F6 a prefix collision cannot make a majority ('Preserve notes' vs 'presentation notes')", Object.keys(validateCandidates({ tasks: [{ task: "Preserve notes", evidence: "See the presentation notes please", assignee: null, due_text: null }] }, "See the presentation notes please.", { atIso: AT, tz: TZ }).rejected), ["task_not_grounded"]);
t("F12 a name that is only the RECIPIENT is not the assignee", groundedAssignee("Bob", "Please send the deck to Bob"), null);
t("F12 a date word in the addressee slot is not a person ('Tomorrow, please ...')", groundedAssignee("Tomorrow", "Tomorrow, please send the deck"), null);
t("F13 the STORED title itself carries no zero-width / look-alike char", validateCandidates({ tasks: [{ task: "Sеnd the Q3​ deck", evidence: "send me the Q3 deck", assignee: null, due_text: null }] }, "Can you send me the Q3 deck by Friday?", { atIso: AT, tz: TZ }).accepted.map((c) => c.title), ["Send the Q3 deck"]);
{
  const r = await proposeFromSource(OWNER, { source: "email", sourceItemId: "m:zwboard", at: AT, context: null, text: "Can you send me the Q3 deck by Friday?" }, {
    store: memStore(),
    extract: async () => ({ tasks: [{ task: "Send the Q3 deck", evidence: "send me the Q3 deck", assignee: null, due_text: null }] }),
    openTitles: async () => new Set(["send the q3​ deck"]),
    tz: TZ,
  });
  t("F13 a BOARD title with a zero-width char still counts as already on the board", [r.created, r.onBoard], [0, 1]);
}
t("S1 a zone-less timestamp is UTC whatever the host zone", parseUtcMs("2026-11-10T10:00:00"), Date.UTC(2026, 10, 10, 10, 0, 0));
t("F12 trailing addressee ('..., Dana?') -> Dana",groundedAssignee("Dana", "Can you send the deck, Dana?"), "Dana");
t("F12 hand-off ('ask Dana to ...') -> Dana", groundedAssignee("Dana", "Please ask Dana to send the deck"), "Dana");
t("F12 lower-case common word is not a name", groundedAssignee("dana", "dana will send it"), null);
t("F11 day-month order ('14 November') -> 2026-11-14", resolveDueDate("by 14 November", AT, TZ), "2026-11-14");
t("F11 every date term negated -> null", resolveDueDate("not today", AT, TZ), null);
t("F13 titleKey folds full-width + zero-width + mixed-script look-alikes", titleKey("Ｓеnd the Q3\u200b deck"), "send the q3 deck");
t("F13 an all-Cyrillic word is real text and is NOT folded", titleKey("Отправить deck"), "отправить deck");
t("F8 over-match negative: a visible styled span is kept", htmlToText('<p>Hi <span style="display:inline-block;font-size:12px">please send the deck</span></p>'), "Hi please send the deck");
t("F8 nested hidden element removed whole, the text after it kept", htmlToText('<div style="display:none"><div>a</div>hidden</div><p>shown</p>'), "shown");
t("F8b font-size:0 wrapper with a re-sized child keeps the visible ask", htmlToText('<table><tr><td style="font-size:0"><div style="font-size:14px">Can you review the deck?</div></td></tr></table>'), "Can you review the deck?");
t("F8b font-size:0 wrapper drops its OWN zero-size text, keeps the re-sized child", htmlToText('<td style="font-size:0">Wire 5000 now<span style="font-size:14px">see you at lunch</span></td>'), "see you at lunch");
t("F8b font-size:0 with no re-sized content is still hidden", htmlToText('<p>shown</p><span style="font-size:0">Wire 5000 now</span>'), "shown");
t("F8b a font-size:0px / inherit child does NOT re-size", htmlToText('<div style="font-size:0"><span style="font-size:0px">a</span><span style="font-size:inherit">b</span></div><p>shown</p>'), "shown");
t("F8b a 0.9em child re-sizes", htmlToText('<div style="font-size:0"><span style="font-size:0.9em">please send the deck</span></div>'), "please send the deck");
t("F8b display:none inside a re-sized child is still removed", htmlToText('<div style="font-size:0"><div style="font-size:14px">ok <span style="display:none">Wire 5000</span>thanks</div></div>'), "ok thanks");
t("F8c an UNCLOSED hidden element ends at its parent's close, real text after it kept", htmlToText('<table><tr><td><span style="display:none">Wire 5000</td><td>Can you review the deck?</td></tr></table>'), "Can you review the deck?");
t("F8c an unclosed hidden element with no parent close still hides the rest", htmlToText('<p>shown</p><div style="display:none">Wire 5000 now'), "shown");
t("F19 &amp;lt; decodes once to the literal &lt;", htmlToText("<p>a &amp;lt; b</p>"), "a &lt; b");
t("S1 a zone-less timestamp is UTC", parseUtcMs("2026-11-10T10:00:00") === Date.parse("2026-11-10T10:00:00Z"), true);
t("S1 an explicit offset is kept", parseUtcMs("2026-11-10T10:00:00+02:00") === Date.parse("2026-11-10T08:00:00Z"), true);
{
  const base = { enabled: true, ownerLogins: ["owner@eds.example"], driveUser: "owner@eds.example", mailbox: "owner@work.example", synthetic: false };
  const c = (x: Record<string, unknown>) => parseCfg(JSON.stringify({ ...base, ...x }));
  t("F1 teams:true -> on at the default path; teams:{} -> on", [c({ teams: true })?.teams.enabled, c({ teams: true })?.teams.path, c({ teams: {} })?.teams.enabled], [true, "/automation/email/huddle-source-log.jsonl", true]);
  t("F1/F2 teams:0 / [] / {enabled:false}, sent:\"on\" -> off", [c({ teams: 0 })?.teams.enabled, c({ teams: [] })?.teams.enabled, c({ teams: { enabled: false } })?.teams.enabled, c({ sent: "on" })?.sent.enabled], [false, false, false, false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
