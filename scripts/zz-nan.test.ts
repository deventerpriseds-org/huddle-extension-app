// Verifier loop 2: maxCalls / allowance guards. Synthetic, no units needed for termination (empty plan).
const P = await import("../src/features/huddle/lib/actions/pipeline");
const { ACTIONS_SETTINGS_DEFAULT } = await import("../src/features/huddle/lib/actions/actions");
const S = { ...ACTIONS_SETTINGS_DEFAULT, sources: { email: true, teams: true, meeting: false } };
let n = 0;
const deps: any = { recordCall: async () => { n++; }, model: async () => ({}), nowIso: () => "2026-11-17T00:00:00Z", storeVerdict: async () => {}, propose: async () => ({ id: null, onBoard: false }), addMeetingRows: async () => 0 };
// Real units: reuse the loop-1 fixture builder is heavy; instead give runClassify a fake assembled plan with 3 units via threadUnits stub is not possible,
// so exercise classifyCallsLeft + runReportClassify's normalisation, and runClassify on whatever plan shape it accepts.
for (const m of [Number.NaN, -5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 3.7]) {
  const norm = Number.isFinite(m) && m > 0 ? Math.floor(m) : 0;
  console.log(`maxCalls=${m} -> classifyCallsLeft(0, 200, norm)=${P.classifyCallsLeft(0, 200, norm)}`);
}
console.log(`classifyCallsLeft(NaN used)=${P.classifyCallsLeft(Number.NaN, 200)} classifyCallsLeft(0,200,NaN perPass)=${P.classifyCallsLeft(0, 200, Number.NaN)}`);
