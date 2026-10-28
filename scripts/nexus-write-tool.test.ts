// WHAT:       Offline proof of the Nexus WRITE tool (`write_nexus_assignments`): config gate, the four
//             registration points, no identity on the wire, the dated-only predicate, DST, meeting
//             refusal, dedup (and its anti-over-match), course-by-code, truthful `persisted`, the
//             reply-honesty guard, write telemetry, and that the READ tools stayed read-only.
// WHY:        Feature 2 of nexus-hub docs/cross-app-agent/AC-syllabus-deliverables-write-tool.md. Every
//             guard here exists because a specific wrong write is cheap to make and expensive to undo:
//             a meeting filed as a deliverable (the owner deleted "Residency 4" by hand), a second
//             "Research Proposal" row, a due date an hour early for ten days a year, a save claimed
//             that never happened.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/BUILD-nexus-write-tool.md (results + mutation verdicts).
//
// OFFLINE ONLY: `fetch` is replaced by an in-memory fake Nexus. Nothing here can reach a real
// Nexus, Huddle, database or board.
//
// Run: npm run test:nexus-write

import {
  nexusWriteTools,
  nexusWriteConfigured,
  executeNexusWriteTool,
  WRITE_NEXUS_ASSIGNMENTS_TOOL,
  NEXUS_WRITE_TOOL_NAME,
  resolveDueInstant,
  classifyNonDeliverable,
  findDuplicate,
  resolveCourse,
  nexusWriteSummary,
  enforceNexusWriteHonesty,
  NEXUS_WRITE_MAX_BATCH,
} from "../src/features/huddle/lib/nexus/nexus-write.server";
import { nexusReadTools, NEXUS_TOOL_NAMES, executeNexusTool } from "../src/features/huddle/lib/nexus/nexus.server";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
// "ok"/"not ok <name>" is load-bearing: scripts/mutate.sh attributes a mutation by `not ok .*<name>`.
const t = (name: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want);
  console.log(`  ${ok ? "ok" : "not ok"} ${name}: ${String(got)}${ok ? "" : `  (EXPECTED ${String(want)})`}`);
  ok ? pass++ : fail++;
};

const OWNER = "owner-uuid-1111";
const TOKEN = "uat-secret-token";
const setEnv = (o: Record<string, string>) => {
  delete process.env.NEXUS_API_URL;
  delete process.env.NEXUS_OWNER_ID;
  delete process.env.UAT_BYPASS_TOKEN;
  Object.assign(process.env, o);
};
const FULL = { NEXUS_API_URL: "https://nexus.test", NEXUS_OWNER_ID: OWNER, UAT_BYPASS_TOKEN: TOKEN };

// ── a fake Nexus ────────────────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
type Call = { method: string; url: URL; headers: Record<string, string>; body: Row | null };
const COURSES: Row[] = [
  { id: "c782", code: "MGT-782", name: "MGT-782-W1 (202711)", program_id: "p-dba", user_id: OWNER },
  { id: "csm", code: null, name: "Strategic Management", program_id: "p-emba", user_id: OWNER },
  { id: "t1", code: "TST-701", name: "Test-course A (202609)", program_id: "p-x", user_id: OWNER },
  { id: "t2", code: "TST 701", name: "Test-course B (202701)", program_id: "p-x", user_id: OWNER },
  { id: "cfx", code: "TST-800", name: "Test-only paper course", program_id: "p-x", user_id: OWNER },
  { id: "cfy", code: "TST-801", name: "Test-other course", program_id: "p-x", user_id: OWNER },
  // a shared demo row owned by someone else -- must never be resolvable
  { id: "demo", code: "MGT-999", name: "Demo course", user_id: "00000000-0000-0000-0000-000000000001" },
];
let ASSIGN: Row[] = [];
const resetAssignments = () => {
  ASSIGN = [
    { id: "aafbf80f-512a-4ea8-892b-0d9c9548c09e", course_id: "c782", title: "Research Proposal", due_date: "2026-10-31T03:59:59.000Z" },
    { id: "6616bef3-0000-0000-0000-000000000000", course_id: "c782", title: "Research Paper", due_date: "2026-12-10T04:59:59.000Z" },
    { id: "4fa0bd96-0000-0000-0000-000000000000", course_id: "c782", title: "Residency participation", due_date: null },
    { id: "only-paper", course_id: "cfx", title: "Research Paper", due_date: "2026-12-10 04:59:59+00" },
    { id: "fy-final", course_id: "cfy", title: "Final Paper", due_date: "2026-12-01T04:59:59.000Z" },
  ];
};
let calls: Call[] = [];
let seq = 0;
type Mode = "normal" | "post200noid" | "post400" | "post500" | "throw" | "timeoutAfterCommit" | "timeout" | "patch404";
let mode: Mode = "normal";

const fakeFetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  const h = init?.headers as Record<string, string> | undefined;
  if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
  const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
  calls.push({ method, url, headers, body });
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  const abort = () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  };
  if (method === "GET") {
    if (url.pathname.endsWith("/api/d1/courses")) return json(200, COURSES);
    if (url.pathname.endsWith("/api/d1/assignments")) {
      const f = JSON.parse(url.searchParams.get("filters") ?? "[]") as [string, string][];
      const cid = f.find(([c]) => c === "course_id")?.[1];
      return json(200, ASSIGN.filter((a) => !cid || a.course_id === cid));
    }
    if (url.pathname.endsWith("/api/d1/programs")) return json(200, []);
    return json(404, { error: "nope" });
  }
  if (mode === "throw") throw new Error("ECONNRESET");
  if (mode === "timeout") abort();
  if (method === "POST") {
    if (mode === "post400") return json(400, { error: "bad" });
    if (mode === "post500") return json(500, { error: "boom" });
    const row = { id: `new-${++seq}`, ...body };
    ASSIGN.push(row);
    if (mode === "timeoutAfterCommit") abort();
    if (mode === "post200noid") return json(200, { rows: [] });
    return json(200, { rows: [row] });
  }
  if (method === "PATCH") {
    if (mode === "patch404") return json(404, { error: "not found or not owned" });
    const id = url.searchParams.get("id");
    const row = ASSIGN.find((a) => a.id === id);
    if (!row) return json(404, { error: "not found or not owned" });
    Object.assign(row, body);
    return json(200, { rows: [row] });
  }
  return json(405, { error: "method not allowed" });
}) as unknown as typeof fetch;
globalThis.fetch = fakeFetch;

const writes = () => calls.filter((c) => c.method !== "GET");
type Res = { ok: boolean; persisted: unknown; error?: string; results: Row[]; inserted?: number };
const run = async (items: unknown[] | Row, ref = "test-ref"): Promise<Res> => {
  calls = [];
  const args = Array.isArray(items) ? { items } : items;
  return (await executeNexusWriteTool(args as Record<string, unknown>, { ref })) as unknown as Res;
};
const r0 = (r: Res) => (r.results?.[0] ?? {}) as Row;

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log("=== AC-F2-30 — unconfigured shows no write tool (4 env permutations) ===");
setEnv({});
t("F2-30 nothing set -> no write tool", nexusWriteTools().length, 0);
setEnv({ NEXUS_API_URL: "https://nexus.test", NEXUS_OWNER_ID: OWNER });
t("F2-30 token missing -> no write tool", nexusWriteTools().length, 0);
t("F2-30 token missing -> the 12 read tools stay", nexusReadTools().length, 12);
setEnv({ NEXUS_API_URL: "https://nexus.test", UAT_BYPASS_TOKEN: TOKEN });
t("F2-30 owner missing -> no write tool", nexusWriteTools().length, 0);
setEnv({ NEXUS_OWNER_ID: OWNER, UAT_BYPASS_TOKEN: TOKEN });
t("F2-30 url missing -> no write tool", nexusWriteTools().length, 0);
t("F2-30 unconfigured executor refuses", ((await executeNexusWriteTool({ items: [] })) as Row).error, "nexus_write_not_configured");
setEnv(FULL);
t("F2-30 all three set -> exactly one write tool", nexusWriteTools().length, 1);
t("F2-30 configured flag", nexusWriteConfigured(), true);

