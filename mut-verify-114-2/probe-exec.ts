// WHAT:       Verifier probe (VERIFY-nexus-write-tool-2): drives classifyNonDeliverable and executeNexusWriteTool
//             against an in-memory fake Nexus with loop-2 attacks: canonicalisation of deny words, deny/allow
//             vocabulary edges, the course-zone dedup day, intra-batch repeats, injection into the new paths.
// WHY:        C2/C5/C9 of verify loop 2 for PR #114; inputs chosen by the verifier, not the builder.
// SUPERSEDES: nothing (loop-1 equivalent: mut-verify-114/probe-exec.ts).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-nexus-write-tool-2.md. OFFLINE: fetch is replaced; nothing leaves the box.
// Run: bun mut-verify-114-2/probe-exec.ts
import { executeNexusWriteTool, classifyNonDeliverable, nexusWriteClaimKey } from "../src/features/huddle/lib/nexus/nexus-write.server";

type Row = Record<string, unknown>;
const OWNER = "owner-uuid-1111";
Object.assign(process.env, { NEXUS_API_URL: "https://nexus.test", NEXUS_OWNER_ID: OWNER, UAT_BYPASS_TOKEN: "srv-token" });
const COURSES: Row[] = [{ id: "c782", code: "MGT-782", name: "MGT-782-W1 (202711)", program_id: "p-dba", user_id: OWNER }];
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

const run = async (items: Row[]) => {
  calls = [];
  return (await executeNexusWriteTool({ items }, { ref: "probe" })) as Row;
};
const posts = () => calls.filter((c) => c.method === "POST").length;
const brief = (o: Row) =>
  ((o.results as Row[]) ?? [{ error: o.error }]).map((r) => `${r.action}/${String(r.persisted)}${r.reason ? `/${r.reason}` : ""}${r.error ? `/${r.error}` : ""}${r.due_date ? ` ${r.due_date}` : ""}`).join(" | ");

