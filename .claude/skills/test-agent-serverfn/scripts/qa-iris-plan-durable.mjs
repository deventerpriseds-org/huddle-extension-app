// WHAT:       Live check of the owner's real complaint on the REAL chat path (durable enqueue + poll):
//             "plan my day" in Iris's 1:1 must come back as an actual plan, not a produce/quick prompt
//             and not an empty reply. journey:{enabled:false} (no board writes), Test- prefixed.
// WHY:        2026-10-28: the sync-path harness (qa-produce-quick.mjs Case 3) got an EMPTY reply after
//             40s for this ask; the sync path has a hard deadline the real client's durable path does not.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run via agent-serverfn-uat.yml with this script path.
process.env.HUDDLE_ID = "dm-iris-chase";
process.env.HUDDLE_SCOPE = "one-to-one";
process.env.HUDDLE_TARGET = "iris-chase";
process.env.HUDDLE_MEMBERS = "iris-chase";
process.env.RUN_TAG = "irisplan";
process.env.HUDDLE_TEXT =
  "Test- I need to plan my activities for the day. Work on my DBA papers for MGMT 702 and 782, draft my " +
  "reflection speech for my friend's funeral on Sunday, go to the gym at 3pm, pick up supplements from the " +
  "vitamin shop, and work on my apps (sidecar, prompto, diagram builder). What's the best approach? Lay out the day.";
await import("./durable-harness.mjs");
