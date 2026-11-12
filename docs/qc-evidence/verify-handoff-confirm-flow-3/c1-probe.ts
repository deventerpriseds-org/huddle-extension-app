// WHAT: loop-3 independent probe of the F1 pure decision pieces (laneHandoffSuppression, stripTeammateDeferral,
//       buildFollowupDirective) with inputs the builder's tests do not use.
// WHY: C1 verification. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE: docs/qc-evidence/VERIFY-handoff-confirm-flow-3.md
import { laneHandoffSuppression, stripTeammateDeferral } from "../../../src/features/huddle/lib/capabilities";
import { buildFollowupDirective } from "../../../src/features/huddle/lib/handoff-followup";

let pass = 0, fail = 0;
const eq = (id: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${id} got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const A = "sam-trent";
const tu = (tool: string, summary: string, ok = true, detail?: string, agentId = A) => ({ agentId, tool, summary, ok, detail });
const ask = "draft a pricing model for the new venture";

// --- laneHandoffSuppression (what counts as "handled")
eq("S-1 delegate ok", laneHandoffSuppression({ text: ask, addressedId: A, toolUses: [tu("delegate_to_specialist", "tasked researcher: pricing")] }), "handled");
eq("S-2 delegate failed", laneHandoffSuppression({ text: ask, addressedId: A, toolUses: [tu("delegate_to_specialist", "delegation failed", false)] }), null);
eq("S-3 artifact saved", laneHandoffSuppression({ text: ask, addressedId: A, toolUses: [tu("create_artifact", 'saved "x.md"', true, "/artifacts/abc")] }), "handled");
eq("S-4 artifact dedup (no detail) alone", laneHandoffSuppression({ text: ask, addressedId: A, toolUses: [tu("create_artifact", "already saved this turn — skipped duplicate")] }), null);
eq("S-5 task row created", laneHandoffSuppression({ text: ask, addressedId: A, toolUses: [tu("create_huddle_task", "“Pricing” → Huddle board + journey · assigned to Sam Trent")] }), "handled");
eq("S-6 task dedup skip", laneHandoffSuppression({ text: ask, addressedId: A, toolUses: [tu("create_huddle_task", "an open task with this title already exists — skipped duplicate")] }), null);
eq("S-7 web search only", laneHandoffSuppression({ text: ask, addressedId: A, toolUses: [tu("tavily_web_search", "searched pricing")] }), null);
eq("S-8 another agent's work", laneHandoffSuppression({ text: ask, addressedId: A, toolUses: [tu("delegate_to_specialist", "tasked x", true, undefined, "finn-reid")] }), null);
eq("S-9 now, no tools", laneHandoffSuppression({ text: "draft a pricing model right away", addressedId: A, toolUses: [] }), "now");
eq("S-10 for-now (C2 HIGH) suppresses", laneHandoffSuppression({ text: "park the pricing model for now", addressedId: A, toolUses: [] }), null);

// --- stripTeammateDeferral (AC-F1-4: no deferral to a NAMED teammate survives a no-hand-off decision)
const keep = "Here is a first pass at the pricing tiers.";
const strip = (id: string, deferral: string) =>
  eq(id, stripTeammateDeferral(`${keep} ${deferral}`, A), keep);
strip("D-1 loop in", "I'll loop in Finn on the numbers.");
strip("D-2 better suited", "Finn's better suited for the model itself.");
strip("D-3 will reach out", "Finn will reach out shortly.");
strip("D-4 answer-first", "Finn knows this area best — I'm looping them in.");
strip("D-5 bring in", "Let me bring Finn in on the numbers.");
strip("D-6 asked to look", "I've asked Finn to take a look.");
strip("D-7 get on it", "I'll get Finn on it.");
strip("D-8 can take it", "Finn can take it from here.");
strip("D-9 will handle", "Finn will handle the spreadsheet.");
strip("D-10 have look into", "I'll have Finn look into it.");
strip("D-11 ping", "I'll ping Finn about it.");
strip("D-12 in Finn's hands", "I'm putting this in Finn's hands.");
strip("D-13 send over", "I'm sending this over to Finn.");
// never over-strip
eq("K-1 neutral mention kept", stripTeammateDeferral(`${keep} As Finn noted last week, margins are thin.`, A), `${keep} As Finn noted last week, margins are thin.`);
eq("K-2 own name kept", stripTeammateDeferral(`${keep} I'll loop in Sam's notes.`, A), `${keep} I'll loop in Sam's notes.`);

// --- buildFollowupDirective (when it fires, the owner is told what was already said)
const d = buildFollowupDirective({ ownerName: "Finn Reid", ownerId: "finn-reid", fromName: "Sam Trent", ask, mode: "confirm", addressedReply: "Here are three tiers: $9, $29, $99." });
eq("F-1 already-said quoted", d.includes('"Here are three tiers: $9, $29, $99."'), true);
eq("F-2 forbids repeating", /Do NOT repeat, re-answer or paraphrase/.test(d), true);
eq("F-3 no at-sign", d.includes("@"), false);
const dn = buildFollowupDirective({ ownerName: "Terry Locke", fromName: "Sam Trent", ask: "groom the backlog now", mode: "now", addressedReply: "On it." });
eq("F-4 now mode no confirm-first", /do NOT ask them to confirm first/.test(dn) && !/tap\s+Confirm/.test(dn), true);
eq("F-5 now mode carries already-said", dn.includes('"On it."'), true);
console.log(`${pass} passed, ${fail} failed`);