const main = async () => {
  console.log("== C2 deny canonicalisation (expect meeting/session or event, NEVER null) ==");
  const DENY = [
    "Residency4, present your research proposal",
    "Residency_4: present your research proposal",
    "ResidencyIV: present your research proposal",
    "Ｒｅｓｉｄｅｎｃｙ 4: present your research proposal",
    "Office-hours: bring your proposal draft",
    "Oﬃce hours: bring your proposal draft",
    "Office hours: bring your proposal draft",
    "Office  hours: bring your proposal draft",
    "Residence weekend: present your research proposal",
    "Weekend intensive: present your research proposal",
    "Doctoral consortium: present your research proposal",
    "Academic conference: present your paper",
    "Cohort gathering: bring your case analysis",
    "On-campus residency week 2: research proposal presentation",
    "Re­sidency 4: present your research proposal",
  ];
  for (const t of DENY) console.log(`  ${JSON.stringify(t)} -> ${classifyNonDeliverable(t)}`);

  console.log("== C2/C9 over-rejection of real graded deliverables (expect null) ==");
  const ALLOW = [
    "Program evaluation report",
    "Case analysis: Stripe payments",
    "Literature review: tuition pricing models",
    "Holiday retail sales analysis",
    "Final paper: lessons from the Delta Air Lines trip to bankruptcy",
    "Business plan: corporate retreat startup",
    "Class participation reflection paper",
    "Breakeven analysis memo",
    "Team project: Ford plant visit report",
  ];
  for (const t of ALLOW) console.log(`  ${JSON.stringify(t)} -> ${classifyNonDeliverable(t)}`);

  console.log("== C2 dedup in the COURSE zone regardless of input zone ==");
  const D: Array<[string, Row]> = [
    ["Z instant same ET day", { title: "Research Proposal", due_date: "2026-10-30T12:00:00Z" }],
    ["Z instant same ET day + time_zone Asia/Tokyo", { title: "Research Proposal", due_date: "2026-10-30T12:00:00Z", time_zone: "Asia/Tokyo" }],
    ["plain date + time_zone America/Los_Angeles", { title: "Research Proposal", due_date: "2026-10-30", time_zone: "America/Los_Angeles" }],
    ["plain date + time_zone PST", { title: "Research Proposal", due_date: "2026-10-30", time_zone: "PST" }],
    ["plain date + time_zone UTC (23:59:59Z = Oct 30 ET)", { title: "Research Proposal", due_date: "2026-10-30", time_zone: "UTC" }],
    ["plain date + time_zone Europe/London", { title: "Research Proposal", due_date: "2026-10-30", time_zone: "Europe/London" }],
    ["full-width title", { title: "Ｒｅｓｅａｒｃｈ Ｐｒｏｐｏｓａｌ", due_date: "2026-10-30" }],
    ["hyphen + trailing period", { title: "research-proposal.", due_date: "2026-10-30" }],
    ["weight '(20% of final grade)'", { title: "Research Proposal (20% of final grade)", due_date: "2026-10-30" }],
    ["'Research Proposal - 20%' ", { title: "Research Proposal - 20%", due_date: "2026-10-30" }],
  ];
  for (const [label, it] of D) {
    reset();
    const o = await run([{ course: "MGT-782", ...it }]);
    console.log(`  ${label} -> ${brief(o)}  POSTs=${posts()}`);
  }
  reset();
  let o = await run([
    { course: "MGT-782", title: "Discussion Post", due_date: "2026-11-09" },
    { course: "MGT-782", title: "Discussion Post", due_date: "2026-11-09" },
  ]);
  console.log(`  same new item twice in ONE batch -> ${brief(o)}  POSTs=${posts()}`);
  reset();
  o = await run([
    { course: "MGT-782", title: "Discussion Post", due_date: "2026-11-09" },
    { course: "MGT-782", title: "Discussion Post", due_date: "2026-11-10T03:00:00Z" },
  ]);
  console.log(`  same course day, plain vs Z (Nov 9 22:00 ET) in ONE batch -> ${brief(o)}  POSTs=${posts()}`);
  console.log(`  claim keys equal (plain vs Z, same course day): ${nexusWriteClaimKey({ items: [{ course: "MGT-782", title: "Discussion Post", due_date: "2026-11-09" }] }) === nexusWriteClaimKey({ items: [{ course: "MGT-782", title: "Discussion Post", due_date: "2026-11-10T03:00:00Z" }] })}`);
  reset();
  o = await run([{ course: "MGT-782", title: "Discussion Post", due_date: "2026-07-15", time_zone: "EST" }]);
  console.log(`  EST in July (DST) -> ${brief(o)} (expect 2026-07-16T03:59:59Z)`);
  reset();
  o = await run([{ course: "MGT-782", title: "Discussion Post", due_date: "2026-12-09", time_zone: "EDT" }]);
  console.log(`  EDT in December -> ${brief(o)} (expect 2026-12-10T04:59:59Z)`);
  reset();
  o = await run([{ course: "MGT-782", title: "Discussion Post", due_date: "2026-12-09", time_zone: "Eastern Standard Time" }]);
  console.log(`  "Eastern Standard Time" (Windows/Graph name) -> ${brief(o)}`);

  console.log("== C5 re-check: identity keys in the loop-2 paths ==");
  reset();
  o = await run([{ course: "MGT-782", title: "Case Brief 9", due_date: "2026-11-20", time_zone: "America/New_York&owner=evil", owner: "evil", user_id: "evil" } as Row]);
  console.log(`  time_zone with '&owner=evil' -> ${brief(o)}  POSTs=${posts()}  owners=${JSON.stringify(calls.map((c) => c.url.searchParams.getAll("owner")))}`);
  reset();
  o = await run([{ course: "MGT-782&owner=evil", title: "Case Brief 9", due_date: "2026-11-20" } as Row]);
  console.log(`  course with '&owner=evil' -> ${brief(o)}  POSTs=${posts()}  owners=${JSON.stringify(calls.map((c) => c.url.searchParams.getAll("owner")))}`);
  reset();
  o = await run([{ course: "MGT-782", title: "Case Brief 9\", \"user_id\": \"evil", due_date: "2026-11-20", description: "x\",\"owner\":\"evil" } as Row]);
  const pb = calls.find((c) => c.method === "POST")?.body;
  console.log(`  JSON-ish title/description -> ${brief(o)}  body keys=${JSON.stringify(Object.keys(pb ?? {}))} owner in body=${pb ? "owner" in pb || "user_id" in pb : "n/a"}`);
};
await main();