console.log("=== AC-F2-31/32 — all four registration points, in the pool for every agent ===");
const textSrc = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
const voiceSrc = readFileSync("src/features/huddle/lib/voice/realtime-tools.server.ts", "utf8");
const writeSrc = readFileSync("src/features/huddle/lib/nexus/nexus-write.server.ts", "utf8");
const readSrc = readFileSync("src/features/huddle/lib/nexus/nexus.server.ts", "utf8");
t("F2-31 tool name is the shared constant", (WRITE_NEXUS_ASSIGNMENTS_TOOL as { name: string }).name, NEXUS_WRITE_TOOL_NAME);
t("F2-31 (1) text pool spreads the write tools into mergedTools", /\.\.\.nexusTools,\s*\n\s*\.\.\.nexusWriteToolList,/.test(textSrc), true);
t("F2-31 (2) voice toolset pushes the write tools", /raw: unknown\[\][^\n]*\.\.\.nexusWriteTools\(\)/.test(voiceSrc), true);
t("F2-31 (3) text dispatch routes the name to the write executor", /c\.name === nexusWriteMod\.NEXUS_WRITE_TOOL_NAME\)[\s\S]{0,900}executeNexusWriteTool/.test(textSrc), true);
t("F2-31 (4a) voice NATIVE set holds the name (never journey-proxied)", /\.\.\.NEXUS_TOOL_NAMES,\s*\n\s*NEXUS_WRITE_TOOL_NAME,/.test(voiceSrc), true);
t("F2-31 (4b) voice dispatch routes the name to the write executor", /name === NEXUS_WRITE_TOOL_NAME\)[\s\S]{0,200}executeNexusWriteTool/.test(voiceSrc), true);
t("F2-31 read executor's name set does NOT contain the write tool", NEXUS_TOOL_NAMES.has(NEXUS_WRITE_TOOL_NAME), false);
// F2-32: ungated -- the text list is built unconditionally (no capability/agent check on the line).
// F2-42: the 1:1 owner follow-up must take the deterministic prime decision BEFORE the LLM resolver,
// or resolveOwnerLLM can still pass Elle's "update the due date on my research paper" to Eli.
t("F2-42 1:1 follow-up consults primeLaneDecision before the LLM resolver",
  /const prime = capOwnerId \? null : primeLaneDecision\(data\.text, nextId\);[\s\S]{0,400}\} else if \(prime === "keep"\) \{[\s\S]{0,200}\} else if \(prime\) \{\s*deliverIfOwner\(prime\);[\s\S]{0,2000}resolveOwnerLLM/.test(textSrc), true);
t("F2-32 text pool is ungated (no agent/capability condition)", /const nexusWriteToolList = nexusWriteTools\(\) as/.test(textSrc), true);
t("F2-32 voice toolset is ungated (same unconditional raw list as the reads)", /\.\.\.nexusReadTools\(\), \.\.\.nexusWriteTools\(\)\]/.test(voiceSrc), true);

console.log("=== AC-F2-33 — no identity in the schema or on the wire ===");
{
  const itemProps = Object.keys(
    (WRITE_NEXUS_ASSIGNMENTS_TOOL.parameters.properties.items.items as { properties: Row }).properties,
  ).map((k) => k.toLowerCase().replace(/[_-]/g, ""));
  const topProps = Object.keys(WRITE_NEXUS_ASSIGNMENTS_TOOL.parameters.properties).map((k) => k.toLowerCase());
  const bad = [...itemProps, ...topProps].find((k) => ["owner", "ownerid", "userid", "user", "email", "programid", "canvasmeta"].includes(k));
  t("F2-33 schema exposes no identity/program/meta property", bad ?? "none", "none");
  resetAssignments();
  const r = await run({
    owner: "evil-owner",
    user_id: "evil-user",
    items: [{ course: "MGT-782", title: "Test-Identity Probe Paper", due_date: "2026-11-20", owner: "evil", user_id: "evil", userId: "evil", email: "x@y.z", program_id: "evil-prog", canvas_meta: { a: 1 }, id: "forced-id" }],
  });
  const w = writes()[0];
  t("F2-33 the write happened", r0(r).persisted, true);
  const keys = Object.keys(w?.body ?? {}).sort().join(",");
  t("F2-33 outbound body carries only whitelisted keys", keys, "course_id,due_date,program_id,status,title,type");
  t("F2-33 program_id comes from the COURSE row, not the model", w?.body?.program_id, "p-dba");
  t("F2-33 ?owner= is the configured owner, never the model's", w?.url.searchParams.getAll("owner").join("|"), OWNER);
  t("F2-33 X-UAT-Token is the server-held token", w?.headers["x-uat-token"], TOKEN);
  t("F2-33 X-Agent-Tool names the tool (makes the insert undoable in Nexus)", w?.headers["x-agent-tool"], NEXUS_WRITE_TOOL_NAME);
  t("F2-33 X-Agent-Ref carries the caller ref", w?.headers["x-agent-ref"], "test-ref");
}

