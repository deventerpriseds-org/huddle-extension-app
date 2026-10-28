// WHAT:       Guards added by the red-team FIX pass that the red-team tests do not themselves pin: the
//             voice speech gate, teammate-mode honesty, the normalised per-turn claim key, the
//             suppressed-duplicate wiring, time-zone/DST edges, kind-filter and dedup non-regressions,
//             and routing near-misses of the context gate.
// WHY:        Each fix in docs/FIX-nexus-write-redteam.md adds code a mutation must be able to break;
//             these are the assertions those mutations are proved against (mutate.sh FIRED verdicts).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-redteam.md.
//
// OFFLINE ONLY: `fetch` is an in-memory fake Nexus. Nothing reaches a real Nexus, Huddle, DB or board.
// Run: bun scripts/nexus-write-fix.test.ts

import {
  executeNexusWriteTool,
  resolveDueInstant,
  classifyNonDeliverable,
  findDuplicate,
  nexusWriteClaimKey,
  nexusWriteUnknownOutcome,
  NEXUS_WRITE_TOOL_NAME as N,
} from "../src/features/huddle/lib/nexus/nexus-write.server";
import { createNexusWriteSpeechGate, enforceNexusWriteHonesty } from "../src/features/huddle/lib/nexus/nexus-write-shared";
import { routeMessage } from "../src/features/huddle/lib/routing";
import { sharedCapabilityHolders } from "../src/features/huddle/lib/capabilities";
import { AGENTS } from "../src/features/huddle/data/agents";
import { readFileSync } from "node:fs";

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
const COURSES: Row[] = [{ id: "c782", code: "MGT-782", name: "MGT-782-W1 (202711)", program_id: "p-dba", user_id: OWNER }];
let ASSIGN: Row[] = [];
let seq = 0;
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  await new Promise((r) => setTimeout(r, 3));
  if (method === "GET") {
    if (url.pathname.endsWith("/api/d1/courses")) return json(200, COURSES);
    return json(200, ASSIGN.map((a) => ({ ...a })));
  }
  if (method === "POST") {
    const row = { id: `new-${++seq}`, ...body };
    ASSIGN.push(row);
    return json(200, { rows: [row] });
  }
  return json(405, {});
}) as unknown as typeof fetch;
const exec = (items: unknown[]) => executeNexusWriteTool({ items }, { ref: "fx" }) as Promise<{ results: Row[] } & Row>;
const use = (results: unknown[]) => [{ tool: N, ok: false, detail: JSON.stringify({ ok: true, results }) }];
const FAILED = use([{ index: 0, title: "Final Paper", action: "failed", persisted: false, error: "http_500" }]);

