// WHAT:       Every reproduction from the independent verifier's loop-2 report (D6-D11, H1-H15, V-a..V-c and the
//             out-of-radius OQ-2 update note), pinned as tests against loop 3's structural fixes:
//             D7 kind filter on a canonical title; item 6 unchanged stored title on UPDATE; D8 dedup day in the
//             COURSE's zone; D6 coursework context = the owner's REAL course list (+ vetoes first);
//             D10/D11 code-built turn replies + saved list + resume state; D9 voice buffering.
// WHY:        docs/VERIFY-nexus-write-tool-2.md REFUTED C1-C4/C9: every loop-2 defence was a word list and
//             leaked on the next spelling. Each test here is a verifier input or the mechanism behind it.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-loop3.md (RESPONDS TO docs/VERIFY-nexus-write-tool-2.md); verifier probes
//             in mut-verify-114-2/.
//
// OFFLINE ONLY: `fetch` is an in-memory fake Nexus. Nothing reaches a real Nexus, Huddle, DB or board.
// Run: bun scripts/nexus-write-loop3.test.ts

import {
  executeNexusWriteTool,
  classifyNonDeliverable,
  canonicalTitle,
  nexusWriteClaimKey,
  resolveDueInstant,
} from "../src/features/huddle/lib/nexus/nexus-write.server";
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
// The owner's courses. c-la carries a time_zone column Nexus does not have today: it proves the course's own
// zone (when Nexus has one) is what the dedup day uses -- never the model's time_zone argument.
const COURSES: Row[] = [
  { id: "c782", code: "MGT-782", name: "MGT-782-W1 (202711)", program_id: "p-dba", user_id: OWNER },
  { id: "c702", code: "MGT-702", name: "Strategic Management", program_id: "p-dba", user_id: OWNER },
  { id: "c-la", code: "OPS-610", name: "Operations West", program_id: "p-dba", user_id: OWNER, time_zone: "America/Los_Angeles" },
];
let ASSIGN: Row[] = [];
type Call = { method: string; url: URL; body: Row | null };
let calls: Call[] = [];
let seq = 0;
const resetStore = () => {
  calls = [];
  ASSIGN = [
    { id: "aafbf80f", course_id: "c782", title: "Research Proposal", due_date: "2026-10-31T03:59:59.000Z" },
    { id: "6616bef3", course_id: "c782", title: "Research Paper", due_date: "2026-12-10 04:59:59+00" },
    { id: "resid-1", course_id: "c782", title: "Residency participation", due_date: "2026-11-09T04:59:59.000Z" },
    // Oct 30 16:00 Pacific = Oct 30 19:00 Eastern.
    { id: "la-1", course_id: "c-la", title: "Ops Memo", due_date: "2026-10-30T23:00:00.000Z" },
  ];
};
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
  calls.push({ method, url, body });
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (method === "GET") {
    if (url.pathname.endsWith("/api/d1/courses")) return json(200, COURSES);
    if (url.pathname.endsWith("/api/d1/assignments")) {
      const f = JSON.parse(url.searchParams.get("filters") ?? "[]") as [string, string][];
      const cid = f.find(([c]) => c === "course_id")?.[1];
      const id = f.find(([c]) => c === "id")?.[1];
      return json(200, ASSIGN.filter((a) => (!cid || a.course_id === cid) && (!id || a.id === id)).map((a) => ({ ...a })));
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
const exec = (items: unknown[]) => executeNexusWriteTool({ items }, { ref: "loop3" }) as Promise<{ results: Row[] } & Row>;
const posts = () => calls.filter((c) => c.method === "POST").length;
const patches = () => calls.filter((c) => c.method === "PATCH");

const main = async () => {
  console.log("=== D7: the kind filter reads a CANONICAL title (no raw-spelling escape) ===");
  {
    // The verifier's D7a-D7i inputs, plus the probe's two extras, verbatim (escapes keep the invisible ones visible).
    const DENY: Array<[string, string]> = [
      ["Residency4, present your research proposal", "meeting/session"],
      ["Residency_4: present your research proposal", "meeting/session"],
      ["ResidencyIV: present your research proposal", "meeting/session"],
      ["Ｒｅｓｉｄｅｎｃｙ 4: present your research proposal", "meeting/session"],
      ["Office-hours: bring your proposal draft", "meeting/session"],
      ["Oﬃce hours: bring your proposal draft", "meeting/session"],
      ["Office hours: bring your proposal draft", "meeting/session"],
      ["Office  hours: bring your proposal draft", "meeting/session"],
      ["Re­sidency 4: present your research proposal", "meeting/session"],
      ["Residence weekend: present your research proposal", "meeting/session"],
      ["Weekend intensive: present your research proposal", "meeting/session"],
      ["Doctoral consortium: present your research proposal", "meeting/session"],
      ["Academic conference: present your paper", "meeting/session"],
      ["Cohort gathering: bring your case analysis", "meeting/session"],
      ["On-campus residency week 2: research proposal presentation", "meeting/session"],
      // more invisible / spacing spellings the brief names
      ["Resi​dency 4: present your research proposal", "meeting/session"],
      ["Resi‍dency 4: present your research proposal", "meeting/session"],
      ["Resi‌dency 4: present your research proposal", "meeting/session"],
      ["Residency⁠IV: present your research proposal", "meeting/session"],
      ["Office hours: bring your proposal draft", "meeting/session"],
      ["Office.hours, bring your proposal draft", "meeting/session"],
      ["RESIDENCY/4 research proposal", "meeting/session"],
      ["Session2: proposal draft", "meeting/session"],
      ["SeminarIII reflection paper", "meeting/session"],
      // the extended deny vocabulary
      ["Annual summit: present your research paper", "event"],
      ["Retreat reflection paper", "event"],
      ["Convocation essay", "event"],
      ["Commencement speech essay", "administrative"],
      ["Immersion week: case analysis", "meeting/session"],
    ];
    for (const [s, why] of DENY) t(`L3-D7a ${JSON.stringify(s)} is refused (${why})`, classifyNonDeliverable(s), why);
    // canonicalTitle itself (the one form every rule reads)
    for (const [s, want] of [
      ["Residency4, present", "residency 4 present"],
      ["ResidencyIV: x", "residency iv x"],
      ["Ｒｅｓｉｄｅｎｃｙ 4", "residency 4"],
      ["Oﬃce hours", "office hours"],
      ["Re­si​den⁠cy", "residency"],
      ["a_b/c.d,e:f-g", "a b c d e f g"],
      ["  Case   Brief\t7 ", "case brief 7"],
      ["Civic paper", "civic paper"],
    ] as Array<[string, string]>) {
      t(`L3-D7b canonicalTitle(${JSON.stringify(s)})`, canonicalTitle(s), want);
    }
    // Real deliverables still pass the canonical rules.
    for (const s of ["Research Proposal", "Case Brief 7", "Break-even analysis", "Civic engagement paper", "Chapter 4 problem set", "研究提案", "Ｒｅｓｅａｒｃｈ Ｐｒｏｐｏｓａｌ", "Test 2"]) {
      t(`L3-D7c ${JSON.stringify(s)} is still accepted`, classifyNonDeliverable(s), "null");
    }
    // Through the executor: refused with a reason, 0 POSTs.
    resetStore();
    const r = await exec([
      { course: "MGT-782", title: "Residency4, present your research proposal", due_date: "2026-11-09" },
      { course: "MGT-782", title: "Oﬃce hours: bring your proposal draft", due_date: "2026-11-10" },
    ]);
    t("L3-D7d executor refuses both canonical spellings, 0 POSTs", `${r.results.map((x) => x.reason).join(",")}/${posts()}`, "meeting/session,meeting/session/0");
  }

  console.log("=== Item 6: an UPDATE passing the row's EXISTING title unchanged is not re-judged ===");
  {
    resetStore();
    let r = await exec([{ assignment_id: "resid-1", title: "Residency participation", due_date: "2026-11-10" }]);
    const p = patches()[0];
    t("L3-K6a unchanged stored meeting-titled row + new date -> updated, persisted", `${r.results[0].action}/${r.results[0].persisted}`, "updated/true");
    t("L3-K6b ...the PATCH carries only the date (the unchanged title is not re-sent)", Object.keys(p?.body ?? {}).join(","), "due_date");
    resetStore();
    r = await exec([{ assignment_id: "resid-1", title: "residency  participation", due_date: "2026-11-10" }]);
    t("L3-K6c the same title in another spelling is still 'unchanged'", `${r.results[0].action}/${r.results[0].persisted}`, "updated/true");
    resetStore();
    r = await exec([{ assignment_id: "resid-1", title: "Residency 5 participation" }]);
    t("L3-K6d a CHANGED meeting title is still refused, 0 PATCH", `${r.results[0].reason}/${patches().length}`, "meeting/session/0");
    resetStore();
    r = await exec([{ assignment_id: "aafbf80f", title: "Office hours prep" }]);
    t("L3-K6e a deliverable row renamed to a meeting is refused, 0 PATCH", `${r.results[0].reason}/${patches().length}`, "meeting/session/0");
    resetStore();
    r = await exec([{ assignment_id: "aafbf80f", due_date: "2026-11-02" }]);
    t("L3-K6f an update with no title reports the STORED title and course (for the saved list)", `${r.results[0].title}/${(r.results[0].course as Row | undefined)?.code}`, "Research Proposal/MGT-782");
    t("L3-K6g ...and its date in the course zone", /Nov 2, 2026, 11:59 PM EST/.test(String(r.results[0].due_local)), true);
  }

  console.log("=== D8: the dedup day is the COURSE's zone; the model's time_zone only interprets an offset-less date ===");
  {
    const dupCase = async (label: string, item: Row, want: string) => {
      resetStore();
      const r = await exec([{ course: "MGT-782", title: "Research Proposal", ...item }]);
      t(label, `${r.results[0].action}/${posts()}`, want);
    };
    await dupCase("L3-D8a verifier repro: Z instant + time_zone Asia/Tokyo on the stored ET day -> duplicate, 0 POSTs", { due_date: "2026-10-30T12:00:00Z", time_zone: "Asia/Tokyo" }, "duplicate/0");
    await dupCase("L3-D8b verifier repro: plain date + time_zone Europe/London -> duplicate, 0 POSTs", { due_date: "2026-10-30", time_zone: "Europe/London" }, "duplicate/0");
    await dupCase("L3-D8c plain date + America/Los_Angeles (Oct 31 02:59 ET) is still the WRITTEN Oct 30 row", { due_date: "2026-10-30", time_zone: "America/Los_Angeles" }, "duplicate/0");
    await dupCase("L3-D8d plain date + PST", { due_date: "2026-10-30", time_zone: "PST" }, "duplicate/0");
    await dupCase("L3-D8e plain date + UTC", { due_date: "2026-10-30", time_zone: "UTC" }, "duplicate/0");
    await dupCase("L3-D8f Z instant + Pacific/Kiritimati (already Oct 31 there) is the ET Oct 30 row", { due_date: "2026-10-30T15:00:00Z", time_zone: "Pacific/Kiritimati" }, "duplicate/0");
    await dupCase("L3-D8g the next ET day is still a separate insert (W1 recurring)", { due_date: "2026-10-31" }, "inserted/1");
    await dupCase("L3-D8h a Z instant on the next ET day + time_zone Pacific/Honolulu (still Oct 30 there) -> inserted", { due_date: "2026-10-31T12:00:00Z", time_zone: "Pacific/Honolulu" }, "inserted/1");
    // The course's own zone decides, when the course carries one (c-la, America/Los_Angeles).
    resetStore();
    let r = await exec([{ course: "OPS-610", title: "Ops Memo", due_date: "2026-10-31T05:00:00Z", time_zone: "America/New_York" }]);
    t("L3-D8i a course WITH a zone: Oct 30 22:00 PT is that course's Oct 30 -> duplicate (ET would say Oct 31)", `${r.results[0].action}/${posts()}`, "duplicate/0");
    // Labels are course-local too.
    resetStore();
    r = await exec([{ course: "MGT-782", title: "Case Brief 9", due_date: "2026-11-20", time_zone: "Asia/Tokyo" }]);
    t("L3-D8j due_local is in the COURSE zone (Nov 20 23:59:59 JST = 9:59 AM EST)", String(r.results[0].due_local), "Fri, Nov 20, 2026, 9:59 AM EST");
    // The per-turn claim key agrees, whatever time_zone the model passed.
    const key = (it: Row) => nexusWriteClaimKey({ items: [{ course: "MGT-782", title: "Research Proposal", ...it }] });
    t("L3-D8k claim key: plain date with or without a time_zone is the same", key({ due_date: "2026-10-30", time_zone: "America/Los_Angeles" }) === key({ due_date: "2026-10-30" }), true);
    t("L3-D8l claim key: an ISO instant with or without a time_zone is the same", key({ due_date: "2026-10-30T12:00:00Z", time_zone: "Asia/Tokyo" }) === key({ due_date: "2026-10-30T12:00:00Z" }), true);
    const iso = resolveDueInstant("2026-10-30T12:00:00Z", undefined, "Asia/Tokyo");
    t("L3-D8m resolveDueInstant ignores time_zone for an ISO instant (zone reported = default)", iso.ok && `${iso.zone}/${iso.writtenDay ?? "none"}`, "America/New_York/none");
    const plain = resolveDueInstant("2026-10-30", undefined, "Asia/Tokyo");
    t("L3-D8n ...and USES it to interpret a plain date (23:59:59 JST = 14:59:59Z), keeping the written day", plain.ok && `${plain.iso}/${plain.writtenDay}`, "2026-10-30T14:59:59Z/2026-10-30");
    const bad = resolveDueInstant("2026-10-30T12:00:00Z", undefined, "America/New_York&owner=evil");
    t("L3-D8o a garbage time_zone is still refused (validated, never silently dropped)", bad.ok ? "ok" : bad.reason, "ambiguous-date");
    const src = readFileSync("src/features/huddle/lib/nexus/nexus-write.server.ts", "utf8");
    t("L3-D8p runNexusWrite dedups in courseZoneOf(course), never due.zone", /const dayZone = courseZoneOf\(course\);\s*\n\s*const dup = findDuplicate\(\{ title, dueMs: due\.ms, zone: dayZone, writtenDay: due\.writtenDay \}, existing\);/.test(src) && !/zone: due\.zone/.test(src), true);
  }
};

await main();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