console.log("=== AC-F2-10/12 — ONE dated-only predicate (10 inputs) ===");
{
  const inputs: [unknown, string][] = [
    [undefined, "undated"], [null, "undated"], ["", "undated"], ["TBD", "undated"],
    ["Week 5", "ambiguous-date"], ["Oct 30", "ambiguous-date"], ["10/30", "ambiguous-date"],
    ["2026-02-30", "ambiguous-date"], ["2026-10-30", "ok"], ["2026-10-30T23:59:00-07:00", "ok"],
  ];
  const vec = inputs.map(([v]) => {
    const d = resolveDueInstant(v);
    return d.ok ? "ok" : d.reason;
  });
  t("F2-10 accept/reject vector", vec.join(","), inputs.map(([, w]) => w).join(","));
  resetAssignments();
  const r = await run([{ course: "MGT-782", title: "Test-Undated Reflection", due_date: "TBD" }]);
  t("F2-10 undated insert is rejected", `${r0(r).action}/${r0(r).reason}`, "rejected/undated");
  t("F2-10 undated insert sends nothing", writes().length, 0);
  const r2 = await run([{ course: "MGT-782", title: "Test-No Year Paper", due_date: "Oct 30" }]);
  t("F2-10 a date with no year is ambiguous-date, never guessed", `${r0(r2).reason}/${writes().length}`, "ambiguous-date/0");
  const r3 = await run([{ assignment_id: "aafbf80f-512a-4ea8-892b-0d9c9548c09e", due_date: null }]);
  t("F2-12 an update cannot make a row undated", `${r0(r3).action}/${r0(r3).reason}/${writes().length}`, "rejected/undated/0");
}

console.log("=== AC-F2-13 / RG-3 — course-local time, DST-correct, zone/offset honoured ===");
{
  const at = (d: string, time = "23:59", tz?: string) => {
    const r = resolveDueInstant(d, time, tz);
    return r.ok ? r.iso : `ERR:${r.reason}`;
  };
  t("RG-3 2026-03-07 23:59 ET (EST, day before the switch)", at("2026-03-07"), "2026-03-08T04:59:00Z");
  t("RG-3 2026-03-09 23:59 ET (EDT)", at("2026-03-09"), "2026-03-10T03:59:00Z");
  t("RG-3 2026-10-30 23:59 ET (EDT)", at("2026-10-30"), "2026-10-31T03:59:00Z");
  t("RG-3 2026-11-01 23:59 ET (EST from 02:00 that day)", at("2026-11-01"), "2026-11-02T04:59:00Z");
  t("RG-3 2026-11-02 23:59 ET (EST)", at("2026-11-02"), "2026-11-03T04:59:00Z");
  t("F2-13 2026-12-09 23:59 ET", at("2026-12-09"), "2026-12-10T04:59:00Z");
  t("F2-13 explicit ISO offset is honoured", at("2026-10-30T23:59:00-07:00"), "2026-10-31T06:59:00Z");
  t("F2-13 a stated zone (PT) is honoured, not overwritten with Eastern", at("2026-10-30", "23:59", "America/Los_Angeles"), "2026-10-31T06:59:00Z");
  const noTime = resolveDueInstant("2026-10-30");
  t("F2-13 no time -> 23:59:59 ET, FLAGGED as assumed", noTime.ok ? `${noTime.iso}/${noTime.timeAssumed}` : "ERR", "2026-10-31T03:59:59Z/true");
  t("F2-13 an unknown zone is refused, not defaulted", (resolveDueInstant("2026-10-30", "23:59", "Mars/Olympus") as { reason?: string }).reason, "ambiguous-date");
  // AC-F1-35: the server zone must not matter.
  const prevTZ = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  t("F2-13 identical under TZ=Asia/Tokyo", at("2026-03-07"), "2026-03-08T04:59:00Z");
  process.env.TZ = "UTC";
  t("F2-13 identical under TZ=UTC", at("2026-11-01"), "2026-11-02T04:59:00Z");
  if (prevTZ === undefined) delete process.env.TZ;
  else process.env.TZ = prevTZ;
}

