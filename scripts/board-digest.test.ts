// Offline unit test for boardDigestNamed — the NAME-level ceremony board digest injected into barge
// turns. Proves the fix for "the agent doesn't know what task it just mentioned": the digest carries
// real task TITLES by lane/status (not the count-only reportDigest). Run: bun scripts/board-digest.test.ts
import { boardDigestNamed, type CeremonyReport, type LaneReport } from "../src/features/huddle/lib/tasks/ceremonies";
import type { AgentId } from "../src/features/huddle/data/agents";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
  cond ? pass++ : fail++;
}

const t = (title: string): { title: string; priority: string | null; due_date: string | null } => ({
  title,
  priority: null,
  due_date: null,
});
const lane = (over: Partial<LaneReport> & { category: string; owner: AgentId }): LaneReport => ({
  upNext: [],
  doing: [],
  inReview: [],
  blocked: [],
  done: [],
  backlog: [],
  ...over,
});
const report = (lanes: LaneReport[]): CeremonyReport => ({
  type: "standup",
  windowHours: 168,
  lanes,
  blockers: [],
  counts: { upNext: 0, doing: 0, inReview: 0, blocked: 0, done: 0, backlog: 0 },
});

console.log("boardDigestNamed — name-level ceremony board digest\n");

// AC1/AC2 — every bucket's task TITLE appears (not just a count).
const r1 = report([
  lane({
    category: "VENTURES",
    owner: "sam-trent" as AgentId,
    doing: [t("Plan the business architecture")],
    upNext: [t("Research Agentforce")],
    inReview: [t("Draft the GTM memo")],
    blocked: [{ ...t("Ship consulting-app export"), why: "waiting on API keys" }],
    done: [t("Lock investor pitch")],
  }),
  lane({ category: "LIFE", owner: "iris-chase" as AgentId, done: [t("the gym task")] }),
]);
const d1 = boardDigestNamed(r1);
check("names a DOING task", d1.includes("Plan the business architecture"), d1);
check("names an UP-NEXT task", d1.includes("Research Agentforce"), d1);
check("names an IN-REVIEW task", d1.includes("Draft the GTM memo"), d1);
check("names a BLOCKED task + why", d1.includes("Ship consulting-app export") && d1.includes("waiting on API keys"), d1);
check("names a DONE task (the Terry gap: nameable now)", d1.includes("Lock investor pitch"), d1);
check("names the other lane's done task", d1.includes("the gym task"), d1);
check("groups under lane owner handle", d1.includes("@sam-trent") && d1.includes("@iris-chase"), d1);
// The bug was counts-only ("done 1"); assert we're NOT emitting a bare count line.
check("does NOT emit a bare count line", !/done \d+(,|$)/.test(d1), d1);

// AC3 — empty report never throws / returns a bounded marker.
const dEmpty = boardDigestNamed(report([]));
check("empty report → safe non-empty marker, no throw", typeof dEmpty === "string" && dEmpty.length > 0, JSON.stringify(dEmpty));
const dNoTasks = boardDigestNamed(report([lane({ category: "FINANCE", owner: "finn-reid" as AgentId })]));
check("lane with no tasks → 'nothing active'", dNoTasks.includes("nothing active"), dNoTasks);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
