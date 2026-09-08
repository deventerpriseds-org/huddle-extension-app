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
t("both set -> three tools", nexusReadTools().length, 3);

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
t("NEXUS_TOOL_NAMES has exactly 3", NEXUS_TOOL_NAMES.size, 3);

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

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
