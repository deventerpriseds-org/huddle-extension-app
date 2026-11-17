// WHAT:  loop-9 C7 probe: NEW rows against presentBoardClaims @ e45abd80, using REAL recordToolUse summaries from
//        src/features/huddle/lib/huddle.functions.ts (line numbers in comments). keep->rewrite = UNSAFE.
// WHY:   fix 0ea0a387 says huddleToolChangedTask decides per tool from the summary; hunts free text that still leaks.
// SUPERSEDES: nothing (loop-7/8 probes re-run alongside)  SUPERSEDED-BY: nothing -- current
// run: bun docs/qc-evidence/probe-9-c27-c7.ts
import { presentBoardClaims } from "../../src/features/huddle/lib/tasks/board-claims.ts";
const A = "ezra";
const U = (tool: string, summary: string, ok = true, detail?: string) => ({ agentId: A, tool, summary, ok, detail });
// :4287  recordToolUse(winner.id, "flag_blocker", `blocked: ${reason.slice(0, 50)}`, true) -- AFTER board BLOCKED set
const blk50 = (reason: string) => U("flag_blocker", `blocked: ${reason.slice(0, 50)}`);
// :5841  same, slice(0, 60)
const blk60 = (reason: string) => U("flag_blocker", `blocked: ${reason.slice(0, 60)}`);
const r1 = "Vendor import keeps reporting skipped duplicate";
const r2 = "Nightly sync from the vendor portal shows skipped duplicate rows again";
// :4183-4185 create_artifact ok=true but task held OUT of review (no flip)
const ART_HELD = U("create_artifact", 'saved "Pricing brief" · saved, but held out of review — confirm intent with the user first', true, "/artifacts/x");
// :4436-4438 confirm_task_intent -- sets DoD only, not status
const CONF = U("confirm_task_intent", "DoD confirmed");
// :2576-2581 delegation, objective free text
const DEL = (obj: string) => U("delegate_to_specialist", `tasked Researcher: ${obj.slice(0, 80)}`);
const cases: [string, string, any[], "keep" | "rewrite"][] = [
  ["U9-1 flag_blocker reason ends 'skipped duplicate' (slice50)", "I've marked it blocked.", [blk50(r1)], "keep"],
  ["U9-2 flag_blocker reason truncated to end 'skipped duplicate' (slice60)", "I've marked it blocked.", [blk60(r2)], "keep"],
  ["U9-3 delegation objective ends 'skipped duplicate'", "I've moved it to In progress.", [DEL("work out why the importer skipped duplicate")], "keep"],
  ["U9-4 real flag_blocker, plain", "I've marked it blocked.", [blk50("waiting on the vendor's quote")], "keep"],
  ["U9-5 flag_blocker reason 'Huddle-only'", "I've marked it blocked.", [blk50("Huddle-only mode, journey disabled for now")], "keep"],
  ["M9-1 artifact HELD out of review, claims review", "I saved it and moved it to review.", [ART_HELD], "rewrite"],
  ["M9-2 confirm_task_intent only, claims Doing", "I've moved it to Doing.", [CONF], "rewrite"],
  ["M9-3 no tool, 'I marked it done'", "I marked it done.", [], "rewrite"],
];
let unsafe = 0, miss = 0;
for (const [name, text, uses, want] of cases) {
  const out = presentBoardClaims([{ agentId: A, text }], uses)[0].text;
  const got = out === text ? "keep" : "rewrite";
  let tag = "ok    ";
  if (got !== want) { if (want === "keep") { unsafe++; tag = "UNSAFE"; } else { miss++; tag = "MISS  "; } }
  console.log(`${tag} [${want}->${got}] ${name}: ${JSON.stringify(text)} => ${JSON.stringify(out)} | summary=${JSON.stringify(uses[0]?.summary)}`);
}
console.log(`unsafe: ${unsafe}  misses: ${miss}`);
