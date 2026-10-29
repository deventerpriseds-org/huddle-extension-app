// WHAT:       Verifier probe (VERIFY-nexus-write-tool-3): loop-3 attacks on the canonicalised kind filter (D7),
//             the course-zone dedup + "written day" key (D8), the stored-title UPDATE rule (item 6), the
//             executor's exception surface (does executeNexusWriteTool ever THROW? the voice path turns a throw
//             into {error,tool}), and a C5 re-check through the new stored-row read.
// WHY:        C2/C5/C9 of verify loop 3 for PR #114; inputs chosen by the verifier, not the builder.
// SUPERSEDES: nothing (loop-2 equivalent: mut-verify-114-2/probe-exec.ts).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-3.md. OFFLINE: fetch is replaced; nothing leaves the box.
// Run: bun mut-verify-114-3/probe-exec.ts
import { executeNexusWriteTool, classifyNonDeliverable, canonicalTitle } from "../src/features/huddle/lib/nexus/nexus-write.server";

type Row = Record<string, unknown>;
const OWNER = "owner-uuid-1111";
Object.assign(process.env, { NEXUS_API_URL: "https://nexus.test", NEXUS_OWNER_ID: OWNER, UAT_BYPASS_TOKEN: "srv-token" });
let COURSES: Row[] = [{ id: "c782", code: "MGT-782", name: "MGT-782-W1 (202711)", program_id: "p-dba", user_id: OWNER }];
let ASSIGN: Row[] = [];
const reset = () => {
  ASSIGN = [
    { id: "aafbf80f", course_id: "c782", title: "Research Proposal", due_date: "2026-10-31T03:59:59.000Z" },
    { id: "post1", course_id: "c782", title: "Discussion Post", due_date: "2026-11-03T04:59:59.000Z" },
    { id: "res1", course_id: "c782", title: "Residency participation", due_date: "2026-11-20T04:59:59.000Z" },
  ];
};
type Call = { method: string; url: URL; body: Row | null };
let calls: Call[] = [];
let seq = 0;
let mode: "ok" | "garbage-rows" = "ok";
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
  calls.push({ method, url, body });
  const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
  if (method === "GET") {
    if (url.pathname.endsWith("/courses")) return json(200, mode === "garbage-rows" ? [{ id: 5, code: null, name: { x: 1 }, user_id: OWNER }, ...COURSES] : COURSES);
    if (url.pathname.endsWith("/assignments")) {
      const f = JSON.parse(url.searchParams.get("filters") ?? "[]") as [string, string][];
      const cid = f.find(([c]) => c === "course_id")?.[1];
      const id = f.find(([c]) => c === "id")?.[1];
      const rows = ASSIGN.filter((a) => (!cid || a.course_id === cid) && (!id || a.id === id));
      return json(200, mode === "garbage-rows" ? [{ id: "g", course_id: cid, title: null, due_date: 12345 }, { id: "h", course_id: cid, title: 7, due_date: "not a date" }, ...rows] : rows);
    }
    return json(404, {});
  }
  if (method === "POST") {
    const row = { id: `new-${++seq}`, ...body };
    ASSIGN.push(row);
    return json(200, { rows: [row] });
  }
  if (method === "PATCH") {
    const row = ASSIGN.find((a) => a.id === url.searchParams.get("id"));
    if (!row) return json(404, { error: "nf" });
    Object.assign(row, body);
    return json(200, { rows: [row] });
  }
  return json(405, {});
}) as unknown as typeof fetch;

const runArgs = async (args: Row) => {
  calls = [];
  return (await executeNexusWriteTool(args, { ref: "probe" })) as Row;
};
const run = (items: unknown[]) => runArgs({ items });
const writes = () => calls.filter((c) => c.method !== "GET").length;
const brief = (o: Row) =>
  ((o.results as Row[]) ?? [{ error: o.error }]).map((r) => `${r.action}/${String(r.persisted)}${r.reason ? `/${r.reason}` : ""}${r.error ? `/${r.error}` : ""}${r.due_date ? ` ${r.due_date}` : ""}${r.due_local ? ` [${r.due_local}]` : ""}`).join(" | ");

