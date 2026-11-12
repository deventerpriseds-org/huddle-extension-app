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
  type ProposalStore,
} from "../src/features/huddle/lib/proposals/proposals";
import {
  approveProposal,
  decideProposal,
  deliverEveningProposals,
  editProposal,
  proposalChecklistResult,
  proposalsProcessor,
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
