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
import { capabilityExplicitOverride, sharedCapabilityHolders } from "../src/features/huddle/lib/capabilities";
// D13 (docs/FIX-nexus-write-loop4.md, owner decision): a NON-holder hands coursework to Elle/Iris deterministically
// ONLY on an explicit write to Nexus; every other coursework ask takes the ordinary 1:1 owner path (origin/main).
const ovrOf = (text: string) => sharedCapabilityHolders(text).some((h) => capabilityExplicitOverride(h.cap, text));
import { AGENTS, type AgentId } from "../src/features/huddle/data/agents";
import {
  NEXUS_WRITE_TOOL_NAME as N,
  nexusWriteGuardedReply,
  createNexusWriteStreamHold,
  createNexusWriteSpeechGate,
  nexusWriteFailureMessage,
  nexusWriteResultsFrom,
} from "../src/features/huddle/lib/nexus/nexus-write-shared";
import { readFileSync } from "node:fs";
import { setNexusCourseContext } from "../src/features/huddle/lib/nexus/course-context";
// loop 3 D6 (docs/FIX-nexus-write-loop3.md): coursework routing's strong context is the owner's REAL Nexus
// course list (data, fetched at runtime); offline it is injected here. The executor also refreshes it
// from its own fake course list whenever a write runs.
setNexusCourseContext([{ code: "MGT-782", name: "MGT-782-W1 (202711)" }, { code: "MGT-702", name: "Strategic Management" }]);
const textSrc = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");

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
    // loop 3 D8 (docs/FIX-nexus-write-loop3.md): was "America/Los_Angeles" -- the model's time_zone argument
    // used to become the day zone. The owner's rule now: it may only interpret a date with NO offset, so for
    // an ISO instant it plays no part and the reported zone is the default course zone.
    t("L2-D1g the model's time_zone is NOT used for an ISO instant (loop 3 D8)", pz.ok && pz.zone, "America/New_York");
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
      t(`L2-D5g 1:1 Finn: "${text}" -> Elle/Iris only on an explicit Nexus write, else no prime hand-off (D13)`, ovrOf(text) ? PRIME.has(String(primeLaneDecision(text, "finn-reid" as AgentId))) : primeLaneDecision(text, "finn-reid" as AgentId) === null, true);
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

  console.log("=== D3: the reply about a write that did not persist is CODE-BUILT (text path) ===");
  {
    const res = (results: unknown[]) => JSON.stringify({ ok: true, persisted: false, results });
    const FAIL_RP = { index: 0, title: "Research Proposal", action: "failed", persisted: false, error: "http_500" };
    const SAVED_CB = { index: 1, title: "Case Brief 2", action: "inserted", persisted: true, assignment_id: "n1" };
    const UPD_FAIL = { index: 0, title: "Research Proposal", assignment_id: "aafbf80f", action: "failed", persisted: false, error: "http_500" };
    const own = (r: unknown[]) => [{ tool: N, ok: false, detail: res(r) }];
    const LINE_RP = "Not saved to Nexus: “Research Proposal” — http 500.";
    // The verifier's N1..N13 (own writer) and N14/N15 (teammate), plus N16 (title, no write-talk word).
    const cases: Array<[string, string, ReturnType<typeof own>, ReturnType<typeof own>, string]> = [
      ["N1 negated-intensifier claim", "I didn't just add the Research Proposal, I also set it to high priority.", own([FAIL_RP]), [], LINE_RP],
      ["N2 'not a problem' + claim", "Not a problem I've saved the Research Proposal for Oct 30.", own([FAIL_RP]), [], LINE_RP],
      ["N3 'never fear' + claim", "Never fear I added the Research Proposal to Nexus.", own([FAIL_RP]), [], LINE_RP],
      ["N4 'not only' construction", "Not only did I add the Research Proposal, it's flagged high priority too.", own([FAIL_RP]), [], LINE_RP],
      ["N5 'squared away'", "Your Research Proposal is all squared away for Oct 30.", own([FAIL_RP]), [], LINE_RP],
      ["N6 update claim 'changed'", "I've changed the Research Proposal deadline to Nov 2.", own([UPD_FAIL]), [], LINE_RP],
      ["N7 update claim 'Moved'", "Moved the Research Proposal to Nov 2 for you.", own([UPD_FAIL]), [], LINE_RP],
      ["N8 check mark U+2713", "Research Proposal ✓", own([FAIL_RP]), [], LINE_RP],
      ["N9 denial about the SAVED item + 'the proposal is added'", "Case Brief 2 could not be saved. The proposal is added though.", own([FAIL_RP, SAVED_CB]), [], `${LINE_RP}\nSaved to Nexus: “Case Brief 2”.`],
      ["N10 'on the books'", "The Research Proposal is on the books for Oct 30.", own([FAIL_RP]), [], LINE_RP],
      ["N11 'is set … scheduled in Nexus'", "Research Proposal is set — due Oct 30 at 11:59pm ET, scheduled in Nexus.", own([FAIL_RP]), [], LINE_RP],
      ["N12 plain claim", "I've added the Research Proposal to Nexus.", own([FAIL_RP]), [], LINE_RP],
      ["N13 honest denial (also code-built)", "I couldn't save the Research Proposal — Nexus returned an error.", own([FAIL_RP]), [], LINE_RP],
      ["N14 teammate unnamed 'took care of it' (was a documented residual)", "Elle took care of it.", [], own([FAIL_RP]), LINE_RP],
      ["N15 teammate named claim", "Elle has added your Research Proposal.", [], own([FAIL_RP]), LINE_RP],
      ["N16 title named with no write-talk word", "The Research Proposal is good to go for Oct 30.", own([FAIL_RP]), [], LINE_RP],
    ];
    // loop 3 D10 (docs/FIX-nexus-write-loop3.md): the expected value of every row below CHANGED. Loop 2 kept the
    // model's text after a failed write minus the sentences that matched a write-talk word list (the `want`
    // column above: the code-built line, sometimes followed by surviving prose). The owner's loop-3 rule: when
    // ANY write this turn did not persist, the reply is REPLACED by ONE code-built message (per-item status +
    // fixed closing line) -- no model sentence survives, no filtering. So each row now expects exactly that
    // message, built from the same results. Stronger, not weaker: the old expectation is a substring of nothing.
    const msgFor = (mine: ReturnType<typeof own>, mates: ReturnType<typeof own>) =>
      nexusWriteFailureMessage(nexusWriteResultsFrom([...mine, ...mates]));
    for (const [label, reply, mine, mates] of cases) {
      t(`L2-D3a ${label}: reply is the code-built message (loop 3)`, nexusWriteGuardedReply(reply, mine, mates), msgFor(mine, mates));
    }
    const mixed = "I couldn't save the Research Proposal. Separately, your MBA reading list is long; start with chapter 2.";
    // loop 3: was "unrelated sentences are kept AFTER the code-built line" -- no model sentence survives now.
    t("L2-D3b no model sentence survives a failed write, unrelated ones included (loop 3)", nexusWriteGuardedReply(mixed, own([FAIL_RP])), msgFor(own([FAIL_RP]), []));
    const saved = "I've added the Research Proposal to Nexus for Oct 30.";
    const SAVED_RP = { ...FAIL_RP, action: "inserted", persisted: true, error: undefined };
    // loop 3 (b): was "passes untouched" -- every clean write now also carries the code-built saved list.
    t("L2-D3c every item persisted: the model's text + the code-built saved list (loop 3)", nexusWriteGuardedReply(saved, own([SAVED_RP])), `${saved}\n\nSaved in Nexus:\n• “Research Proposal”`);
    t("L2-D3d no write this turn: untouched", nexusWriteGuardedReply(saved, []), saved);
    t("L2-D3e a duplicate is code-built too (nothing new was written)", nexusWriteGuardedReply("I added the Research Proposal.", own([{ ...FAIL_RP, action: "duplicate", error: undefined }])).includes("• Already in Nexus, nothing new added: “Research Proposal”"), true);
    t("L2-D3f a timeout is 'Unknown — check Nexus'", nexusWriteGuardedReply("Done!", own([{ ...FAIL_RP, persisted: "unknown", error: "timeout" }])).includes("• Unknown — check Nexus: “Research Proposal”"), true);
    t("L2-D3g a refusal gives its plain reason", nexusWriteGuardedReply("All set.", own([{ index: 0, title: "Residency 4, present your research proposal", action: "rejected", persisted: false, reason: "meeting/session" }])).includes("• Not saved: “Residency 4, present your research proposal” — it is a meeting/session/class, not a graded deliverable"), true);
    // loop 3 (a): was "a teammate that said nothing about the write is untouched" -- EVERY reply of a turn with a
    // failed write is replaced now (the owner's rule), so a teammate's reply is the code-built message too.
    t("L2-D3h a teammate's reply in a failed-write turn is replaced as well (loop 3)", nexusWriteGuardedReply("Your budget looks fine this month.", [], own([FAIL_RP])), msgFor([], own([FAIL_RP])));
    t("L2-D3i a tool-level error (no per-item results) is code-built", nexusWriteGuardedReply("Saved it!", [{ tool: N, ok: false, detail: JSON.stringify({ ok: false, error: "network_error" }) }]).includes("• Not saved: the whole write request — Nexus could not be reached"), true);
    // loop 3: was a source check that the per-agent reply assembly calls nexusWriteGuardedReply with teammates'
    // writes. The runtime now presents EVERY reply against EVERY write of the turn.
    t("L2-D3j the text path presents every reply against every write of the turn (loop 3)", /const presentedReplies = \(list: Reply\[\] = replies\): Reply\[\] => presentNexusWriteTurn\(list, turnNexusWriteUses\) as Reply\[\];/.test(textSrc), true);
    // The verifier's own probe inputs, end to end: none of them keeps its original text any more.
    t("L2-D3k none of the verifier's 13 own-writer replies survives verbatim", cases.slice(0, 13).filter(([, reply, mine]) => nexusWriteGuardedReply(reply, mine).includes(reply)).length, 0);
  }

  console.log("=== D4: 1:1 text streaming is held from the moment a write call starts ===");
  {
    const hold = createNexusWriteStreamHold();
    const published: string[] = [];
    const onDelta = hold.wrap((full: string) => published.push(full));
    onDelta("Let me check");
    hold.noteToolCall("get_nexus_assignments");
    onDelta("Let me check your list");
    hold.noteToolCall(N);
    onDelta("I've added your Research Proposal");
    onDelta("I've added your Research Proposal to Nexus.");
    t("L2-D4a deltas after a write call starts are never published", published.join(" | "), "Let me check | Let me check your list");
    t("L2-D4b the hold is armed by the write call (and was not by the read call: L2-D4a)", hold.held, true);
    t("L2-D4c the 1:1 onDelta is wrapped in the stream hold", /const onDelta = streamOneOnOne\s*\?\s*nexusStreamHold\.wrap\(\(full: string\) =>/.test(textSrc), true);
    t("L2-D4d the write dispatch arms the hold before executing", /c\.name === nexusWriteMod\.NEXUS_WRITE_TOOL_NAME\) \{[\s\S]{0,200}nexusStreamHold\.noteToolCall\(c\.name\);[\s\S]{0,900}executeNexusWriteTool/.test(textSrc), true);
    t("L2-D4e the hold is turn-scoped (one per runHuddleTurn, beside turnNexusWriteUses)", /const turnNexusWriteUses[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*const nexusStreamHold = createNexusWriteStreamHold\(\);/.test(textSrc), true);
  }

  console.log("=== D3/D4 voice: same code-built text spoken; the gate holds from call start and survives a barge-in ===");
  {
    const failed = JSON.stringify({ ok: true, persisted: false, results: [{ index: 0, title: "Research Proposal", action: "failed", persisted: false, error: "http_500" }] });
    const clean = JSON.stringify({ ok: true, persisted: true, results: [{ index: 0, title: "Research Proposal", action: "inserted", persisted: true }] });
    let g = createNexusWriteSpeechGate();
    t("L2-V1 not holding before any write", g.holding, false);
    g.noteToolCall(N);
    t("L2-V2 holding from the moment the write call STARTS (result not in yet)", g.holding, true);
    g.reset(); // the user talks while the write is in flight
    t("L2-V3 a reset during the write is deferred: still holding", g.holding, true);
    g.noteToolOutput(N, failed);
    const spoken = g.finalize("I didn't just add the Research Proposal, I also set it to high priority.");
    // loop 3 D10/D9: the code-built line became the ONE code-built message, and finalize now returns
    // { full (captioned+persisted), speak (voiced), mode } instead of one string.
    t("L2-V4 the voice speaks AND persists only the code-built message (verifier N1 on voice)", `${spoken.speak === nexusWriteFailureMessage(nexusWriteResultsFrom([{ tool: N, ok: false, detail: failed }]))}/${spoken.full === spoken.speak}/${spoken.mode}`, "true/true/whole");
    t("L2-V5 the deferred reset lands once that reply is delivered", g.holding, false);
    g = createNexusWriteSpeechGate();
    g.noteToolCall(N);
    g.noteToolOutput(N, failed);
    g.reset(); // user utterance arrives AFTER the result but BEFORE the reply's text.done
    t("L2-V6 a reset after the result but before the reply is still deferred", g.holding, true);
    t("L2-V7 ...and the reply is still code-built", g.finalize("Your Research Proposal is all squared away.").speak, nexusWriteFailureMessage(nexusWriteResultsFrom([{ tool: N, ok: false, detail: failed }])));
    g = createNexusWriteSpeechGate();
    g.noteToolCall(N);
    g.noteToolOutput(N, clean);
    t("L2-V8 a clean write releases the hold once its result is in (happy path streams)", g.holding, false);
    // loop 3 (b)/D9: was "passes untouched" -- a clean write's reply streams as usual and the code-built saved
    // list is APPENDED (persisted text = reply + list; voiced after the streamed tail = the list).
    const v9 = g.finalize("I've added the Research Proposal.");
    t("L2-V9 a clean write's reply + the code-built saved list", `${v9.mode}|${v9.full}|${v9.speak}`, "append|I've added the Research Proposal.\n\nSaved in Nexus:\n• “Research Proposal”|Saved in Nexus:\n• “Research Proposal”");
    g.reset();
    t("L2-V10 after delivery a reset clears at once", `${g.holding}/${g.uses.length}`, "false/0");
    const hook = readFileSync("src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts", "utf8");
    t("L2-V11 the hook arms the gate when a tool call starts", /case "response\.function_call_arguments\.done":[\s\S]{0,700}nexusGateRef\.current\.noteToolCall\(name\);[\s\S]{0,200}runRealtimeTool\(/.test(hook), true);
    // loop 3 D9: was `const full = gate.finalize(raw);` -- finalize returns { full, speak, mode } now.
    t("L2-V12 the hook speaks/persists gate.finalize(raw)", /const out = gate\.finalize\(raw\);\s*\n\s*if \(out\.mode === "whole"\) \{[\s\S]{0,200}void speak\(out\.speak, agentIdRef\.current, gen\);[\s\S]{0,600}persist\("agent", agentIdRef\.current, out\.full\);/.test(hook), true);
    t("L2-V13 the hook still streams only while the gate is not holding", /if \(!nexusGateRef\.current\.holding\) pumpSpeech\(/.test(hook), true);
  }
};

await main();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
