// WHAT: verifier probe (VERIFY-nexus-write-tool-2) -- classifyTurnIntent + primeLaneDecision for the loop-2 routing
//       attacks, i.e. does the deterministic 1:1 follow-up DM (huddle.functions.ts ~6775) fire, and from which agent.
// WHY: C4/C9 calibration. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/VERIFY-nexus-write-tool-2.md
// Run: bun mut-verify-114-2/probe-intent.ts <tree-root>
const root = process.argv[2];
const { classifyTurnIntent } = await import(`${root}/src/features/huddle/lib/capabilities.ts`);
const routing = await import(`${root}/src/features/huddle/lib/routing.ts`);
const cases: Array<[string, string]> = [
  ["my UA 902 check-in deadline is tonight, can you handle it", "troy-lennox"],
  ["check me in for UA 902 before the deadline tonight", "troy-lennox"],
  ["my DS-160 visa form is due Friday", "troy-lennox"],
  ["fill out my DS-160 visa form, it's due Friday", "troy-lennox"],
  ["my DBA filing deadline for the LLC is Friday", "sam-trent"],
  ["file my DBA for the LLC before the deadline", "sam-trent"],
  ["my yoga instructor says the class pass payment is due Monday", "flex-grimes"],
  ["pay my yoga instructor, the payment is due Monday", "finn-reid"],
  ["when is the due date on my mortgage papers", "finn-reid"],
  ["sign my mortgage papers before the due date", "finn-reid"],
  ["my new job assignment in Germany starts Monday, what's my assignment exactly", "sam-trent"],
  ["roll my NVDA 200 calls before the deadline Friday", "finn-reid"],
  ["the IRS 941 payment is due Friday", "finn-reid"],
  ["pay the IRS 941 payment due Friday", "finn-reid"],
  ["my MBA loan payment is due Monday, can I afford it", "finn-reid"],
  ["set up autopay for my MBA loan payment due Monday", "finn-reid"],
];
for (const [t, self] of cases) {
  const p = routing.primeLaneDecision ? routing.primeLaneDecision(t, self) : "(none on this tree)";
  const l = routing.laneOwnerFor(t, self);
  console.log(JSON.stringify({ t, self, intent: classifyTurnIntent(t), prime: p, lane: l ? l.id : null }));
}