console.log("=== AC-F2-11 — meetings/sessions and admin dates are refused ===");
{
  resetAssignments();
  const r = await run([{ course: "MGT-782", title: "Residency 4 – present ideas and insights from the readings", due_date: "2026-11-09", due_time: "19:00" }]);
  t("F2-11 Residency 4 is rejected as meeting/session", `${r0(r).action}/${r0(r).reason}`, "rejected/meeting/session");
  t("F2-11 nothing was sent for it", writes().length, 0);
  t("F2-11 the result tells the agent it belongs on the schedule", /SCHEDULE/.test(String(r0(r).note)), true);
  t("F2-11 participation is a meeting, not a deliverable", classifyNonDeliverable("Residency participation"), "meeting/session");
  t("F2-11 office hours / zoom session refused", classifyNonDeliverable("Zoom live session with the professor"), "meeting/session");
  // loop2 D2 (docs/FIX-nexus-write-loop2.md): a meeting word ANYWHERE now wins over a deliverable noun (owner
  // rule), so "Seminar paper" is refused with its reason -- the accepted cost of deny-anywhere. Was: null.
  t("F2-11 a meeting word anywhere wins ('Seminar paper' is refused, loop2 D2)", classifyNonDeliverable("Seminar paper"), "meeting/session");
  t("F2-11 admin date refused", classifyNonDeliverable("Drop deadline"), "administrative");
  t("F2-11 a plain deliverable passes", classifyNonDeliverable("Research Proposal"), "null");
}

console.log("=== AC-F2-14 / AC-F1-11..14 — dedup, and it must NOT over-match ===");
{
  resetAssignments();
  const ID = "aafbf80f-512a-4ea8-892b-0d9c9548c09e";
  let r = await run([{ course: "MGT-782", title: "Research Proposal (20%)", due_date: "2026-10-30", due_time: "23:59" }]);
  t("F2-14 'Research Proposal (20%)' is the stored row", `${r0(r).action}/${r0(r).persisted}/${r0(r).assignment_id}`, `duplicate/false/${ID}`);
  t("F2-14 a duplicate sends nothing", writes().length, 0);
  r = await run([{ course: "MGT-782", title: "Research Paper Proposal", due_date: "2026-10-30", due_time: "23:59" }]);
  t("F1-11 'Research Paper Proposal' (same instant) is the stored 'Research Proposal'", `${r0(r).action}/${r0(r).assignment_id}`, `duplicate/${ID}`);
  r = await run([{ course: "MGT-782", title: "research  proposal", due_date: "2026-10-30" }]);
  t("F1-13 case/whitespace differences dedup", r0(r).action, "duplicate");
  r = await run([{ course: "MGT-782", title: "Research-Proposal", due_date: "2026-10-30" }]);
  t("F1-13 punctuation differences dedup", r0(r).action, "duplicate");
  r = await run([{ course: "TST-800", title: "Research Paper Proposal", due_date: "2026-10-30", due_time: "23:59" }]);
  t("F1-12 'Research Paper Proposal' is NOT swallowed by a different-date 'Research Paper'", `${r0(r).action}/${r0(r).persisted}`, "inserted/true");
  t("F1-12 exactly one POST", writes().filter((w) => w.method === "POST").length, 1);
  r = await run([{ course: "MGT-782", title: "Final Paper", due_date: "2026-11-30" }]);
  t("F1-14 dedup is scoped to ONE course (another course's 'Final Paper' does not block)", r0(r).action, "inserted");
  const direct = findDuplicate({ title: "Research Paper", dueMs: Date.parse("2026-10-31T03:59:00Z") }, [
    { id: "x", title: "Research Paper Proposal", due_date: "2026-12-10T04:59:59Z" },
  ]);
  t("F1-12 subset match needs the SAME instant", direct ? "dup" : "none", "none");
  const weighted = findDuplicate({ title: "Research Proposal (20%)", dueMs: null }, [{ id: "w", title: "Research Proposal", due_date: null }]);
  t("F2-14 a grade weight is not part of the title", weighted ? String(weighted.row.id) : "none", "w");
  resetAssignments();
  r = await run([
    { course: "MGT-782", title: "Test-Same Batch Twice Paper", due_date: "2026-11-15" },
    { course: "MGT-782", title: "Test-Same Batch Twice Paper", due_date: "2026-11-15" },
  ]);
  t("F2-14 an identical second item in ONE batch is a duplicate of the first", `${String(r.results[0].action)}/${String(r.results[1].action)}`, "inserted/duplicate");
}

