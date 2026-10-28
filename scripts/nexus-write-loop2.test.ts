// WHAT:       Every reproduction from the independent verifier's loop-1 report (D1-D5 and the wrong rows
//             of its 48-input table), pinned as tests against the STRUCTURAL fixes of loop 2:
//             D1 dedup day in the course zone; D2 allow-list + deny-anywhere kind filter; D3/D4 code-built
//             write replies + stream hold (text and voice); D5 specific-signal coursework routing.
// WHY:        docs/VERIFY-nexus-write-tool-1.md REFUTED C1-C4/C9 with 30+ wrong results; two rounds of
//             phrase patching had leaked, so each fix here is a mechanism and each test a verifier input.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-loop2.md (RESPONDS TO docs/VERIFY-nexus-write-tool-1.md); verifier
//             probes in mut-verify-114/.
//
// OFFLINE ONLY: `fetch` is an in-memory fake Nexus. Nothing reaches a real Nexus, Huddle, DB or board.
// Run: bun scripts/nexus-write-loop2.test.ts

import {
  executeNexusWriteTool,
  classifyNonDeliverable,
  findDuplicate,
  resolveDueInstant,
  nexusWriteClaimKey,
} from "../src/features/huddle/lib/nexus/nexus-write.server";
import { routeMessage, laneOwnerFor, primeLaneDecision } from "../src/features/huddle/lib/routing";
import { sharedCapabilityHolders } from "../src/features/huddle/lib/capabilities";
import { AGENTS, type AgentId } from "../src/features/huddle/data/agents";

let pass = 0;
let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want);
  console.log(`  ${ok ? "ok" : "not ok"} ${name}: ${String(got)}${ok ? "" : `  (EXPECTED ${String(want)})`}`);
  ok ? pass++ : fail++;
};

const OWNER = "owner-uuid-1111";
Object.assign(process.env, { NEXUS_API_URL: "https://nexus.test", NEXUS_OWNER_ID: OWNER, UAT_BYPASS_TOKEN: "uat-secret-token" });
type Row = Record<string, unknown>;
const COURSES: Row[] = [{ id: "c782", code: "MGT-782", name: "MGT-782-W1 (202711)", program_id: "p-dba", user_id: OWNER }];
let ASSIGN: Row[] = [];
let POSTS = 0;
let seq = 0;
const resetStore = () => {
  POSTS = 0;
  ASSIGN = [
    { id: "aafbf80f", course_id: "c782", title: "Research Proposal", due_date: "2026-10-31T03:59:59.000Z" },
    { id: "6616bef3", course_id: "c782", title: "Research Paper", due_date: "2026-12-10 04:59:59+00" },
  ];
};
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (method === "GET") {
    if (url.pathname.endsWith("/api/d1/courses")) return json(200, COURSES);
    return json(200, ASSIGN.map((a) => ({ ...a })));
  }
  if (method === "POST") {
    POSTS++;
    const row = { id: `new-${++seq}`, ...body };
    ASSIGN.push(row);
    return json(200, { rows: [row] });
  }
  return json(405, {});
}) as unknown as typeof fetch;
const exec = (items: unknown[]) => executeNexusWriteTool({ items }, { ref: "loop2" }) as Promise<{ results: Row[] } & Row>;

