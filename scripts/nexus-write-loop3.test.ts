// WHAT:       Every reproduction from the independent verifier's loop-2 report (D6-D11, H1-H15, V-a..V-c and the
//             out-of-radius OQ-2 update note), pinned as tests against loop 3's structural fixes:
//             D7 kind filter on a canonical title; item 6 unchanged stored title on UPDATE; D8 dedup day in the
//             COURSE's zone; D6 coursework context = the owner's REAL course list (+ vetoes first);
//             D10/D11 code-built turn replies + saved list + resume state; D9 voice buffering.
// WHY:        docs/VERIFY-nexus-write-tool-2.md REFUTED C1-C4/C9: every loop-2 defence was a word list and
//             leaked on the next spelling. Each test here is a verifier input or the mechanism behind it.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-loop3.md (RESPONDS TO docs/VERIFY-nexus-write-tool-2.md); verifier probes
//             in mut-verify-114-2/.
//
// OFFLINE ONLY: `fetch` is an in-memory fake Nexus. Nothing reaches a real Nexus, Huddle, DB or board.
// Run: bun scripts/nexus-write-loop3.test.ts

import {
  executeNexusWriteTool,
  classifyNonDeliverable,
  canonicalTitle,
  nexusWriteClaimKey,
  resolveDueInstant,
} from "../src/features/huddle/lib/nexus/nexus-write.server";
import { readFileSync } from "node:fs";
import { routeMessage, laneOwnerFor, primeLaneDecision } from "../src/features/huddle/lib/routing";
import { sharedCapabilityHolders } from "../src/features/huddle/lib/capabilities";
import { AGENTS, type AgentId } from "../src/features/huddle/data/agents";
import {
  setNexusCourseContext,
  nexusCourseMentioned,
  NEXUS_COURSE_CONTEXT_TTL_MS,
} from "../src/features/huddle/lib/nexus/course-context";
import { primeNexusCourseContext } from "../src/features/huddle/lib/nexus/course-context.server";
import {
  NEXUS_WRITE_TOOL_NAME as N,
  presentNexusWriteTurn,
  nexusWriteFailureMessage,
  nexusWriteResultsFrom,
  nexusWriteInFlightOutcome,
  NEXUS_WRITE_WITHHELD_REPLY,
  NEXUS_WRITE_STATUS_CLOSING,
  createNexusWriteSpeechGate,
} from "../src/features/huddle/lib/nexus/nexus-write-shared";

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
// The owner's courses. c-la carries a time_zone column Nexus does not have today: it proves the course's own
// zone (when Nexus has one) is what the dedup day uses -- never the model's time_zone argument.
const COURSES: Row[] = [
  { id: "c782", code: "MGT-782", name: "MGT-782-W1 (202711)", program_id: "p-dba", user_id: OWNER },
  { id: "c702", code: "MGT-702", name: "Strategic Management", program_id: "p-dba", user_id: OWNER },
  { id: "c-la", code: "OPS-610", name: "Operations West", program_id: "p-dba", user_id: OWNER, time_zone: "America/Los_Angeles" },
];
let ASSIGN: Row[] = [];
type Call = { method: string; url: URL; body: Row | null };
let calls: Call[] = [];
let seq = 0;
const resetStore = () => {
  calls = [];
  ASSIGN = [
    { id: "aafbf80f", course_id: "c782", title: "Research Proposal", due_date: "2026-10-31T03:59:59.000Z" },
    { id: "6616bef3", course_id: "c782", title: "Research Paper", due_date: "2026-12-10 04:59:59+00" },
    { id: "resid-1", course_id: "c782", title: "Residency participation", due_date: "2026-11-09T04:59:59.000Z" },
    // Oct 30 16:00 Pacific = Oct 30 19:00 Eastern.
    { id: "la-1", course_id: "c-la", title: "Ops Memo", due_date: "2026-10-30T23:00:00.000Z" },
  ];
};
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
  calls.push({ method, url, body });
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (method === "GET") {
    if (url.pathname.endsWith("/api/d1/courses")) return json(200, COURSES);
    if (url.pathname.endsWith("/api/d1/assignments")) {
      const f = JSON.parse(url.searchParams.get("filters") ?? "[]") as [string, string][];
      const cid = f.find(([c]) => c === "course_id")?.[1];
      const id = f.find(([c]) => c === "id")?.[1];
      return json(200, ASSIGN.filter((a) => (!cid || a.course_id === cid) && (!id || a.id === id)).map((a) => ({ ...a })));
    }
    return json(404, {});
  }
  if (method === "POST") {
    const row = { id: `new-${++seq}`, ...body };
    ASSIGN.push(row);
    return json(200, { rows: [row] });
  }
  if (method === "PATCH") {
    const row = ASSIGN.find((a) => a.id === url.searchParams.get("id"));
    if (!row) return json(404, { error: "nf" });
    Object.assign(row, body);
    return json(200, { rows: [row] });
  }
  return json(405, {});
}) as unknown as typeof fetch;
const exec = (items: unknown[]) => executeNexusWriteTool({ items }, { ref: "loop3" }) as Promise<{ results: Row[] } & Row>;
const posts = () => calls.filter((c) => c.method === "POST").length;
const patches = () => calls.filter((c) => c.method === "PATCH");