console.log("=== AC-F2-15 — retry after a client timeout that committed server-side ===");
{
  resetAssignments();
  mode = "timeoutAfterCommit";
  const first = await run([{ course: "MGT-782", title: "Test-Timeout Paper", due_date: "2026-11-20" }]);
  mode = "normal";
  t("F2-15 a timeout is persisted:'unknown', never true or false", r0(first).persisted, "unknown");
  t("F2-15 the unknown result tells the agent to verify", /get_nexus_assignments/.test(String(r0(first).note)), true);
  const createdId = String(ASSIGN.find((a) => a.title === "Test-Timeout Paper")?.id);
  const second = await run([{ course: "MGT-782", title: "Test-Timeout Paper", due_date: "2026-11-20" }]);
  t("F2-15 the retry returns duplicate with the first call's id", `${r0(second).action}/${r0(second).assignment_id}`, `duplicate/${createdId}`);
  t("F2-15 exactly one row exists", ASSIGN.filter((a) => a.title === "Test-Timeout Paper").length, 1);
}

console.log("=== AC-F2-16..19 — course by code, never first-match, never a guess ===");
{
  const owned = COURSES.filter((c) => c.user_id === OWNER);
  for (const ref of ["MGT-782", "mgt 782", "MGT782", "mgt-782", "MGT-782-W1 (202711)"]) {
    const c = resolveCourse(ref, owned);
    t(`F2-16 '${ref}' resolves to MGT-782`, c.ok ? String(c.course.id) : c.error, "c782");
  }
  resetAssignments();
  let r = await run([{ course: "MGT-999", title: "Test-Unknown Course Paper", due_date: "2026-11-20" }]);
  t("F2-17 unknown course (a foreign demo row is NOT his) -> course_not_found", `${r0(r).error}/${writes().length}`, "course_not_found/0");
  t("F2-17 the result lists his courses so the agent can ask", Array.isArray(r0(r).courses) && (r0(r).courses as Row[]).some((c) => c.code === "MGT-782"), true);
  r = await run([{ course: "TST-701", title: "Test-Ambiguous Paper", due_date: "2026-11-20" }]);
  t("F2-18 a duplicated code is course_ambiguous, not the first hit", `${r0(r).error}/${(r0(r).candidates as Row[] | undefined)?.length}/${writes().length}`, "course_ambiguous/2/0");
  t("F2-19 NULL-code course resolves by exact name", (() => { const c = resolveCourse("Strategic Management", owned); return c.ok ? String(c.course.id) : c.error; })(), "csm");
  t("F2-19 a partial name is NOT a containment guess", (() => { const c = resolveCourse("Strategy", owned); return c.ok ? String(c.course.id) : c.error; })(), "course_not_found");
}

