// WHAT:       Proves the three Nexus read tools are reachable from BOTH live surfaces, that the
//             owner id can never come from a tool argument, and that an empty result is reported as
//             empty rather than as "you're all caught up".
// WHY:        Three failure modes, each with a precedent in this repo.
//             (1) VOICE DRIFT. realtime-tools.server.ts records NINE native tools that exist on text
//                 and are silently absent when spoken -- a name missing from its NATIVE set is
//                 proxied to journey, where it does not exist, and fails as "the tool is broken".
//                 There is no telemetry on that path. The drift is always one-directional.
//             (2) OWNER SPOOFING. Nexus authorises these reads from an ?owner=<uuid> it does not
//                 verify. If an agent could pass that id, any prompt could read any user's
//                 coursework by guessing a UUID.
//             (3) CONFIDENT EMPTY ANSWER. A correct pipeline and a broken one both return no rows,
//                 so an agent that says "you're caught up!" is indistinguishable from one whose
//                 query is broken. (This comment used to cite "534 assignments, ZERO due in the
//                 future" as though it were structural. It EXPIRED -- two were due in the future on
//                 2026-09-08. A count of live data is true on its measurement date only.)
//             (4) A NAMED ASSIGNMENT MATCHING SEVERAL. The owner names one in words; if the tool
//                 picks between matches, it can draft against the wrong course and look correct
//                 doing it. Ambiguity must come back as a QUESTION.
//             (5) BATCH TWO (Part 7): the same ambiguity trap on two more axes -- "module 3" is
//                 unique only WITHIN a course, and "last week's lecture" is a WINDOW that routinely
//                 holds several classes -- plus two shapes that only source-reading settles: slide
//                 notes are keyed by page_number (nothing writes slide_number), and three capture
//                 tables have created_at and NO updated_at while d1 whitelists `updated_at` as a
//                 name on every table, so an order on it is accepted and then fails in Postgres.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   the NATIVE-set comment at realtime-tools.server.ts:450; CAP-nexus §2.1 (unverified
//             owner parameter); SCENARIOS.md A-READ-2 (the zero-future-due-dates measurement).
//
// Run: npm run test:nexus-tools

import {
  nexusReadTools,
  nexusReadConfigured,
  NEXUS_TOOL_NAMES,
  executeNexusTool,
  GET_NEXUS_ASSIGNMENTS_TOOL,
  GET_NEXUS_SLIDE_NOTES_TOOL,
} from "../src/features/huddle/lib/nexus/nexus.server";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want);
  console.log(`  ${ok ? "✔" : "✘"} ${name}: ${got}${ok ? "" : `  (EXPECTED ${want})`}`);
  ok ? pass++ : fail++;
};

const setEnv = (o: Record<string, string>) => {
  delete process.env.NEXUS_API_URL;
  delete process.env.NEXUS_OWNER_ID;
  Object.assign(process.env, o);
};

console.log("=== PART 1 — configuration gate: no tools unless BOTH are set ===");
setEnv({});
t("nothing set -> not configured", nexusReadConfigured(), false);
t("nothing set -> zero tools", nexusReadTools().length, 0);
setEnv({ NEXUS_API_URL: "https://x" });
t("url only -> zero tools", nexusReadTools().length, 0);
setEnv({ NEXUS_OWNER_ID: "abc" });
t("owner only -> zero tools", nexusReadTools().length, 0);
setEnv({ NEXUS_API_URL: "https://x", NEXUS_OWNER_ID: "abc" });
t("both set -> eight tools", nexusReadTools().length, 8);

console.log("=== PART 2 — VOICE DRIFT: every tool defined on text is reachable on voice ===");
const voiceSrc = readFileSync("src/features/huddle/lib/voice/realtime-tools.server.ts", "utf8");
const textSrc = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
t("voice imports the shared definitions", voiceSrc.includes("nexusReadTools"), true);
t("voice pushes them into its toolset", /raw: unknown\[\][^\n]*nexusReadTools\(\)/.test(voiceSrc), true);
t("voice adds them to NATIVE (else journey-proxied)", voiceSrc.includes("...NEXUS_TOOL_NAMES"), true);
t("voice dispatches them", voiceSrc.includes("NEXUS_TOOL_NAMES.has(name)"), true);
t("text pushes them into mergedTools", textSrc.includes("...nexusTools"), true);
t("text dispatches them", textSrc.includes("NEXUS_TOOL_NAMES.has(c.name)"), true);
t("both surfaces call the SAME executor", voiceSrc.includes("executeNexusTool") && textSrc.includes("executeNexusTool"), true);

