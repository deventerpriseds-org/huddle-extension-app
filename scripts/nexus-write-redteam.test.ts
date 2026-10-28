// WHAT:       FAILING tests from the red-team pass over `write_nexus_assignments` -- one per WRONG
//             finding in the tool itself (honesty guard, dedup, kind filter, dates, course, points).
//             Every `not ok` line here is a defect, not a broken test; there are no fixes on this branch.
// WHY:        Tier-1 red-team pre-pass: inputs the builder's suite (scripts/nexus-write-tool.test.ts)
//             never tried. Each test names its finding id (W#) in docs/REDTEAM-nexus-write-tool.md.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current (fold into nexus-write-tool.test.ts on fix).
// EVIDENCE:   docs/REDTEAM-nexus-write-tool.md; target commit 507e13b.
//
// OFFLINE ONLY: `fetch` is replaced by an in-memory fake Nexus. Nothing here reaches a real
// Nexus, Huddle, database or board.
//
// Run: bun scripts/nexus-write-redteam.test.ts

import {
  executeNexusWriteTool,
  NEXUS_WRITE_TOOL_NAME,
  resolveDueInstant,
  classifyNonDeliverable,
  findDuplicate,
  resolveCourse,
  enforceNexusWriteHonesty,
} from "../src/features/huddle/lib/nexus/nexus-write.server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  // A real network hop: lets two concurrent executions interleave the way two agents in one wave do.
  await new Promise((r) => setTimeout(r, 5));
  if (method === "GET") {
    if (url.pathname.endsWith("/api/d1/courses")) return json(200, COURSES);
    const f = JSON.parse(url.searchParams.get("filters") ?? "[]") as [string, string][];
    const cid = f.find(([c]) => c === "course_id")?.[1];
    return json(200, ASSIGN.filter((a) => !cid || a.course_id === cid).map((a) => ({ ...a })));
  }
  if (method === "POST") {
    const row = { id: `new-${++seq}`, ...body };
    ASSIGN.push(row);
    return json(200, { rows: [row] });
  }
  return json(405, { error: "method not allowed" });
}) as unknown as typeof fetch;
const exec = (items: unknown[], ref = "rt") => executeNexusWriteTool({ items }, { ref }) as Promise<{ results: Row[] } & Row>;
const msOf = (d: string) => (resolveDueInstant(d) as { ms: number }).ms;

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log("=== Honesty guard (AC-F2-35) ===");
{
  const fail500 = JSON.stringify({ ok: true, persisted: false, results: [{ index: 0, title: "Research Proposal", action: "failed", persisted: false, error: "http_500" }] });
  const uses = [{ tool: NEXUS_WRITE_TOOL_NAME, ok: false, detail: fail500 }];
  const hasNotSaved = (s: string) => /not saved/i.test(s);
  // W8: a stray denial word elsewhere in the reply must not exempt a false success claim.
  const a = enforceNexusWriteHonesty("Done! Your Research Proposal is in Nexus, and nothing failed.", uses);
  t("RT-H1 'nothing failed' does not launder a false save (W8)", hasNotSaved(a) && !/^Done!/.test(a), true);
  const b = enforceNexusWriteHonesty("All set — I was unable to find any conflicts, so the Research Proposal is saved.", uses);
  t("RT-H2 'unable to find any conflicts' does not launder a false save (W8)", hasNotSaved(b) && !/is saved/.test(b), true);
  // W10: one honest denial about item B must not carry a false claim about item A.
  const mixed = JSON.stringify({ ok: true, persisted: "unknown", results: [
    { index: 0, title: "Final Paper", action: "failed", persisted: "unknown", error: "timeout" },
    { index: 1, title: "Residency 4", action: "rejected", persisted: false, reason: "meeting/session" },
  ] });
  const c = enforceNexusWriteHonesty("Final Paper is saved. Residency 4 wasn't added because it's a meeting.", [{ tool: NEXUS_WRITE_TOOL_NAME, ok: false, detail: mixed }]);
  t("RT-H3 mixed batch: a true denial does not carry a false 'Final Paper is saved' (W10)", /Final Paper is saved/.test(c), false);
  // W11: a success claim the regex does not know is left standing next to "Not saved".
  const d = enforceNexusWriteHonesty("Your Research Proposal is now in Nexus for Oct 30.", uses);
  t("RT-H4 'is now in Nexus' claim is not left standing beside 'Not saved' (W11)", /is now in Nexus/.test(d), false);
  const e = enforceNexusWriteHonesty("I've put the Research Proposal into Nexus.", uses);
  t("RT-H4b 'I've put the Research Proposal into Nexus' is not left standing (W11)", /I've put the Research Proposal into/.test(e), false);

  // W17: the group dispatch's suppressed-duplicate branch records the call with NO detail, so the
  // second agent's reply is checked against nothing. It must carry the outcome it is deferring to.
  const textSrc = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
  const m = /recordToolUse\(winner\.id, c\.name, "Nexus write -- already done this turn"([^)]*)\)/.exec(textSrc);
  const argTail = m?.[1] ?? "";
  // Anchor guard: if the branch is renamed this must not silently read as "no detail".
  if (!m) console.log("  NOTE RT-H5 anchor not found -- re-read the already_done_this_turn branch before trusting RT-H5");
  t("RT-H5 suppressed duplicate write carries the first write's outcome as detail (W17)", argTail.split(",").length >= 3, true);

  // W18: the voice surface has no runtime honesty -- only the tool result's prose note.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(ent.name)) files.push(p);
    }
  };
  walk("src");
  // loop2 D3 (docs/FIX-nexus-write-loop2.md): the voice hook now calls the gate's finalize (the structural
  // nexusWriteGuardedReply) instead of naming enforceNexusWriteHonesty; the check accepts that call site.
  const voiceGuarded = files.filter((f) => {
    if (!/voice|realtime|Voice|Realtime/.test(f)) return false;
    const src = readFileSync(f, "utf8");
    return /enforceNexusWriteHonesty|nexusWriteOutcomeStatement/.test(src) || (/createNexusWriteSpeechGate\(\)/.test(src) && /gate\.finalize\(raw\)/.test(src));
  });
  t("RT-H6 the voice path enforces Nexus write honesty in code (W18)", voiceGuarded.length > 0, true);
}