const main = async () => {
  console.log("== D7 NEW canonicalisation / vocabulary attacks (meeting/event titles; expect NON-null) ==");
  for (const t of [
    "Rеsidency 4: present your research proposal", // Cyrillic е U+0435
    "Οffice hours: bring your proposal draft", // Greek Omicron U+039F
    "ResidencyFour: present your research proposal",
    "Residancy 4: present your research proposal", // misspelling as in a syllabus typo
    "Residential week 2: present your research proposal", // UK programmes call residencies "residentials"
    "Synchronous meetup: present your research proposal",
    "Mtg 4: present your proposal draft",
    "Town hall: bring your proposal draft",
    "Virtual huddle: share your project draft",
    "Live Zoom: present your research proposal",
    "Residency four - present research proposal",
    "R E S I D E N C Y 4: present your research proposal",
    "On-campus intensive (Res. 4): present your proposal",
    "Res. 4: present your research proposal",
    "In-residence: present your research proposal",
  ]) console.log(`  ${JSON.stringify(t)} -> ${classifyNonDeliverable(t)}   canon=${JSON.stringify(canonicalTitle(t))}`);

  console.log("== D7 real deliverables (expect null) -- over-rejection check on the NEW vocabulary ==");
  for (const t of [
    "Cohort analysis paper", "Weekend reflection paper", "Conference paper submission", "Final project: summit pricing case",
    "Case study: Ritz-Carlton retreat strategy", "Research proposal (Session 3 deliverable)", "Week 5 discussion post",
    "Module 3 quiz", "Peer review of Class 2 proposals", "Capstone presentation", "Midterm exam",
  ]) console.log(`  ${JSON.stringify(t)} -> ${classifyNonDeliverable(t)}`);

  console.log("== D7 executor end-to-end: 0 writes for a refused title ==");
  reset();
  for (const t of ["Residency4, present your research proposal", "Ｒｅｓｉｄｅｎｃｙ 4: present your research proposal"]) {
    const o = await run([{ course: "MGT-782", title: t, due_date: "2026-11-21" }]);
    console.log(`  ${JSON.stringify(t)} -> ${brief(o)} writes=${writes()}`);
  }

  console.log("== item 6: UPDATE carrying the stored title ==");
  reset();
  for (const [label, it] of [
    ["stored title, new date", { assignment_id: "res1", title: "Residency participation", due_date: "2026-11-21" }],
    ["stored title + trailing period", { assignment_id: "res1", title: "Residency participation.", due_date: "2026-11-22" }],
    ["stored title in Cyrillic-е (looks identical)", { assignment_id: "res1", title: "Rеsidency participation", due_date: "2026-11-23" }],
    ["rename a deliverable to a meeting", { assignment_id: "aafbf80f", title: "Residency 4 kickoff", due_date: "2026-11-01" }],
    ["update unknown id", { assignment_id: "nope", title: "Research Proposal", due_date: "2026-11-01" }],
  ] as [string, Row][]) {
    const o = await run([it]);
    const patch = calls.find((c) => c.method === "PATCH");
    console.log(`  ${label} -> ${brief(o)} writes=${writes()} patchBody=${patch ? JSON.stringify(patch.body) : "-"}`);
  }

  console.log("== D8 course-zone dedup + written-day key: new inputs ==");
  for (const [label, it] of [
    ["Discussion Post plain 11-01 + LA (= Nov 2 02:59 ET; stored post is Nov 2 ET)", { course: "MGT-782", title: "Discussion Post", due_date: "2026-11-01", time_zone: "America/Los_Angeles" }],
    ["Discussion Post plain 11-02 (written day = stored ET day)", { course: "MGT-782", title: "Discussion Post", due_date: "2026-11-02" }],
    ["Discussion Post plain 11-03 + Pacific/Kiritimati (= Nov 3 04:59 ET)", { course: "MGT-782", title: "Discussion Post", due_date: "2026-11-03", time_zone: "Pacific/Kiritimati" }],
    ["Research Proposal plain 10-29 + Pacific/Pago_Pago (= Oct 30 06:59 ET)", { course: "MGT-782", title: "Research Proposal", due_date: "2026-10-29", time_zone: "Pacific/Pago_Pago" }],
    ["Research Proposal 10-30T23:59 no zone", { course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30T23:59" }],
    ["Research Proposal 10-31T00:30-04:00 (Oct 31 ET)", { course: "MGT-782", title: "Research Proposal", due_date: "2026-10-31T00:30:00-04:00" }],
    ["Research Proposal due_date 10-30 + due_time 23:59 + Asia/Tokyo", { course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30", due_time: "23:59", time_zone: "Asia/Tokyo" }],
  ] as [string, Row][]) {
    reset();
    const o = await run([it]);
    console.log(`  ${label} -> ${brief(o)} writes=${writes()}`);
  }

  console.log("== THROW surface of executeNexusWriteTool (voice turns a throw into {error,tool}) ==");
  reset();
  const weird: [string, Row][] = [
    ["items [null,5,'x',[]]", { items: [null, 5, "x", []] }],
    ["title object", { items: [{ course: "MGT-782", title: { a: 1 }, due_date: "2026-11-21" }] }],
    ["numeric due_date", { items: [{ course: "MGT-782", title: "Paper X", due_date: 20261121 }] }],
    ["object due_date", { items: [{ course: "MGT-782", title: "Paper X", due_date: { y: 2026 } }] }],
    ["array time_zone", { items: [{ course: "MGT-782", title: "Paper X", due_date: "2026-11-21", time_zone: ["America/New_York"] }] }],
    ["numeric course", { items: [{ course: 782, title: "Paper X", due_date: "2026-11-21" }] }],
    ["items not array (object)", { items: { title: "Paper X" } }],
    ["assignment_id number", { items: [{ assignment_id: 5, title: "Paper X", due_date: "2026-11-21" }] }],
    ["points NaN/Infinity", { items: [{ course: "MGT-782", title: "Paper Y", due_date: "2026-11-21", points: Infinity }] }],
    ["due_time garbage", { items: [{ course: "MGT-782", title: "Paper Z", due_date: "2026-11-21", due_time: "25:99" }] }],
    ["huge title", { items: [{ course: "MGT-782", title: "Paper ".repeat(5000), due_date: "2026-11-21" }] }],
    ["description object", { items: [{ course: "MGT-782", title: "Paper W", due_date: "2026-11-21", description: { x: 1 } }] }],
  ];
  for (const [label, args] of weird) {
    try {
      const o = await runArgs(args);
      console.log(`  ${label} -> returned ${brief(o)} writes=${writes()}`);
    } catch (e) {
      console.log(`  ${label} -> THREW ${String(e)}`);
    }
  }
  mode = "garbage-rows";
  for (const [label, args] of [
    ["garbage course/assignment rows from Nexus: add", { items: [{ course: "MGT-782", title: "Paper Q", due_date: "2026-11-21" }] }],
    ["garbage rows: update", { items: [{ assignment_id: "aafbf80f", due_date: "2026-11-02" }] }],
  ] as [string, Row][]) {
    try {
      const o = await runArgs(args);
      console.log(`  ${label} -> returned ${brief(o)} writes=${writes()}`);
    } catch (e) {
      console.log(`  ${label} -> THREW ${String(e)}`);
    }
  }
  mode = "ok";

  console.log("== C5 through the new stored-row read ==");
  reset();
  const o = await run([{ assignment_id: "aafbf80f&owner=evil", due_date: "2026-11-02", owner: "evil", user_id: "evil" }]);
  console.log(`  injected id -> ${brief(o)}; every request owner params: ${JSON.stringify(calls.map((c) => [c.method, c.url.searchParams.getAll("owner")]))}`);
  console.log(`  GET ids: ${JSON.stringify(calls.filter((c) => c.method === "GET").map((c) => c.url.searchParams.get("filters")))}`);
};
main();
