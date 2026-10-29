// WHAT:       (loop 4, docs/FIX-nexus-write-loop4.md: + D13/D13-ovr rows vs origin/main, warm+cold, and the M0 primeHint
//             opt-in -- chat hand-off only, never grooming/task creation.) D12 of the independent verifier's loop-3 report, pinned as tests: other lanes' asks that name one of
//             the owner's REAL courses (warm course list) or "my professor/instructor" (cold cache, weak signals)
//             keep their origin/main routing -- group leader, 1:1 lane owner -- and make NO deterministic prime
//             hand-off / follow-up DM. Plus the coursework asks that must stay with Elle/Iris, and (A) the
//             additive, data-built "prime owners" hint reaching BOTH LLM routers (group router, 1:1 resolver).
// WHY:        docs/VERIFY-nexus-write-tool-3.md D12: 13 deterministic lane steals (email, dinner, budget, car,
//             lodging, calendar, reminder, runs) -- BLOCKING, moderate-high likelihood; F2-45 NOT MET.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-routing.md (RESPONDS TO VERIFY-nexus-write-tool-3.md D12). The origin/main
//             baselines below are MEASURED (`bun mut-routing-prime/probe-d12.ts <git archive origin/main>`,
//             mut-routing-prime/probe-d12.main.out), not typed.
//
// OFFLINE ONLY: `fetch` is replaced by an in-memory fake OpenAI that records the prompt and returns a fixed
// decision. Nothing reaches OpenAI, Nexus, Huddle, a DB or the board.
// Run: bun scripts/nexus-write-routing.test.ts

import { readFileSync } from "node:fs";
import { routeMessage, routeMessageLLM, resolveOwnerLLM, laneOwnerFor, primeLaneDecision } from "../src/features/huddle/lib/routing";
import { capabilityExplicitOverride, sharedCapabilityHolders, primeOwnershipDirectory } from "../src/features/huddle/lib/capabilities";
// D13 (docs/FIX-nexus-write-loop4.md, owner decision): a NON-holder hands coursework to Elle/Iris deterministically
// ONLY on an explicit write to Nexus; every other coursework ask takes the ordinary 1:1 owner path (origin/main).
const ovrOf = (text: string) => sharedCapabilityHolders(text).some((h) => capabilityExplicitOverride(h.cap, text));
import { AGENTS, type AgentId } from "../src/features/huddle/data/agents";
import { setNexusCourseContext } from "../src/features/huddle/lib/nexus/course-context";

let pass = 0;
let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want);
  console.log(`  ${ok ? "ok" : "not ok"} ${name}: ${String(got)}${ok ? "" : `  (EXPECTED ${String(want)})`}`);
  ok ? pass++ : fail++;
};