console.log("=== PART 3 — the owner id is NOT reachable from a tool argument ===");
const names = new Set(Object.keys(GET_NEXUS_ASSIGNMENTS_TOOL.parameters.properties));
t("assignments schema has no 'owner'", names.has("owner"), false);
t("assignments schema has no 'user_id'", names.has("user_id"), false);
for (const tool of nexusReadTools() as { name: string; parameters: { properties: Record<string, unknown> } }[]) {
  const keys = Object.keys(tool.parameters.properties).map((k) => k.toLowerCase().replace(/[_-]/g, ""));
  const leak = keys.find((k) => ["owner", "userid", "user", "email", "ownerid"].includes(k));
  t(`${tool.name} exposes no identity parameter`, leak ?? "none", "none");
}

console.log("=== PART 4 — every failure returns ok:false; empty is reported as EMPTY ===");
setEnv({});
t("unconfigured", ((await executeNexusTool("get_nexus_courses", {}, "UTC")) as { error?: string }).error, "nexus_not_configured");
setEnv({ NEXUS_API_URL: "https://x", NEXUS_OWNER_ID: "abc" });
const origFetch = globalThis.fetch;

globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
t("upstream 500", ((await executeNexusTool("get_nexus_courses", {}, "UTC")) as { error?: string }).error, "http_500");

globalThis.fetch = (async () => {
  throw new Error("boom");
}) as typeof fetch;
t("network error", ((await executeNexusTool("get_nexus_courses", {}, "UTC")) as { error?: string }).error, "network_error");

let sentUrl = "";
globalThis.fetch = (async (u: string) => {
  sentUrl = String(u);
  return new Response(JSON.stringify([]), { status: 200 });
}) as unknown as typeof fetch;
const empty = (await executeNexusTool("get_nexus_assignments", { due_within_days: 7 }, "UTC")) as {
  ok: boolean;
  count: number;
  note?: string;
};
t("empty result is ok:true", empty.ok, true);
t("empty result reports count 0", empty.count, 0);
t("empty result carries the do-not-say-caught-up note", !!empty.note && empty.note.includes("caught up"), true);
t("owner rides in the query string", sentUrl.includes("owner=abc"), true);
t("a due bound produces a date filter", sentUrl.includes("due_date"), true);

globalThis.fetch = (async () =>
  new Response(JSON.stringify([{ id: "2", due_date: "2026-10-02" }, { id: "1", due_date: "2026-09-09" }]), {
    status: 200,
  })) as typeof fetch;
const rows = (await executeNexusTool("get_nexus_assignments", {}, "UTC")) as {
  count: number;
  note?: string;
  assignments: { id: string }[];
};
t("rows counted", rows.count, 2);
t("sorted by due date, soonest first", rows.assignments[0].id, "1");
t("no caught-up note when rows exist", rows.note ?? "none", "none");

globalThis.fetch = origFetch;

console.log("=== PART 5 — an unknown name is refused, not silently proxied ===");
t("unknown tool", ((await executeNexusTool("get_nexus_everything", {}, "UTC")) as { error?: string }).error, "unknown_nexus_tool_get_nexus_everything");
t("NEXUS_TOOL_NAMES has exactly 8", NEXUS_TOOL_NAMES.size, 8);
t(
  "every advertised tool is dispatchable (no definition without a name entry)",
  (nexusReadTools() as { name: string }[]).filter((x) => !NEXUS_TOOL_NAMES.has(x.name)).length,
  0,
);

console.log("=== PART 6 — a named assignment: the title filter, and ASKING when several match ===");
setEnv({ NEXUS_API_URL: "https://nexus.example", NEXUS_OWNER_ID: "owner-uuid" });