console.log("=== AC-F2-20/22 — update is minimal; inserted rows have the F1 shape ===");
{
  resetAssignments();
  let r = await run([{ assignment_id: "6616bef3-0000-0000-0000-000000000000", due_date: "2026-12-11", due_time: "23:59" }]);
  const w = writes()[0];
  t("F2-20 update is a PATCH by id", `${w?.method}/${w?.url.searchParams.get("id")}`, "PATCH/6616bef3-0000-0000-0000-000000000000");
  t("F2-20 PATCH body carries ONLY the changed field", Object.keys(w?.body ?? {}).join(","), "due_date");
  t("F2-20 the new instant is course-local", w?.body?.due_date, "2026-12-12T04:59:00Z");
  t("F2-20 PATCH also names the tool (pre-image actor)", w?.headers["x-agent-tool"], NEXUS_WRITE_TOOL_NAME);
  t("F2-20 update reported persisted:true", `${r0(r).action}/${r0(r).persisted}`, "updated/true");
  mode = "patch404";
  r = await run([{ assignment_id: "someone-elses", title: "Test-x paper" }]);
  mode = "normal";
  t("F2-20 a foreign/absent id -> not_found, persisted:false", `${r0(r).error}/${r0(r).persisted}`, "not_found/false");
  resetAssignments();
  r = await run([{ course: "MGT-782", title: "Test-Shape Paper", due_date: "2026-11-21", description: "AI Writing tools are not permitted for any stage. 20% of the grade.", points: 20.5 }]);
  const b = writes()[0]?.body ?? {};
  t("F2-22 type=assignment, status=active", `${b.type}/${b.status}`, "assignment/active");
  t("F2-22 course_id + program_id from the course row", `${b.course_id}/${b.program_id}`, "c782/p-dba");
  t("F2-22 a non-integer 'points' (a weight) is NOT sent as points", "points" in b, false);
  t("F2-22 policy/weight text kept verbatim in description", b.description, "AI Writing tools are not permitted for any stage. 20% of the grade.");
}

console.log("=== AC-F2-23 — batch semantics ===");
{
  resetAssignments();
  const r = await run([
    { course: "MGT-782", title: "Test-Batch One Paper", due_date: "2026-11-22" },
    { course: "MGT-782", title: "Test-Batch Two Paper", due_date: "Week 5" },
    { course: "MGT-782", title: "Test-Batch Three Paper", due_date: "2026-11-24" },
  ]);
  t("F2-23 per-item persisted flags", r.results.map((x) => String(x.persisted)).join(","), "true,false,true");
  t("F2-23 item 2 rejected, the others inserted", r.results.map((x) => String(x.action)).join(","), "inserted,rejected,inserted");
  t("F2-23 top-level persisted is not true when any item failed", r.persisted, false);
  const big = Array.from({ length: NEXUS_WRITE_MAX_BATCH + 1 }, (_, i) => ({ course: "MGT-782", title: `Test-Big ${i}`, due_date: "2026-11-25" }));
  const rb = await run(big);
  t("F2-23 over the limit -> batch_too_large", rb.error, "batch_too_large");
  t("F2-23 over the limit -> NO request at all", calls.length, 0);
}

console.log("=== AC-F2-34 — `persisted` is truthful on every outcome ===");
{
  const shapes: [Mode, string][] = [
    ["normal", "true/-"], ["post200noid", "false/no_row_id_in_response"], ["post400", "false/http_400"],
    ["post500", "false/http_500"], ["throw", "false/network_error"], ["timeout", "unknown/timeout"],
  ];
  for (const [m, want] of shapes) {
    resetAssignments();
    mode = m;
    const r = await run([{ course: "MGT-782", title: `Test-Persist ${m} Paper`, due_date: "2026-11-26" }]);
    mode = "normal";
    t(`F2-34 ${m} -> persisted/error`, `${String(r0(r).persisted)}/${String(r0(r).error ?? "-")}`, want);
  }
}

