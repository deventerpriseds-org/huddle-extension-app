// WHAT:       Zero-call test for the REAL heartbeat entry (proposals.server.ts runProposalsPass) with every server
//             dependency replaced by a spy (bun mock.module): with meeting triage OFF the Fireflies pass makes NO
//             Fireflies, minutes-store, transcript-ledger or turn calls at all, and no proposal is ever made from a
//             meeting; with it ON the Fireflies pass runs and pings once.
// WHY:        AC docs/qc-evidence/AC-correspondence-redesign.md AC-R9.2 / AC-R9.3 (zero calls when off; the owner
//             rejected automatic to-dos from minutes, so OFF must not silently keep the old behaviour).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-meeting-triage.md.
// Run: bun scripts/meeting-triage-server.test.ts
import { mock } from "bun:test";
import { join } from "node:path";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const OWNER = "owner@eds.example";
const LIB = join(import.meta.dir, "../src/features/huddle/lib");
const calls: string[] = [];
const hit = (n: string) => calls.push(n);

mock.module(join(LIB, "fireflies/fireflies.server.ts"), () => ({
  minutesOwner: () => (hit("ff.minutesOwner"), OWNER),
  fetchTranscript: async () => (hit("ff.fetchTranscript"), { transcript: { summary: { action_items: "- Test-Send the deck\n- Test-Book the room" } } }),
}));
mock.module(join(LIB, "fireflies/minutes-store.server.ts"), () => ({
  listRecentMeetings: async () => (hit("minutes.listRecentMeetings"), [{ meeting_id: "ff-1", title: "Test-Sync", meeting_at: "2026-11-14T14:00:00.000Z", content_hash: "h1", created_at: new Date().toISOString(), pending_email: false, pending_onedrive: false }]),
}));
mock.module(join(LIB, "identity/identity.server.ts"), () => ({ resolveScopeByEmail: async () => ({ emails: [OWNER] }) }));
mock.module(join(LIB, "identity/scheduling-config.server.ts"), () => ({ DEFAULT_TZ: "America/New_York" }));
const claimed = new Set<string>();
mock.module(join(LIB, "correspondence/ledger.server.ts"), () => ({
  pgLedger: {
    observe: async (_o: string, items: Array<{ source: string }>) => (hit(`ledger.observe:${items.map((i) => i.source).join(",")}`), { inserted: items.length, changed: 0, unchanged: 0 }),
    claimDue: async (_o: string, sources: string[]) => {
      hit(`ledger.claimDue:${sources.join(",")}`);
      if (claimed.has("ff-1")) return [];
      claimed.add("ff-1");
      return [{ source: "transcript", sourceItemId: "ff-1", claimVersion: 1, attempts: 1 }];
    },
    markProcessed: async () => (hit("ledger.markProcessed"), true),
    markNeedsContext: async () => true,
    markFailed: async () => (hit("ledger.markFailed"), true),
    hasDue: async () => false,
  },
}));
const rows = new Map<string, { id: string; state: string; title: string; sources: unknown[] }>();
mock.module(join(LIB, "proposals/proposals-store.server.ts"), () => ({
  pgProposalStore: {
    listActive: async () => (hit("store.listActive"), [...rows.values()].filter((r) => r.state === "proposed")),
    upsert: async () => (hit("store.upsert"), { kind: "created", id: "prop-x" }),
    addTriageRows: async (ps: Array<{ id: string; title: string; ref: unknown }>) => {
      hit("store.addTriageRows");
      for (const p of ps) rows.set(p.id, { id: p.id, state: "untriaged", title: p.title, sources: [p.ref] });
      return { created: ps.map((p) => p.id), existing: [] };
    },
    getMany: async (_o: string[], ids: string[]) => ids.map((i) => rows.get(i)).filter(Boolean).map((r) => ({ ...r, owner: OWNER, originalTitle: r!.title, normTitle: r!.title, edited: false, evidence: r!.title, assignee: null, dueText: null, dueDate: null, taskId: null, createdAt: "", decidedAt: null })),
  },
}));
const turns: string[] = [];
mock.module(join(LIB, "tasks/turns.server.ts"), () => ({ enqueueTurn: async (id: string) => (hit("turns.enqueue"), turns.includes(id) ? false : (turns.push(id), true)) }));
mock.module(join(LIB, "huddle.functions.ts"), () => ({ runTurnById: async () => hit("turns.run") }));

const feeds = (cc: Record<string, unknown>) =>
  JSON.stringify({ enabled: true, ownerLogins: [OWNER], driveUser: OWNER, mailbox: "owner@work.example", sourceLogin: "login@work.example", synthetic: true, subjectPrefix: "HUDDLE-PA-SBX-", correspondence: cc });

process.env.FIREFLIES_API_KEY = "dummy-not-a-key";
const { runProposalsPass } = await import("../src/features/huddle/lib/proposals/proposals.server");
const fireflyish = () => calls.filter((c) => /^ff\.|^minutes\.|transcript|^turns\.|addTriageRows/.test(c));

// AC-R9.3: proposals ON, meetingTriage OFF -> the meeting pass does not run AT ALL; no proposal from a meeting.
process.env.HUDDLE_ONEDRIVE_FEEDS = feeds({ proposals: true });
calls.length = 0;
await runProposalsPass();
t("AC-R9.3 triage OFF: zero Fireflies / minutes-store / transcript-ledger / turn calls", fireflyish(), []);
t("AC-R9.3 triage OFF: no proposal is ever written from a meeting (no upsert at all)", calls.includes("store.upsert"), false);
t("AC-R9.2 triage OFF: the evening delivery still runs as before", calls.includes("store.listActive"), true);

// meetingTriage given as a non-literal value -> still OFF.
process.env.HUDDLE_ONEDRIVE_FEEDS = feeds({ proposals: true, meetingTriage: "true" });
calls.length = 0;
await runProposalsPass();
t("AC-R9.1 meetingTriage:\"true\" (a string) is OFF: zero meeting calls", fireflyish(), []);

// Everything OFF -> zero calls of any kind (AC-R9.5 pattern).
process.env.HUDDLE_ONEDRIVE_FEEDS = feeds({ meetingTriage: true });
calls.length = 0;
await runProposalsPass();
t("AC-R9.5 proposals OFF (even with meetingTriage true): zero calls of any kind", calls, []);

// ON -> the meeting pass runs: one ping, untriaged rows, still no proposal.
process.env.HUDDLE_ONEDRIVE_FEEDS = feeds({ proposals: true, meetingTriage: true });
calls.length = 0;
await runProposalsPass();
t("AC-R5.5 triage ON: the finished meeting is read and ONE ping is enqueued and run", [calls.includes("ff.fetchTranscript"), calls.filter((c) => c === "turns.enqueue").length, calls.filter((c) => c === "turns.run").length], [true, 1, 1]);
t("AC-R5.3 triage ON: rows are untriaged, zero proposals written", [[...rows.values()].map((r) => r.state), calls.includes("store.upsert")], [["untriaged", "untriaged"], false]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