t(
  "the schema exposes a title parameter at all",
  Object.prototype.hasOwnProperty.call(GET_NEXUS_ASSIGNMENTS_TOOL.parameters.properties, "title"),
  true,
);

// The filter must reach the SERVER as an ilike, not be applied after fetching everything.
let seenUrl = "";
globalThis.fetch = (async (u: string) => {
  seenUrl = String(u);
  return new Response(JSON.stringify([{ id: "1", title: "Discussion Board 1", due_date: "2026-09-07" }]), { status: 200 });
}) as unknown as typeof fetch;
const one = (await executeNexusTool(
  "get_nexus_assignments",
  { title: "Discussion Board 1" },
  "UTC",
)) as { count: number; note?: string; needs_disambiguation?: boolean };
t("title reaches the server as an ilike filter", /ilike\.%Discussion\+Board\+1%|ilike\.%25Discussion/.test(decodeURIComponent(seenUrl)) || decodeURIComponent(seenUrl).includes("ilike.%Discussion Board 1%"), true);
t("one match does NOT ask for disambiguation", one.needs_disambiguation ?? false, false);
t("one match carries no note", one.note ?? "none", "none");

// SEVERAL matches -> a question, never a pick. This is the assertion the owner asked for.
globalThis.fetch = (async () =>
  new Response(
    JSON.stringify([
      { id: "1", title: "Introductions", course_id: "c1", due_date: "2026-09-10" },
      { id: "2", title: "Discussion Board 1 - Introduce Yourself", course_id: "c2", due_date: "2026-09-07" },
    ]),
    { status: 200 },
  )) as typeof fetch;
const many = (await executeNexusTool(
  "get_nexus_assignments",
  { title: "introduc" },
  "UTC",
)) as { count: number; note?: string; needs_disambiguation?: boolean };
t("several matches are all returned", many.count, 2);
t("several matches FLAG disambiguation", many.needs_disambiguation, true);
t("the directive names COURSE as the thing to ask about", /which COURSE/.test(many.note ?? ""), true);
t("the directive forbids acting before he answers", /do not act on any of them/.test(many.note ?? ""), true);

// A stray wildcard must not widen the search back to everything and look like it worked.
seenUrl = "";
globalThis.fetch = (async (u: string) => {
  seenUrl = String(u);
  return new Response(JSON.stringify([]), { status: 200 });
}) as unknown as typeof fetch;
await executeNexusTool("get_nexus_assignments", { title: "%" }, "UTC");
t("a bare wildcard is stripped, so no title filter is sent", decodeURIComponent(seenUrl).includes("title"), false);

globalThis.fetch = origFetch;

console.log("=== PART 7 — batch two: modules, slide notes, lecture capture, library, transcript ===");
setEnv({ NEXUS_API_URL: "https://nexus.example", NEXUS_OWNER_ID: "owner-uuid" });

let calls: string[] = [];
const route = (map: Record<string, unknown>) =>
  (async (u: string) => {
    const url = decodeURIComponent(String(u));
    calls.push(url);
    for (const [k, v] of Object.entries(map)) if (url.includes(k)) return new Response(JSON.stringify(v), { status: 200 });
    return new Response(JSON.stringify([]), { status: 200 });
  }) as unknown as typeof fetch;

// --- A-READ-7: "module 3" matches one module per course, so several matches must ASK.
calls = [];
globalThis.fetch = route({
  "/api/d1/modules": [
    { id: "m1", course_id: "c1", module_number: 3, name: "Process Design" },
    { id: "m2", course_id: "c2", module_number: 3, name: "Pricing" },
  ],
  "/api/d1/courses": [{ id: "c1", name: "Ops Management" }, { id: "c2", name: "Corporate Finance" }],
});
const modsMany = (await executeNexusTool("get_nexus_module_materials", { module_number: 3 }, "UTC")) as {
  needs_disambiguation?: boolean;
  modules: { course_name: string | null }[];
  note?: string;
};
t("two modules match -> disambiguation", modsMany.needs_disambiguation, true);
t("the ask carries the COURSE NAME, not a bare uuid", modsMany.modules[0].course_name, "Ops Management");
t("the directive names COURSE", /which COURSE/.test(modsMany.note ?? ""), true);
t(
  "ambiguous -> the module's CONTENTS were never fetched",
  calls.some((u) => u.includes("module-items") || u.includes("course-materials")),
  false,
);

