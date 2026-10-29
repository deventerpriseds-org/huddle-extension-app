// WHAT:       D14 scratch probe: capabilityExplicitOverride on the clause / destination / cancel / purpose ("for")
//             examples used in the D14 tests, plus every explicit-override positive in nexus-write-routing.test.ts.
// WHY:        Measure before asserting (docs/FIX-nexus-write-loop4.md, "D14 -- override needs Nexus as the destination").
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   mut-d14/probe-units.out
// Run: bun mut-d14/probe-units.ts <tree-root>
const root = process.argv[2];
const { capabilityExplicitOverride } = await import(`${root}/src/features/huddle/lib/capabilities.ts`);
const { AGENTS } = await import(`${root}/src/features/huddle/data/agents.ts`);
const cap = AGENTS.flatMap((a: { capabilities?: Array<{ id: string }> }) => a.capabilities ?? []).find(
  (c: { id: string }) => c.id === "nexus-assignments",
);
const ASKS = [
  // clause boundary
  "save me some dinner, I'm finishing my essay in Nexus",
  "add my reading list, the essay is in Nexus",
  "my workout got moved, add my essay to Nexus",
  "move my flight home, my exam in Nexus got moved to Monday",
  // destination
  "add my essay in Nexus to the shared folder",
  "put the case study in my Nexus on the team drive",
  "add the exam dates in Nexus to my calendar",
  // competing destination / object
  "add a reminder about my essay to Nexus",
  "add my hotel booking and the essay to Nexus",
  "put my workout plan and my paper into Nexus",
  "add my essay to Nexus and to my calendar",
  // purpose ("for")
  "log the textbook I bought for my MGT-782 project in Nexus",
  // positives (test file POS + OVR_POS + probe P rows)
  "add the MGT-782 email marketing case analysis to Nexus",
  "put my travel industry essay due Nov 3 into Nexus",
  "update the Airbnb pricing case study due date in Nexus",
  "can you add my hotel management essay to Nexus",
  "please reschedule the budgeting case study to Dec 2 in Nexus",
  "add the flight operations essay to my Nexus assignments",
  "set the travel essay due date to Friday in Nexus",
  "record my dinner etiquette essay due Nov 10 into Nexus",
  "change the client presentation paper deadline in Nexus to Monday",
  "save the email marketing paper to my Nexus",
  "enter the fitness industry case study into Nexus",
  "move my hotel case study to Dec 4 in Nexus",
  "log the tax accounting paper due Friday in Nexus",
  "hey Elle, add my airline pricing essay to Nexus",
  "I need you to put the restaurant case study into Nexus",
  "add my essay to my Nexus account",
  "put the MGT-782 email marketing case analysis due Nov 3 into Nexus",
  "hey Troy, please add the travel industry essay due Nov 3 to my Nexus",
  "add the MGT-701 research proposal due Dec 1 to Nexus",
  "update the due date of my research paper in Nexus to Dec 9",
  "add my MGT-782 reflection paper to Nexus, due Sunday",
  "please put the EMBA694 case analysis into my Nexus",
  "update the due date for my MGT-701 proposal in Nexus to Dec 3",
  "email my professor and then update the due date in Nexus",
  "update my essay in Nexus by Friday at 5pm",
  "log the paper in Nexus for Friday",
];
for (const a of ASKS) console.log(`${capabilityExplicitOverride(cap, a)}\t${a}`);
