// WHAT:       Verifier probe (VERIFY-nexus-write-tool-1): drives executeNexusWriteTool against an
//             in-memory fake Nexus and prints each result, for C2 (owner rules), C5 (identity/url/
//             headers) and C9 (new adversarial inputs).
// WHY:        Independent re-measurement of PR #114; inputs chosen by the verifier, not the builder.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-1.md. OFFLINE: fetch is replaced; nothing leaves the box.
// Run: bun mut-verify-114/probe-exec.ts
import {
  executeNexusWriteTool,
  resolveDueInstant,
  classifyNonDeliverable,
} from "../src/features/huddle/lib/nexus/nexus-write.server";

type Row = Record<string, unknown>;
const OWNER = "owner-uuid-1111";
Object.assign(process.env, { NEXUS_API_URL: "https://nexus.test", NEXUS_OWNER_ID: OWNER, UAT_BYPASS_TOKEN: "srv-token" });
const COURSES: Row[] = [
  { id: "c782", code: "MGT-782", name: "MGT-782-W1 (202711)", program_id: "p-dba", user_id: OWNER },
];
let ASSIGN: Row[] = [];
const reset = () => {
  ASSIGN = [
    { id: "aafbf80f", course_id: "c782", title: "Research Proposal", due_date: "2026-10-31T03:59:59.000Z" },
    { id: "6616bef3", course_id: "c782", title: "Research Paper", due_date: "2026-12-10T04:59:59.000Z" },
    { id: "post1", course_id: "c782", title: "Discussion Post", due_date: "2026-11-03T04:59:59.000Z" },
  ];
};
type Call = { method: string; url: URL; headers: Record<string, string>; body: Row | null };
let calls: Call[] = [];
let seq = 0;
let postMode: "ok" | "500" = "ok";
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = String(v);
  const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
  calls.push({ method, url, headers, body });
  const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
  if (method === "GET") {
    if (url.pathname.endsWith("/courses")) return json(200, COURSES);
    if (url.pathname.endsWith("/assignments")) {
      const f = JSON.parse(url.searchParams.get("filters") ?? "[]") as [string, string][];
      const cid = f.find(([c]) => c === "course_id")?.[1];
      return json(200, ASSIGN.filter((a) => !cid || a.course_id === cid));
    }
    return json(404, {});
  }
  if (method === "POST") {
    if (postMode === "500") return json(500, { error: "boom" });
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

const run = async (items: Row[] | Row) => {
  calls = [];
  const args = Array.isArray(items) ? { items } : items;
  const out = (await executeNexusWriteTool(args, { ref: "probe" })) as Row;
  return out;
};
const brief = (o: Row) =>
  ((o.results as Row[]) ?? [{ error: o.error }]).map((r) => `${r.action}/${String(r.persisted)}${r.reason ? `/${r.reason}` : ""}${r.error ? `/${r.error}` : ""}${r.due_date ? ` ${r.due_date}` : ""}`).join(" | ");

const main = async () => {
  console.log("== C2 dates (resolveDueInstant) ==");
  const D: Array<[unknown, unknown, unknown]> = [
    ["2026-10-30", "23:59", undefined], ["2026-10-30", "23:59", "EST"], ["2026-10-30", "23:59", "ET"],
    ["2026-12-09", "23:59", "EST"], ["2026-03-07", "23:59", "ET"], ["2026-03-08", "23:59", "ET"],
    ["2026-11-01", "01:30", "ET"], ["2026-03-08", "02:30", "ET"], ["2026-10-30T23:59:00-07:00", undefined, undefined],
    [null, undefined, undefined], ["", undefined, undefined], ["TBD", undefined, undefined], ["Week 5", undefined, undefined],
    ["Oct 30", undefined, undefined], ["10/30", undefined, undefined], ["2026-02-30", undefined, undefined],
    ["2026-10-30T23:59:00+0530", undefined, undefined], ["2026-10-30", "11:59 PM", "ET"], ["2026-10-30", "23:59", "E.S.T."],
    ["2026-10-30", "23:59", "Eastern Standard Time"], ["2026-10-30", "23:59", "MST"], ["2026-10-30", "23:59", "US/Eastern"],
  ];
  for (const [d, t, z] of D) console.log(`  ${JSON.stringify([d, t, z])} -> ${JSON.stringify(resolveDueInstant(d, t, z))}`);

  console.log("== C2/C9 classification ==");
  const T = [
    "Research Proposal", "Final exam", "Residency 4: present your research proposal", "Residency 4 – present ideas and insights from the readings",
    "Residency 4, present your research proposal", "Residency 4 present your research proposal", "Residency 4. Present your research proposal",
    "Residency 4 / present your research proposal", "Present your research proposal at Residency 4", "Office hours with Prof. Lee",
    "Thanksgiving", "Spring Recess", "Tuition payment due", "Annual research symposium", "Networking dinner", "Pre-read: Porter Five Forces (HBR 1979)",
    "Readings for week 3", "Chapter 4 problem set", "Holiday Inn case study", "Spring break reflection paper", "Thanksgiving reflection essay",
    "Read and respond: chapter 4", "Course evaluations due", "Field trip to Ford plant", "Weekly discussion post",
  ];
  for (const t of T) console.log(`  ${JSON.stringify(t)} -> ${classifyNonDeliverable(t)}`);

  console.log("== C2 dedup (executor, fake Nexus) ==");
  reset();
  let o = await run([{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30", due_time: "12:00", time_zone: "ET" }]);
  console.log(`  same title, same ET day, different time -> ${brief(o)}`);
  reset();
  o = await run([{ course: "MGT-782", title: "research proposal (20%)", due_date: "2026-10-30", due_time: "23:59", time_zone: "EST" }]);
  console.log(`  "(20%)" + EST same day -> ${brief(o)}`);
  reset();
  o = await run([
    { course: "mgt 782", title: "Discussion Post", due_date: "2026-11-09" },
    { course: "MGT782", title: "Discussion Post", due_date: "2026-11-16" },
    { course: "MGT-782", title: "Discussion Post", due_date: "2026-11-02" },
  ]);
  console.log(`  recurring Discussion Post 11-09, 11-16 (new) and 11-02 (stored) -> ${brief(o)}`);
  reset();
  o = await run([{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30T20:00:00Z" }]);
  console.log(`  C9: "Research Proposal" given as a Z instant on the SAME ET day (Oct 30 16:00 ET) -> ${brief(o)}  POSTs=${calls.filter((c) => c.method === "POST").length}`);
  reset();
  o = await run([{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-30T16:00:00-04:00" }]);
  console.log(`  same instant written with -04:00 -> ${brief(o)}  POSTs=${calls.filter((c) => c.method === "POST").length}`);
  reset();
  o = await run([{ course: "MGT-782", title: "Research Proposal", due_date: "2026-10-31" }]);
  console.log(`  same title, next day (Oct 31 ET) -> ${brief(o)}`);

  console.log("== C2 refusals through the executor ==");
  reset();
  o = await run([
    { course: "MGT-782", title: "Residency 4: present your research proposal", due_date: "2026-11-09", due_time: "19:00" },
    { course: "MGT-782", title: "Thanksgiving", due_date: "2026-11-26" },
    { course: "MGT-782", title: "Last day to withdraw", due_date: "2026-11-20" },
    { course: "MGT-782", title: "Reading: Porter chapter 4", due_date: "2026-11-05" },
    { course: "MGT-782", title: "Case Brief 3", due_date: null },
    { course: "MGT-782", title: "Case Brief 3", due_date: "Week 5" },
    { course: "MGT-782", title: "Weekly zoom session", due_date: "2026-11-05" },
  ]);
  console.log(`  ${brief(o)}  POSTs=${calls.filter((c) => c.method === "POST").length}`);

  console.log("== C5 identity / url / headers ==");
  reset();
  o = await run({
    owner: "evil-owner", user_id: "evil", email: "x@evil", url: "https://evil.test", headers: { "X-UAT-Token": "evil" }, table: "courses",
    items: [{
      course: "MGT-782", title: "Case Brief 7", due_date: "2026-11-12", owner: "evil-owner", user_id: "evil", userId: "evil", email: "e@x",
      program_id: "evil-prog", id: "forced-id", course_id: "evil-course", canvas_meta: { a: 1 }, output_format: "copy", sheet_row_number: 9,
      status: "deleted", type: "quiz", nested: { owner: "evil" },
    }],
  });
  const post = calls.find((c) => c.method === "POST")!;
  console.log(`  result: ${brief(o)}`);
  console.log(`  POST url: ${post.url.toString()}  owner params: ${JSON.stringify(post.url.searchParams.getAll("owner"))}`);
  console.log(`  POST headers: ${JSON.stringify(post.headers)}`);
  console.log(`  POST body: ${JSON.stringify(post.body)}`);
  reset();
  o = await run([{ assignment_id: "aafbf80f&owner=evil&id=6616bef3", due_date: "2026-11-02", owner: "evil" }]);
  const patch = calls.find((c) => c.method === "PATCH");
  console.log(`  PATCH with injected assignment_id -> ${brief(o)}; url=${patch?.url.toString()} owner=${JSON.stringify(patch?.url.searchParams.getAll("owner"))} id=${JSON.stringify(patch?.url.searchParams.getAll("id"))}`);
  reset();
  o = await run([{ assignment_id: "aafbf80f", due_date: null }]);
  console.log(`  update due_date:null -> ${brief(o)} writes=${calls.filter((c) => c.method !== "GET").length}`);
  const gets = calls.filter((c) => c.method === "GET");
  console.log(`  every GET carries owner=${OWNER}: ${calls.every((c) => c.url.searchParams.get("owner") === OWNER)}`);
  void gets;
  reset();
  o = await run({ items: Array.from({ length: 26 }, (_, i) => ({ course: "MGT-782", title: `Case Brief ${i}`, due_date: "2026-11-12" })) });
  console.log(`  26 items -> ${String(o.error)} writes=${calls.filter((c) => c.method !== "GET").length}`);
};
main();