// --- one module -> its items and its materials, both filtered by module_id, both ordered on a
//     column that physically exists on that table.
calls = [];
globalThis.fetch = route({
  "/api/d1/modules": [{ id: "m1", course_id: "c1", module_number: 3, name: "Process Design" }],
  "/api/d1/courses": [{ id: "c1", name: "Ops Management" }],
  "/api/d1/module-items": [{ id: "i1", title: "Read chapter 4", type: "File", position: 1 }],
  "/api/d1/course-materials": [{ id: "f1", title: "Chapter 4.pdf" }],
});
const modOne = (await executeNexusTool(
  "get_nexus_module_materials",
  { module_number: 3, course_id: "c1" },
  "UTC",
)) as { item_count: number; material_count: number; needs_disambiguation?: boolean; note?: string };
t("one module -> no disambiguation", modOne.needs_disambiguation ?? false, false);
t("its ordered item spine is read", modOne.item_count, 1);
t("its filed materials are read", modOne.material_count, 1);
t(
  "items are filtered by module_id server-side",
  calls.some((u) => u.includes("module-items") && u.includes('["module_id","eq.m1"]')),
  true,
);
t(
  "items are ordered by position (a column module_items actually has)",
  calls.some((u) => u.includes("module-items") && u.includes("order=position")),
  true,
);

// --- A-READ-9: notes are keyed by PAGE. slide_number is in the table and in d1's allow-list and is
//     written by nothing (DocumentViewer.tsx handleNoteSave), so offering it would return zero rows
//     for every real note while looking like a working search.
const slideProps = Object.keys(GET_NEXUS_SLIDE_NOTES_TOOL.parameters.properties);
t("slide notes expose page_number", slideProps.includes("page_number"), true);
t("slide notes do NOT expose slide_number", slideProps.includes("slide_number"), false);

calls = [];
globalThis.fetch = route({
  "/api/d1/course-materials": [
    { id: "f1", title: "Strategy deck week 1" },
    { id: "f2", title: "Strategy deck week 2" },
  ],
});
const decksMany = (await executeNexusTool("get_nexus_slide_notes", { deck_title: "strategy deck" }, "UTC")) as {
  needs_disambiguation?: boolean;
  note?: string;
};
t("two decks match -> disambiguation", decksMany.needs_disambiguation, true);
t("ambiguous deck -> no annotations were read", calls.some((u) => u.includes("slide-annotations")), false);

calls = [];
globalThis.fetch = route({
  "/api/d1/course-materials": [{ id: "f1", title: "Strategy deck week 1" }],
  "/api/d1/slide-annotations": [],
});
const noteMiss = (await executeNexusTool(
  "get_nexus_slide_notes",
  { deck_title: "strategy deck", page_number: 14 },
  "UTC",
)) as { count: number; note?: string };
t("'slide 14' becomes a page_number filter", calls.some((u) => u.includes('["page_number","eq.14"]')), true);
t("an empty page is reported as empty", noteMiss.count, 0);
t("and is NOT reported as 'you never annotated it'", /page 14 .*no note|Nothing is noted on page 14/.test(noteMiss.note ?? ""), true);

// --- A-READ-10: a session IS a class_schedules row, and a week routinely holds several classes.
calls = [];
globalThis.fetch = route({
  "/api/d1/class-schedules": [
    { id: "s1", course_name: "Ops Management", date: "2026-09-02" },
    { id: "s2", course_name: "Corporate Finance", date: "2026-09-04" },
  ],
});
const capMany = (await executeNexusTool("get_nexus_lecture_capture", {}, "UTC")) as {
  needs_disambiguation?: boolean;
  from?: string;
  to?: string;
  note?: string;
};
const today = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
const weekAgoD = new Date();
weekAgoD.setDate(weekAgoD.getDate() - 7);
const weekAgo = weekAgoD.toLocaleDateString("en-CA", { timeZone: "UTC" });
t("the default window ends today", capMany.to, today);
t("the default window starts 7 days back ('last week')", capMany.from, weekAgo);
t("two sessions in the window -> disambiguation", capMany.needs_disambiguation, true);
t("no transcript was read while ambiguous", calls.some((u) => u.includes("lecture-transcripts-segments")), false);

