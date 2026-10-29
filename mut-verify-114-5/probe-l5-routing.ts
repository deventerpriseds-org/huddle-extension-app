// WHAT:       Verifier probe (VERIFY-nexus-write-tool-5, C4/C9): NEW realistic owner phrasings (not exotic spellings)
//             across Cam/Eli/Troy/Finn/Charleston/Flex/Sam/Tess and Elle/Iris. Per ask: turn intent, GROUP leader,
//             primeLaneDecision and laneOwnerFor from the addressed agent. PR tree or a `git archive origin/main` export.
// WHY:        Pre-merge check of the loop-4 fix (override needs an assignment noun; 1:1 hand-off only on override)
//             and of the reverse direction loop 4 did not probe: Elle/Iris addressed with another lane's ask that
//             matches the capability -> "keep" (no directive, no follow-up, LLM judge skipped).
// SUPERSEDES: nothing (follows mut-verify-114-4/probe-c9-routing.ts).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-5.md. Deterministic path only; no API calls, no writes.
// Run: bun mut-verify-114-5/probe-l5-routing.ts <tree-root> [warm|cold]
const root = process.argv[2];
const cache = process.argv[3] ?? "warm";
if (cache === "warm") {
  try {
    const cc = await import(`${root}/src/features/huddle/lib/nexus/course-context.ts`);
    cc.setNexusCourseContext([
      { code: "MGT-782-W1 (202711)", name: "MGT-782-W1-Theories of Strategy (202711)" },
      { code: "MGT-702-W1 (202711)", name: "MGT-702-W1 (202711)" },
      { code: "MGT-701-W1 (202712)", name: "MGT-701-W1-Becoming an Applied Researcher (202712)" },
      { code: "EMBA694", name: "EMBA694 Operations Management" },
    ]);
  } catch {
    /* origin/main has no course context */
  }
}
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const { classifyTurnIntent } = await import(`${root}/src/features/huddle/lib/capabilities.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const ALL: string[] = AGENTS.map((a: { id: string }) => a.id);
const CASES: Array<[string, string, string]> = [
  // --- explicit-override shape, but another lane's job (D13-ovr class) ---
  ["N1", "set a reminder to submit my MGT-782 paper in Nexus Friday", "eli-vaughn"],
  ["N2", "add the exam dates in Nexus to my calendar", "eli-vaughn"],
  ["N3", "put the due dates in Nexus on my calendar", "eli-vaughn"],
  ["N4", "add my essay deadline in Nexus to my calendar", "eli-vaughn"],
  ["N5", "move my workout to tomorrow so I can finish my paper in Nexus", "flex-grimes"],
  ["N6", "reschedule my study session, the exam in Nexus moved to Friday", "eli-vaughn"],
  ["N7", "save me some dinner, I'm finishing my essay in Nexus", "charleston-lewis"],
  ["N8", "log the textbook I bought for my MGT-782 project in Nexus", "finn-reid"],
  ["N9", "email my professor and then update the due date in Nexus", "cam-post"],
  ["N10", "set up a study block tonight for the exam in Nexus", "eli-vaughn"],
  ["N11", "add the MGT-782 exam to my calendar, it's listed in Nexus", "eli-vaughn"],
  // --- other lane, no override shape (D13 vocabulary class, new words) ---
  ["N12", "can you text my MGT-782 group the proposal is due Friday", "cam-post"],
  ["N13", "grab me a coffee before my MGT-782 exam", "charleston-lewis"],
  ["N14", "find me a quiet coworking spot to finish my MGT-782 paper due Friday", "troy-lennox"],
  ["N15", "how much will the EMBA694 exam fee be, it's due Friday", "finn-reid"],
  ["N16", "draft a pitch deck for my startup, the MGT-701 deadline is Friday", "sam-trent"],
  ["N17", "write the PRD for my MGT-782 capstone app, due Friday", "tess-sutton"],
  // --- coursework the PR intends to hand off / keep ---
  ["P4", "add my MGT-782 reflection paper to Nexus, due Sunday", "finn-reid"],
  ["P5", "please put the EMBA694 case analysis into my Nexus", "cam-post"],
  ["P6", "add my essay to my Nexus account", "troy-lennox"],
  ["P7", "update the due date for my MGT-701 proposal in Nexus to Dec 3", "sam-trent"],
  ["P8", "help me outline my MGT-782 strategy paper due Friday", "finn-reid"],
  ["P9", "what's due in Nexus this week", "iris-chase"],
  // --- reverse direction: Elle/Iris addressed with another lane's ask (keep-steal) ---
  ["K1", "book a room near campus for the MGT-701 residency, deadline is Friday", "iris-chase"],
  ["K2", "I need a ride to my MGT-782 exam", "iris-chase"],
  ["K3", "send my MGT-782 group the slides before the deadline", "elle-rowan"],
  ["K4", "order the EMBA694 textbook before the exam", "iris-chase"],
  ["K5", "stretch routine before my MGT-782 exam", "elle-rowan"],
  ["K6", "put the MGT-782 exam on the calendar for Friday", "iris-chase"],
  ["K7", "find a babysitter for the MGT-701 residency weekend, deadline Friday", "elle-rowan"],
  ["K8", "share the slides with my MGT-782 group before Friday's deadline", "iris-chase"],
  ["K9", "can you get the MGT-782 exam onto my schedule", "elle-rowan"],
  ["K10", "set a reminder to submit my MGT-782 paper in Nexus Friday", "iris-chase"],
];
for (const [tag, text, self] of CASES) {
  const r = routing.routeMessage({ text, scope: "group", members: ALL, history: [] });
  const p = routing.primeLaneDecision ? routing.primeLaneDecision(text, self) : null;
  const l = routing.laneOwnerFor(text, self);
  console.log(`${tag}\t${cache}\tintent=${classifyTurnIntent(text)}\tgroup=${r.winners[0]}\tprime=${p ?? "-"}\tlane=${l ? l.id : "-"}\t${self}\t${text}`);
}