console.log("=== Dedup (AC-F2-14/15, AC-F1-11..16) ===");
{
  const EX: Row[] = [
    { id: "dp1", title: "Discussion Post", due_date: "2026-11-02T04:59:59.000Z" },
    { id: "rpaper", title: "Research Paper", due_date: "2026-12-10T04:59:59.000Z" },
    { id: "cs", title: "Case Study", due_date: "2026-11-14T04:59:59.000Z" },
  ];
  // W1: a recurring deliverable with one title, a week apart, is a NEW row.
  t("RT-D1 'Discussion Post' Nov 8 is not a duplicate of 'Discussion Post' Nov 2 (W1)", findDuplicate({ title: "Discussion Post", dueMs: msOf("2026-11-08") }, EX)?.row.id ?? "none", "none");
  // W2: same day + word subset is not the same deliverable.
  t("RT-D2a 'Research Paper Peer Review' (Dec 9) is not 'Research Paper' (W2)", findDuplicate({ title: "Research Paper Peer Review", dueMs: msOf("2026-12-09") }, EX)?.row.id ?? "none", "none");
  t("RT-D2b 'Research Paper Presentation' (Dec 9) is not 'Research Paper' (W2)", findDuplicate({ title: "Research Paper Presentation", dueMs: msOf("2026-12-09") }, EX)?.row.id ?? "none", "none");
  t("RT-D2c 'Case Study 2' is not 'Case Study' (W2)", findDuplicate({ title: "Case Study 2", dueMs: msOf("2026-11-13") }, EX)?.row.id ?? "none", "none");

  // W3: two agents in one wave, args differing by one optional field -> one row, not two.
  ASSIGN = [];
  const item = { course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30" };
  await Promise.all([exec([item], "A"), exec([{ ...item, priority: "high" }], "B")]);
  t("RT-D3 concurrent near-identical writes leave ONE row (W3)", ASSIGN.filter((r) => r.title === "Research Proposal").length, 1);

  // W7: an undated stored row must not silently swallow the date the owner just gave.
  ASSIGN = [{ id: "fr", course_id: "c782", title: "Final Reflection", due_date: null }];
  const r7 = await exec([{ course: "MGT-782", title: "Final Reflection", due_date: "2026-12-01" }]);
  const note7 = String(r7.results[0]?.note ?? "");
  t("RT-D4 duplicate of an UNDATED row says the stored row has no date / offers the update (W7)", /no (due )?date|undated|DIFFERENT due date|update/i.test(note7), true);

  // W14: non-Latin titles normalise to "" and never dedup.
  ASSIGN = [];
  const r14 = await exec([{ course: "MGT-782", title: "研究提案", due_date: "2026-10-30" }, { course: "MGT-782", title: "研究提案", due_date: "2026-10-30" }]);
  t("RT-D5 a repeated non-Latin title is a duplicate, not a second insert (W14)", r14.results.map((r) => r.action).join(","), "inserted,duplicate");
}

console.log("=== Kind filter (AC-F2-11, AC-F1-20..23) ===");
{
  // W4: a session that merely mentions a deliverable noun is still a session.
  for (const s of ["Residency 4: present your research proposal", "Kickoff meeting for final project", "Office hours: project Q&A", "Midterm exam review session"]) {
    t(`RT-K1 "${s}" is refused as a meeting (W4)`, classifyNonDeliverable(s), "meeting/session");
  }
  // W5: meeting vocabulary the classifier does not know.
  for (const s of ["Doctoral colloquium 2", "Week 3 class", "Class 5", "Module 3 live call", "Coaching call", "Conference call", "Advising appointment", "Guest speaker", "Study group"]) {
    t(`RT-K2 "${s}" is refused as a meeting (W5)`, classifyNonDeliverable(s), "meeting/session");
  }
  // W6: holidays/admin dates AC-F1-23 says never become assignments.
  for (const s of ["Thanksgiving", "Thanksgiving break", "Labor Day", "Reading week", "Mid-semester break", "Last day to withdraw", "Grades due"]) {
    t(`RT-K3 "${s}" is refused as administrative (W6)`, classifyNonDeliverable(s), "administrative");
  }
  // W12: a reading is not a graded deliverable.
  t(`RT-K4 "Reading: chapter 4" is not filed as an assignment (W12)`, classifyNonDeliverable("Reading: chapter 4") !== null, true);
}

console.log("=== Dates (AC-F2-10, AC-F2-13) ===");
{
  // W9: "11:59 pm EST" on an EDT date means Eastern; a fixed UTC-5 stores it an hour late.
  const est = resolveDueInstant("2026-10-30", "23:59", "EST");
  t("RT-T1 time_zone 'EST' on an EDT date is refused or stored as Eastern 03:59Z (W9)", !est.ok || est.iso === "2026-10-31T03:59:00Z", true);
  // W13: a nonexistent spring-forward local time must never move a deadline EARLIER.
  const gap = resolveDueInstant("2026-03-08", "02:30");
  t("RT-T2 2026-03-08 02:30 ET (DST gap) is refused or resolved forward, never to 01:30 EST (W13)", !gap.ok || gap.ms >= Date.parse("2026-03-08T07:00:00Z"), true);
}

console.log("=== Course resolution (AC-F2-16..19) ===");
{
  const r = resolveCourse("!!!", [{ id: "weird", code: "--", name: "Weird" }]);
  t("RT-C1 a reference that normalises to '' resolves to nothing (W15)", r.ok, false);
}

console.log("=== Points (AC-F2-22) ===");
{
  ASSIGN = [];
  const r = await exec([{ course: "MGT-782", title: "Case Brief", due_date: "2026-11-20", points: 12.5 }]);
  t("RT-P1 non-integer points are refused or reported, not silently dropped (W16)", /points/i.test(JSON.stringify(r.results[0])), true);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