calls = [];
globalThis.fetch = route({
  "/api/d1/lecture-transcripts-segments": [{ id: "g1", segment_number: 1, text: "welcome" }],
  "/api/d1/live-insights": [{ id: "n1", category: "core_knowledge" }],
  "/api/d1/session-qa": [{ id: "q1", question: "why?" }],
});
const capOne = (await executeNexusTool("get_nexus_lecture_capture", { session_id: "s1" }, "UTC")) as {
  segment_count: number;
  insight_count: number;
  qa_count: number;
};
t("a known session reads all three capture tables", `${capOne.segment_count}/${capOne.insight_count}/${capOne.qa_count}`, "1/1/1");
t(
  "segments are ordered by segment_number, never by the double-precision start_time",
  calls.some((u) => u.includes("lecture-transcripts-segments") && u.includes("order=segment_number")),
  true,
);
t(
  "NO capture read orders by updated_at — those three tables do not have that column",
  calls.filter((u) => /lecture-transcripts-segments|live-insights|session-qa/.test(u) && u.includes("order=updated_at")).length,
  0,
);

// --- an existing-but-unrecorded session must not read as "nothing happened".
globalThis.fetch = route({});
const capEmpty = (await executeNexusTool("get_nexus_lecture_capture", { session_id: "s9" }, "UTC")) as { note?: string };
t("an unrecorded session says so explicitly", /nothing was recorded/.test(capEmpty.note ?? ""), true);

// --- A-READ-4 / A-READ-8: the two NON-d1 endpoints. Different path, camelCase params, {count,...}
//     bodies — and the same owner-from-config rule.
calls = [];
globalThis.fetch = route({ "/api/library": { count: 1, items: [{ kind: "material", title: "Chapter 4.pdf" }] } });
const lib = (await executeNexusTool(
  "get_nexus_library",
  { course_id: "c1", kind: "everything", q: "%", limit: 25 },
  "UTC",
)) as { count: number; items: unknown[] };
t("library reads /api/library, not a d1 table", calls[0].includes("/api/library") && !calls[0].includes("/api/d1/"), true);
t("library params are camelCase as that endpoint expects", calls[0].includes("courseId=c1"), true);
t("library carries the configured owner", calls[0].includes("owner=owner-uuid"), true);
t("exactly one owner parameter is ever sent", (calls[0].match(/owner=/g) ?? []).length, 1);
t("an unrecognised kind is DROPPED, not passed through", calls[0].includes("kind="), false);
t("a bare wildcard q is stripped", calls[0].includes("q="), false);
t("library returns its items", lib.count, 1);

calls = [];
globalThis.fetch = route({ "/api/writer-transcript": { count: 2, rows: [{ seq: 1 }, { seq: 2 }] } });
const noId = (await executeNexusTool("get_nexus_writer_transcript", {}, "UTC")) as { ok: boolean; error?: string };
t("writer transcript without an assignment is REFUSED", noId.error, "assignment_id_required");
t("...and nothing was fetched (no reading of another assignment's draft)", calls.length, 0);

const wt = (await executeNexusTool(
  "get_nexus_writer_transcript",
  { assignment_id: "a1", phase: "reviewer" },
  "UTC",
)) as { count: number };
t("with an assignment it reads /api/writer-transcript", calls[0].includes("/api/writer-transcript"), true);
t("assignmentId is camelCase for that endpoint", calls[0].includes("assignmentId=a1"), true);
t("phase is forwarded", calls[0].includes("phase=reviewer"), true);
t("transcript rows are returned as messages", wt.count, 2);

globalThis.fetch = origFetch;

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