console.log("=== Voice speech gate (W18) ===");
{
  const g = createNexusWriteSpeechGate();
  t("FX-V1 a clean write does not hold speech", (g.noteToolOutput(N, JSON.stringify({ ok: true, results: [{ index: 0, title: "X", action: "inserted", persisted: true }] })), g.holding), false);
  g.noteToolOutput(N, FAILED[0].detail);
  t("FX-V2 a failed write holds speech", g.holding, true);
  t("FX-V3 the held reply is checked by the text-path guard", /Final Paper is saved/.test(enforceNexusWriteHonesty("Final Paper is saved.", g.uses)), false);
  g.noteToolOutput("schedule_reminder", FAILED[0].detail);
  g.reset();
  t("FX-V4 reset (next utterance) releases the hold", g.holding, false);
  g.noteToolOutput(N, JSON.stringify({ ok: false, error: "network" }));
  t("FX-V5 a tool-level error holds speech", g.holding, true);
  const hook = readFileSync("src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts", "utf8");
  t("FX-V6 the hook does not stream-synth while the gate holds", /if \(!nexusGateRef\.current\.holding\) pumpSpeech\(/.test(hook), true);
  t("FX-V7 the hook speaks the CHECKED text when held", /const full = held \? enforceNexusWriteHonesty\(raw, gate\.uses\) : raw;/.test(hook), true);
  t("FX-V8 the hook arms the gate from each tool output", /nexusGateRef\.current\.noteToolOutput\(name, r\.ok \? output/.test(hook), true);
}

console.log("=== Teammate honesty (W17) ===");
{
  const a = enforceNexusWriteHonesty("Budget looks fine. Elle saved the Final Paper for you.", [], FAILED);
  t("FX-G1 a teammate's claim naming the writer's failed item is removed", /saved the Final Paper/.test(a) || !/Not saved to Nexus/.test(a), false);
  t("FX-G1b the rest of the teammate's reply is kept", a.startsWith("Budget looks fine."), true);
  t("FX-G2 a teammate silent about it is left alone", enforceNexusWriteHonesty("Budget looks fine.", [], FAILED), "Budget looks fine.");
  t("FX-G3 a teammate's generic 'Done' is about its own work", enforceNexusWriteHonesty("Done — budget updated.", [], FAILED), "Done — budget updated.");
  const fn = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
  t("FX-G4 the first write's outcome is stored by claim key", /nexusWriteOutcomes\.set\(claimKey, pending/.test(fn), true);
  t("FX-G5 the suppressed call returns the first call's results", /return JSON\.stringify\(\{ \.\.\.firstOut, already_done_this_turn: true/.test(fn), true);
  t("FX-G6 reply assembly passes teammates' writes to the guard", /turnNexusWriteUses\.filter\(\(u\) => u\.agentId !== nextId\)/.test(fn), true);
  t("FX-G7 the claim is keyed on the normalised items, not raw JSON", /claimAction\(claimKey\)/.test(fn) && !/claimAction\(`\$\{c\.name\}:\$\{JSON\.stringify\(writeArgs\)\}`\)/.test(fn), true);
  const unk = nexusWriteUnknownOutcome({ items: [{ title: "A" }, { title: "B" }] }) as { results: Row[] };
  t("FX-G8 an outcome from an earlier chunk is 'unknown', never ok", unk.results.map((r) => r.persisted).join(","), "unknown,unknown");
}

console.log("=== Claim key (W3) ===");
{
  const k = (items: unknown[]) => nexusWriteClaimKey({ items });
  const base = { course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30" };
  t("FX-C1 priority / weight / course spelling do not change the key", k([base]) === k([{ ...base, course: "mgt 782", title: "research proposal (20%)", priority: "high" }]), true);
  t("FX-C2 item order does not change the key", k([base, { ...base, title: "Final Paper" }]) === k([{ ...base, title: "Final Paper" }, base]), true);
  t("FX-C3 a different due date is a different key", k([base]) === k([{ ...base, due_date: "2026-11-30" }]), false);
  const many = Array.from({ length: 25 }, (_, i) => ({ ...base, title: `Weekly Discussion Post ${i + 1}` }));
  const many2 = many.map((x, i) => (i === 24 ? { ...x, title: "Something Else Entirely" } : x));
  t("FX-C4 two long batches differing only in the last item do not collide (240-char ledger cut)", k(many) === k(many2), false);
  t("FX-C5 the key fits the ledger's 240 characters", `${N}:${k(many)}`.length <= 240, true);
}

console.log("=== Time zones / DST (W9, W13) ===");
{
  const mst = resolveDueInstant("2026-10-30", "23:59", "MST");
  t("FX-T1 'MST' is refused as ambiguous (Arizona vs Denver)", mst.ok, false);
  const et = resolveDueInstant("2026-01-15", "23:59", "ET");
  t("FX-T2 'ET' in winter is Eastern standard time", et.ok && et.iso, "2026-01-16T04:59:00Z");
  const ov = resolveDueInstant("2026-11-01", "01:30");
  t("FX-T3 a fall-back overlap keeps the FIRST occurrence", ov.ok && ov.iso, "2026-11-01T05:30:00Z");
  const ok = resolveDueInstant("2026-03-08", "03:30");
  t("FX-T4 a real time on a spring-forward day is not flagged shifted", ok.ok && ok.timeShifted === undefined, true);
  ASSIGN = [];
  const r = await exec([{ course: "MGT-782", title: "Gap Paper", due_date: "2026-03-08", due_time: "02:30" }]);
  t("FX-T5 the item result flags a shifted gap time", `${r.results[0].due_date}/${r.results[0].time_shifted}`, "2026-03-08T07:30:00Z/true");
}

console.log("=== Kind filter non-regressions (W4/W5/W12) ===");
{
  for (const s of ["Paper due at Residency 4", "Residency 4 reflection paper", "Seminar paper", "Final presentation", "Reading response 3", "Reading quiz", "Thanksgiving reflection essay", "Case Study 2"]) {
    t(`FX-K1 "${s}" is still a deliverable`, classifyNonDeliverable(s), "null");
  }
  t("FX-K2 'Read chapters 3-5' is a reading", classifyNonDeliverable("Read chapters 3-5"), "reading");
}

console.log("=== Dedup non-regressions (W1/W2/W7) ===");
{
  const EX: Row[] = [{ id: "rp", title: "Research Proposal", due_date: "2026-10-31T03:59:59.000Z" }];
  const d = findDuplicate({ title: "Research Proposal", dueMs: Date.parse("2026-10-30T21:00:00Z") }, EX);
  t("FX-D1 same title, same local day, different time is still the stored row", d?.row.id ?? "none", "rp");
  t("FX-D2 a one-word title matches nothing by subset", findDuplicate({ title: "Proposal", dueMs: Date.parse("2026-10-31T03:59:59Z") }, EX)?.row.id ?? "none", "none");
  ASSIGN = [{ id: "dp1", course_id: "c782", title: "Discussion Post", due_date: "2026-11-02T04:59:59.000Z" }];
  const r = await exec([{ course: "MGT-782", title: "Discussion Post", due_date: "2026-11-08" }]);
  t("FX-D3 a recurring insert says another same-titled row exists", `${r.results[0].action}/${/SEPARATE/.test(String(r.results[0].note))}`, "inserted/true");
  ASSIGN = [{ id: "fr", course_id: "c782", title: "Final Reflection", due_date: null }];
  const u = await exec([{ course: "MGT-782", title: "Final Reflection", due_date: "2026-12-01" }]);
  t("FX-D4 an undated duplicate is flagged and nothing is written", `${u.results[0].action}/${u.results[0].stored_undated}/${ASSIGN.length}`, "duplicate/true/1");
  t("FX-D5 the outcome statement offers to add the date", /no due date/.test(String(u.outcome)), true);
}

console.log("=== Points (W16) ===");
{
  ASSIGN = [];
  const r = await exec([{ course: "MGT-782", title: "Case Brief", due_date: "2026-11-20", points: 12.5 }]);
  t("FX-P1 the item still saves, the points do not, and it says so", `${r.results[0].persisted}/${"points" in (ASSIGN[0] ?? {})}/${/whole number/.test(String(r.outcome))}`, "true/false/true");
}

console.log("=== Routing near-misses of the context gate (W19/W21) ===");
{
  const ALL_IDS = AGENTS.map((a) => a.id);
  const lead = (text: string) => routeMessage({ text, scope: "group", members: ALL_IDS, history: [] } as Parameters<typeof routeMessage>[0]);
  for (const s of ["upgrade my seat assignment to first class", "of course the client deliverable is due Friday", "my kid's school project is due Friday"]) {
    t(`FX-R1 "${s}" is not a coursework prime ask`, sharedCapabilityHolders(s).length, 0);
  }
  for (const s of ["what's due for MGT-782 this week", "add the case study due Nov 3 to Nexus", "my EMBA essay deadline moved to Dec 2"]) {
    const r = lead(s);
    t(`FX-R2 "${s}" is led by a prime agent`, r.decision.reason.startsWith("Prime responder"), true);
  }
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