const main = async () => {
  console.log("=== D1: dedup 'same local day' is the COURSE day, whatever zone the date was written in ===");
  {
    resetStore();
    let r = await exec([{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30T20:00:00Z" }]);
    t("L2-D1a verifier repro: Z instant on the stored row's ET day is a duplicate, 0 POSTs", `${r.results[0].action}/${POSTS}`, "duplicate/0");
    resetStore();
    r = await exec([{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-31T02:00:00Z" }]);
    t("L2-D1b Z instant that is Oct 30 22:00 ET (Oct 31 in UTC) is a duplicate", `${r.results[0].action}/${POSTS}`, "duplicate/0");
    resetStore();
    r = await exec([{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30T16:00:00-04:00" }]);
    t("L2-D1c the same instant written with -04:00 is a duplicate (control)", `${r.results[0].action}/${POSTS}`, "duplicate/0");
    resetStore();
    r = await exec([{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30T23:00:00-07:00" }]);
    t("L2-D1d a -07:00 instant that is Oct 31 02:00 ET is the NEXT course day -> separate insert", `${r.results[0].action}/${POSTS}`, "inserted/1");
    resetStore();
    r = await exec([{ course: "MGT-782", title: "Research Paper", due_date: "2026-12-09T22:00:00Z" }]);
    t("L2-D1e a Postgres-format stored instant ('… 04:59:59+00') is compared on the ET day too", `${r.results[0].action}/${POSTS}`, "duplicate/0");
    const z = resolveDueInstant("2026-10-30T20:00:00Z");
    t("L2-D1f resolveDueInstant reports the COURSE zone for a Z instant (not 'UTC')", z.ok && z.zone, "America/New_York");
    const pz = resolveDueInstant("2026-10-30T20:00:00Z", undefined, "PT");
    t("L2-D1g an explicit course zone is kept for an ISO instant", pz.ok && pz.zone, "America/Los_Angeles");
    const direct = findDuplicate({ title: "Research Proposal", dueMs: Date.parse("2026-10-30T20:00:00Z"), zone: "UTC" }, [
      { id: "s", title: "Research Proposal", due_date: "2026-10-31T03:59:59Z" },
    ]);
    t("L2-D1h findDuplicate ignores a written-zone 'UTC' and uses the course day", direct?.by, "title");
    const off = findDuplicate({ title: "Research Proposal", dueMs: Date.parse("2026-10-30T20:00:00Z"), zone: "-04:00" }, [
      { id: "s", title: "Research Proposal", due_date: "2026-10-31T03:59:59Z" },
    ]);
    t("L2-D1i findDuplicate ignores a bare offset '-04:00' as a zone", off?.by, "title");
    const k1 = nexusWriteClaimKey({ items: [{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30T20:00:00Z" }] });
    const k2 = nexusWriteClaimKey({ items: [{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30" }] });
    t("L2-D1j the per-turn claim key agrees: a Z instant and the plain date are the same course day", k1 === k2, true);
    resetStore();
    r = await exec([{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-31" }]);
    t("L2-D1k the next ET day is still a separate (recurring) insert (W1 non-regression)", `${r.results[0].action}/${POSTS}`, "inserted/1");
  }

  console.log("=== D2: allow-list + deny-anywhere kind filter ===");
  {
    // The owner's named example, in every punctuation the verifier tried (and two more).
    for (const s of [
      "Residency 4: present your research proposal",
      "Residency 4, present your research proposal",
      "Residency 4 present your research proposal",
      "Residency 4. Present your research proposal",
      "Residency 4 / present your research proposal",
      "Residency 4 – present your research proposal",
      "Present your research proposal at Residency 4",
      "Residency 4 (present your research proposal)",
      "Residency 4; present your research proposal",
      "RESIDENCY 4 PRESENT YOUR RESEARCH PROPOSAL",
    ]) {
      t(`L2-D2a "${s}" is refused as a meeting`, classifyNonDeliverable(s), "meeting/session");
    }
    // D2b: the verifier's wrongly ACCEPTED vocabulary.
    for (const [s, why] of [
      ["Spring Recess", "administrative"],
      ["Tuition payment due", "administrative"],
      ["Course evaluations due", "administrative"],
      ["Annual research symposium", "event"],
      ["Networking dinner", "event"],
      ["Field trip to Ford plant", "event"],
      ["Pre-read: Porter Five Forces (HBR 1979)", "reading"],
    ]) {
      t(`L2-D2b "${s}" is refused (${why})`, classifyNonDeliverable(s), why);
    }
    // Deny wins over a deliverable noun ANYWHERE in the title.
    for (const [s, why] of [
      ["Kickoff meeting for final project", "meeting/session"],
      ["Final project kickoff meeting", "meeting/session"],
      ["Research proposal workshop", "meeting/session"],
      ["Office hours: research paper Q&A", "meeting/session"],
      ["Paper presentation call with Prof. Lee", "meeting/session"],
      ["Case study networking dinner", "event"],
      ["Thesis defense ceremony", "event"],
      ["Spring break reflection paper", "administrative"],
      ["Tuition payment memo", "administrative"],
    ]) {
      t(`L2-D2c "${s}" is refused: the ${why} word wins anywhere`, classifyNonDeliverable(s), why);
    }
    // D2c over-rejects the verifier listed: the one the allow-list fixes, and the accepted-cost ones.
    t('L2-D2d "Chapter 4 problem set" is accepted (verifier over-reject, fixed)', classifyNonDeliverable("Chapter 4 problem set"), "null");
    t('L2-D2e "Holiday Inn case study" is refused (accepted cost, reason returned)', classifyNonDeliverable("Holiday Inn case study"), "administrative");
    t('L2-D2f "Read and respond: chapter 4" is refused as a reading (no deliverable noun)', classifyNonDeliverable("Read and respond: chapter 4"), "reading");
    // Allow-list: no deliverable noun -> refused, even with no deny word.
    for (const s of ["Module 3 overview", "Porter Five Forces", "Week 5", "Strategy"]) {
      t(`L2-D2g "${s}" names no deliverable -> refused`, classifyNonDeliverable(s), "not-a-deliverable");
    }
    // Allow-list positives (graded deliverables) stay accepted.
    for (const s of [
      "Research Proposal", "Case Brief 7", "Discussion post 3", "Midterm", "Final exam", "Problem set 4", "Literature review",
      "Capstone project", "Reflection paper", "Break-even analysis", "Quiz 2", "Group presentation", "Reading response 3",
      "Dissertation chapter 2 draft", "Strategy memo", "Weekly journal", "研究提案",
    ]) {
      t(`L2-D2h "${s}" is accepted`, classifyNonDeliverable(s), "null");
    }
    t('L2-D2i the org "Test-" prefix is not the deliverable noun "test"', classifyNonDeliverable("Test-walk the dog"), "not-a-deliverable");
    t('L2-D2j "Test 2" (a real test) is accepted', classifyNonDeliverable("Test 2"), "null");
    // Through the executor: 0 POSTs and the reason rides back to the agent.
    resetStore();
    const r = await exec([
      { course: "MGT-782", title: "Residency 4, present your research proposal", due_date: "2026-11-09" },
      { course: "MGT-782", title: "Networking dinner", due_date: "2026-11-10" },
      { course: "MGT-782", title: "Module 3 overview", due_date: "2026-11-11" },
    ]);
    t("L2-D2k executor refuses all three with reasons, 0 POSTs", `${r.results.map((x) => x.reason).join(",")}/${POSTS}`, "meeting/session,event,not-a-deliverable/0");
    t("L2-D2l each refusal carries a note telling the agent to tell the owner", r.results.every((x) => /Nothing was written/.test(String(x.note))), true);
  }

  console.log("=== D5: coursework routing needs a SPECIFIC signal ===");
  {
    const ALL_IDS = AGENTS.map((a) => a.id) as AgentId[];
    const PRIME = new Set(["elle-rowan", "iris-chase"]);
    const lead = (text: string) =>
      routeMessage({ text, scope: "group", members: ALL_IDS, history: [] } as Parameters<typeof routeMessage>[0]).winners[0];
    // Baselines = routeMessage(...).winners[0] on origin/main d618114 (measured with
    // mut-verify-114/probe-routing.ts against a `git archive origin/main` export; same as the verifier's table).
    const D5: Array<[string, string]> = [
      ["should I apply to NEXUS before my trip to Toronto", "troy-lennox"],
      ["what's the investment thesis for buying more NVDA", "tess-sutton"],
      ["my semester tuition payment is due Dec 1, can I afford it", "finn-reid"],
      ["review the course of action for the merger proposal due Friday", "cole-blake"],
      ["is there a case study on intermittent fasting results", "cole-blake"],
      ["I'm teaching a training class at work, slides due Friday", "flex-grimes"],
    ];
    for (const [text, base] of D5) {
      t(`L2-D5a group "${text}" routes to its origin/main baseline`, lead(text), base);
      t(`L2-D5b "${text}" matches no coursework prime capability`, sharedCapabilityHolders(text).length, 0);
      const handoffs = ALL_IDS.map((id) => laneOwnerFor(text, id)?.id).filter((x) => x && PRIME.has(x));
      t(`L2-D5c 1:1 with ANY agent: "${text}" is never handed to Elle/Iris`, handoffs.length, 0);
    }
    // [text, self, laneOwnerFor on origin/main d618114]. The last row's "elle-rowan" is PRE-EXISTING theme
    // routing (Elle's theme "course", unchanged since 4809e2e), not the prime rule: primeLaneDecision is null.
    for (const [text, self, base] of [
      ["write up an investment thesis for NVDA", "finn-reid", "null"],
      ["apply to NEXUS for me before my Toronto trip", "troy-lennox", "null"],
      ["my tuition payment for the semester is due, set aside the money", "finn-reid", "null"],
      ["teach the course of action workshop for my team, deck due Friday", "ezra-miles", "elle-rowan"],
    ] as Array<[string, AgentId, string]>) {
      t(`L2-D5d 1:1 ${self}: "${text}" -> no prime hand-off, origin/main lane`, `${primeLaneDecision(text, self)}/${laneOwnerFor(text, self)?.id ?? "null"}`, `null/${base}`);
    }
    // Every coursework phrasing the verifier listed still goes to Elle/Iris -- group AND 1:1.
    const COURSEWORK = [
      "add my assignments", "add my MGT-782 assignments from the syllabus", "put the research paper due Dec 9 on my assignments",
      "update the due date on my research paper", "change my research proposal deadline to Nov 2", "log my DBA deliverables",
      "add this syllabus's deadlines to Nexus", "I have a new paper due next month for MGT-782, add it", "add my school assignments",
      "fix the due date on my strategy paper", "my professor pushed the case analysis to Friday",
      // specific-signal spellings the owner's rule names
      "add the case study due Nov 3 to Nexus", "what's due in Nexus this week", "show my Nexus assignments", "mgt-782 paper deadline moved",
      "my instructor extended the essay deadline", "my doctoral dissertation draft is due Dec 1",
    ];
    for (const text of COURSEWORK) {
      t(`L2-D5e group "${text}" is led by Elle/Iris`, PRIME.has(String(lead(text))), true);
      t(`L2-D5f 1:1 Elle/Iris keep "${text}"`, `${laneOwnerFor(text, "elle-rowan" as AgentId)?.id ?? "null"}/${laneOwnerFor(text, "iris-chase" as AgentId)?.id ?? "null"}`, "null/null");
      t(`L2-D5g 1:1 Finn hands "${text}" to Elle/Iris`, PRIME.has(String(laneOwnerFor(text, "finn-reid" as AgentId)?.id)), true);
    }
    // A course code must look like one: "pay 300" / "is 300" (a word then three digits) is not MGT-782.
    for (const text of ["the deadline to pay 300 for my gym is Friday", "my rent is 300 more, deadline is Monday"]) {
      t(`L2-D5i "${text}" is not a course code`, sharedCapabilityHolders(text).length, 0);
    }
    // The context is DATA on the capability (agents.ts), not code: no generic word survives in it.
    const cap = AGENTS.flatMap((a) => a.capabilities ?? []).find((c) => c.id === "nexus-assignments");
    const ctxWords = [...(cap?.requiresContext?.strong ?? []), ...(cap?.requiresContext?.weak ?? [])];
    t("L2-D5h no generic word (course/class/semester/school/thesis/case study/tuition/training/nexus) is context", ctxWords.filter((w) => /^(course|courses|class|classes|semester|school|thesis|case study|tuition|training|nexus)$/i.test(w)).join(",") || "none", "none");
  }
};

await main();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
