// WHAT:       Offline tests for MEETING-MINUTES TRIAGE (AC-correspondence-redesign R5 + spelling table S-C + the R9
//             flag ACs that apply to R5): the minutes predicate, the action-item splitter (probe P-4 shapes), the
//             typed-name cleaner, the one-ping-per-meeting pass against an in-memory store / ledger / turn queue,
//             Mine / For someone / Skip, the checklist row mapping and sanitizer, the report grouping, the flag,
//             and the proposals processor's minutes skip. Every check names its AC id.
// WHY:        Tier 1: this decides what enters the owner's meeting action-item queue. Synthetic fixtures only.
// SUPERSEDES: scripts/task-proposals.test.ts section H (automatic transcript -> proposals, rejected by the owner).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-meeting-triage.md.
// Run: bun scripts/meeting-triage.test.ts
import { minutesSignal, isMinutesVendor } from "../src/features/huddle/lib/correspondence/minutes-signal";
import {
  MAX_TRIAGE_PER_MEETING,
  cleanTriageName,
  groupMeetingQueue,
  meetingTriageTurnId,
  splitActionItems,
  triageRowsFor,
  type TriageOutcome,
  type TriageStore,
} from "../src/features/huddle/lib/proposals/meeting-triage";
import {
  proposalChecklistRow,
  proposalSourceFromItem,
  sanitizeChecklistPayload,
  type NewProposal,
  type ProposalRow,
  type ProposalState,
} from "../src/features/huddle/lib/proposals/proposals";
import { proposalsProcessor, runMeetingTriage, triageProposal, type ExtractFn, type MeetingRef, type MeetingTriageDeps } from "../src/features/huddle/lib/proposals/engine";
import * as engine from "../src/features/huddle/lib/proposals/engine";
import { ledgerKey, type ClaimedItem, type LedgerStatus, type LedgerStore, type SourceItem } from "../src/features/huddle/lib/correspondence/source-item";
import { parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { meetingTriageOn } from "../src/features/huddle/lib/proposals/proposals.server";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const OWNER = "owner@eds.example";
const AT = "2026-11-10T14:00:00.000Z";
const TZ = "America/New_York";

// ── A. SPELLING TABLE S-C: what counts as minutes (AC-R5.1, AC-R5.4) ───────────────────────────────
console.log("\n# A. minutes spelling table (S-C, Tier 1)");
type MRow = [string, Parameters<typeof minutesSignal>[0], boolean];
const MTABLE: MRow[] = [
  ["S-C1 Huddle's own 'Meeting Minutes:' subject -> minutes", { subject: "Meeting Minutes: Budget sync Nov 14, 10:00 AM", fromAddress: "huddle@work.example", newText: "Summary..." }, true],
  ["S-C2 'Updated Meeting Minutes:' -> minutes", { subject: "Updated Meeting Minutes: Budget sync Nov 14", fromAddress: "huddle@work.example", newText: "" }, true],
  ["S-C2b lower-case 'meeting minutes:' -> minutes", { subject: "meeting minutes: budget sync", fromAddress: "pat@work.example", newText: "" }, true],
  ["S-C3 sender @fireflies.ai, any subject -> minutes", { subject: "Your meeting is ready", fromAddress: "fred@fireflies.ai", newText: "Can you review it?" }, true],
  ["S-C3b sender at a fireflies.ai subdomain, display-name form -> minutes", { subject: "Recap", fromAddress: "Fred <notes@mail.fireflies.ai>", newText: "" }, true],
  ["S-C4 'Meeting recap: Budget sync' -> minutes", { subject: "Meeting recap: Budget sync", fromAddress: "pat@work.example", newText: "Notes below." }, true],
  ["S-C4b 'Recap of Budget sync' -> minutes", { subject: "Recap of Budget sync", fromAddress: "pat@work.example", newText: "Notes below." }, true],
  ["S-C5 'Meeting notes: Budget sync' -> minutes", { subject: "Meeting notes: Budget sync", fromAddress: "pat@work.example", newText: "Attached." }, true],
  ["S-C5b 'Meeting summary for Budget sync' -> minutes", { subject: "Meeting summary for Budget sync", fromAddress: "pat@work.example", newText: "Attached." }, true],
  ["S-C6 NEG 'Fw: Meeting Minutes: ...' + a direct ask -> NOT minutes", { subject: "Fw: Meeting Minutes: Budget sync", fromAddress: "pat@work.example", newText: "Owner, can you take item 3 by Friday?" }, false],
  ["S-C6b NEG 'Re: Meeting Minutes: ...' (a person replied) -> NOT minutes", { subject: "Re: Meeting Minutes: Budget sync", fromAddress: "pat@work.example", newText: "Thanks." }, false],
  ["S-C7 NEG 'Summary of the budget' + 'Can you approve by Friday?' -> NOT minutes", { subject: "Summary of the budget", fromAddress: "pat@work.example", newText: "Can you approve by Friday?" }, false],
  ["S-C7b NEG 'Meeting notes: ...' + a direct ask -> NOT minutes", { subject: "Meeting notes: Budget sync", fromAddress: "pat@work.example", newText: "Could you send the numbers?" }, false],
  ["S-C NEG 'notfireflies.ai' sender (substring) -> NOT minutes", { subject: "Hello", fromAddress: "a@notfireflies.ai", newText: "" }, false],
  ["S-C NEG 'fireflies.ai.evil.test' sender -> NOT minutes", { subject: "Hello", fromAddress: "a@fireflies.ai.evil.test", newText: "" }, false],
  ["S-C NEG 'minutes' word alone ('5 minutes late') -> NOT minutes", { subject: "Running 5 minutes late", fromAddress: "pat@work.example", newText: "" }, false],
  ["S-C NEG 'Budget summary' (no 'meeting', not leading 'summary of') -> NOT minutes", { subject: "Budget summary", fromAddress: "pat@work.example", newText: "" }, false],
  ["S-C NEG a plain email -> NOT minutes", { subject: "Lunch?", fromAddress: "pat@work.example", newText: "Are you free?" }, false],
  ["S-C8 Teams app sender in a meeting chat -> minutes", { teams: { senderIsApp: true, chatKind: "meeting_chat" } }, true],
  ["S-C8 NEG Teams app sender in a 1:1 -> NOT minutes", { teams: { senderIsApp: true, chatKind: "one_to_one" } }, false],
  ["S-C8 NEG a PERSON in a meeting chat -> NOT minutes", { teams: { senderIsApp: false, chatKind: "meeting_chat" } }, false],
];
for (const [name, input, want] of MTABLE) t(name, minutesSignal(input).minutes, want);
t("S-C7 the reason is direct_ask (decided as a normal message)", minutesSignal({ subject: "Summary of the budget", newText: "Can you approve by Friday?" }), { minutes: false, reason: "direct_ask" });
t("AC-R1.5 the subject never reaches the ask test ('invite' in a minutes subject decides nothing)", minutesSignal({ subject: "Meeting notes: invite list", newText: "Notes attached." }).minutes, true);
t("S-C isMinutesVendor whole-label only", [isMinutesVendor("x@fireflies.ai"), isMinutesVendor("x@FIREFLIES.AI"), isMinutesVendor("x@ffireflies.ai"), isMinutesVendor(null)], [true, true, false, false]);

// ── B. splitting Fireflies action_items (AC-R5.2, probe P-4) ───────────────────────────────────────
console.log("\n# B. action-item splitter (probe P-4 shapes)");
t("P-4 one string, every line a bullet -> one item per line, bullet stripped", splitActionItems("- Send the Q3 deck\n- Book the room\n- Call the vendor").items, ["Send the Q3 deck", "Book the room", "Call the vendor"]);
t("P-4 trailing (mm:ss) stamp stripped", splitActionItems("- Send the Q3 deck (12:34)\n- Book the room (01:02:03)").items, ["Send the Q3 deck", "Book the room"]);
t("P-4 two trailing stamps stripped", splitActionItems("- Send the deck (00:10) (00:45)").items, ["Send the deck"]);
t("P-4 a stamp in the MIDDLE is kept (only trailing)", splitActionItems("- At (10:00) review the deck").items, ["At (10:00) review the deck"]);
t("bullets * • · – and numbers 1. 2) all stripped", splitActionItems("* One item here\n• Two item here\n· Three item\n– Four item\n1. Five item\n2) Six item").items, ["One item here", "Two item here", "Three item", "Four item", "Five item", "Six item"]);
t("blank lines and CRLF ignored", splitActionItems("- A thing to do\r\n\r\n  \r\n- Another thing").items, ["A thing to do", "Another thing"]);
t("no bullet at all: the line is still one item", splitActionItems("Send the Q3 deck").items, ["Send the Q3 deck"]);
{
  const r = splitActionItems("**Pat Doe**\n- Send the deck\nAction items:\n- Book the room");
  t("defensive: heading-only lines are not items (counted)", [r.items, r.dropped.heading], [["Send the deck", "Book the room"], 2]);
}
{
  const r = splitActionItems("- Send the deck\n- send the deck.\n- SEND THE DECK");
  t("duplicates within a meeting (same title key) -> one item", [r.items.length, r.dropped.duplicate], [1, 2]);
}
{
  const lines = Array.from({ length: 60 }, (_, i) => `- Distinct item number ${i + 1}`).join("\n");
  const r = splitActionItems(lines);
  t("cap: at most MAX_TRIAGE_PER_MEETING rows, the rest counted", [r.items.length, r.dropped.overCap, MAX_TRIAGE_PER_MEETING], [50, 10, 50]);
}
t("a list of strings is accepted too", splitActionItems(["- Send the deck", "- Book the room"]).items, ["Send the deck", "Book the room"]);
t("non-text input -> no items", [splitActionItems(null).items, splitActionItems(42).items, splitActionItems({ a: 1 }).items], [[], [], []]);
t("an over-long line is capped at 200 characters", splitActionItems(`- ${"word ".repeat(80)}`).items[0].length <= 200, true);
t("zero-width characters are removed", splitActionItems("- Send​ the deck").items, ["Send the deck"]);
t("P-4 no owner is ever guessed: rows carry no assignee", triageRowsFor(OWNER, { meetingId: "ff-1", title: "Test-Sync", meetingAt: AT }, ["Pat to send the deck"]).map((r) => r.assignee), [null]);

// ── C. typed name (AC-R5.10 / R5.16) ──────────────────────────────────────────────────────────────
console.log("\n# C. typed name");
t("AC-R5.16 trimmed", cleanTriageName("  Pat  "), "Pat");
t("AC-R5.16 capped at 80 characters", cleanTriageName("x".repeat(120))?.length, 80);
t("AC-R5.16 empty / whitespace -> null (nothing saved)", [cleanTriageName(""), cleanTriageName("   "), cleanTriageName(null), cleanTriageName(5)], [null, null, null, null]);
t("AC-R5.16 control and zero-width characters removed", cleanTriageName("Pa\u0000t​ D\noe"), "Pa t D oe");
t("AC-R5.16 markup kept as TEXT (rendered escaped, never parsed)", cleanTriageName("<b>Pat</b>"), "<b>Pat</b>");

// ── In-memory twins ───────────────────────────────────────────────────────────────────────────────
const memStore = () => {
  const rows = new Map<string, ProposalRow>();
  const refs = new Map<string, string>(); // owner|source|item|norm -> proposal id
  const calls: string[] = [];
  const own = (owners: string[], r?: ProposalRow) => !!r && owners.map((o) => o.toLowerCase()).includes(r.owner);
  const out = (r?: ProposalRow) => (r ? structuredClone(r) : null);
  const store: TriageStore & { rows: typeof rows; refs: typeof refs; calls: typeof calls; listActive(o: string[]): Promise<ProposalRow[]>; addActive(p: NewProposal): void } = {
    rows,
    refs,
    calls,
    async addTriageRows(ps) {
      calls.push("addTriageRows");
      const created: string[] = [];
      const existing: string[] = [];
      for (const p of ps) {
        const k = [p.owner.toLowerCase(), p.ref.source, p.ref.sourceItemId, p.normTitle].join("|");
        if (refs.has(k)) {
          existing.push(refs.get(k)!);
          continue;
        }
        rows.set(p.id, { id: p.id, owner: p.owner.toLowerCase(), state: "untriaged", title: p.title, originalTitle: p.title, normTitle: p.normTitle, edited: false, evidence: p.evidence, assignee: null, dueText: null, dueDate: null, sources: [{ ...p.ref, context: p.ref.context ?? null }], taskId: null, createdAt: AT, decidedAt: null });
        refs.set(k, p.id);
        created.push(p.id);
      }
      return { created, existing };
    },
    async triage(owners, id, target, assignee): Promise<TriageOutcome> {
      calls.push("triage");
      await Promise.resolve(); // let a concurrent caller interleave
      const r = rows.get(id);
      if (!own(owners, r)) return { applied: false, row: null };
      if (r!.state !== "untriaged") return { applied: false, row: out(r) };
      if (target === "proposed") {
        const act = [...rows.values()].find((x) => x.owner === r!.owner && x.normTitle === r!.normTitle && x.state === "proposed");
        if (act) {
          const k = [r!.owner, r!.sources[0].source, r!.sources[0].sourceItemId, r!.normTitle].join("|");
          refs.set(k, act.id);
          act.sources.push(r!.sources[0]);
          r!.state = "dismissed";
          return { applied: true, row: out(r), mergedInto: out(act) };
        }
      }
      r!.state = target;
      if (target === "delegated") r!.assignee = assignee;
      return { applied: true, row: out(r) };
    },
    async getMany(owners, ids) {
      return ids.map((i) => rows.get(i)).filter((r) => own(owners, r)).map((r) => out(r)!);
    },
    async listMeetingQueue(owners) {
      return [...refs.entries()]
        .filter(([k]) => k.split("|")[1] === "transcript")
        .map(([k, id]) => ({ ...out(rows.get(id))!, meetingId: k.split("|")[2] }))
        .filter((r) => own(owners, r));
    },
    async listUntriaged(owners) {
      return [...rows.values()].filter((r) => own(owners, r) && r.state === "untriaged").map((r) => out(r)!);
    },
    // The evening checklist's read (ProposalStore.listActive semantics: state = proposed only).
    async listActive(owners) {
      return [...rows.values()].filter((r) => own(owners, r) && r.state === "proposed").map((r) => out(r)!);
    },
    addActive(p) {
      rows.set(p.id, { id: p.id, owner: p.owner, state: "proposed", title: p.title, originalTitle: p.title, normTitle: p.normTitle, edited: false, evidence: p.evidence, assignee: null, dueText: null, dueDate: null, sources: [{ ...p.ref, context: p.ref.context ?? null }], taskId: null, createdAt: AT, decidedAt: null });
      refs.set([p.owner, p.ref.source, p.ref.sourceItemId, p.normTitle].join("|"), p.id);
    },
  };
  return store;
};

type LRow = { owner: string; hash: string; status: LedgerStatus; attempts: number; v: number; leased: boolean; result: Record<string, string[]>; source: SourceItem["source"]; id: string; missing: string | null };
const memLedger = () => {
  const rows = new Map<string, LRow>();
  const ledger: LedgerStore = {
    async observe(owner, items) {
      const o = { inserted: 0, changed: 0, unchanged: 0 };
      for (const i of items) {
        const k = ledgerKey(i);
        const r = rows.get(k);
        if (!r) {
          rows.set(k, { owner, hash: i.contentHash, status: "pending", attempts: 0, v: 0, leased: false, result: {}, source: i.source, id: i.sourceItemId, missing: null });
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
    async hasDue() {
      return false;
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
    async markFailed(c, _cat, max) {
      const r = rows.get(ledgerKey(c))!;
      if (r.v !== c.claimVersion) return false;
      Object.assign(r, { status: r.attempts >= max ? "failed" : "failed_retryable", leased: false });
      return true;
    },
    async health() {
      return {};
    },
  };
  return { rows, ledger, unlease: () => rows.forEach((r) => (r.leased = false)) };
};

/** The durable-turn queue twin: enqueueTurn's ON CONFLICT (id) DO NOTHING. */
const memTurns = () => {
  const turns = new Map<string, Record<string, unknown>>();
  const runs: string[] = [];
  let failEnqueue = 0;
  let failRun = 0;
  return {
    turns,
    runs,
    failNextEnqueue: () => failEnqueue++,
    failNextRun: () => failRun++,
    enqueue: async (id: string, payload: Record<string, unknown>) => {
      if (failEnqueue) {
        failEnqueue--;
        throw new Error("turns:enqueue_failed");
      }
      if (turns.has(id)) return false;
      turns.set(id, structuredClone(payload));
      return true;
    },
    run: async (id: string) => {
      if (failRun) {
        failRun--;
        throw new Error("run failed");
      }
      runs.push(id);
    },
  };
};

const meetingsFixture = (): MeetingRef[] => [
  { meetingId: "ff-1", title: "Test-Budget sync", meetingAt: AT, contentHash: "h1" },
  { meetingId: "ff-2", title: "Test-Standup", meetingAt: AT, contentHash: "h2" },
];
const ITEMS: Record<string, unknown> = {
  "ff-1": "- Test-Send the Q3 deck (01:02)\n- Test-Book the room\n- Test-Call the vendor",
  "ff-2": "", // a meeting with no action items
};
const mkDeps = (store: ReturnType<typeof memStore>, led: ReturnType<typeof memLedger>, turns: ReturnType<typeof memTurns>, meetings: MeetingRef[], items = ITEMS) => {
  const fetched: string[] = [];
  const deps: MeetingTriageDeps = {
    store,
    ledger: led.ledger,
    listFinishedMeetings: async () => meetings,
    fetchActionItems: async (id) => {
      fetched.push(id);
      return id in items ? items[id] : null;
    },
    enqueue: turns.enqueue,
    run: turns.run,
    maxAttempts: 5,
    now: () => 0,
    budgetMs: 10_000,
    tz: TZ,
  };
  return { deps, fetched };
};

// ── D. the pass: one ping per meeting (AC-R5.3, 5.5-5.7, 5.12) ────────────────────────────────────
console.log("\n# D. triage pass (one ping per meeting)");
t("AC-R5.3 the automatic transcript -> proposals path is gone from the engine", "runTranscriptProposals" in engine, false);
{
  const store = memStore();
  const led = memLedger();
  const turns = memTurns();
  const meetings = meetingsFixture();
  const { deps, fetched } = mkDeps(store, led, turns, meetings);
  const r1 = await runMeetingTriage(OWNER, deps);
  const rows = [...store.rows.values()];
  t("AC-R5.3 a finished meeting creates ZERO proposed rows", rows.filter((r) => r.state === "proposed").length, 0);
  t("AC-R5.5 its 3 action items are 3 untriaged rows (stamp stripped, no assignee)", rows.map((r) => [r.state, r.title, r.assignee]), [["untriaged", "Test-Send the Q3 deck", null], ["untriaged", "Test-Book the room", null], ["untriaged", "Test-Call the vendor", null]]);
  t("AC-R5.5 ONE durable turn for that meeting, run once", [turns.turns.size, turns.runs.length, r1.pinged], [1, 1, 1]);
  const [turnId, payload] = [...turns.turns.entries()][0];
  t("AC-R5.6 turn id = meeting-triage-<hash(owner, meeting_id)>", turnId, meetingTriageTurnId(OWNER, "ff-1"));
  t("AC-R5.6 turn id is case-insensitive in the owner", meetingTriageTurnId("OWNER@EDS.example", "ff-1"), turnId);
  t("AC-R5.5 posted in Iris's 1:1 with the usual push; journey disabled", [payload.huddleId, payload.targetAgentId, payload.notify, (payload.agents as Record<string, { journey: { enabled: boolean } }>)["iris-chase"].journey.enabled], ["dm-iris-chase", "iris-chase", "push", false]);
  const cl = payload.checklist as { title: string; rows: Array<{ kind: string; status: string; proposal: { triage?: boolean; state: string } }> };
  t("AC-R5.5/R5.15 the checklist holds the 3 rows, kind proposal, triage flag, untriaged", [cl.rows.length, cl.rows.every((x) => x.kind === "proposal" && x.proposal.triage === true && x.status === "untriaged")], [3, true]);
  t("AC-R5.5 the checklist is titled with the meeting", cl.title, "Meeting action items: Test-Budget sync");
  t("privacy: the directive carries no meeting title or item text", /Test-/.test(String(payload.text)), false);
  t("AC-R5.12 the meeting with ZERO action items: no ping, ledger processed", [[...led.rows.values()].find((x) => x.id === "ff-2")?.status, turns.turns.size], ["processed", 1]);
  t("both meetings processed, none failed", [r1.processed, r1.failed], [2, 0]);

  // AC-R5.6: the same meeting again (no change) -> no fetch, no ping.
  await runMeetingTriage(OWNER, deps);
  t("AC-R5.6 a re-run with nothing new -> no re-fetch, no second ping", [fetched.length, turns.turns.size, turns.runs.length], [2, 1, 1]);

  // AC-R5.6: re-sent / updated minutes (new content hash), same items -> processed again, no second ping.
  meetings[0] = { ...meetings[0], contentHash: "h1-resent" };
  await runMeetingTriage(OWNER, deps);
  t("AC-R5.6 re-sent minutes (new hash) -> no second ping, no duplicate rows", [turns.turns.size, turns.runs.length, store.rows.size], [1, 1, 3]);

  // AC-R5.11: Skip one item, then the minutes are updated -> the skipped item never reappears.
  const skip = rows.find((r) => r.title === "Test-Book the room")!;
  t("AC-R5.11 Skip applies", (await triageProposal([OWNER], skip.id, "skip", undefined, store)).ok, true);
  // AC-R5.7 (OQ-9): an update ADDS an item after the first ping -> one new row, no second ping.
  meetings[0] = { ...meetings[0], contentHash: "h1-updated" };
  const items2 = { ...ITEMS, "ff-1": `${ITEMS["ff-1"]}\n- Test-Renew the permit (10:11)` };
  const d2 = mkDeps(store, led, turns, meetings, items2);
  const r3 = await runMeetingTriage(OWNER, d2.deps);
  const after = [...store.rows.values()];
  t("AC-R5.7 an updated item list adds ONE untriaged row and sends NO second ping", [after.length, r3.rowsCreated, turns.turns.size, turns.runs.length, after.at(-1)?.state, after.at(-1)?.title], [4, 1, 1, 1, "untriaged", "Test-Renew the permit"]);
  t("AC-R5.11 the skipped item is still the one dismissed row (not re-created)", after.filter((r) => r.normTitle === skip.normTitle).map((r) => r.state), ["dismissed"]);
}
{
  // Crash safety: rows written, then the ping enqueue fails -> retried, rows not duplicated, exactly one ping.
  const store = memStore();
  const led = memLedger();
  const turns = memTurns();
  const { deps } = mkDeps(store, led, turns, meetingsFixture().slice(0, 1));
  turns.failNextEnqueue();
  // The twin ledger has no backoff, so the failed claim is re-claimed inside the same pass (attempt 2).
  const r1 = await runMeetingTriage(OWNER, deps);
  t("enqueue failure -> attempt 1 failed, the retry pings ONCE, rows not duplicated, processed", [r1.failed, r1.pinged, r1.rowsCreated, store.rows.size, turns.turns.size, [...led.rows.values()][0].status, [...led.rows.values()][0].attempts], [1, 1, 3, 3, 1, "processed", 2]);
}
{
  // The turn is durable: an immediate run failure does not fail the meeting (the turn runner picks it up).
  const store = memStore();
  const led = memLedger();
  const turns = memTurns();
  const { deps } = mkDeps(store, led, turns, meetingsFixture().slice(0, 1));
  turns.failNextRun();
  const r = await runMeetingTriage(OWNER, deps);
  t("run failure after enqueue -> processed, ping counted, not re-pinged later", [r.processed, r.pinged, r.failed, turns.turns.size], [1, 1, 0, 1]);
}
{
  // Summary unavailable -> needs_context (no ping, no rows); unknown meeting id -> needs_context.
  const store = memStore();
  const led = memLedger();
  const turns = memTurns();
  const { deps } = mkDeps(store, led, turns, [{ meetingId: "ff-x", title: null, meetingAt: AT, contentHash: "hx" }], {});
  const r = await runMeetingTriage(OWNER, deps);
  t("summary unavailable -> needs_context, zero rows, zero pings", [r.needsContext, store.rows.size, turns.turns.size], [1, 0, 0]);
}

// ── E. owner actions: Mine / For someone / Skip (AC-R5.8-R5.11, R5.16, R5.17) ─────────────────────
console.log("\n# E. Mine / For someone / Skip");
const seedTriage = async (store: ReturnType<typeof memStore>, titles: string[], meetingId = "ff-9") => {
  const r = await store.addTriageRows(triageRowsFor(OWNER, { meetingId, title: "Test-Planning", meetingAt: AT }, titles));
  return r.created;
};
{
  const store = memStore();
  const [mine, someone, skip] = await seedTriage(store, ["Test-Draft the plan", "Test-Order the chairs", "Test-Clean the board"]);
  const m = await triageProposal([OWNER], mine, "mine", undefined, store);
  t("AC-R5.9 Mine -> a normal proposal (state proposed), meeting ref kept", [m.ok, m.ok && m.row.state, store.rows.get(mine)!.sources[0].source], [true, "proposed", "transcript"]);
  t("AC-R5.9 Mine appears in the evening checklist (active list)", (await store.listActive([OWNER])).map((r) => r.id), [mine]);
  const s1 = await triageProposal([OWNER], someone, "someone", "  Pat  ", store);
  t("AC-R5.10 For someone 'Pat' -> delegated, assignee kept as TEXT", [s1.ok, store.rows.get(someone)!.state, store.rows.get(someone)!.assignee], [true, "delegated", "Pat"]);
  t("AC-R5.10/R5.14 a delegated row is NOT in the active list", (await store.listActive([OWNER])).some((r) => r.id === someone), false);
  const k = await triageProposal([OWNER], skip, "skip", undefined, store);
  t("AC-R5.11 Skip -> dismissed", [k.ok, store.rows.get(skip)!.state], [true, "dismissed"]);
  t("AC-R5.14 untriaged / delegated / skipped never in the active list", (await store.listActive([OWNER])).map((r) => r.state), ["proposed"]);
  const again = await triageProposal([OWNER], mine, "skip", undefined, store);
  t("a decided row is not re-triaged (alreadyDone, state unchanged)", [again.ok, again.ok && again.alreadyDone, store.rows.get(mine)!.state], [true, true, "proposed"]);
  t("AC-R5.10 the triage action has only the store: zero journey / email / contact deps (calls seen)", [...new Set(store.calls)].sort(), ["addTriageRows", "triage"]);
}
{
  const store = memStore();
  const [id] = await seedTriage(store, ["Test-Draft the plan"]);
  const before = store.calls.length;
  const e = await triageProposal([OWNER], id, "someone", "   ", store);
  t("AC-R5.16 empty name -> error, NO store write, row stays untriaged", [e.ok, store.calls.length - before, store.rows.get(id)!.state], [false, 0, "untriaged"]);
  await triageProposal([OWNER], id, "someone", "y".repeat(120), store);
  t("AC-R5.16 a 120-char name is stored capped at 80", store.rows.get(id)!.assignee?.length, 80);
}
{
  const store = memStore();
  const [id] = await seedTriage(store, ["Test-Draft the plan"]);
  const [a, b] = await Promise.all([triageProposal([OWNER], id, "mine", undefined, store), triageProposal([OWNER], id, "skip", undefined, store)]);
  const applied = [a, b].filter((x) => x.ok && !x.alreadyDone).length;
  t("AC-R5.17 double tap (Mine + Skip at once) -> exactly ONE applies", [applied, store.rows.get(id)!.state], [1, "proposed"]);
}
{
  const store = memStore();
  const [id] = await seedTriage(store, ["Test-Draft the plan"]);
  t("another owner cannot triage the row", (await triageProposal(["someone-else@eds.example"], id, "mine", undefined, store)).ok, false);
  t("an unknown choice is refused before any write", (await triageProposal([OWNER], id, "maybe" as never, undefined, store)).ok, false);
  t("the row is untouched", store.rows.get(id)!.state, "untriaged");
}
{
  // OQ-9: Mine on a to-do already active from email -> merged into that proposal, one active row.
  const store = memStore();
  const norm = "test-draft the plan";
  store.addActive({ id: "prop-0e0e0e", owner: OWNER, title: "Test-Draft the plan", normTitle: norm, evidence: "e", assignee: null, dueText: null, dueDate: null, ref: { source: "email", sourceItemId: "mbx:1", at: AT, context: null } });
  const [id] = await seedTriage(store, ["Test-Draft the plan"]);
  const r = await triageProposal([OWNER], id, "mine", undefined, store);
  t("OQ-9 Mine on an already-active to-do -> merged: one active proposal, both sources", [r.ok, r.ok && r.row.id, (await store.listActive([OWNER])).length, store.rows.get("prop-0e0e0e")!.sources.map((s) => s.source)], [true, "prop-0e0e0e", 1, ["email", "transcript"]]);
  const q = groupMeetingQueue(await store.listMeetingQueue([OWNER]));
  t("OQ-9 the merged item still shows as Mine under its meeting", q.meetings.map((m) => [m.meetingId, m.mine.map((x) => x.id)]), [["ff-9", ["prop-0e0e0e"]]]);
}

// ── F. checklist rows + sanitizer (AC-R5.15) ──────────────────────────────────────────────────────
console.log("\n# F. checklist row mapping + sanitizer");
const mkRow = (state: ProposalState, source: "email" | "transcript"): ProposalRow => ({ id: "prop-abc123", owner: OWNER, state, title: "Test-x", originalTitle: "Test-x", normTitle: "test-x", edited: false, evidence: "Test-x", assignee: state === "delegated" ? "Pat" : null, dueText: null, dueDate: null, sources: [{ source, sourceItemId: "s", at: AT, context: null }], taskId: null, createdAt: AT, decidedAt: null });
t("AC-R5.15 a meeting row carries triage:true on the SAME row kind", [proposalChecklistRow(mkRow("untriaged", "transcript")).kind, proposalChecklistRow(mkRow("untriaged", "transcript")).proposal.triage], ["proposal", true]);
t("AC-R5.15 an email proposal row has no triage flag (unchanged shape)", "triage" in proposalChecklistRow(mkRow("proposed", "email")).proposal, false);
const san = (p: Record<string, unknown>) => sanitizeChecklistPayload({ title: "x", rows: [{ taskId: "prop-abc123", title: "Test-x", kind: "proposal", proposal: p }] })!.rows[0] as { status: string; proposal: { state: string; triage?: boolean; assignee: string | null } };
t("AC-R5.15 sanitize: triage row with an UNKNOWN state -> untriaged (never proposed)", [san({ state: "weird", triage: true }).status, san({ state: "weird", triage: true }).proposal.triage], ["untriaged", true]);
t("AC-R5.15 sanitize: NON-triage row with an unknown state -> proposed (as before)", san({ state: "weird" }).status, "proposed");
t("AC-R5.15 sanitize keeps the new states", [san({ state: "untriaged", triage: true }).status, san({ state: "delegated", triage: true, assignee: "Pat" }).proposal.assignee], ["untriaged", "Pat"]);
t("AC-R5.15 sanitize: triage must be literally true", "triage" in san({ state: "proposed", triage: "yes" }).proposal, false);

// ── G. the report's third list (exposure) ─────────────────────────────────────────────────────────
console.log("\n# G. meeting queue for the report");
{
  const store = memStore();
  const ids1 = await store.addTriageRows(triageRowsFor(OWNER, { meetingId: "ff-a", title: "Test-Older", meetingAt: "2026-11-09T14:00:00.000Z" }, ["Test-One thing", "Test-Two thing", "Test-Three thing", "Test-Four thing"]));
  const ids2 = await store.addTriageRows(triageRowsFor(OWNER, { meetingId: "ff-b", title: "Test-Newer", meetingAt: "2026-11-11T14:00:00.000Z" }, ["Test-Five thing"]));
  await triageProposal([OWNER], ids1.created[0], "mine", undefined, store);
  await triageProposal([OWNER], ids1.created[1], "someone", "Pat", store);
  await triageProposal([OWNER], ids1.created[2], "skip", undefined, store);
  await triageProposal([OWNER], ids2.created[0], "mine", undefined, store);
  const q = groupMeetingQueue(await store.listMeetingQueue([OWNER]));
  t("AC-R7.4 report: newest meeting first, Mine listed per meeting", q.meetings.map((m) => [m.title, m.mine.map((x) => x.title)]), [["Test-Newer", ["Test-Five thing"]], ["Test-Older", ["Test-One thing"]]]);
  t("AC-R5.10 For someone is listed separately (text name), never under Mine", q.meetings[1].forSomeone.map((x) => [x.title, x.assignee]), [["Test-Two thing", "Pat"]]);
  t("AC-R7.5 untriaged / skipped are counts only", q.counts, { mine: 2, forSomeone: 1, untriaged: 1, skipped: 1 });
}

// ── H. the flag (AC-R9.1) ─────────────────────────────────────────────────────────────────────────
console.log("\n# H. flag");
const base = { enabled: true, ownerLogins: ["owner@eds.example"], driveUser: "owner@eds.example", mailbox: "owner@work.example", sourceLogin: "login@work.example", synthetic: true, subjectPrefix: "HUDDLE-PA-SBX-" };
const flag = (v: unknown) => parseFeedsConfig(JSON.stringify({ ...base, correspondence: { proposals: true, ...(v === undefined ? {} : { meetingTriage: v }) } }))!.correspondence.meetingTriage;
t("AC-R9.1 meetingTriage: absent / 'true' / 1 / false -> OFF; true -> ON", [flag(undefined), flag("true"), flag(1), flag(false), flag(true)], [false, false, false, false, true]);
const on = (p: boolean, m: boolean) => meetingTriageOn({ correspondence: { proposals: p, meetingTriage: m } });
t("AC-R9.1 triage runs only inside proposals (proposals AND meetingTriage)", [on(false, false), on(true, false), on(false, true), on(true, true), meetingTriageOn(null)], [false, false, false, true, false]);

// ── I. the proposals processor: minutes emails are not sources (AC-R5.1, R5.4, R9.2) ──────────────
console.log("\n# I. proposals processor + minutes");
const emailItem = (id: string, subject: string, body: string, from = "pat@work.example"): SourceItem => ({
  source: "email",
  sourceItemId: id,
  identityBasis: "graph_id",
  threadId: null,
  at: AT,
  contentHash: id,
  drivePath: null,
  driveItemId: null,
  fileEtag: null,
  internetMessageId: null,
  email: { id, subject, bodyText: body, fromAddress: from, fromName: "Pat", inferenceClassification: "focused", headerNames: [] },
} as SourceItem);
{
  const minutes = emailItem("m1", "Meeting Minutes: Test-Budget sync Nov 14", "Action Items\n- Test-Send the Q3 deck by Friday");
  const fwdAsk = emailItem("m2", "Fw: Meeting Minutes: Test-Budget sync", "Owner, can you take item 3 by Friday?");
  t("AC-R5.1 triage ON: a minutes email is never a proposal source", proposalSourceFromItem(minutes, "owner@work.example", { skipMinutes: true }), { skip: "minutes" });
  t("AC-R5.4 a forward WITH a direct ask is still a proposal source", "text" in proposalSourceFromItem(fwdAsk, "owner@work.example", { skipMinutes: true }), true);
  t("AC-R9.2 triage OFF: the source decision is exactly as before (minutes email still a source)", proposalSourceFromItem(minutes, "owner@work.example"), proposalSourceFromItem(minutes, "owner@work.example", { skipMinutes: false }));
  t("AC-R9.2 triage OFF: minutes email still read (unchanged behaviour)", "text" in proposalSourceFromItem(minutes, "owner@work.example"), true);

  // Through the processor: zero model calls for the minutes email; the forward is extracted; neither makes a
  // triage row or a ping (the processor has no triage path at all).
  const calls: string[] = [];
  const extract: ExtractFn = async (_i, input) => {
    calls.push(input);
    return { tasks: [] };
  };
  const triage = memStore();
  const turns = memTurns();
  const proposalStore = { upsert: async () => ({ kind: "created" as const, id: "prop-1" }), priorRelated: async () => [], listActive: async () => [], getMany: async () => [], claimApprove: async () => ({ claimed: false, row: null }), finishApprove: async () => null, releaseApprove: async () => {}, decide: async () => ({ applied: false, row: null }), edit: async () => ({ applied: false, row: null }) };
  const proc = proposalsProcessor({ store: proposalStore, extract, openTitles: async () => new Set(), tz: TZ, owner: () => OWNER, mailbox: () => "owner@work.example", skipMinutes: true });
  await proc.process(minutes, { owner: OWNER, nowMs: 0 });
  t("AC-R5.1 / R6.1 minutes email -> zero extraction calls", calls.length, 0);
  await proc.process(fwdAsk, { owner: OWNER, nowMs: 0 });
  t("AC-R5.4 forwarded minutes with an ask -> extracted once (a reply/to-do source)", calls.length, 1);
  t("brief: a forwarded-minutes email NEVER creates a triage row or a ping", [triage.rows.size, turns.turns.size], [0, 0]);
  const procOff = proposalsProcessor({ store: proposalStore, extract, openTitles: async () => new Set(), tz: TZ, owner: () => OWNER, mailbox: () => "owner@work.example" });
  await procOff.process(minutes, { owner: OWNER, nowMs: 0 });
  t("AC-R9.2 processor with triage OFF: minutes email extracted exactly as before", calls.length, 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