const ALL_IDS = AGENTS.map((a) => a.id) as AgentId[];
const PRIME = new Set<string>(
  AGENTS.filter((a) => (a.capabilities ?? []).some((c) => c.id === "nexus-assignments")).map((a) => a.id),
);
// The owner's REAL course rows as Nexus holds them (the verifier's probe fixture, nexus-hub docs).
const REAL_COURSES = [
  { code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" },
  { code: "MGT-702-W1 (202711)", name: "MGT-702-W1 (202711)" },
  { code: "MGT-701-W1 (202712)", name: "MGT-701-W1-Becoming an Applied Researcher (202712)" },
  { code: "EMBA694", name: "EMBA694 Operations Management" },
];
const CACHES: Array<[string, () => void]> = [
  ["warm", () => setNexusCourseContext(REAL_COURSES)],
  ["cold", () => setNexusCourseContext(null)],
];
const lead = (text: string) =>
  String(routeMessage({ text, scope: "group", members: ALL_IDS, history: [] } as Parameters<typeof routeMessage>[0]).winners[0]);

async function main() {
  console.log("=== prime capability holders are data (agents.ts) ===");
  t("R-PRIME the nexus-assignments holders", [...PRIME].sort().join(","), "elle-rowan,iris-chase");

  console.log("=== D12: other lanes' course-mentioning asks keep origin/main routing; no prime hand-off/DM ===");
  {
    // [veto group, ask, addressed agent in the 1:1, group leader on origin/main, laneOwnerFor(ask, addressed) on
    // origin/main]. The verifier's 14 D12 rows + its 5 weak (cold-cache) rows + extras per veto group.
    const D12: Array<[string, string, AgentId, string, string]> = [
      ["email", "email my professor that my MGT-782 paper will be a day late", "cam-post", "cam-post", "null"],
      ["email", "draft an email to my MGT-782 group about the proposal deadline", "cam-post", "elle-rowan", "null"],
      ["email", "email my professor that my paper will be a day late", "cam-post", "cam-post", "null"],
      ["email", "draft an email to my instructor asking for an extension on the essay deadline", "cam-post", "elle-rowan", "elle-rowan"],
      ["email", "message my MGT-782 professor that the essay will be late", "cam-post", "elle-rowan", "elle-rowan"],
      ["email-pattern", "write to my professor that my MGT-782 paper will be late", "cam-post", "elle-rowan", "null"],
      ["email-pattern", "text my instructor that I need more time on the essay deadline", "cam-post", "elle-rowan", "elle-rowan"],
      ["calendar", "block two hours on my calendar Thursday for the MGT-782 paper", "eli-vaughn", "iris-chase", "null"],
      ["calendar", "schedule focus time before my MGT-782 essay deadline", "eli-vaughn", "elle-rowan", "elle-rowan"],
      ["calendar", "block two hours on my calendar Thursday for my research paper deadline", "eli-vaughn", "elle-rowan", "null"],
      ["calendar", "put study time on my calendar before the MGT-702 exam", "eli-vaughn", "iris-chase", "null"],
      ["reminder", "remind me tomorrow at 9 that the MGT-782 paper is due", "eli-vaughn", "iris-chase", "null"],
      ["reminder", "remind me tomorrow at 9 that my essay deadline is Friday", "eli-vaughn", "elle-rowan", "elle-rowan"],
      ["reminder", "set a reminder for the MGT-702 final paper deadline", "eli-vaughn", "elle-rowan", "null"],
      ["dining", "book a table for my MGT-782 study group after the exam Friday", "charleston-lewis", "iris-chase", "null"],
      ["dining", "pick a restaurant for dinner after my MGT-782 exam", "charleston-lewis", "charleston-lewis", "null"],
      ["dining", "pick a restaurant for dinner with my professor after the exam", "charleston-lewis", "charleston-lewis", "null"],
      ["dining", "where should I eat lunch before my EMBA694 exam", "charleston-lewis", "elle-rowan", "null"],
      ["car", "rent a car for the MGT-701 residency weekend, it's due back Sunday", "troy-lennox", "ezra-miles", "null"],
      ["car", "get me a rental car for the MGT-782 residency, the deadline to book is Friday", "troy-lennox", "elle-rowan", "null"],
      ["car-pattern", "drive me to campus for my MGT-782 exam Friday", "troy-lennox", "iris-chase", "null"],
      ["lodging", "I need an Airbnb in Toronto for the EMBA694 residency, the deadline to book is Friday", "troy-lennox", "elle-rowan", "elle-rowan"],
      ["lodging", "find me lodging near campus for the MGT-782 residency, deadline to book is Friday", "troy-lennox", "elle-rowan", "null"],
      ["lodging-pattern", "find a place to stay for the MGT-701 residency, the deadline is Friday", "troy-lennox", "elle-rowan", "null"],
      ["money", "the EMBA694 textbook payment is due Friday, can I afford it", "finn-reid", "elle-rowan", "null"],
      ["money", "budget for the MGT-701 residency costs, the deposit is due Monday", "finn-reid", "finn-reid", "null"],
      ["money", "pay my EMBA694 tuition before the deadline", "finn-reid", "elle-rowan", "elle-rowan"],
      ["money", "buy the MGT-782 textbook before the exam", "finn-reid", "iris-chase", "null"],
      ["money-pattern", "what will the MGT-701 residency cost, the paper is due the same week", "finn-reid", "tess-sutton", "null"],
      ["fitness", "plan my runs around the MGT-782 exam week", "flex-grimes", "iris-chase", "null"],
      ["fitness", "build a training plan around my MGT-782 exam", "flex-grimes", "flex-grimes", "null"],
      ["fitness-pattern", "I want to go for a run before my MGT-782 exam", "flex-grimes", "flex-grimes", "null"],
      ["travel", "book my travel to the MGT-701 residency, the deadline is Friday", "troy-lennox", "troy-lennox", "null"],
      ["travel", "book a flight for the EMBA694 residency before the deadline", "troy-lennox", "elle-rowan", "null"],
    ];
    for (const [cache, prime] of CACHES) {
      prime();
      for (const [group, text, self, mainLead, mainLane] of D12) {
        const id = `R12-${group} ${cache}`;
        t(`${id} "${text}" matches NO coursework prime capability`, sharedCapabilityHolders(text).length, 0);
        t(`${id} group "${text}" -> origin/main leader`, lead(text), mainLead);
        const handoffs = ALL_IDS.map((a) => primeLaneDecision(text, a)).filter((x) => x !== null);
        t(`${id} 1:1 with ANY agent: "${text}" makes no prime hand-off / follow-up DM`, handoffs.length, 0);
        t(`${id} 1:1 ${self}: "${text}" -> origin/main lane`, laneOwnerFor(text, self)?.id ?? "null", mainLane);
        const one = routeMessage({
          text, scope: "one-to-one", members: [self], history: [], targetAgentId: self,
        } as Parameters<typeof routeMessage>[0]);
        t(`${id} 1:1 ${self} answers "${text}" itself`, one.winners.join(","), self);
      }
    }
  }

  console.log("=== coursework (add/update his Nexus assignments) still goes to Elle/Iris ===");
  {
    // warm: every ask is coursework. cold: only the ones carrying non-course-list context (Nexus as the app,
    // syllabus, professor + add, a deliverable + "due date") -- a bare course code is no context without the list.
    const CW: Array<[string, string, boolean]> = [
      ["R-CW-nexus", "add the MGT-701 research proposal due Dec 1 to Nexus", true],
      ["R-CW-code", "my MGT-782 paper is due Friday", false],
      ["R-CW-prof", "my professor wants the case study by Friday, can you add it", true],
      ["R-CW-cost", "add the MGT-782 cost-benefit analysis paper due Friday to Nexus", true],
      ["R-CW-drive", "upload the MGT-702 syllabus from my Google Drive to Nexus", true],
      ["R-CW-gdrive", "add the MGT-782 deadlines from the syllabus on my Google Drive to my assignments", true],
      ["R-CW-drive-nexus", "import the MGT-702 syllabus from Drive to Nexus", true],
      ["R-CW-calendar", "the course calendar in my MGT-782 syllabus has the paper due Dec 9, add it", true],
      ["R-CW-update", "update the due date on my MGT-782 essay to Friday", true],
      ["R-CW-brief", "add my EMBA694 case brief due Nov 20", false],
      ["R-CW-stay", "stay on top of my MGT-782 assignments, add the essay due Friday", false],
      ["R-CW-run", "add the MGT-782 regression analysis paper due Friday, I still need to run the model", false],
    ];
    for (const [cache, prime] of CACHES) {
      prime();
      for (const [id, text, coldToo] of CW) {
        if (cache === "cold" && !coldToo) continue;
        t(`${id} ${cache} group "${text}" is led by Elle/Iris`, PRIME.has(lead(text)), true);
        t(
          `${id} ${cache} 1:1 Elle/Iris keep "${text}"`,
          `${primeLaneDecision(text, "elle-rowan")}/${primeLaneDecision(text, "iris-chase")}`,
          "keep/keep",
        );
        t(`${id} ${cache} 1:1 Finn: "${text}" -> Elle/Iris only on an explicit Nexus write, else no prime hand-off (D13)`, ovrOf(text) ? PRIME.has(String(primeLaneDecision(text, "finn-reid" as AgentId))) : primeLaneDecision(text, "finn-reid" as AgentId) === null, true);
      }
    }
    setNexusCourseContext(REAL_COURSES);
  }

  console.log("=== Explicit Nexus override (2026-10-29): an explicit '… to/in/into Nexus' write beats the vetoes ===");
  {
    const cap = AGENTS.flatMap((a) => a.capabilities ?? []).find((c) => c.id === "nexus-assignments");
    t("R-X-data the override is DATA on the capability (explicitOverride)", (cap?.requiresContext?.explicitOverride ?? []).length > 0, true);
    const capSrc = readFileSync("src/features/huddle/lib/capabilities.ts", "utf8");
    t(
      "R-X-order capabilityContextPresent checks explicitOverride BEFORE the vetoes",
      /if \(anyPattern\(ctx\.explicitOverride\)\) return true;\s*\n\s*if \(anyWord\(ctx\.vetoes\) \|\| anyPattern\(ctx\.vetoPatterns\)\) return false;/.test(capSrc),
      true,
    );
    t("R-X-hint the routers' hint says an explicit Nexus write is theirs", String(cap?.routerHint).includes("An EXPLICIT request to add, put, log, save, update, change, move or reschedule something TO, IN or INTO Nexus"), true);
    // [ask, a non-holder addressed in a 1:1]. Every ask carries another lane's veto word (email, travel, Airbnb,
    // hotel, budget(ing), flight, dinner, client, fitness, tax, restaurant): on the PR head before this change all
    // were vetoed (holders=0) -- mut-explicit-override/probe-override.before.out.
    const POS: Array<[string, AgentId]> = [
      ["add the MGT-782 email marketing case analysis to Nexus", "cam-post"],
      ["put my travel industry essay due Nov 3 into Nexus", "troy-lennox"],
      ["update the Airbnb pricing case study due date in Nexus", "troy-lennox"],
      ["can you add my hotel management essay to Nexus", "troy-lennox"],
      ["please reschedule the budgeting case study to Dec 2 in Nexus", "finn-reid"],
      ["add the flight operations essay to my Nexus assignments", "troy-lennox"],
      ["set the travel essay due date to Friday in Nexus", "troy-lennox"],
      ["record my dinner etiquette essay due Nov 10 into Nexus", "charleston-lewis"],
      ["change the client presentation paper deadline in Nexus to Monday", "sam-trent"],
      ["save the email marketing paper to my Nexus", "cam-post"],
      ["enter the fitness industry case study into Nexus", "flex-grimes"],
      ["move my hotel case study to Dec 4 in Nexus", "troy-lennox"],
      ["log the tax accounting paper due Friday in Nexus", "finn-reid"],
      ["hey Elle, add my airline pricing essay to Nexus", "cam-post"],
      ["I need you to put the restaurant case study into Nexus", "charleston-lewis"],
    ];
    // [guard, ask, addressed agent, origin/main group leader, origin/main laneOwnerFor(ask, addressed)] -- MEASURED:
    // mut-explicit-override/probe-override.main.out (origin/main ee8f7b6), identical warm and cold.
    const NEG: Array<[string, string, AgentId, string, string]> = [
      ["card", "renew my NEXUS card before the deadline", "troy-lennox", "elle-rowan", "null"],
      ["card", "update the address on my NEXUS card", "troy-lennox", "eli-vaughn", "eli-vaughn"],
      ["card", "add my NEXUS card renewal fee to my budget", "finn-reid", "finn-reid", "null"],
      ["card", "add the renewal date to my NEXUS card", "troy-lennox", "iris-chase", "null"],
      ["program", "update the interview date in my NEXUS program", "troy-lennox", "cole-blake", "cole-blake"],
      ["program", "my NEXUS program application deadline is Friday", "troy-lennox", "elle-rowan", "elle-rowan"],
      ["program", "move my NEXUS program interview to Friday", "troy-lennox", "cole-blake", "cole-blake"],
      ["apply", "apply to NEXUS for me before my Toronto trip", "troy-lennox", "troy-lennox", "null"],
      ["apply", "should I apply to NEXUS before the deadline", "troy-lennox", "elle-rowan", "null"],
      ["trusted", "update my address in NEXUS trusted traveler before the deadline", "troy-lennox", "troy-lennox", "null"],
      ["trusted", "add my kid to NEXUS trusted traveler", "troy-lennox", "troy-lennox", "null"],
      ["fitness", "can you log my 5k run to Nexus fitness tracker by the deadline", "flex-grimes", "elle-rowan", "null"],
      ["email", "email my professor about Nexus", "cam-post", "cam-post", "null"],
      ["email", "email my professor about the essay I put in Nexus", "cam-post", "elle-rowan", "elle-rowan"],
      ["email", "email my professor that I will add the MGT-782 essay to Nexus tonight", "cam-post", "elle-rowan", "elle-rowan"],
      ["down", "is Nexus down", "cam-post", "iris-chase", "null"],
      ["down", "is Nexus down again? I can't add the travel essay", "cam-post", "troy-lennox", "troy-lennox"],
      ["question", "when is my travel essay due in Nexus", "troy-lennox", "troy-lennox", "null"],
      ["question", "did the email marketing paper make it into Nexus", "cam-post", "cam-post", "null"],
      ["nexus-of", "update my travel essay to the nexus of airlines and hotels", "troy-lennox", "troy-lennox", "null"],
      ["nexus-of", "add a paragraph on the nexus of travel and pricing to my essay", "troy-lennox", "troy-lennox", "null"],
    ];
    for (const [cache, prime] of CACHES) {
      prime();
      for (const [text, other] of POS) {
        const id = `R-X ${cache}`;
        t(`${id} "${text}" -> holders are Elle/Iris`, sharedCapabilityHolders(text).map((h) => h.agent.id).sort().join(","), "elle-rowan,iris-chase");
        t(`${id} group "${text}" is led by Elle/Iris`, PRIME.has(lead(text)), true);
        t(`${id} 1:1 Elle/Iris keep "${text}" (no hand-off away)`, `${primeLaneDecision(text, "elle-rowan")}/${primeLaneDecision(text, "iris-chase")}`, "keep/keep");
        t(`${id} 1:1 Elle/Iris: laneOwnerFor is null (they answer it)`, `${laneOwnerFor(text, "elle-rowan")?.id ?? "null"}/${laneOwnerFor(text, "iris-chase")?.id ?? "null"}`, "null/null");
        t(`${id} 1:1 Cam hands "${text}" to Elle/Iris`, PRIME.has(String(laneOwnerFor(text, "cam-post" as AgentId)?.id)), true);
        t(`${id} 1:1 ${other} hands "${text}" to Elle/Iris`, PRIME.has(String(laneOwnerFor(text, other)?.id)), true);
      }
      for (const [guard, text, self, mainLead, mainLane] of NEG) {
        const id = `R-XN-${guard} ${cache}`;
        t(`${id} "${text}" matches NO coursework prime capability`, sharedCapabilityHolders(text).length, 0);
        t(`${id} group "${text}" -> origin/main leader`, lead(text), mainLead);
        const handoffs = ALL_IDS.map((a) => primeLaneDecision(text, a)).filter((x) => x !== null);
        t(`${id} 1:1 with ANY agent: "${text}" makes no prime hand-off / follow-up DM`, handoffs.length, 0);
        t(`${id} 1:1 ${self}: "${text}" -> origin/main lane`, laneOwnerFor(text, self)?.id ?? "null", mainLane);
        const one = routeMessage({
          text, scope: "one-to-one", members: [self], history: [], targetAgentId: self,
        } as Parameters<typeof routeMessage>[0]);
        t(`${id} 1:1 ${self} answers "${text}" itself`, one.winners.join(","), self);
      }
    }
    setNexusCourseContext(REAL_COURSES);
  }

  console.log("=== D13 / D13-ovr (loop 4): 1:1 matches origin/main unless the ask is an EXPLICIT Nexus write of an assignment ===");
  {
    // docs/VERIFY-nexus-write-tool-4.md D13 (18 lane-vocabulary steals) + D13-ovr (O3 O4 O8) + the override-adjacent
    // rows O1 O2 O11 O15. Owner decision (docs/FIX-nexus-write-loop4.md): the coursework rule keeps deciding the GROUP
    // leader; in a 1:1 with a non-holder the deterministic hand-off fires ONLY on the explicit override.
    const D13: Array<[string, string, AgentId, string, string, string, string, string]> = [
    // [tag, ask, addressed, origin/main laneOwnerFor (warm=cold), group warm, group cold, origin/main group warm, origin/main group cold]
    // GENERATED from mut-loop4/measure-d13.{main,fixed}.out (bun mut-loop4/measure-d13.ts <tree>), not typed. The group
    // columns of O1 O2 O3 L8 S11 S12 re-measured after the group-veto rows fix: mut-group-veto/measure-d13.after.out
    // (every row's group, lane and hand-offs now identical to measure-d13.main.out, warm and cold).
    ["O1", "update my address in NEXUS before my next border crossing", "troy-lennox", "eli-vaughn", "eli-vaughn", "eli-vaughn", "eli-vaughn", "eli-vaughn"],
    ["O2", "reschedule my interview in NEXUS, I can't make the 14th", "troy-lennox", "cole-blake", "cole-blake", "cole-blake", "cole-blake", "cole-blake"],
    ["O3", "change my vehicle info in my NEXUS account", "troy-lennox", "null", "ezra-miles", "ezra-miles", "ezra-miles", "ezra-miles"],
    ["O4", "add my new passport number to NEXUS", "troy-lennox", "null", "iris-chase", "iris-chase", "iris-chase", "iris-chase"],
    ["O8", "set a reminder to log into Nexus tonight and check my grades", "eli-vaughn", "null", "terry-locke", "terry-locke", "terry-locke", "terry-locke"],
    ["O11", "Finn, add the EMBA694 textbook cost to Nexus", "finn-reid", "null", "elle-rowan", "elle-rowan", "elle-rowan", "elle-rowan"],
    ["O15", "save my flight confirmation to Nexus", "troy-lennox", "null", "troy-lennox", "troy-lennox", "troy-lennox", "troy-lennox"],
    ["L3", "book a room near campus for the MGT-701 residency, deadline is Friday", "troy-lennox", "null", "elle-rowan", "elle-rowan", "elle-rowan", "elle-rowan"],
    ["L4", "get me a ride to the MGT-782 exam on Friday", "troy-lennox", "null", "iris-chase", "iris-chase", "iris-chase", "iris-chase"],
    ["L6", "order the MGT-782 textbook, it is due to arrive before the exam", "finn-reid", "null", "iris-chase", "iris-chase", "iris-chase", "iris-chase"],
    ["L8", "plan my meals for MGT-782 exam week", "charleston-lewis", "null", "charleston-lewis", "charleston-lewis", "charleston-lewis", "charleston-lewis"],
    ["L10", "put the MGT-782 exam on the calendar for Friday", "eli-vaughn", "null", "iris-chase", "iris-chase", "iris-chase", "iris-chase"],
    ["L12", "find a babysitter for the MGT-701 residency weekend, deadline Friday", "charleston-lewis", "null", "elle-rowan", "elle-rowan", "elle-rowan", "elle-rowan"],
    ["L13", "send my MGT-782 group the slides before the deadline", "cam-post", "null", "elle-rowan", "elle-rowan", "elle-rowan", "elle-rowan"],
    ["L14", "DM my MGT-782 group that the proposal deadline moved", "cam-post", "null", "elle-rowan", "elle-rowan", "elle-rowan", "elle-rowan"],
    ["S1", "put my MGT-782 exam on the calendar", "eli-vaughn", "null", "iris-chase", "iris-chase", "iris-chase", "iris-chase"],
    ["S2", "add the MGT-782 final exam to the calendar, it's Dec 12", "eli-vaughn", "null", "iris-chase", "iris-chase", "iris-chase", "iris-chase"],
    ["S4", "can you get the MGT-782 exam onto my schedule", "eli-vaughn", "null", "iris-chase", "iris-chase", "iris-chase", "iris-chase"],
    ["S5", "share the slides with my MGT-782 group before Friday's deadline", "cam-post", "null", "elle-rowan", "elle-rowan", "elle-rowan", "elle-rowan"],
    ["S6", "send the MGT-782 group my draft before the deadline", "cam-post", "elle-rowan", "elle-rowan", "elle-rowan", "elle-rowan", "elle-rowan"],
    ["S7", "reply to my MGT-782 professor about the exam", "cam-post", "null", "elle-rowan", "elle-rowan", "elle-rowan", "elle-rowan"],
    ["S8", "book a room for the MGT-701 residency, it's due by Friday", "troy-lennox", "null", "iris-chase", "iris-chase", "iris-chase", "iris-chase"],
    ["S9", "I need a ride to my MGT-782 exam", "troy-lennox", "null", "iris-chase", "iris-chase", "iris-chase", "iris-chase"],
    ["S10", "order the EMBA694 textbook before the exam", "finn-reid", "null", "elle-rowan", "elle-rowan", "elle-rowan", "elle-rowan"],
    ["S11", "meal prep for my MGT-782 exam week", "charleston-lewis", "null", "charleston-lewis", "charleston-lewis", "charleston-lewis", "charleston-lewis"],
    ["S12", "what should I cook the night before my MGT-782 exam", "charleston-lewis", "null", "tess-sutton", "tess-sutton", "tess-sutton", "tess-sutton"],
    ["S14", "stretch routine before my MGT-782 exam", "flex-grimes", "null", "iris-chase", "iris-chase", "iris-chase", "iris-chase"],
    ];
    for (const [cache, prime] of CACHES) {
      prime();
      for (const [tag, text, self, mainLane, gWarm, gCold, mainGWarm, mainGCold] of D13) {
        const id = `R13-${tag} ${cache}`;
        const g = cache === "warm" ? gWarm : gCold;
        const mainG = cache === "warm" ? mainGWarm : mainGCold;
        // GROUP: the hard coursework rule decides (owner); where that differs from origin/main the name says so.
        t(`${id} group "${text}" -> ${g}${g === mainG ? " (= origin/main)" : ` (coursework group rule; origin/main ${mainG})`}`, lead(text), g);
        // Group-veto rows fix (docs/FIX-nexus-write-loop4.md): ALL 27 rows lead the GROUP exactly as origin/main does.
        t(`${id} group "${text}" = origin/main leader ${mainG}`, lead(text), mainG);
        // 1:1: no deterministic prime hand-off from ANY non-holder (holders may only "keep").
        const handoffs = ALL_IDS.map((a) => primeLaneDecision(text, a)).filter((x) => x !== null && x !== "keep");
        t(`${id} 1:1 with ANY agent: "${text}" makes no deterministic prime hand-off / follow-up DM`, handoffs.length, 0);
        t(`${id} 1:1 ${self}: "${text}" directive lane = origin/main laneOwnerFor`, laneOwnerFor(text, self)?.id ?? "null", mainLane);
        t(`${id} 1:1 ${self}: "${text}" is NOT an explicit Nexus override`, sharedCapabilityHolders(text).some((h) => capabilityExplicitOverride(h.cap, text)), false);
        const one = routeMessage({
          text, scope: "one-to-one", members: [self], history: [], targetAgentId: self,
        } as Parameters<typeof routeMessage>[0]);
        t(`${id} 1:1 ${self} answers "${text}" itself`, one.winners.join(","), self);
      }
    }
    setNexusCourseContext(REAL_COURSES);

    // Group-veto rows (docs/FIX-nexus-write-loop4.md, "Group-veto rows"): the 6 rows whose GROUP leader used to differ
    // from origin/main. The coursework capability must not match them at all (warm or cold), so the group falls back to
    // origin/main's keyword leader: O1/O2/O3 via the NEXUS-program clause veto (NEXUS_PROGRAM_WORDS), L8/S11/S12 via the
    // dining / food veto group. [tag, ask, origin/main leader warm, origin/main leader cold] -- from the D13 table above.
    const G6 = D13.filter(([tag]) => ["O1", "O2", "O3", "L8", "S11", "S12"].includes(tag));
    t("R13-G6 the six group-veto rows are all present in the D13 table", G6.map(([tag]) => tag).join(","), "O1,O2,O3,L8,S11,S12");
    for (const [cache, prime] of CACHES) {
      prime();
      for (const [tag, text, , , , , mainGWarm, mainGCold] of G6) {
        const mainG = cache === "warm" ? mainGWarm : mainGCold;
        t(`R13-G6-${tag} ${cache} "${text}" matches NO coursework prime capability`, sharedCapabilityHolders(text).length, 0);
        t(`R13-G6-${tag} ${cache} group "${text}" -> origin/main ${mainG}`, lead(text), mainG);
      }
    }
    setNexusCourseContext(REAL_COURSES);

    // D13-ovr: the override needs a write verb + an ASSIGNMENT OBJECT + to/in/into Nexus. DATA on the capability.
    const cap = AGENTS.flatMap((a) => a.capabilities ?? []).find((c) => c.id === "nexus-assignments")!;
    t("R13-ovr-data the capability's 1:1 hand-off is DATA: oneToOneHandoff = explicit-override", cap.oneToOneHandoff, "explicit-override");
    const OVR_NEG = [
      "add my new passport number to NEXUS",
      "change my vehicle info in my NEXUS account",
      "set a reminder to log into Nexus tonight and check my grades",
      "save my flight confirmation to Nexus",
      "Finn, add the EMBA694 textbook cost to Nexus",
      "update my address in NEXUS before my next border crossing",
      "reschedule my interview in NEXUS, I can't make the 14th",
      "add my phone number to my Nexus profile",
      "log into Nexus and check my grades",
      "put my new email address in Nexus",
    ];
    for (const text of OVR_NEG) t(`R13-ovr-neg "${text}" is NOT an explicit override (no assignment object)`, capabilityExplicitOverride(cap, text), false);
    // Each listed assignment noun, in the same carrier sentences, IS an override (owner's list, 2026-10-29).
    const NOUNS = [
      "assignment", "paper", "essay", "proposal", "case", "case study", "case analysis", "analysis", "memo", "reflection",
      "post", "quiz", "exam", "project", "presentation", "problem set", "deliverable", "brief", "review", "report", "due date",
      "assignments", "case studies", "quizzes", "problem sets",
    ];
    for (const n of NOUNS) {
      t(`R13-ovr-pos "add the MGT-782 ${n} to Nexus" IS an explicit override`, capabilityExplicitOverride(cap, `add the MGT-782 ${n} to Nexus`), true);
      t(`R13-ovr-pos "update my ${n} in my Nexus" IS an explicit override`, capabilityExplicitOverride(cap, `update my ${n} in my Nexus`), true);
    }
    // The verifier's intended overrides still hand off deterministically from a non-holder in a 1:1.
    const OVR_POS: Array<[string, AgentId]> = [
      ["put the MGT-782 email marketing case analysis due Nov 3 into Nexus", "cam-post"],
      ["hey Troy, please add the travel industry essay due Nov 3 to my Nexus", "troy-lennox"],
      ["add the MGT-701 research proposal due Dec 1 to Nexus", "troy-lennox"],
      ["update the due date of my research paper in Nexus to Dec 9", "cam-post"],
      ["add the flight operations essay to my Nexus assignments", "troy-lennox"],
    ];
    for (const [cache, prime] of CACHES) {
      prime();
      for (const [text, self] of OVR_POS) {
        t(`R13-ovr-hand ${cache} "${text}" IS an explicit override`, capabilityExplicitOverride(cap, text), true);
        t(`R13-ovr-hand ${cache} 1:1 ${self} hands "${text}" to Elle/Iris deterministically`, PRIME.has(String(primeLaneDecision(text, self))), true);
        t(`R13-ovr-hand ${cache} 1:1 Elle/Iris keep "${text}"`, `${primeLaneDecision(text, "elle-rowan")}/${primeLaneDecision(text, "iris-chase")}`, "keep/keep");
        t(`R13-ovr-hand ${cache} group "${text}" is led by Elle/Iris`, PRIME.has(lead(text)), true);
      }
    }
    setNexusCourseContext(REAL_COURSES);
    // Coursework (non-override) asks addressed to Elle/Iris stay with them (unchanged); to anyone else: no deterministic
    // hand-off -- the ordinary 1:1 owner path decides, as on origin/main.
    for (const text of ["my MGT-782 paper is due Friday", "update the due date on my MGT-782 essay to Friday", "put my MGT-782 exam on the calendar"]) {
      t(`R13-cw "${text}": Elle/Iris keep`, `${primeLaneDecision(text, "elle-rowan")}/${primeLaneDecision(text, "iris-chase")}`, "keep/keep");
      t(`R13-cw "${text}": Finn makes no deterministic hand-off`, primeLaneDecision(text, "finn-reid" as AgentId), null);
    }
  }

  console.log("=== (A) the LLM routers carry an additive, data-built prime-owners hint ===");
  {
    const dir = primeOwnershipDirectory();
    const cap = AGENTS.find((a) => a.id === "elle-rowan")?.capabilities?.find((c) => c.id === "nexus-assignments");
    t(
      "R-A1 the directory names Elle and Iris (from the roster) for the Nexus assignments job",
      dir.includes("Elle Rowan (@elle-rowan)") && dir.includes("Iris Chase (@iris-chase)") && dir.includes(String(cap?.label)),
      true,
    );
    t(
      "R-A1-hint the directory carries the capability's routerHint (preferred owners; other lanes keep course mentions)",
      !!cap?.routerHint && dir.includes(cap.routerHint),
      true,
    );
    for (const phrase of [
      "preferred owners", "ADD or UPDATE", "emailing or messaging a professor", "booking travel, lodging or a rental car",
      "budgeting tuition, a deposit or a textbook purchase", "scheduling study time or a reminder", "dinner after an exam",
      "training around exam week",
    ])
      t(`R-A2 the hint data says "${phrase}"`, String(cap?.routerHint).includes(phrase), true);
    t("R-A2b a huddle without a holder gets no directory", primeOwnershipDirectory(["finn-reid", "cam-post"] as AgentId[]), "");
    const onlyIris = primeOwnershipDirectory(["iris-chase", "finn-reid"] as AgentId[]);
    t("R-A2c a huddle with only Iris names only Iris", /Iris Chase/.test(onlyIris) && !/Elle Rowan/.test(onlyIris), true);
    const capSrc = readFileSync("src/features/huddle/lib/capabilities.ts", "utf8");
    t("R-A2d no agent id or name is written in capabilities.ts", /elle|iris|rowan|chase/i.test(capSrc), false);

    // Fake OpenAI: record every request body, answer with a fixed decision.
    const bodies: Array<{ input?: Array<{ role: string; content: string }> }> = [];
    let answer: unknown = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ output_text: JSON.stringify(answer) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key-offline";
    const sysOf = () => bodies[0]?.input?.find((m) => m.role === "system")?.content ?? "";
    const userOf = () => bodies[0]?.input?.find((m) => m.role === "user")?.content ?? "";
    try {
      answer = { primary: "cam-post", supporting: [], explicitlyRequested: [], interjectors: [], reason: "email lane", difficulty: 1 };
      const ask = "email my professor that my MGT-782 paper will be a day late";
      for (const strict of [false, true]) {
        bodies.length = 0;
        const r = await routeMessageLLM(
          { text: ask, scope: "group", members: ALL_IDS, history: [] } as Parameters<typeof routeMessageLLM>[0],
          { backend: "openai", model: "test-model", strictPrompt: strict },
        );
        const tag = strict ? "R-A3s strict" : "R-A3 base";
        t(`${tag} router called once (offline fake)`, bodies.length, 1);
        t(`${tag} router system prompt carries the prime-owners directory`, sysOf().includes(dir), true);
        t(`${tag} ...ADDITIVE: the existing PRIME RESPONDERS rule is still there`, sysOf().includes("PRIME RESPONDERS:"), true);
        t(`${tag} ...ADDITIVE: ADDRESSED BY NAME is still there`, sysOf().includes("ADDRESSED BY NAME:"), true);
        t(`${tag} ...and the roster still marks Elle/Iris [prime for: …]`, /- elle-rowan \(Elle Rowan[^\n]*\[prime for: /.test(userOf()), true);
        t(`${tag} the router's own decision is used (the hint is advisory)`, r.winners[0], "cam-post");
      }
      bodies.length = 0;
      await routeMessageLLM(
        { text: "pick a restaurant", scope: "group", members: ["cam-post", "finn-reid", "charleston-lewis"] as AgentId[], history: [] } as Parameters<typeof routeMessageLLM>[0],
        { backend: "openai", model: "test-model" },
      );
      t("R-A3n no holder in the huddle -> no PRIME OWNERS block", sysOf().includes("PRIME OWNERS"), false);

      bodies.length = 0;
      answer = { owner: "cam-post" };
      // The live 1:1 chat hand-off opts in EXPLICITLY ({ primeHint: true }) since the merge with origin/main #124
      // made resolveOwnerLLM the grooming / task-creation judge too (docs/FIX-nexus-write-loop4.md M0).
      const owner = await resolveOwnerLLM(ask, "cam-post" as AgentId, { backend: "openai", model: "test-model" }, { primeHint: true });
      t("R-A4 1:1 owner resolver prompt (chat hand-off, primeHint) carries the prime-owners directory", userOf().includes(dir), true);
      t(
        "R-A4b ...and the [prime for: …] marker on Elle's and Iris's roster lines",
        /- elle-rowan \(Elle Rowan[^\n]*\[prime for: /.test(userOf()) && /- iris-chase \(Iris Chase[^\n]*\[prime for: /.test(userOf()),
        true,
      );
      t("R-A4c ...ADDITIVE: the keep-with-the-addressed-agent default is still there", userOf().includes('Use "cam-post" to KEEP'), true);
      t("R-A4d ...ADDITIVE: the resolver's system prompt is unchanged in kind", sysOf().includes("DEFAULT STRONGLY to keeping"), true);
      t("R-A4e the resolver's own decision is used", owner, "cam-post");

      // M0 (loop 4, docs/FIX-nexus-write-loop4.md): since origin/main #124 resolveOwnerLLM is ALSO the grooming judge
      // and the 1:1 task-creation / produce-task judge. Only the live 1:1 chat hand-off may carry the prime hint.
      const PRIME_MARK = /\[prime for: /;
      const variants: Array<[string, Parameters<typeof resolveOwnerLLM>[3] | undefined, boolean]> = [
        ["chat hand-off { primeHint: true }", { primeHint: true }, true],
        ["grooming { framing: 'assigned' }", { framing: "assigned" }, false],
        ["task creation / produce task (no opts)", undefined, false],
        ["{ framing: 'dm' } without primeHint", { framing: "dm" }, false],
        ["{ framing: 'assigned', primeHint: true } (assigned wins)", { framing: "assigned", primeHint: true }, false],
      ];
      for (const [name, opts, want] of variants) {
        bodies.length = 0;
        if (opts === undefined) await resolveOwnerLLM(ask, "cam-post" as AgentId, { backend: "openai", model: "test-model" });
        else await resolveOwnerLLM(ask, "cam-post" as AgentId, { backend: "openai", model: "test-model" }, opts);
        t(`R-M0-${name}: resolver called once (offline fake)`, bodies.length, 1);
        t(`R-M0-${name}: prompt carries the PRIME OWNERS directory`, userOf().includes("PRIME OWNERS"), want);
        t(`R-M0-${name}: roster lines carry [prime for: …]`, PRIME_MARK.test(userOf()), want);
      }
      bodies.length = 0;
      await resolveOwnerLLM("Draft the MGT-782 essay outline", "flex-grimes" as AgentId, { backend: "openai", model: "test-model" }, { framing: "assigned" });
      t("R-M0-groom-shape grooming keeps #124's assigned framing (task owner, not a 1:1)", userOf().includes("This task is currently owned by Flex"), true);

      // Call-site shape: the opt-in is EXPLICIT at the chat hand-off and absent everywhere else.
      const turnSrc = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
      const groomSrc = readFileSync("src/features/huddle/lib/tasks/groom.ts", "utf8");
      t("R-M0-site exactly one primeHint opt-in in huddle.functions.ts", (turnSrc.match(/primeHint: true/g) ?? []).length, 1);
      t(
        "R-M0-site ...and it is the 1:1 chat hand-off call (resolveOwnerLLM(data.text, nextId, …))",
        /resolveOwnerLLM\(data\.text, nextId, \{[\s\S]{0,200}?\}, \{ primeHint: true \}\)/.test(turnSrc),
        true,
      );
      t("R-M0-site the 1:1 task-creation judge call has no primeHint", /resolveOwnerLLM\(title, winner\.id, \{[^}]*\}\)/.test(turnSrc), true);
      t("R-M0-site the produce-task judge call has no primeHint", /resolveOwnerLLM\(askText, agentId, \{[^}]*\}\)/.test(turnSrc), true);
      t("R-M0-site grooming calls the judge with framing 'assigned'", /resolveOwnerLLM\([\s\S]{0,200}?\{ framing: "assigned" \},?\s*\)/.test(groomSrc), true);
      t("R-M0-site grooming never passes primeHint", /primeHint/.test(groomSrc), false);
    } finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  }

  console.log(`\n${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
await main();
