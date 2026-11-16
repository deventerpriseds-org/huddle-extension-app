// WHAT:       Proves a ceremony barge turn is bounded at 25s and every other sync turn keeps 36s.
// WHY:        The client gives up on a barge at 30s (MeetingBar.tsx) while the server allowed 36s, so an
//             answer finishing at 30-36s was thrown away and the user heard nothing. Owner-approved
//             2026-11-16: server cap 25s for barges only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/DIAG-uat-long-task-barge.md; docs/qc-evidence/BUILD-barge-cap-standup-toggle.md.
//             Run: bun scripts/barge-deadline.test.ts

import { readFileSync } from "node:fs";
import {
  agentBudgetMs,
  BARGE_TURN_DEADLINE_MS,
  turnDeadlineMs,
  TURN_DEADLINE_MS,
} from "../src/features/huddle/lib/turn-deadline";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const barge = turnDeadlineMs({ chunked: false, chunkBudgetMs: 30_000, ceremonyBarge: true });
const normal = turnDeadlineMs({ chunked: false, chunkBudgetMs: 30_000, ceremonyBarge: false });
const unset = turnDeadlineMs({ chunked: false, chunkBudgetMs: 30_000 });
const chunked = turnDeadlineMs({ chunked: true, chunkBudgetMs: 30_000, ceremonyBarge: false });

check("D1 barge turn deadline is 25s", barge === 25_000, String(barge));
check("D2 normal sync turn deadline is 36s", normal === 36_000, String(normal));
check("D3 ceremonyBarge unset = normal 36s", unset === 36_000, String(unset));
check("D4 chunked turn keeps the chunk budget", chunked === 30_000, String(chunked));
check("D5 constants are the named values", BARGE_TURN_DEADLINE_MS === 25_000 && TURN_DEADLINE_MS === 36_000);

// Per-agent budget (runBounded): a barge never gets the 40s 1:1 allowance; ordinary turns unchanged.
check("D6 group barge agent budget = 25s",
  agentBudgetMs({ scope: "group", ceremonyBarge: true, deadlineMs: barge }) === 25_000);
check("D7 a 1:1-scoped barge still 25s (client gives up at 30s whatever the scope)",
  agentBudgetMs({ scope: "one-to-one", ceremonyBarge: true, deadlineMs: barge }) === 25_000);
check("D8 ordinary 1:1 keeps 40s",
  agentBudgetMs({ scope: "one-to-one", ceremonyBarge: false, deadlineMs: normal }) === 40_000);
check("D9 ordinary group keeps the turn deadline",
  agentBudgetMs({ scope: "group", ceremonyBarge: false, deadlineMs: normal }) === 36_000);

// The server cap must sit INSIDE the client's barge timer, read from the client source itself.
const bar = readFileSync("src/features/huddle/components/MeetingBar.tsx", "utf8");
const m = /reject\(new Error\("barge answer timed out"\)\), (\d[\d_]*)\)/.exec(bar);
const clientMs = m ? Number(m[1].replace(/_/g, "")) : NaN;
check("D10 server barge cap is below the client barge timer", clientMs > BARGE_TURN_DEADLINE_MS,
  `client=${clientMs} server=${BARGE_TURN_DEADLINE_MS}`);

// Wiring: runHuddleTurn actually uses the helpers with the request's ceremonyBarge flag.
const fn = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
check("D11 runHuddleTurn derives deadlineMs from turnDeadlineMs(ceremonyBarge)",
  /const deadlineMs = turnDeadlineMs\(\{[\s\S]{0,120}ceremonyBarge: !!data\.ceremonyBarge/.test(fn));
check("D12 runBounded derives its budget from agentBudgetMs(ceremonyBarge)",
  /const budgetMs = agentBudgetMs\(\{ scope: data\.scope, ceremonyBarge: !!data\.ceremonyBarge, deadlineMs \}\)/.test(fn));
check("D13 no inline 36_000 deadline left in runHuddleTurn", !/const TURN_DEADLINE_MS = 36_000/.test(fn));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