console.log("=== AC-F2-35 — the runtime refuses a success claim on a failed write ===");
{
  const failed = { ok: true, persisted: false, results: [{ index: 0, title: "Test-Research Proposal", action: "failed", persisted: false, error: "http_500" }] };
  const use = [{ tool: NEXUS_WRITE_TOOL_NAME, ok: false, detail: JSON.stringify(failed) }];
  const claim = enforceNexusWriteHonesty("Done — I've added your Research Proposal for MGT-782, due Oct 30.", use);
  t("F2-35 a success claim is REPLACED, not decorated", /added|Done/.test(claim), false);
  t("F2-35 the replacement states it was not saved", /Not saved to Nexus/.test(claim), true);
  const silent = enforceNexusWriteHonesty("Here's what I found about MGT-782.", use);
  t("F2-35 a silent reply gets the failure appended", /Not saved to Nexus/.test(silent) && silent.startsWith("Here's"), true);
  const honest = "I couldn't save that one — Nexus returned an error.";
  t("F2-35 a reply that already admits it is left alone", enforceNexusWriteHonesty(honest, use), honest);
  const ok = { ok: true, persisted: true, results: [{ index: 0, title: "X", action: "inserted", persisted: true }] };
  const fine = "Added it.";
  t("F2-35 a real save is left alone", enforceNexusWriteHonesty(fine, [{ tool: NEXUS_WRITE_TOOL_NAME, ok: true, detail: JSON.stringify(ok) }]), fine);
  const dup = { ok: true, persisted: false, results: [{ index: 0, title: "X", action: "duplicate", persisted: false }] };
  const already = "That's already on your list.";
  t("F2-35 a duplicate is not a failure", enforceNexusWriteHonesty(already, [{ tool: NEXUS_WRITE_TOOL_NAME, ok: false, detail: JSON.stringify(dup) }]), already);
  // loop2 D3: the runtime guard is now the structural nexusWriteGuardedReply (was enforceNexusWriteHonesty).
  t("F2-35 the guard is applied in the reply assembly", /const safeText = nexusWriteGuardedReply\(/.test(textSrc), true);
}

console.log("=== AC-F2-36 — telemetry says WRITE ===");
{
  const s1 = nexusWriteSummary({ ok: true, persisted: true, inserted: 1, updated: 0, duplicate: 0, results: [{ action: "inserted", persisted: true }] });
  t("F2-36 success label", `${s1.summary}/${s1.ok}`, "Nexus write: 1 inserted, 0 updated/true");
  const s2 = nexusWriteSummary({ ok: true, persisted: false, inserted: 0, updated: 0, duplicate: 0, results: [{ action: "rejected", persisted: false, reason: "course_not_found", error: "course_not_found" }] });
  t("F2-36 failure label + ok:false", `${s2.summary}/${s2.ok}`, "Nexus write FAILED: 0 inserted, 0 updated, not saved: course_not_found/false");
  const s3 = nexusWriteSummary({ ok: false, error: "batch_too_large" });
  t("F2-36 tool-level failure", `${s3.summary}/${s3.ok}`, "Nexus write FAILED: batch_too_large/false");
  t("F2-36 the text dispatch records the write summary, not the read label", /nexusWriteSummary\(out\);\s*\n[^\n]*\n[^\n]*\n\s*recordToolUse\(winner\.id, c\.name, summary, ok, JSON\.stringify\(out\)\)/.test(textSrc), true);
}

console.log("=== AC-F2-37 / RG-6 / RG-2 — reads stay read-only; no DELETE anywhere ===");
{
  t("RG-6 nexusFetch is still a bare GET", readSrc.includes("const res = await fetch(url.toString(), { signal: controller.signal });"), true);
  t("RG-6 the read module carries no token", /UAT_BYPASS_TOKEN|X-UAT-Token|x-uat-token/.test(readSrc.replace(/^\s*\/\/.*$/gm, "")), false);
  t("RG-6 the read module sends no method", /method\s*:/.test(readSrc.replace(/^\s*\/\/.*$/gm, "")), false);
  t("RG-6 nexusReadTools() still returns exactly 12", nexusReadTools().length, 12);
  calls = [];
  await executeNexusTool("get_nexus_courses", {}, "UTC");
  t("RG-6 a read with the token configured sends no headers and no method", calls.every((c) => c.method === "GET" && Object.keys(c.headers).length === 0), true);
  t("RG-2 the write module has no DELETE", /DELETE/.test(writeSrc.replace(/^\s*\/\/.*$/gm, "")), false);
  t("RG-2 the write module's methods are POST and PATCH only", [...new Set([...writeSrc.matchAll(/nexusWriteFetch\("([A-Z]+)"/g)].map((m) => m[1]))].sort().join(","), "PATCH,POST");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