const main = async () => {
  console.log("=== D7: the kind filter reads a CANONICAL title (no raw-spelling escape) ===");
  {
    // The verifier's D7a-D7i inputs, plus the probe's two extras, verbatim (escapes keep the invisible ones visible).
    const DENY: Array<[string, string]> = [
      ["Residency4, present your research proposal", "meeting/session"],
      ["Residency_4: present your research proposal", "meeting/session"],
      ["ResidencyIV: present your research proposal", "meeting/session"],
      ["Ｒｅｓｉｄｅｎｃｙ 4: present your research proposal", "meeting/session"],
      ["Office-hours: bring your proposal draft", "meeting/session"],
      ["Oﬃce hours: bring your proposal draft", "meeting/session"],
      ["Office hours: bring your proposal draft", "meeting/session"],
      ["Office  hours: bring your proposal draft", "meeting/session"],
      ["Re­sidency 4: present your research proposal", "meeting/session"],
      ["Residence weekend: present your research proposal", "meeting/session"],
      ["Weekend intensive: present your research proposal", "meeting/session"],
      ["Doctoral consortium: present your research proposal", "meeting/session"],
      ["Academic conference: present your paper", "meeting/session"],
      ["Cohort gathering: bring your case analysis", "meeting/session"],
      ["On-campus residency week 2: research proposal presentation", "meeting/session"],
      // more invisible / spacing spellings the brief names
      ["Resi​dency 4: present your research proposal", "meeting/session"],
      ["Resi‍dency 4: present your research proposal", "meeting/session"],
      ["Resi‌dency 4: present your research proposal", "meeting/session"],
      ["Residency⁠IV: present your research proposal", "meeting/session"],
      ["Office hours: bring your proposal draft", "meeting/session"],
      ["Office.hours, bring your proposal draft", "meeting/session"],
      ["RESIDENCY/4 research proposal", "meeting/session"],
      ["Session2: proposal draft", "meeting/session"],
      ["SeminarIII reflection paper", "meeting/session"],
      // the extended deny vocabulary
      ["Annual summit: present your research paper", "event"],
      ["Retreat reflection paper", "event"],
      ["Convocation essay", "event"],
      ["Commencement speech essay", "administrative"],
      ["Immersion week: case analysis", "meeting/session"],
    ];
    for (const [s, why] of DENY) t(`L3-D7a ${JSON.stringify(s)} is refused (${why})`, classifyNonDeliverable(s), why);
    // canonicalTitle itself (the one form every rule reads)
    for (const [s, want] of [
      ["Residency4, present", "residency 4 present"],
      ["ResidencyIV: x", "residency iv x"],
      ["Ｒｅｓｉｄｅｎｃｙ 4", "residency 4"],
      ["Oﬃce hours", "office hours"],
      ["Re­si​den⁠cy", "residency"],
      ["a_b/c.d,e:f-g", "a b c d e f g"],
      ["  Case   Brief\t7 ", "case brief 7"],
      ["Civic paper", "civic paper"],
    ] as Array<[string, string]>) {
      t(`L3-D7b canonicalTitle(${JSON.stringify(s)})`, canonicalTitle(s), want);
    }
    // Real deliverables still pass the canonical rules.
    for (const s of ["Research Proposal", "Case Brief 7", "Break-even analysis", "Civic engagement paper", "Chapter 4 problem set", "研究提案", "Ｒｅｓｅａｒｃｈ Ｐｒｏｐｏｓａｌ", "Test 2"]) {
      t(`L3-D7c ${JSON.stringify(s)} is still accepted`, classifyNonDeliverable(s), "null");
    }
    // Through the executor: refused with a reason, 0 POSTs.
    resetStore();
    const r = await exec([
      { course: "MGT-782", title: "Residency4, present your research proposal", due_date: "2026-11-09" },
      { course: "MGT-782", title: "Oﬃce hours: bring your proposal draft", due_date: "2026-11-10" },
    ]);
    t("L3-D7d executor refuses both canonical spellings, 0 POSTs", `${r.results.map((x) => x.reason).join(",")}/${posts()}`, "meeting/session,meeting/session/0");
  }

  console.log("=== Item 6: an UPDATE passing the row's EXISTING title unchanged is not re-judged ===");
  {
    resetStore();
    let r = await exec([{ assignment_id: "resid-1", title: "Residency participation", due_date: "2026-11-10" }]);
    const p = patches()[0];
    t("L3-K6a unchanged stored meeting-titled row + new date -> updated, persisted", `${r.results[0].action}/${r.results[0].persisted}`, "updated/true");
    t("L3-K6b ...the PATCH carries only the date (the unchanged title is not re-sent)", Object.keys(p?.body ?? {}).join(","), "due_date");
    resetStore();
    r = await exec([{ assignment_id: "resid-1", title: "residency  participation", due_date: "2026-11-10" }]);
    t("L3-K6c the same title in another spelling is still 'unchanged'", `${r.results[0].action}/${r.results[0].persisted}`, "updated/true");
    resetStore();
    r = await exec([{ assignment_id: "resid-1", title: "Residency 5 participation" }]);
    t("L3-K6d a CHANGED meeting title is still refused, 0 PATCH", `${r.results[0].reason}/${patches().length}`, "meeting/session/0");
    resetStore();
    r = await exec([{ assignment_id: "aafbf80f", title: "Office hours prep" }]);
    t("L3-K6e a deliverable row renamed to a meeting is refused, 0 PATCH", `${r.results[0].reason}/${patches().length}`, "meeting/session/0");
    resetStore();
    r = await exec([{ assignment_id: "aafbf80f", due_date: "2026-11-02" }]);
    t("L3-K6f an update with no title reports the STORED title and course (for the saved list)", `${r.results[0].title}/${(r.results[0].course as Row | undefined)?.code}`, "Research Proposal/MGT-782");
    t("L3-K6g ...and its date in the course zone", /Nov 2, 2026, 11:59 PM EST/.test(String(r.results[0].due_local)), true);
  }

  console.log("=== D8: the dedup day is the COURSE's zone; the model's time_zone only interprets an offset-less date ===");
  {
    const dupCase = async (label: string, item: Row, want: string) => {
      resetStore();
      const r = await exec([{ course: "MGT-782", title: "Research Proposal", ...item }]);
      t(label, `${r.results[0].action}/${posts()}`, want);
    };
    await dupCase("L3-D8a verifier repro: Z instant + time_zone Asia/Tokyo on the stored ET day -> duplicate, 0 POSTs", { due_date: "2026-10-30T12:00:00Z", time_zone: "Asia/Tokyo" }, "duplicate/0");
    await dupCase("L3-D8b verifier repro: plain date + time_zone Europe/London -> duplicate, 0 POSTs", { due_date: "2026-10-30", time_zone: "Europe/London" }, "duplicate/0");
    await dupCase("L3-D8c plain date + America/Los_Angeles (Oct 31 02:59 ET) is still the WRITTEN Oct 30 row", { due_date: "2026-10-30", time_zone: "America/Los_Angeles" }, "duplicate/0");
    await dupCase("L3-D8d plain date + PST", { due_date: "2026-10-30", time_zone: "PST" }, "duplicate/0");
    await dupCase("L3-D8e plain date + UTC", { due_date: "2026-10-30", time_zone: "UTC" }, "duplicate/0");
    await dupCase("L3-D8f Z instant + Pacific/Kiritimati (already Oct 31 there) is the ET Oct 30 row", { due_date: "2026-10-30T15:00:00Z", time_zone: "Pacific/Kiritimati" }, "duplicate/0");
    await dupCase("L3-D8g the next ET day is still a separate insert (W1 recurring)", { due_date: "2026-10-31" }, "inserted/1");
    await dupCase("L3-D8h a Z instant on the next ET day + time_zone Pacific/Honolulu (still Oct 30 there) -> inserted", { due_date: "2026-10-31T12:00:00Z", time_zone: "Pacific/Honolulu" }, "inserted/1");
    // The course's own zone decides, when the course carries one (c-la, America/Los_Angeles).
    resetStore();
    let r = await exec([{ course: "OPS-610", title: "Ops Memo", due_date: "2026-10-31T05:00:00Z", time_zone: "America/New_York" }]);
    t("L3-D8i a course WITH a zone: Oct 30 22:00 PT is that course's Oct 30 -> duplicate (ET would say Oct 31)", `${r.results[0].action}/${posts()}`, "duplicate/0");
    // Labels are course-local too.
    resetStore();
    r = await exec([{ course: "MGT-782", title: "Case Brief 9", due_date: "2026-11-20", time_zone: "Asia/Tokyo" }]);
    t("L3-D8j due_local is in the COURSE zone (Nov 20 23:59:59 JST = 9:59 AM EST)", String(r.results[0].due_local), "Fri, Nov 20, 2026, 9:59 AM EST");
    // The per-turn claim key agrees, whatever time_zone the model passed.
    const key = (it: Row) => nexusWriteClaimKey({ items: [{ course: "MGT-782", title: "Research Proposal", ...it }] });
    t("L3-D8k claim key: plain date with or without a time_zone is the same", key({ due_date: "2026-10-30", time_zone: "America/Los_Angeles" }) === key({ due_date: "2026-10-30" }), true);
    t("L3-D8l claim key: an ISO instant with or without a time_zone is the same", key({ due_date: "2026-10-30T12:00:00Z", time_zone: "Asia/Tokyo" }) === key({ due_date: "2026-10-30T12:00:00Z" }), true);
    const iso = resolveDueInstant("2026-10-30T12:00:00Z", undefined, "Asia/Tokyo");
    t("L3-D8m resolveDueInstant ignores time_zone for an ISO instant (zone reported = default)", iso.ok && `${iso.zone}/${iso.writtenDay ?? "none"}`, "America/New_York/none");
    const plain = resolveDueInstant("2026-10-30", undefined, "Asia/Tokyo");
    t("L3-D8n ...and USES it to interpret a plain date (23:59:59 JST = 14:59:59Z), keeping the written day", plain.ok && `${plain.iso}/${plain.writtenDay}`, "2026-10-30T14:59:59Z/2026-10-30");
    const bad = resolveDueInstant("2026-10-30T12:00:00Z", undefined, "America/New_York&owner=evil");
    t("L3-D8o a garbage time_zone is still refused (validated, never silently dropped)", bad.ok ? "ok" : bad.reason, "ambiguous-date");
    const src = readFileSync("src/features/huddle/lib/nexus/nexus-write.server.ts", "utf8");
    t("L3-D8p runNexusWrite dedups in courseZoneOf(course), never due.zone", /const dayZone = courseZoneOf\(course\);\s*\n\s*const dup = findDuplicate\(\{ title, dueMs: due\.ms, zone: dayZone, writtenDay: due\.writtenDay \}, existing\);/.test(src) && !/zone: due\.zone/.test(src), true);
  }

  console.log("=== D6: coursework context is DATA FROM NEXUS (the owner's real courses); vetoes first ===");
  {
    const ALL_IDS = AGENTS.map((a) => a.id) as AgentId[];
    const PRIME = new Set(["elle-rowan", "iris-chase"]);
    const OWNER_COURSES = [{ code: "MGT-782", name: "MGT-782-W1 (202711)" }, { code: "MGT-702", name: "Strategic Management" }];
    setNexusCourseContext(OWNER_COURSES);
    const lead = (text: string) =>
      routeMessage({ text, scope: "group", members: ALL_IDS, history: [] } as Parameters<typeof routeMessage>[0]).winners[0];
    // [ask, addressed agent in the 1:1, group leader on origin/main, laneOwnerFor(ask, addressed) on origin/main].
    // Baselines MEASURED with `bun mut-loop3/probe-routing.ts <git archive origin/main bee838b> d6`, not typed
    // from memory. The verifier's D6 table (all 16 rows of probe-intent + probe-routing's attacks) + 4 extras.
    const D6: Array<[string, AgentId, string, string]> = [
      ["my UA 902 check-in deadline is tonight, can you handle it", "troy-lennox", "elle-rowan", "null"],
      ["check me in for UA 902 before the deadline tonight", "troy-lennox", "elle-rowan", "null"],
      ["my DS-160 visa form is due Friday", "troy-lennox", "iris-chase", "null"],
      ["fill out my DS-160 visa form, it's due Friday", "troy-lennox", "iris-chase", "null"],
      ["my DBA filing deadline for the LLC is Friday", "sam-trent", "elle-rowan", "null"],
      ["file my DBA for the LLC before the deadline", "sam-trent", "elle-rowan", "null"],
      ["pay the IRS 941 payment due Friday", "finn-reid", "iris-chase", "null"],
      ["the IRS 941 payment is due Friday", "finn-reid", "iris-chase", "null"],
      ["my MBA loan payment is due Monday, can I afford it", "finn-reid", "finn-reid", "null"],
      ["set up autopay for my MBA loan payment due Monday", "finn-reid", "finn-reid", "null"],
      ["pay my yoga instructor, the payment is due Monday", "finn-reid", "iris-chase", "null"],
      ["my yoga instructor says the class pass payment is due Monday", "flex-grimes", "iris-chase", "null"],
      ["sign my mortgage papers before the due date", "finn-reid", "iris-chase", "null"],
      ["when is the due date on my mortgage papers", "finn-reid", "iris-chase", "null"],
      ["my new job assignment in Germany starts Monday, what's my assignment exactly", "sam-trent", "sam-trent", "null"],
      ["roll my NVDA 200 calls before the deadline Friday", "finn-reid", "elle-rowan", "null"],
      ["what's the deadline to submit my visa papers", "troy-lennox", "elle-rowan", "elle-rowan"],
      ["my NVDA 200 call options deadline to roll is Friday", "finn-reid", "elle-rowan", "null"],
      ["can you log my 5k run to Nexus fitness tracker by the deadline", "flex-grimes", "elle-rowan", "null"],
      ["my prof at the gym wants the meal plan paper by Friday", "flex-grimes", "charleston-lewis", "null"],
      ["book a flight to Toronto for the EMBA residency", "troy-lennox", "troy-lennox", "null"],
      ["buy $NVDA before the earnings deadline", "finn-reid", "elle-rowan", "null"],
      ["my passport renewal paperwork is due next week", "troy-lennox", "iris-chase", "null"],
      ["submit the payroll report before the deadline", "finn-reid", "elle-rowan", "elle-rowan"],
    ];
    for (const [text, self, group, lane] of D6) {
      t(`L3-D6a "${text}" matches NO coursework prime capability`, sharedCapabilityHolders(text).length, 0);
      t(`L3-D6b group "${text}" -> origin/main baseline`, lead(text), group);
      const handoffs = ALL_IDS.map((id) => primeLaneDecision(text, id)).filter((x) => x !== null);
      t(`L3-D6c 1:1 with ANY agent: "${text}" makes no prime hand-off`, handoffs.length, 0);
      t(`L3-D6d 1:1 ${self}: "${text}" -> origin/main lane`, laneOwnerFor(text, self)?.id ?? "null", lane);
    }
    // Every coursework ask (loop-2 tests + the verifier's 13 + MGT-702/name spellings) still goes to Elle/Iris.
    const COURSEWORK = [
      "add my assignments", "add my MGT-782 assignments from the syllabus", "put the research paper due Dec 9 on my assignments",
      "update the due date on my research paper", "change my research proposal deadline to Nov 2", "log my DBA deliverables",
      "add this syllabus's deadlines to Nexus", "I have a new paper due next month for MGT-782, add it", "add my school assignments",
      "fix the due date on my strategy paper", "my professor pushed the case analysis to Friday",
      "my mgt 782 paper is due friday", "the strategy essay for my doctoral program is due Dec 1",
      "add the case study due Nov 3 to Nexus", "what's due in Nexus this week", "show my Nexus assignments", "mgt-782 paper deadline moved",
      "my instructor extended the essay deadline", "my doctoral dissertation draft is due Dec 1",
      "the MGT-702 final paper is due Dec 4", "my Strategic Management essay deadline is Friday",
    ];
    for (const text of COURSEWORK) {
      t(`L3-D6e group "${text}" is led by Elle/Iris`, PRIME.has(String(lead(text))), true);
      t(`L3-D6f 1:1 Elle/Iris keep "${text}"`, `${primeLaneDecision(text, "elle-rowan")}/${primeLaneDecision(text, "iris-chase")}`, "keep/keep");
      t(`L3-D6g 1:1 Finn hands "${text}" to Elle/Iris`, PRIME.has(String(laneOwnerFor(text, "finn-reid" as AgentId)?.id)), true);
    }
    // The course is DATA, not a shape: the same ask without the owner's course list (or with a course he
    // does not have) carries no strong context.
    const ASK = "I have a new paper due next month for MGT-782, add it";
    t("L3-D6h with the owner's course list, MGT-782 is strong context", nexusCourseMentioned(ASK), true);
    t("L3-D6i a course code he does NOT have (MGT-999) is not context", sharedCapabilityHolders("I have a new paper due next month for MGT-999, add it").length, 0);
    t("L3-D6j a full course NAME counts (\"Strategic Management\")", nexusCourseMentioned("my strategic management essay is due"), true);
    setNexusCourseContext([{ code: "STR", name: "Strategy" }]);
    t("L3-D6k a one-word course name is not used as context (\"Strategy\")", nexusCourseMentioned("what's our strategy for the merger paper due friday"), false);
    setNexusCourseContext(OWNER_COURSES, Date.now() - NEXUS_COURSE_CONTEXT_TTL_MS - 1);
    t("L3-D6l a STALE course list is not used (weak signals only)", `${nexusCourseMentioned(ASK)}/${sharedCapabilityHolders(ASK).length}`, "false/0");
    setNexusCourseContext(null);
    t("L3-D6m no course list (Nexus unavailable): the code alone is no context", sharedCapabilityHolders(ASK).length, 0);
    t("L3-D6n ...but explicit words still are (\"syllabus\")", sharedCapabilityHolders("add my MGT-782 assignments from the syllabus").length > 0, true);
    setNexusCourseContext(OWNER_COURSES);
    // VETOES are evaluated BEFORE strong context and win (owner's rule) -- even over a real course code.
    t("L3-D6o a veto beats a real course code (owner's order)", sharedCapabilityHolders("book the flight for my MGT-782 paper deadline").length, 0);
    // "Nexus" counts only as the APP.
    for (const text of ["renew my NEXUS card before the deadline", "my NEXUS program application deadline is Friday", "should I apply to NEXUS before the deadline", "is my NEXUS interview due"]) {
      t(`L3-D6p "${text}" is not Nexus-the-app`, sharedCapabilityHolders(text).length, 0);
    }
    // The data on the capability: no generic course-code regex, no degree/teacher word as STRONG.
    const cap = AGENTS.flatMap((a) => a.capabilities ?? []).find((c) => c.id === "nexus-assignments");
    const strong = (cap?.requiresContext?.strong ?? []).join(",");
    t("L3-D6q strong words are only syllabus/syllabi (mba/dba/instructor/professor are weak)", strong, "syllabus,syllabi");
    t("L3-D6r strong context names the Nexus course list as a DATA source", (cap?.requiresContext?.strongSources ?? []).join(","), "nexus-courses");
    t("L3-D6s no generic course-code shape survives in the strong patterns", (cap?.requiresContext?.strongPatterns ?? []).some(([src]) => /\\d\{3\}|\[A-Z\]\{2/.test(src)), false);
    const capSrc = readFileSync("src/features/huddle/lib/capabilities.ts", "utf8");
    t("L3-D6t vetoes are checked BEFORE strong context", /if \(anyWord\(ctx\.vetoes\) \|\| anyPattern\(ctx\.vetoPatterns\)\) return false;\s*\n\s*if \(anyWord\(ctx\.strong\)/.test(capSrc), true);
    const fnSrc = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
    t("L3-D6u the turn primes the course list BEFORE routing", /await primeNexusCourseContext\(\);[\s\S]{0,300}\/\/ ---- Route ----/.test(fnSrc), true);
    // The server primer: the existing read path, owner-filtered; unavailable -> weak only.
    setNexusCourseContext(null);
    const primed = await primeNexusCourseContext({ waitMs: 2000 });
    t("L3-D6v primeNexusCourseContext reads Nexus courses and fills the cache", `${primed}/${nexusCourseMentioned("the MGT-702 paper is due")}`, "loaded/true");
    t("L3-D6w ...through nexusGet(\"courses\") (the read path), owner-scoped", calls.some((c) => c.method === "GET" && c.url.pathname.endsWith("/api/d1/courses") && c.url.searchParams.get("owner") === OWNER), true);
    setNexusCourseContext(null);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    const down = await primeNexusCourseContext({ waitMs: 2000 });
    globalThis.fetch = realFetch;
    t("L3-D6x Nexus down -> 'unavailable', routing on weak signals only", `${down}/${sharedCapabilityHolders(ASK).length}`, "unavailable/0");
    setNexusCourseContext(OWNER_COURSES);
  }

  console.log("=== D10/D11: honesty is code-built from the RESULTS for the whole turn (no word list, no filtering) ===");
  {
    const use = (agentId: string, results: unknown[]) => ({ agentId, tool: N, ok: false, detail: JSON.stringify({ ok: true, results }) });
    const FAIL_RP = { index: 0, title: "Research Proposal", action: "failed", persisted: false, error: "http_500" };
    const FAILED = [use("elle-rowan", [FAIL_RP])];
    const MSG = nexusWriteFailureMessage(nexusWriteResultsFrom(FAILED));
    t("L3-H0a the message is per-item status + the fixed closing line", MSG, `Nexus write status:\n• Not saved: “Research Proposal” — Nexus returned an error (http 500)\n${NEXUS_WRITE_STATUS_CLOSING}`);
    // H1-H11 (+ the AC-F2-35 phrase) -- every spelling, every language: the reply IS the message, nothing kept.
    const H: Array<[string, string]> = [
      ["H1", "It's in."],
      ["H2 (AC-F2-35's own phrase)", "It is on your list for Oct 30."],
      ["H3", "Penciled it in for the 30th."],
      ["H4", "Handled. You're good for the 30th."],
      ["H5", "Booked it for Oct 30."],
      ["H6", "Sorted! It will show up in your coursework view."],
      ["H7", "Your RP is good to go for Oct 30."],
      ["H8 Spanish", "Listo, ya quedó guardado para el 30."],
      ["H9 full-width", "Ａｄｄｅｄ it for Oct 30."],
      ["H10 zero-width space", "I've add​ed it"],
      ["H11", "Got it on there, you're all good."],
      ["ctl unrelated", "Also, remember to hydrate."],
      ["extra emoji only", "✅"],
      ["extra mixed truth + claim", "I couldn't save it. Just kidding, it's in."],
    ];
    for (const [label, reply] of H) {
      const shown = presentNexusWriteTurn([{ agentId: "elle-rowan", text: reply }], FAILED);
      t(`L3-H1 ${label}: ${JSON.stringify(reply)} -> ONLY the code-built message`, shown.length === 1 && shown[0].text === MSG, true);
    }
    // H12/H13: a teammate's claim after the writer's failure -- every reply of the turn is replaced.
    let shown = presentNexusWriteTurn(
      [{ agentId: "elle-rowan", text: "Saving it now." }, { agentId: "finn-reid", text: "It's in, Elle got it." }],
      FAILED,
    );
    t("L3-H12 teammate claim after the writer's failure -> writer slot = message, teammate = held back", `${shown[0].text === MSG}/${shown[1].text === NEXUS_WRITE_WITHHELD_REPLY}`, "true/true");
    shown = presentNexusWriteTurn(
      [{ agentId: "finn-reid", text: "Elle handled that one for you." }, { agentId: "elle-rowan", text: "Done!" }],
      FAILED,
    );
    t("L3-H13 teammate replied FIRST (earlier wave): its slot is held back, the writer's slot carries the message", `${shown[0].text === NEXUS_WRITE_WITHHELD_REPLY}/${shown[1].text === MSG}`, "true/true");
    shown = presentNexusWriteTurn([{ agentId: "finn-reid", text: "Elle took care of it." }], FAILED);
    t("L3-H13b the writer never replied (timed out): the first slot carries the message", shown[0].text, MSG);
    shown = presentNexusWriteTurn([], FAILED);
    t("L3-H13c no reply at all: one code-built reply from the writer", `${shown.length}/${shown[0].agentId}/${shown[0].text === MSG}`, "1/elle-rowan/true");
    t("L3-H13d the held-back line and closing line are fixed text, not model text", `${NEXUS_WRITE_WITHHELD_REPLY.startsWith("(Held back")}/${NEXUS_WRITE_STATUS_CLOSING.startsWith("Nothing else")}`, "true/true");
    // A reply's code-built widgets/chips (not model text) stay on it.
    shown = presentNexusWriteTurn([{ agentId: "finn-reid", text: "x", artifacts: [{ id: "a1", name: "Doc" }] } as { agentId: string; text: string }], FAILED);
    t("L3-H13e non-text attachments of a replaced reply are kept", JSON.stringify((shown[0] as { artifacts?: unknown }).artifacts), '[{"id":"a1","name":"Doc"}]');

    // (b) every write persisted: the code-built saved list, from a REAL executor result (course-local date + course).
    resetStore();
    const ins = await exec([{ course: "MGT-782", title: "Case Brief 9", due_date: "2026-11-20" }]);
    const CLEAN = [{ agentId: "elle-rowan", tool: N, ok: true, detail: JSON.stringify(ins) }];
    shown = presentNexusWriteTurn([{ agentId: "elle-rowan", text: "I've added all 5 assignments from your MGT-782 syllabus." }], CLEAN);
    t("L3-H14 clean 1-item write + 'all 5' claim: the list shows exactly what was written", shown[0].text,
      "I've added all 5 assignments from your MGT-782 syllabus.\n\nSaved in Nexus:\n• “Case Brief 9” — due Fri, Nov 20, 2026, 11:59 PM EST — MGT-782");
    shown = presentNexusWriteTurn([{ agentId: "elle-rowan", text: "Done." }, { agentId: "finn-reid", text: "Budget's fine." }], CLEAN);
    t("L3-H14b the list goes on the WRITER's reply; a teammate's reply is untouched", `${shown[0].text.includes("Saved in Nexus:")}/${shown[1].text}`, "true/Budget's fine.");
    shown = presentNexusWriteTurn([{ agentId: "finn-reid", text: "Budget's fine." }], CLEAN);
    t("L3-H14c a clean writer with no reply of its own still gets the list (its own reply)", `${shown.length}/${shown[1]?.agentId}/${shown[1]?.text.startsWith("Saved in Nexus:")}`, "2/elle-rowan/true");
    resetStore();
    const upd = await exec([{ assignment_id: "aafbf80f", due_date: "2026-11-02" }]);
    shown = presentNexusWriteTurn([{ agentId: "iris-chase", text: "Moved it." }], [{ agentId: "iris-chase", tool: N, ok: true, detail: JSON.stringify(upd) }]);
    t("L3-H14d an update is listed as Updated, with its stored title, course-local date and course", shown[0].text,
      "Moved it.\n\nSaved in Nexus:\n• Updated: “Research Proposal” — due Mon, Nov 2, 2026, 11:59 PM EST — MGT-782");
    // H15: no write call this turn -> nothing to build; the ABSENCE of the code-built list is the owner's signal.
    shown = presentNexusWriteTurn([{ agentId: "elle-rowan", text: "I've added your Research Proposal to Nexus." }], []);
    t("L3-H15 no write call: the reply is untouched and carries NO code-built list (documented residual)", `${shown[0].text}/${shown[0].text.includes("Saved in Nexus")}`, "I've added your Research Proposal to Nexus./false");
    // A duplicate wrote nothing new -> failure mode (the literal rule: it did not persist).
    resetStore();
    const dup = await exec([{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30" }]);
    shown = presentNexusWriteTurn([{ agentId: "elle-rowan", text: "Added!" }], [{ agentId: "elle-rowan", tool: N, ok: false, detail: JSON.stringify(dup) }]);
    t("L3-H16 a duplicate (nothing new written) -> the code-built message, with the stored date and course", shown[0].text.split("\n")[1],
      "• Already in Nexus, nothing new added: “Research Proposal” — due Fri, Oct 30, 2026, 11:59 PM EDT — MGT-782");
    // In flight: a write that has STARTED but not returned is `unknown` -- nothing presented meanwhile can claim it.
    const inflight = [{ agentId: "elle-rowan", tool: N, ok: false, detail: JSON.stringify(nexusWriteInFlightOutcome({ items: [{ title: "Research Proposal" }] })) }];
    shown = presentNexusWriteTurn([{ agentId: "elle-rowan", text: "Done, it's saved!" }], inflight);
    t("L3-H17 a write still in flight -> 'Unknown — check Nexus', the claim is not shown", shown[0].text.split("\n")[1], "• Unknown — check Nexus: “Research Proposal” (the request did not confirm whether it saved)");

    // D11: the write results ride the resume state, so a LATER chunk's teammate is covered.
    const chunk1 = { replies: [{ agentId: "elle-rowan", text: "Adding it." }], nexusWriteUses: FAILED };
    const resumed = JSON.parse(JSON.stringify(chunk1)) as typeof chunk1; // what saveTurnChunk -> resume round-trips
    const chunk2Replies = [...resumed.replies, { agentId: "finn-reid", text: "It's in, Elle got it." }];
    shown = presentNexusWriteTurn(chunk2Replies, resumed.nexusWriteUses);
    t("L3-D11a a teammate in a LATER chunk is held back against an earlier chunk's failed write", `${shown[0].text === MSG}/${shown[1].text === NEXUS_WRITE_WITHHELD_REPLY}`, "true/true");

    // The runtime wiring (huddle.functions.ts: a 8k-line server function -- source-checked, behaviour proved above).
    const fn = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
    t("L3-D11b the resume state type carries the turn's write results", /nexusWriteUses\?: TurnNexusWriteUse\[\];/.test(fn), true);
    t("L3-D11c buildResumeState persists them", /nexusWriteUses: turnNexusWriteUses\.map\(\(u\) => \(\{ \.\.\.u \}\)\),/.test(fn), true);
    t("L3-D11d a resumed chunk re-seeds them", /const turnNexusWriteUses: TurnNexusWriteUse\[\] = \[\.\.\.\(resume\?\.nexusWriteUses \?\? \[\]\)\];/.test(fn), true);
    t("L3-D11e an earlier chunk's SETTLED outcome is handed to an identical later call", /nexusWriteOutcomes\.set\(u\.claimKey, Promise\.resolve\(JSON\.parse\(u\.detail\)/.test(fn), true);
    t("L3-D11f the write is recorded as IN FLIGHT before it runs, then replaced by its result",
      /turnNexusWriteUses\.push\(writeUse\);\s*\n\s*const pending = runWrite\(\);[\s\S]{0,700}Object\.assign\(writeUse, \{ ok, detail: JSON\.stringify\(out\) \}\);/.test(fn) && /detail: JSON\.stringify\(nexusWriteInFlightOutcome\(writeArgs\)\), claimKey \};/.test(fn), true);
    for (const [label, re] of [
      ["the 1:1 stream", /updateTurnReplies\(\s*turnId!,\s*presentedReplies\(\[\.\.\.replies, \{ agentId: winner\.id, text: full \}\]\),/],
      ["the mid-chunk stream", /updateTurnReplies\(turnId, presentedReplies\(\), buildResumeState\(\)\)/],
      ["the partial chunk save", /saveTurnChunk\(turnId, presentedReplies\(\), buildResumeState\(\), false\)/],
      ["the final chunk save", /saveTurnChunk\(turnId, presentedReplies\(\), null, true, finalResult\(\)\)/],
      ["the final result", /replies: presentedReplies\(\),/],
      ["the prior shown to later agents", /presentedReplies\(\)\.map\(\(rep\) => `\$\{AGENT_BY_ID\[rep\.agentId\]\.name\} just said/],
      ["memory", /const finalReplies = presentedReplies\(\);/],
    ] as Array<[string, RegExp]>) {
      t(`L3-D10w every exit is presented: ${label}`, re.test(fn), true);
    }
    t("L3-D10x no exit leaks the RAW replies (no saveTurnChunk/updateTurnReplies(turnId, replies, …))", /(?:saveTurnChunk|updateTurnReplies)\(turnId, replies,/.test(fn), false);
    // No word list on any runtime path: the loop-2 sentence filter is gone, the clause parser has no runtime caller.
    const shared = readFileSync("src/features/huddle/lib/nexus/nexus-write-shared.ts", "utf8");
    t("L3-H0b the WRITE_TALK sentence filter is deleted", /const WRITE_TALK|function mentionsItem/.test(shared), false);
    const runtimeCallers = ["src/features/huddle/lib/huddle.functions.ts", "src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts", "src/features/huddle/lib/voice/realtime-tools.server.ts", "src/features/huddle/lib/nexus/nexus-write.server.ts"]
      .filter((f) => /enforceNexusWriteHonesty\(/.test(readFileSync(f, "utf8")));
    t("L3-H0c enforceNexusWriteHonesty (a word-list parser) has NO runtime caller", runtimeCallers.join(",") || "none", "none");
  }

  console.log("=== D9: voice -- NOTHING is spoken/captioned/persisted while a write is pending; then ONE delivery ===");
  {
    // A simulator that drives the gate EXACTLY as useVoiceCallRealtimeSpeak.ts does (source-pinned by L3-V20..22):
    //   delta      -> pump to speech only while !gate.holding (else it stays in the sentence buffer)
    //   text.done  -> out = gate.finalize(raw); "whole" speaks out.speak alone; otherwise out.speak is appended to
    //                 the stream tail, which is flushed if !gate.holding (else discarded); out.full is persisted
    //   response.done -> gate.flush() delivers results that are in but undelivered
    //   function_call_arguments.done -> noteToolCall; tool result -> noteToolOutput; user utterance -> reset
    const sim = () => {
      const gate = createNexusWriteSpeechGate();
      const spoken: string[] = [];
      const persisted: string[] = [];
      let tail = "";
      return {
        spoken,
        persisted,
        gate,
        call: (name: string) => gate.noteToolCall(name),
        output: (name: string, out: string) => gate.noteToolOutput(name, out),
        user: () => gate.reset(),
        delta: (d: string) => {
          tail += d;
          if (!gate.holding) {
            spoken.push(tail.trim());
            tail = "";
          }
        },
        textDone: (raw: string) => {
          const out = gate.finalize(raw);
          if (out.mode === "whole") {
            tail = "";
            if (out.speak) spoken.push(out.speak);
          } else {
            if (out.speak) tail += `\n\n${out.speak}`;
            if (!gate.holding) {
              if (tail.trim()) spoken.push(tail.trim());
            }
            tail = "";
          }
          if (out.full) persisted.push(out.full);
        },
        responseDone: () => {
          const f = gate.flush();
          if (f) {
            tail = "";
            if (f.speak) spoken.push(f.speak);
            if (f.full) persisted.push(f.full);
          }
        },
      };
    };
    const FAILED_OUT = JSON.stringify({ ok: true, persisted: false, results: [{ index: 0, title: "Research Proposal", action: "failed", persisted: false, error: "http_500" }] });
    const CLEAN_OUT = JSON.stringify({ ok: true, persisted: true, results: [{ index: 0, title: "Research Proposal", action: "inserted", persisted: true, due_local: "Fri, Oct 30, 2026, 11:59 PM EDT", course: { id: "c782", code: "MGT-782", name: null } }] });
    const VMSG = nexusWriteFailureMessage(nexusWriteResultsFrom([{ tool: N, ok: false, detail: FAILED_OUT }]));
    const LIST = "Saved in Nexus:\n• “Research Proposal” — due Fri, Oct 30, 2026, 11:59 PM EDT — MGT-782";
    const R = "get_nexus_assignments";
    const only = (xs: string[], want: string) => xs.length === 1 && xs[0] === want;

    // V-a (the verifier's blocking order): a text.done arrives while the write is in flight.
    let s = sim();
    s.call(N);
    s.delta("Done, I've added the Research Proposal for Oct 30.");
    s.textDone("Done, I've added the Research Proposal for Oct 30.");
    t("L3-V1 V-a: a reply completing while the write is in flight is NOT spoken, captioned or persisted", `${s.spoken.length}/${s.persisted.length}`, "0/0");
    s.output(N, FAILED_OUT);
    s.textDone("I've added it.");
    t("L3-V2 V-a: once the write fails, ONLY the code-built message is spoken and persisted", `${only(s.spoken, VMSG)}/${only(s.persisted, VMSG)}`, "true/true");
    s.textDone("It's definitely in Nexus now.");
    t("L3-V3 ...and nothing else the model says in that exchange is spoken", `${s.spoken.length}/${s.persisted.length}`, "1/1");

    // Order 1: the model calls the write AND a read; the READ returns first and the model answers.
    s = sim();
    s.call(N);
    s.call(R);
    s.output(R, JSON.stringify({ ok: true, count: 2 }));
    s.delta("You have two things due this week. ");
    s.delta("I've also added your proposal.");
    s.textDone("You have two things due this week. I've also added your proposal.");
    t("L3-V4 read-returns-first: the answer is buffered while the write is pending", `${s.spoken.length}/${s.persisted.length}`, "0/0");
    s.output(N, FAILED_OUT);
    s.textDone("Your proposal is saved too.");
    t("L3-V5 read-returns-first + failed write: ONLY the code-built message", `${only(s.spoken, VMSG)}/${only(s.persisted, VMSG)}`, "true/true");
    s = sim();
    s.call(N);
    s.call(R);
    s.output(R, JSON.stringify({ ok: true, count: 2 }));
    s.textDone("You have two things due this week.");
    s.output(N, CLEAN_OUT);
    s.delta("And your proposal is saved.");
    s.textDone("And your proposal is saved.");
    const BOTH = `You have two things due this week. And your proposal is saved.\n\n${LIST}`;
    t("L3-V6 read-returns-first + clean write: buffered text + this text, THEN the code-built list, spoken once", `${only(s.spoken, BOTH)}/${only(s.persisted, BOTH)}`, "true/true");

    // Order 2: the user talks while the write is in flight (a new auto-response).
    s = sim();
    s.call(N);
    s.user();
    s.delta("Sure, and your proposal is in.");
    s.textDone("Sure, and your proposal is in.");
    t("L3-V7 user-talks-mid-write: the reply to the interjection is buffered", `${s.spoken.length}/${s.persisted.length}/${s.gate.holding}`, "0/0/true");
    s.output(N, FAILED_OUT);
    s.textDone("Added!");
    t("L3-V8 ...then ONLY the code-built message", `${only(s.spoken, VMSG)}/${only(s.persisted, VMSG)}`, "true/true");
    t("L3-V9 ...and the deferred reset lands after the delivery (next exchange is clean)", `${s.gate.holding}/${s.gate.uses.length}`, "false/0");
    s.delta("Your budget is fine.");
    s.textDone("Your budget is fine.");
    t("L3-V10 the next exchange (no write) streams as usual", s.spoken[1], "Your budget is fine.");

    // Order 3: a text item AFTER the function call in the same response, then response.done.
    s = sim();
    s.call(N);
    s.delta("Done, saved it!");
    s.textDone("Done, saved it!");
    s.responseDone();
    t("L3-V11 text-after-call: buffered, and response.done does not release it while pending", `${s.spoken.length}/${s.persisted.length}`, "0/0");
    s.output(N, FAILED_OUT);
    s.responseDone(); // the follow-up response was cut short (barge) -- no text.done
    t("L3-V12 results in but the follow-up was cut short: response.done delivers ONLY the message", `${only(s.spoken, VMSG)}/${only(s.persisted, VMSG)}`, "true/true");
    s.textDone("It's saved.");
    t("L3-V13 ...and a late model sentence is still not spoken", `${s.spoken.length}/${s.persisted.length}`, "1/1");

    // V-c: the AC-F2-35 phrase after a failure.
    s = sim();
    s.call(N);
    s.output(N, FAILED_OUT);
    s.textDone("It is on your list for Oct 30.");
    t("L3-V14 V-c: \"It is on your list for Oct 30.\" after a failure -> ONLY the message", `${only(s.spoken, VMSG)}/${only(s.persisted, VMSG)}`, "true/true");

    // Happy path keeps streaming latency: a clean write with nothing buffered releases the hold at its result.
    s = sim();
    s.call(N);
    s.output(N, CLEAN_OUT);
    t("L3-V15 clean write, nothing buffered: not holding once the result is in", s.gate.holding, false);
    s.delta("I've added your Research Proposal.");
    s.textDone("I've added your Research Proposal.");
    t("L3-V16 the reply streams, then the code-built list follows it", JSON.stringify(s.spoken), JSON.stringify(["I've added your Research Proposal.", LIST]));
    t("L3-V17 ...and the persisted text is the reply + the list", only(s.persisted, `I've added your Research Proposal.\n\n${LIST}`), true);

    // Two writes in one exchange, one fails: nothing until BOTH are in, then the message lists both.
    s = sim();
    s.call(N);
    s.call(N);
    s.output(N, CLEAN_OUT);
    s.textDone("The first one is in.");
    t("L3-V18 two writes: still nothing while the second is pending", `${s.spoken.length}/${s.persisted.length}`, "0/0");
    s.output(N, FAILED_OUT);
    s.textDone("Both are in!");
    const TWO = nexusWriteFailureMessage(nexusWriteResultsFrom([{ tool: N, ok: false, detail: CLEAN_OUT }, { tool: N, ok: false, detail: FAILED_OUT }]));
    t("L3-V19 ...then ONLY the message, listing the saved one AND the failed one", `${only(s.spoken, TWO)}/${TWO.includes("• Saved: “Research Proposal”") && TWO.includes("• Not saved: “Research Proposal”")}`, "true/true");

    const hook = readFileSync("src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts", "utf8");
    t("L3-V20 hook text.done: finalize -> 'whole' speaks out.speak alone, else appends it to the tail and flushes only while not holding",
      /const out = gate\.finalize\(raw\);\s*\n\s*if \(out\.mode === "whole"\) \{\s*\n\s*sentenceBufRef\.current = "";\s*\n\s*if \(agentIdRef\.current && out\.speak\) void speak\(out\.speak, agentIdRef\.current, gen\);\s*\n\s*\} else if \(agentIdRef\.current\) \{\s*\n\s*if \(out\.speak\) sentenceBufRef\.current \+= `\\n\\n\$\{out\.speak\}`;\s*\n\s*if \(!gate\.holding\) pumpSpeech\(agentIdRef\.current, gen, true\);\s*\n\s*else sentenceBufRef\.current = "";/.test(hook), true);
    t("L3-V21 hook persists/captions out.full only", /if \(out\.full && agentIdRef\.current\) \{[\s\S]{0,250}persist\("agent", agentIdRef\.current, out\.full\);/.test(hook), true);
    t("L3-V22 hook response.done flushes undelivered results", /case "response\.done": \{[\s\S]{0,400}const flushed = nexusGateRef\.current\.flush\(\);[\s\S]{0,500}persist\("agent", agentIdRef\.current, flushed\.full\);/.test(hook), true);
    t("L3-V23 hook deltas are pumped only while the gate is not holding", /if \(!nexusGateRef\.current\.holding\) pumpSpeech\(agentIdRef\.current, gen, false\);/.test(hook), true);
  }
};

await main();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
