// WHAT:       Direction 1 of the cross-app bridge -- lets a Huddle agent READ the owner's Nexus
//             coursework. ELEVEN tools, one shared executor, reachable from both live Huddle
//             surfaces: assignments (with real due dates), programs and courses, the class
//             schedule (batch one), then module contents, the owner's own page notes, a recorded
//             lecture's transcript/insights/Q&A, the unified library, and the AI writer's working
//             transcript (batch two, A-READ-7/9/10/4/8), and finally a literal search of the
//             indexed knowledge base, the list of what IS indexed, and an assignment's case-study
//             analysis (batch three, A-RAG-1/5/3).
//
//             BATCH THREE CARRIES ONE LIMIT WORTH STATING AT THE TOP. `search_nexus_knowledge` is a
//             LITERAL substring match, not a semantic one. Nexus HAS real pgvector retrieval
//             (api/src/lib/vectorSearch.ts) but it is a LIBRARY with exactly one importer,
//             embaAssistantChat.ts, and no HTTP route exposes it -- so the sharpest operator
//             reachable from here is the d1 GET's `ilike`. The tool says so to the model, because
//             one that believes it searched by MEANING reports a miss as "that is not in your
//             knowledge base" instead of "that word does not appear".
// WHY:        Two separate problems, and the second is the worse one.
//             (1) Nothing on the Huddle side could reach Nexus at all -- grepped 2026-09-08, zero
//                 references. So "what's due this week in my EMBA?" had no route to the data.
//             (2) journey's `list_pending_assignments` answers that question ANYWAY, from a STALE
//                 FORK of the same dataset. Measured: journey holds 469 assignment rows for the
//                 owner with the newest created 2026-04-06; Nexus holds 534, of which 241 were
//                 created AFTER that date. So the agent answers confidently from a five-month-old
//                 snapshot and looks fine doing it. This is not adding a missing capability -- it
//                 is replacing a silently-wrong one, which is why the descriptions below tell the
//                 model to prefer these tools for coursework.
// SUPERSEDES: nothing yet. `list_pending_assignments` still exists on journey's bus; retiring it is
//             a journey-side change and a separate, deliberate step. Until then, DO NOT leave two
//             answers standing silently -- the description on get_nexus_assignments is what steers
//             the model to the live one.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   nexus-hub/docs/cross-app-agent/SCENARIOS.md A-READ-1/3/6 and B-READ-5 (the stale-fork
//             measurement); CAP-nexus.md §2.2 for the d1 route; the filterable set read from
//             nexus-hub/api/src/functions/d1.ts:522.
//             Batch two: nexus-hub/docs/cross-app-agent/BUILD-a-read-tools.md carries the per-table
//             column read (which COMMON columns physically exist where), the proof that a Nexus
//             "session" is a class_schedules row, and the proof that slide notes are keyed by
//             page_number because slide_number is never written by anything.
//
// READ-ONLY BY CONSTRUCTION. Every call here is a bare GET -- against /api/d1/{table}, and (batch
// two) against the two aggregate GET-only endpoints /api/library and /api/writer-transcript. There
// is one outbound call site, `nexusFetch`, and it passes no method, no body and no headers, so
// nothing in this file can write; the Nexus side blocks writes on this auth path anyway
// (`requireWrite` rejects the owner-parameter identity) and both aggregate endpoints are declared
// methods: ['GET','OPTIONS']. Adding a write path is a different decision with a different gate.

/** The owner id Nexus scopes rows by. Configured, never inferred -- see resolveNexusOwner below. */
function nexusOwner(): string {
  return (process.env.NEXUS_OWNER_ID ?? "").trim();
}

function nexusBase(): string {
  return (process.env.NEXUS_API_URL ?? "").trim().replace(/\/+$/, "");
}

/**
 * Both must be present. A half-configured environment reads as "no Nexus tools" rather than as a
 * tool that exists and fails at call time -- a tool the model can see but cannot use is worse than
 * one it never had, because the model will keep retrying it and narrate the failure to the user.
 */
export function nexusReadConfigured(): boolean {
  return !!nexusBase() && !!nexusOwner();
}

const TIMEOUT_MS = 15_000;

type Row = Record<string, unknown>;

/**
 * ONE-WAY IDENTITY NOTE, recorded because it is the sharpest edge in this file.
 *
 * Nexus authorises these reads from an `?owner=<uuid>` query parameter that it does NOT verify --
 * the UUID is the only secret. That is a pre-existing property of the Nexus API (CAP-nexus §2.1,
 * flagged for the owner and not created here), and it is why this module takes the owner id from
 * SERVER CONFIG and never from a tool argument. If an agent could pass an owner id, any prompt
 * could read any user's coursework by guessing a UUID. The model cannot reach this value.
 */
type Fetched = { ok: true; body: unknown } | { ok: false; error: string };

/**
 * ONE outbound shape for every read in this file -- one timeout, one abort branch, one error
 * vocabulary. Both helpers below funnel through it, which is the whole reason it exists: the
 * second endpoint family (§ nexusGetPath) would otherwise arrive with its own timeout constant and
 * its own error strings, and the model would have to learn two failure languages for one system.
 *
 * The owner parameter is applied HERE and only here, with `set` AFTER the caller's params are
 * appended -- `set` replaces every existing entry of that name, so even a caller that tried to
 * pass an owner cannot: the configured value always wins. See the identity note above for why
 * that matters more than it looks like it should.
 */
async function nexusFetch(path: string, params: URLSearchParams): Promise<Fetched> {
  const base = nexusBase();
  const owner = nexusOwner();
  if (!base || !owner) return { ok: false, error: "nexus_not_configured" };

  const url = new URL(`${base}${path}`);
  params.forEach((v, k) => url.searchParams.append(k, v));
  url.searchParams.set("owner", owner);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    return { ok: true, body: (await res.json()) as unknown };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A read of one `/api/d1/{table}` route.
 *
 * `limit`/`order` are the d1 GET's own parameters (d1.ts `orderable`/`limitSql`, cap 5000). They
 * are here because the capture tables are unbounded in a way assignments and courses are not -- a
 * lecture's transcript is thousands of segments, and pulling all of them into a model prompt to
 * then slice them client-side is the same mistake as fetching-everything-and-sifting that the
 * server-side `ilike` filter exists to avoid.
 *
 * ORDER COLUMNS MUST PHYSICALLY EXIST ON THE TABLE. d1's `orderable` set unions the blanket
 * `COMMON` list into every table, so `order=updated_at` is ACCEPTED as a name for a table that has
 * no such column and then fails in Postgres. Every order/filter column used by the callers below
 * was read out of the table's CREATE TABLE first.
 */
async function nexusGet(
  table: string,
  filters: [string, string][] = [],
  opts: { limit?: number; order?: string } = {},
): Promise<{ ok: true; rows: Row[] } | { ok: false; error: string }> {
  const params = new URLSearchParams();
  // Nexus takes filters as ONE json param -- repeated query keys get merged into a comma-joined
  // value by the Azure Functions host, which corrupts same-column ranges (a due_date gte AND lte
  // becomes one nonsense value). Read from d1.ts:523-527; do not "simplify" this to ?col=val.
  if (filters.length) params.set("filters", JSON.stringify(filters));
  if (opts.order) params.set("order", opts.order);
  if (opts.limit !== undefined && Number.isFinite(opts.limit)) {
    params.set("limit", String(Math.max(1, Math.trunc(opts.limit))));
  }

  const r = await nexusFetch(`/api/d1/${table}`, params);
  if (!r.ok) return r;
  const body = r.body;
  const rows = Array.isArray(body)
    ? (body as Row[])
    : Array.isArray((body as { rows?: unknown })?.rows)
      ? ((body as { rows: Row[] }).rows)
      : [];
  return { ok: true, rows };
}

/**
 * A read of a NON-d1 Nexus endpoint. Two of them exist and both are GET-only aggregates that d1
 * cannot express, which is why this second helper is here rather than a fourth argument on
 * nexusGet:
 *   - `/api/library` joins course_materials to assignment_artifacts up the program→course→module
 *     hierarchy and returns `{count, items}`;
 *   - `/api/writer-transcript` reads content.conversation_messages filtered on jsonb metadata keys
 *     and returns `{count, rows}` in emission order.
 * Neither is a `/api/d1/{table}` route, neither takes d1's json `filters` param, and neither
 * returns a bare row array -- so the shape this returns is the parsed BODY, not rows.
 *
 * STILL READ-ONLY BY CONSTRUCTION, exactly like nexusGet: it goes through nexusFetch, which issues
 * a bare `fetch(url)` with no method, no body and no headers. There is no way to write from here.
 * Both endpoints are declared GET/OPTIONS only on the Nexus side (library.ts / writerTranscript.ts
 * `app.http(... methods: ['GET','OPTIONS'] ...)`), so a write would 405 even if one were attempted.
 */
async function nexusGetPath(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    sp.set(k, String(v));
  }
  return nexusFetch(path, sp);
}

/** yyyy-mm-dd in the caller's zone, so "this week" means their week and not the server's. */
function dayIn(tz: string, offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: tz || "UTC" });
}

export const GET_NEXUS_ASSIGNMENTS_TOOL = {
  type: "function" as const,
  name: "get_nexus_assignments",
  description:
    "The owner's REAL, CURRENT EMBA coursework assignments, read live from Nexus. Use this for ANY question about coursework, assignments, homework, papers, case briefs, submissions or what is due — 'what's due this week', 'what do I still owe', 'what's pending in Corporate Finance'. PREFER THIS OVER list_pending_assignments: that tool reads a separate copy that stopped being updated in April and will answer confidently with months-old data.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      due_within_days: {
        type: "number",
        description: "Only assignments due within this many days from today. Omit for no date bound.",
      },
      status: {
        type: "string",
        description: "Filter by lifecycle status exactly as Nexus stores it (e.g. 'pending', 'submitted'). Omit for all.",
      },
      course_id: { type: "string", description: "Restrict to one course, by Nexus course id." },
      title: {
        type: "string",
        description:
          "Case-insensitive substring of the assignment TITLE, for when the owner names one ('the introduction discussion', 'Discussion Board 1'). Pass the distinctive words only, not the whole phrase.",
      },
    },
    required: [] as string[],
  },
  strict: false,
};

export const GET_NEXUS_COURSES_TOOL = {
  type: "function" as const,
  name: "get_nexus_courses",
  description:
    "The owner's EMBA programs and the courses inside them, read live from Nexus. Use for 'what courses am I taking', 'what's in my program', or to resolve a course NAME the owner mentioned into the id the other Nexus tools take.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
    required: [] as string[],
  },
  strict: false,
};

export const GET_NEXUS_CLASS_SCHEDULE_TOOL = {
  type: "function" as const,
  name: "get_nexus_class_schedule",
  description:
    "The owner's CLASS SCHEDULE — live sessions, lectures and residencies from Nexus. Use for 'when is my next live session', 'when do I have class', 'what's my residency schedule'. This is academic class timetabling and is SEPARATE from get_calendar_events, which answers about their general day, meetings and tasks.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      from: { type: "string", description: "Start date, yyyy-mm-dd. Defaults to today." },
      to: { type: "string", description: "End date, yyyy-mm-dd. Defaults to 60 days out." },
    },
    required: [] as string[],
  },
  strict: false,
};

/** Wildcards stripped so a stray % cannot widen an ilike back to everything and still look like a
 *  working search -- the same guard the assignment title search above uses. */
function likeTerm(v: unknown): string {
  return typeof v === "string" ? v.trim().replace(/[%_]/g, "") : "";
}

/** Models emit numbers as numbers OR as strings depending on the surface; both are accepted, and
 *  anything else becomes undefined rather than NaN reaching a filter value. */
function numArg(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  return undefined;
}

function strArg(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** d1's zero-UUID sentinel owner (api/src/lib/auth.ts:35). Rows carrying it on an `anonUnion`
 *  route are the shared demo corpus, not the owner's own material. */
const NEXUS_ANON_OWNER = "00000000-0000-0000-0000-000000000000";

/**
 * DROP THE RAW EMBEDDING VECTOR. `/api/d1/{table}` runs a bare `SELECT *` with no column
 * projection anywhere (d1.ts handleGet), and content.assistant_knowledge_chunks.embedding is a
 * pgvector column at 1536 dimensions (vectorSearch.ts EMBED_DIMS, asserted on both ingest and
 * query). Twenty rows is ~30,000 floats that mean nothing to a language model and would dominate
 * the tool result it has to read. Nothing downstream wants it, so it never leaves this module.
 */
function stripEmbedding(row: Row): Row {
  if (!("embedding" in row)) return row;
  const { embedding: _dropped, ...rest } = row;
  return rest;
}

/** The text columns of content.case_study_analyses, read from that route's `writable` list
 *  (d1.ts:391) and confirmed against the CREATE TABLE (002_app_tables.sql:207). `completed_sections`
 *  is jsonb and is returned separately, not as a section. */
const CASE_STUDY_SECTIONS = [
  "case_text", "questions", "supplemental_context", "extracted_data", "concepts_taught",
  "case_analysis", "verification_needed", "outline", "summaries", "conceptual_learning",
  "case_extraction", "missing_extracts", "sourced_answers", "draft_writeup",
] as const;

/** The rich extraction columns of content.extracted_content, from its CREATE TABLE
 *  (001_d1_content.sql:58). Reported by NAME in the knowledge-base listing instead of by value --
 *  see the projection note at the call site. */
const EXTRACTED_CONTENT_FIELDS = [
  "quick_summary", "comprehensive_summary", "atoms", "assumptions", "case_facts_statistics",
  "case_players", "key_terms", "key_concepts", "frameworks", "formulas", "learning_objectives",
  "key_definitions", "study_questions", "case_problem", "case_approach", "case_outcome",
  "assignment_guidance", "v2_extraction_data",
] as const;

/** Non-empty in the sense the listing means: a present string with text, or a non-empty array or
 *  object. `[]` and `{}` are the DEFAULTS on several of these columns, so counting them as content
 *  would report every document as carrying every extraction. */
function hasContent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

export const GET_NEXUS_MODULE_MATERIALS_TOOL = {
  type: "function" as const,
  name: "get_nexus_module_materials",
  description:
    "What is INSIDE a course module in Nexus — the module's ordered item list (Canvas Assignment / Quiz / File / Page / Discussion entries) and the course materials filed under it. Use for 'what materials are attached to module 3 of Ops Management', 'what's in this week's module', 'what readings do I have for module 2'. Identify the module by module_number and/or module_name, and narrow with course_id when the owner named a course — call get_nexus_courses first to turn a course NAME into its id. If several modules match, this returns them and asks you to check with the owner: do NOT pick one. For what is DUE prefer get_nexus_assignments; this tool answers what has been FILED under a module.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      course_id: { type: "string", description: "Restrict to one course, by Nexus course id (from get_nexus_courses)." },
      module_number: { type: "number", description: "The module's number within its course, e.g. 3 for 'module 3'." },
      module_name: {
        type: "string",
        description: "Case-insensitive substring of the module NAME, for when the owner names it rather than numbering it. Distinctive words only.",
      },
    },
    required: [] as string[],
  },
  strict: false,
};

export const GET_NEXUS_SLIDE_NOTES_TOOL = {
  type: "function" as const,
  name: "get_nexus_slide_notes",
  description:
    "The owner's OWN notes typed onto pages of a deck or document in the Nexus viewer. Use for 'what did I note on slide 14 of that deck', 'what were my notes on the strategy deck', 'did I write anything on that reading'. These are the owner's authored annotations — NOT lecture transcripts (get_nexus_lecture_capture) and NOT the file itself (get_nexus_library). Name the deck with deck_title, or pass material_id if you already have one. If several documents match the title this returns them and asks you to check with the owner: do NOT pick one.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      deck_title: {
        type: "string",
        description: "Case-insensitive substring of the document/deck TITLE. Distinctive words only.",
      },
      material_id: { type: "string", description: "Nexus course-material id, when already known." },
      page_number: {
        type: "number",
        description: "One page only. Notes are keyed by PAGE number, so 'slide 14' means page_number 14. Omit for every note on the document.",
      },
    },
    required: [] as string[],
  },
  strict: false,
};

export const GET_NEXUS_LECTURE_CAPTURE_TOOL = {
  type: "function" as const,
  name: "get_nexus_lecture_capture",
  description:
    "What Nexus's recorder captured during a live class session: the lecture TRANSCRIPT segments, the live INSIGHTS it extracted while listening, and any Q&A asked against the session. Use for 'what did the recorder pick up in last week's lecture', 'what came up in Tuesday's class', 'summarise what was said in that session'. A session is one class-schedule entry — omit session_id and this looks in a date window (the last 7 days by default) and asks the owner which one if more than one class sits in it. Use get_nexus_class_schedule to see the sessions themselves; this tool answers what was RECORDED in one.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      session_id: { type: "string", description: "The class-session id (a get_nexus_class_schedule row's id), when already known." },
      from: { type: "string", description: "Window start, yyyy-mm-dd. Defaults to 7 days ago. Ignored when session_id is given." },
      to: { type: "string", description: "Window end, yyyy-mm-dd. Defaults to today. Ignored when session_id is given." },
      limit: { type: "number", description: "Max transcript segments to return, newest ordering aside. Defaults to 400." },
    },
    required: [] as string[],
  },
  strict: false,
};

export const GET_NEXUS_LIBRARY_TOOL = {
  type: "function" as const,
  name: "get_nexus_library",
  description:
    "EVERYTHING the owner holds for a course, module or assignment in one list — imported materials (readings, decks, files) AND documents the Nexus writer produced — each with its course, module and assignment. Use for 'show me everything I've got for AI and Business Strategy', 'what do I have for this module', 'what files are attached to that course'. Call get_nexus_courses first to turn a course NAME into course_id. Prefer this for a BREADTH question across a course; prefer get_nexus_module_materials when the owner asked about one module's contents specifically, and get_nexus_assignments for what is due.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      course_id: { type: "string", description: "Nexus course id (from get_nexus_courses)." },
      program_id: { type: "string", description: "Nexus program id (from get_nexus_courses)." },
      module_id: { type: "string", description: "Nexus module id (from get_nexus_module_materials)." },
      assignment_id: {
        type: "string",
        description: "One assignment's id. Returns only the DOCUMENTS written for it — materials carry no assignment tie in Nexus.",
      },
      session_id: {
        type: "string",
        description: "One class session's id. Returns only MATERIALS linked to that session — documents carry no session tie in Nexus.",
      },
      kind: { type: "string", description: "'material' for imported files only, 'document' for writer output only. Omit for both." },
      q: { type: "string", description: "Case-insensitive substring of the title. Distinctive words only." },
      limit: { type: "number", description: "Max items. Defaults to 200; Nexus caps it at 2000." },
    },
    required: [] as string[],
  },
  strict: false,
};

export const GET_NEXUS_WRITER_TRANSCRIPT_TOOL = {
  type: "function" as const,
  name: "get_nexus_writer_transcript",
  description:
    "The full exchange Nexus's AI writer had while producing an assignment's draft — every phase (extract, outline, writer, reviewer, chat) in the order it happened. Use for 'read me back what the writer produced for that case brief', 'what did the AI actually do on that assignment', 'show me the reviewer's feedback'. It needs an assignment_id: resolve it with get_nexus_assignments{title} first, which will ask the owner which course he means if the title matches more than one. For the finished document itself prefer get_nexus_library{assignment_id}; this tool is the working transcript behind it and is long.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      assignment_id: { type: "string", description: "The assignment whose writer transcript to read (from get_nexus_assignments)." },
      workflow_type: { type: "string", description: "Restrict to one workflow, exactly as Nexus stores it. Omit for all." },
      phase: { type: "string", description: "Restrict to one phase, exactly as Nexus stores it (e.g. 'outline', 'writer', 'reviewer'). Omit for all." },
      limit: { type: "number", description: "Max messages. Defaults to 200; Nexus caps it at 2000." },
    },
    required: [] as string[],
  },
  strict: false,
};

export const SEARCH_NEXUS_KNOWLEDGE_TOOL = {
  type: "function" as const,
  name: "search_nexus_knowledge",
  description:
    "Search the TEXT of the owner's indexed Nexus course material — syllabi, readings, decks, case files and the summaries/facts/atoms extracted from them — for a LITERAL word or phrase. Use for 'what does the CF syllabus say about the grading breakdown', 'find where the reading mentions working capital', 'what did that case say about margins'. THIS IS A LITERAL SUBSTRING MATCH, NOT A MEANING-BASED SEARCH: pass the exact distinctive WORD the document would use ('grading', 'rubric', 'weighting'), not a whole question, and try a second wording before concluding anything is absent — a miss means that word does not appear, NOT that the topic is missing from the owner's materials. For which DOCUMENTS are indexed rather than what they say, use get_nexus_knowledge_base.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        description: "The literal word or short phrase to find in the material. One distinctive term works far better than a sentence.",
      },
      course_id: {
        type: "string",
        description: "Restrict to one course, by Nexus course id (from get_nexus_courses). Applied to each chunk's recorded course.",
      },
      source_type: {
        type: "string",
        description: "Restrict to one kind of indexed text, exactly as Nexus stores it: 'summary', 'fact', 'assumption', 'atom', 'full_text' or 'knowledge_base'. Omit for all.",
      },
      limit: { type: "number", description: "Max passages to return. Defaults to 20." },
    },
    required: ["query"] as string[],
  },
  strict: false,
};

export const GET_NEXUS_KNOWLEDGE_BASE_TOOL = {
  type: "function" as const,
  name: "get_nexus_knowledge_base",
  description:
    "WHICH documents the owner has analysed and indexed into his Nexus knowledge base, and what was extracted from each. Use for \"what's in my knowledge base for this course\", 'what have I actually indexed', 'which readings have you analysed'. Pass course_id to scope it to one course — call get_nexus_courses first to turn a course NAME into its id. This answers WHAT IS INDEXED; to search what those documents SAY, use search_nexus_knowledge; for files the owner merely holds without analysis, use get_nexus_library.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      course_id: { type: "string", description: "Restrict to one course, by Nexus course id (from get_nexus_courses)." },
      limit: { type: "number", description: "Max documents. Defaults to 100." },
    },
    required: [] as string[],
  },
  strict: false,
};

export const GET_NEXUS_CASE_STUDY_ANALYSIS_TOOL = {
  type: "function" as const,
  name: "get_nexus_case_study_analysis",
  description:
    "The case-study analysis Nexus ran for ONE assignment — its extracted case data, the concepts taught, the analysis itself, the outline, the sourced answers and the draft write-up. Use for 'summarise the case-study analysis you ran on Marketing Strategy', 'what did the case analysis conclude', 'read me the outline it produced'. It needs an assignment_id: resolve it with get_nexus_assignments{title} first, which will ask the owner which course he means if the title matches more than one. Sections are long, so each is trimmed by default — pass `sections` to pull specific ones back in full.",
  parameters: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      assignment_id: { type: "string", description: "The assignment whose case-study analysis to read (from get_nexus_assignments)." },
      sections: {
        type: "array",
        items: { type: "string" },
        description: "Only these sections, each returned in full — e.g. ['case_analysis','outline','draft_writeup']. Omit for every non-empty section, trimmed.",
      },
      max_chars: {
        type: "number",
        description: "Trim each returned section to this many characters. Defaults to 4000. Ignored for sections named in `sections`.",
      },
    },
    required: ["assignment_id"] as string[],
  },
  strict: false,
};

/** The eleven tools, or none at all when Nexus is not configured. */
export function nexusReadTools(): unknown[] {
  if (!nexusReadConfigured()) return [];
  return [
    GET_NEXUS_ASSIGNMENTS_TOOL,
    GET_NEXUS_COURSES_TOOL,
    GET_NEXUS_CLASS_SCHEDULE_TOOL,
    GET_NEXUS_MODULE_MATERIALS_TOOL,
    GET_NEXUS_SLIDE_NOTES_TOOL,
    GET_NEXUS_LECTURE_CAPTURE_TOOL,
    GET_NEXUS_LIBRARY_TOOL,
    GET_NEXUS_WRITER_TRANSCRIPT_TOOL,
    SEARCH_NEXUS_KNOWLEDGE_TOOL,
    GET_NEXUS_KNOWLEDGE_BASE_TOOL,
    GET_NEXUS_CASE_STUDY_ANALYSIS_TOOL,
  ];
}

export const NEXUS_TOOL_NAMES = new Set([
  "get_nexus_assignments",
  "get_nexus_courses",
  "get_nexus_class_schedule",
  "get_nexus_module_materials",
  "get_nexus_slide_notes",
  "get_nexus_lecture_capture",
  "get_nexus_library",
  "get_nexus_writer_transcript",
  "search_nexus_knowledge",
  "get_nexus_knowledge_base",
  "get_nexus_case_study_analysis",
]);

/**
 * ONE executor, called by BOTH surfaces. The text path and the voice path having separate copies is
 * exactly how this estate ends up with tools that work when typed and are silently missing when
 * spoken -- CAP-huddle-journey records nine such divergences, all one-directional, all voice.
 */
export async function executeNexusTool(
  name: string,
  args: Record<string, unknown>,
  timeZone: string,
): Promise<unknown> {
  if (!nexusReadConfigured()) return { ok: false, error: "nexus_not_configured" };

  if (name === "get_nexus_courses") {
    const [programs, courses] = await Promise.all([nexusGet("programs"), nexusGet("courses")]);
    if (!programs.ok) return { ok: false, error: programs.error };
    if (!courses.ok) return { ok: false, error: courses.error };
    return { ok: true, programs: programs.rows, courses: courses.rows };
  }

  if (name === "get_nexus_class_schedule") {
    const from = typeof args.from === "string" && args.from.trim() ? args.from.trim().slice(0, 10) : dayIn(timeZone);
    const to = typeof args.to === "string" && args.to.trim() ? args.to.trim().slice(0, 10) : dayIn(timeZone, 60);
    const r = await nexusGet("class-schedules", [["date", `gte.${from}`], ["date", `lte.${to}`]]);
    if (!r.ok) return { ok: false, error: r.error };
    const sessions = [...r.rows].sort((a, b) =>
      String(a.date ?? "").localeCompare(String(b.date ?? "")),
    );
    return { ok: true, from, to, count: sessions.length, sessions };
  }

  if (name === "get_nexus_assignments") {
    const filters: [string, string][] = [];
    if (typeof args.course_id === "string" && args.course_id.trim()) {
      filters.push(["course_id", `eq.${args.course_id.trim()}`]);
    }
    if (typeof args.status === "string" && args.status.trim()) {
      filters.push(["status", `eq.${args.status.trim()}`]);
    }
    // TITLE SEARCH. The owner names an assignment in words ("the introduction discussion"); without
    // this the model could only filter by course/status/date and had to scan. `ilike` is whitelisted
    // by the Nexus API's operator table (d1.ts:461), so this is a server-side filter, not a fetch-
    // everything-and-sift. Wildcards are stripped from the input so a stray % cannot widen the match
    // back to everything and look like a working search.
    const titleQuery =
      typeof args.title === "string" ? args.title.trim().replace(/[%_]/g, "") : "";
    if (titleQuery) filters.push(["title", `ilike.%${titleQuery}%`]);
    const within = typeof args.due_within_days === "number" ? args.due_within_days : undefined;
    if (within !== undefined && Number.isFinite(within)) {
      filters.push(["due_date", `gte.${dayIn(timeZone)}`]);
      filters.push(["due_date", `lte.${dayIn(timeZone, Math.max(0, Math.trunc(within)))}`]);
    }

    const r = await nexusGet("assignments", filters);
    if (!r.ok) return { ok: false, error: r.error };

    const rows = [...r.rows].sort((a, b) => {
      const da = String(a.due_date ?? ""), db = String(b.due_date ?? "");
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db);
    });

    // AN EMPTY RESULT IS REPORTED AS EMPTY, not dressed up. A correct pipeline and a broken one both
    // return zero rows, so an agent answering "you're all caught up!" from an empty set is the
    // confident-wrong-answer failure this whole bridge exists to remove.
    //
    // A COUNT OF LIVE DATA HAS A SHELF LIFE, and this comment previously carried one as though it
    // did not: "534 assignments, 504 with a due date, 0 in the future, latest 2026-08-18", measured
    // 2026-09-03 and used to argue the date filter was untestable. On 2026-09-08 two assignments
    // were due in the FUTURE (2026-09-07 and 2026-09-10) -- the owner had imported a new term. The
    // structural point survives; the number did not, so the number is gone rather than restated.
    const ambiguous = titleQuery !== "" && rows.length > 1;
    return {
      ok: true,
      count: rows.length,
      filtered_by: filters.map(([c, v]) => `${c} ${v}`),
      // WHEN A TITLE SEARCH MATCHES SEVERAL, ASK -- never pick. The owner: "if there are multiple,
      // I'd expect it to clarify for which course before executing." Guessing between two courses'
      // assignments and then DRAFTING against the wrong one wastes the turn and looks like the tool
      // worked. The course name is what disambiguates, so the directive names it explicitly.
      needs_disambiguation: ambiguous || undefined,
      note: ambiguous
        ? `${rows.length} assignments match that title. STOP and ask the owner which COURSE he means -- list the matches with their course and due date, and do not act on any of them until he answers.`
        : rows.length === 0
          ? "No assignments matched. Report this as 'nothing matched those filters' and state the filters used -- do NOT tell the owner he is caught up unless an unfiltered read also returns nothing."
          : undefined,
      assignments: rows,
    };
  }

  // A-READ-7 -- "what materials are attached to module 3 of Ops Management?"
  //
  // Two hops, because a module is the thing that has to be RESOLVED first and `module_number` is
  // unique only WITHIN a course: `modules` is keyed UNIQUE (course_id, module_number), so "module
  // 3" on its own legitimately matches one row per course the owner takes. Guessing between them
  // and then reading out another course's reading list is the exact failure the assignment title
  // search already refuses to make, so this refuses it the same way.
  if (name === "get_nexus_module_materials") {
    const courseId = strArg(args.course_id);
    const moduleNumber = numArg(args.module_number);
    const moduleName = likeTerm(args.module_name);

    const modFilters: [string, string][] = [];
    if (courseId) modFilters.push(["course_id", `eq.${courseId}`]);
    if (moduleNumber !== undefined) modFilters.push(["module_number", `eq.${moduleNumber}`]);
    // `name` is not in the `modules` route's `filters` list but IS in its `writable` list, and d1
    // builds `filterable` as filters ∪ writable ∪ COMMON (d1.ts handleGet) -- so this is a
    // server-side ILIKE, not a fetch-everything-and-sift. Verified in the registry, not assumed.
    if (moduleName) modFilters.push(["name", `ilike.%${moduleName}%`]);

    // Courses are fetched alongside so a disambiguation question can name the COURSE. `modules`
    // rows carry only `course_id`; an ask that lists three uuids is not an ask the owner can
    // answer, and an unanswerable ask is the same wasted turn as guessing.
    const [mods, courses] = await Promise.all([
      nexusGet("modules", modFilters, { order: "module_number" }),
      nexusGet("courses"),
    ]);
    if (!mods.ok) return { ok: false, error: mods.error };
    const courseName = new Map<string, string>();
    if (courses.ok) for (const c of courses.rows) courseName.set(str(c.id), str(c.name));

    const candidates = mods.rows.map((m) => ({
      id: str(m.id),
      course_id: str(m.course_id),
      course_name: courseName.get(str(m.course_id)) ?? null,
      module_number: m.module_number ?? null,
      name: m.name ?? null,
      start_date: m.start_date ?? null,
      end_date: m.end_date ?? null,
    }));

    if (candidates.length === 0) {
      return {
        ok: true,
        count: 0,
        modules: [],
        note: "No module matched. Report that nothing matched these filters and state them — do NOT tell the owner the module is empty. If he named the course by name, resolve it with get_nexus_courses and pass course_id.",
      };
    }
    if (candidates.length > 1) {
      return {
        ok: true,
        needs_disambiguation: true,
        count: candidates.length,
        modules: candidates,
        note: `${candidates.length} modules match. STOP and ask the owner which COURSE he means — list the matches with their course name and module number, and do not read out any module's contents until he answers.`,
      };
    }

    const mod = candidates[0];
    const [items, materials] = await Promise.all([
      // The ordered Canvas spine. These rows POINT at the real object via content_ref
      // (assignments.id | course_materials.id | page slug) or external_url -- they are not copies
      // of it, so an item and a material below can describe the same file.
      nexusGet("module-items", [["module_id", `eq.${mod.id}`]], { order: "position" }),
      nexusGet("course-materials", [["module_id", `eq.${mod.id}`]], { order: "title" }),
    ]);
    if (!items.ok) return { ok: false, error: items.error };
    if (!materials.ok) return { ok: false, error: materials.error };

    return {
      ok: true,
      module: mod,
      item_count: items.rows.length,
      material_count: materials.rows.length,
      items: items.rows,
      materials: materials.rows,
      note:
        items.rows.length === 0 && materials.rows.length === 0
          ? "The module exists but nothing is filed under it in Nexus. Say exactly that — an empty module and a failed read look identical from here, so do not describe it as 'nothing due' or 'all clear'."
          : undefined,
    };
  }

  // A-READ-9 -- "what did I note on slide 14 of that deck?"
  //
  // NOTES ARE KEYED BY page_number, NOT slide_number, and this is measured rather than inferred:
  // the ONLY writer of content.slide_annotations is nexus-hub's DocumentViewer.tsx, whose
  // handleNoteSave upserts {user_id, material_id, page_number, note_text} on conflict
  // (user_id, material_id, page_number) and whose loadNotes selects page_number + note_text.
  // `slide_number` is in the table and in the d1 allow-list and is never written by anything. A
  // slide_number filter would therefore return zero rows for every real note while looking like a
  // working search -- so this tool does not offer one.
  if (name === "get_nexus_slide_notes") {
    let materialId = strArg(args.material_id);
    const deckTitle = likeTerm(args.deck_title);
    const page = numArg(args.page_number);
    let deck: { id: string; title: unknown; course_id: unknown; material_type: unknown } | undefined;

    if (!materialId && deckTitle) {
      const mats = await nexusGet("course-materials", [["title", `ilike.%${deckTitle}%`]], { order: "title" });
      if (!mats.ok) return { ok: false, error: mats.error };
      const docs = mats.rows.map((m) => ({
        id: str(m.id),
        title: m.title ?? null,
        course_id: m.course_id ?? null,
        material_type: m.material_type ?? null,
      }));
      if (docs.length === 0) {
        return {
          ok: true,
          count: 0,
          notes: [],
          note: `No document title matched "${deckTitle}". Report that and state the search term — do not report that the owner has no notes.`,
        };
      }
      if (docs.length > 1) {
        return {
          ok: true,
          needs_disambiguation: true,
          count: docs.length,
          documents: docs,
          note: `${docs.length} documents match that title. STOP and ask the owner which one he means — list them by title — and do not read notes from any of them until he answers.`,
        };
      }
      deck = docs[0];
      materialId = deck.id;
    }

    const filters: [string, string][] = [];
    if (materialId) filters.push(["material_id", `eq.${materialId}`]);
    if (page !== undefined) filters.push(["page_number", `eq.${page}`]);
    const r = await nexusGet("slide-annotations", filters, {
      order: "page_number",
      // Unscoped means "every note on every document"; bound it so one call cannot drag the
      // owner's whole annotation history into a prompt. A scoped read is already small.
      limit: materialId ? undefined : 200,
    });
    if (!r.ok) return { ok: false, error: r.error };

    return {
      ok: true,
      document: deck,
      material_id: materialId || undefined,
      page_number: page,
      count: r.rows.length,
      notes: r.rows,
      note:
        r.rows.length === 0
          ? page !== undefined
            ? `Nothing is noted on page ${page}. Say that the page has no note rather than that the owner never annotated the document — other pages may.`
            : "No notes are stored for that scope. Report it as 'no notes found' and state the scope used."
          : undefined,
    };
  }

  // A-READ-10 -- "what did the recorder pick up in last week's lecture?"
  //
  // A SESSION IS A class_schedules ROW. There is no `sessions` table and no d1 route for one; the
  // three capture tables carry a bare `session_id uuid` with no FK. Two independent confirmations:
  // content.session_material_links.schedule_session_id REFERENCES content.class_schedules(id)
  // (sql/nexus_hub/002_app_tables.sql), and nexus-hub's CreateSessionDialog.tsx inserts into
  // class_schedules and hands that row's id out as the sessionId the recorder writes under.
  // So get_nexus_class_schedule is the resolver, and "last week's lecture" is a date window over
  // it -- which is exactly where several classes can sit, so the same ask-don't-guess rule applies.
  if (name === "get_nexus_lecture_capture") {
    let sessionId = strArg(args.session_id);
    let session: Record<string, unknown> | undefined;
    let from: string | undefined;
    let to: string | undefined;

    if (!sessionId) {
      from = strArg(args.from) ? strArg(args.from).slice(0, 10) : dayIn(timeZone, -7);
      to = strArg(args.to) ? strArg(args.to).slice(0, 10) : dayIn(timeZone);
      const sched = await nexusGet("class-schedules", [["date", `gte.${from}`], ["date", `lte.${to}`]], {
        order: "date",
      });
      if (!sched.ok) return { ok: false, error: sched.error };
      if (sched.rows.length === 0) {
        return {
          ok: true,
          from,
          to,
          count: 0,
          sessions: [],
          note: `No class session sits between ${from} and ${to}. Say that, with the window used, and offer to widen it — do not report that the recorder captured nothing.`,
        };
      }
      if (sched.rows.length > 1) {
        return {
          ok: true,
          needs_disambiguation: true,
          from,
          to,
          count: sched.rows.length,
          sessions: sched.rows.map((r) => ({
            id: str(r.id),
            course_name: r.course_name ?? null,
            date: r.date ?? null,
            start_time: r.start_time ?? null,
            type: r.type ?? null,
            location: r.location ?? null,
          })),
          note: `${sched.rows.length} class sessions fall in that window. STOP and ask the owner which one he means — list them by course and date — and do not read a transcript until he answers.`,
        };
      }
      session = sched.rows[0];
      sessionId = str(session.id);
    }

    const limit = numArg(args.limit) ?? 400;
    const [segments, insights, qa] = await Promise.all([
      // segment_number is the recorder's own ordering and is UNIQUE (session_id, segment_number).
      // NOTE start_time on this table is `double precision` seconds into the recording, NOT a
      // timestamp -- it only shares a NAME with class_schedules.start_time. Do not order on it.
      nexusGet("lecture-transcripts-segments", [["session_id", `eq.${sessionId}`]], {
        order: "segment_number",
        limit,
      }),
      // These three tables have created_at and NO updated_at (sql/nexus_hub/002_app_tables.sql).
      // d1's `orderable` set would ACCEPT order=updated_at as a name and then fail in Postgres,
      // because COMMON is whitelisted per-name and not per-table.
      nexusGet("live-insights", [["session_id", `eq.${sessionId}`]], { order: "created_at", limit: 200 }),
      nexusGet("session-qa", [["session_id", `eq.${sessionId}`]], { order: "created_at", limit: 200 }),
    ]);
    if (!segments.ok) return { ok: false, error: segments.error };
    if (!insights.ok) return { ok: false, error: insights.error };
    if (!qa.ok) return { ok: false, error: qa.error };

    const empty = segments.rows.length === 0 && insights.rows.length === 0 && qa.rows.length === 0;
    return {
      ok: true,
      session_id: sessionId,
      session,
      from,
      to,
      segment_count: segments.rows.length,
      segment_limit: limit,
      truncated: segments.rows.length >= limit || undefined,
      insight_count: insights.rows.length,
      qa_count: qa.rows.length,
      segments: segments.rows,
      insights: insights.rows,
      qa: qa.rows,
      note: empty
        ? "That session exists but nothing was recorded against it — no transcript, no insights, no Q&A. Say exactly that; a session that was never recorded and a failed read look identical from here."
        : undefined,
    };
  }

  // A-READ-4 -- "show me everything I've got for AI and Business Strategy".
  // NOT a d1 route: /api/library is an aggregate that JOINS course_materials to
  // assignment_artifacts up the program→course→module hierarchy, which d1's one-table router
  // cannot express. Its params are camelCase and its body is {count, items} -- hence nexusGetPath.
  if (name === "get_nexus_library") {
    // Nexus caps limit at 2000 and defaults to 500. 200 is the default here instead, because this
    // result goes into a model prompt rather than a paginated UI list.
    const limit = numArg(args.limit) ?? 200;
    // Only the two values library.ts actually branches on are forwarded; anything else is dropped
    // rather than passed through, where it would silently behave as "both kinds" and look honoured.
    const kindRaw = strArg(args.kind).toLowerCase();
    const kind = kindRaw === "material" || kindRaw === "document" ? kindRaw : undefined;
    const q = likeTerm(args.q);

    const r = await nexusGetPath("/api/library", {
      programId: strArg(args.program_id) || undefined,
      courseId: strArg(args.course_id) || undefined,
      moduleId: strArg(args.module_id) || undefined,
      sessionId: strArg(args.session_id) || undefined,
      assignmentId: strArg(args.assignment_id) || undefined,
      kind,
      q: q || undefined,
      limit,
    });
    if (!r.ok) return { ok: false, error: r.error };
    const items = Array.isArray((r.body as { items?: unknown })?.items)
      ? ((r.body as { items: Row[] }).items)
      : [];
    return {
      ok: true,
      count: items.length,
      truncated: items.length >= limit || undefined,
      items,
      note:
        items.length === 0
          ? "Nothing is filed for that scope. Report it as 'nothing matched those filters' and state them — if the owner named a course, confirm you resolved the right course_id with get_nexus_courses before concluding he has nothing."
          : undefined,
    };
  }

  // A-READ-8 -- "read me back what the writer produced for that case brief".
  // NOT a d1 route either: /api/writer-transcript filters content.conversation_messages on jsonb
  // metadata keys (metadata->>'assignment_id' / 'workflow_type' / 'phase'), which is not something
  // d1's column allow-list can name. Body is {count, rows} in emission order (seq ASC).
  if (name === "get_nexus_writer_transcript") {
    const assignmentId = strArg(args.assignment_id);
    if (!assignmentId) {
      // Refused rather than answered broadly: without an assignment this endpoint returns the
      // owner's ENTIRE writer history across every assignment, and reading a different case
      // brief's draft back as "what the writer produced" is a confidently-wrong answer, not a
      // partial one. get_nexus_assignments already asks the owner which course he means.
      return {
        ok: false,
        error: "assignment_id_required",
        note: "Resolve the assignment first with get_nexus_assignments{title} — it will ask the owner which course he means if the title matches more than one — then call this again with that id.",
      };
    }
    const limit = numArg(args.limit) ?? 200;
    const r = await nexusGetPath("/api/writer-transcript", {
      assignmentId,
      workflowType: strArg(args.workflow_type) || undefined,
      phase: strArg(args.phase) || undefined,
      limit,
    });
    if (!r.ok) return { ok: false, error: r.error };
    const rows = Array.isArray((r.body as { rows?: unknown })?.rows)
      ? ((r.body as { rows: Row[] }).rows)
      : [];
    return {
      ok: true,
      assignment_id: assignmentId,
      count: rows.length,
      truncated: rows.length >= limit || undefined,
      messages: rows,
      note:
        rows.length === 0
          ? "The writer has no recorded exchange for that assignment. Say that rather than that no draft exists — the finished document is a separate thing and lives in get_nexus_library{assignment_id}."
          : undefined,
    };
  }

  // A-RAG-1 -- "what does the CF syllabus say about the grading breakdown?"
  //
  // WHAT THIS IS NOT: a semantic search. Nexus HAS one -- api/src/lib/vectorSearch.ts does real
  // pgvector KNN with a similarity floor and a metadata containment filter -- but its only importer
  // is embaAssistantChat.ts, and that module's own header records why it is not a tool ("the chat
  // endpoint dispatches a tool call one-shot and has no tool-RESULT round-trip"). Grepped across
  // api/src: one hit. So no HTTP route performs a vector search, and the sharpest operator the d1
  // GET offers is `ilike`. This is a LITERAL substring match, the tool description says so in those
  // words, and the empty-result note repeats it -- because a model that thinks it searched by
  // MEANING reads a miss as "that is not in your knowledge base", which is a confidently-wrong
  // answer rather than a null one.
  if (name === "search_nexus_knowledge") {
    const query = likeTerm(args.query);
    if (!query) {
      return {
        ok: false,
        error: "query_required",
        note: "This tool matches a literal word in the material, so it needs one. If the owner asked WHICH documents are indexed rather than what they say, call get_nexus_knowledge_base instead.",
      };
    }
    const limit = Math.max(1, Math.min(numArg(args.limit) ?? 20, 200));
    const courseId = strArg(args.course_id);
    const sourceType = strArg(args.source_type);

    const filters: [string, string][] = [["content", `ilike.%${query}%`]];
    // `source_type` is in this route's OWN `filters` list (d1.ts:352), so this is server-side.
    if (sourceType) filters.push(["source_type", `eq.${sourceType}`]);

    // THE COURSE SCOPE IS A CLIENT-SIDE POST-FILTER, and it has to be. The chunks table has no
    // course_id column; the link is `metadata.topic_id`, and a topic IS a course (TopicDetail.tsx
    // passes the route's topicId straight in as course_id to assignments/modules/class_schedules;
    // every upload path passes topicId: courseId; extractContent writes that value into both
    // extracted_content.topic_id and every chunk's metadata.topic_id). d1 cannot filter a jsonb
    // PATH -- `metadata` is filterable by NAME, so d1 would build `"metadata" ILIKE $1`, and jsonb
    // has no ~~* operator, which is a 500. So the ilike bounds the fetch server-side and the course
    // narrows it here. Over-fetch when scoping, or a course with few hits returns nothing while a
    // wider read had them.
    const fetchLimit = courseId ? Math.min(limit * 5, 500) : limit;
    const r = await nexusGet("assistant-knowledge-chunks", filters, {
      // created_at ONLY. `updated_at` is in d1's COMMON list and is therefore ACCEPTED as an order
      // name on every table -- and this table does not have the column (002_app_tables.sql:296),
      // so it is accepted and then fails in Postgres.
      order: "created_at.desc",
      limit: fetchLimit,
    });
    if (!r.ok) return { ok: false, error: r.error };

    const scanned = r.rows.length;
    const scoped = courseId
      ? r.rows.filter((row) => {
          const md = row.metadata;
          const topic = md && typeof md === "object" ? (md as Record<string, unknown>).topic_id : undefined;
          return str(topic) === courseId;
        })
      : r.rows;

    const passages = scoped.slice(0, limit).map(stripEmbedding);

    return {
      ok: true,
      query,
      match_type: "literal_substring",
      course_id: courseId || undefined,
      source_type: sourceType || undefined,
      scanned,
      count: passages.length,
      truncated: scoped.length > passages.length || undefined,
      passages,
      note:
        passages.length === 0
          ? `Nothing in the indexed material contains the literal text "${query}"${courseId ? " for that course" : ""}. This is a WORD match, not a meaning match — say that the word does not appear and TRY ANOTHER WORDING before telling the owner the topic is missing from his knowledge base. get_nexus_knowledge_base will show whether the document is indexed at all.`
          : undefined,
    };
  }

  // A-RAG-5 -- "what's in my knowledge base for this course?"
  //
  // A DIFFERENT TABLE FROM A-RAG-1 ON PURPOSE. The owner is asking which DOCUMENTS are indexed;
  // chunks are fragments of those documents, so answering from chunks is wrong in kind and not
  // merely in shape. content.extracted_content is one row per analysed file and its `topic_id` IS
  // the course id -- and unlike the chunks' metadata it is a real COLUMN in this route's `filters`
  // list (d1.ts:172), so the course scope here is server-side.
  if (name === "get_nexus_knowledge_base") {
    const courseId = strArg(args.course_id);
    const limit = Math.max(1, Math.min(numArg(args.limit) ?? 100, 500));
    const filters: [string, string][] = [];
    if (courseId) filters.push(["topic_id", `eq.${courseId}`]);

    const [docs, courses] = await Promise.all([
      nexusGet("extracted-content", filters, { order: "created_at.desc", limit }),
      nexusGet("courses"),
    ]);
    if (!docs.ok) return { ok: false, error: docs.error };
    const courseName = new Map<string, string>();
    if (courses.ok) for (const c of courses.rows) courseName.set(str(c.id), str(c.name));

    // PROJECTED, NOT PASSED THROUGH. A d1 GET is `SELECT *` and an extracted_content row carries
    // atoms, v2_extraction_data, case_facts_statistics, case_players, study_questions,
    // key_definitions and two comprehensive summaries (001_d1_content.sql:58). A dozen of those is
    // larger than the answer, so the listing reports WHICH rich fields a document has and the model
    // asks for a specific one rather than being handed everything.
    const documents = docs.rows.map((d) => ({
      id: str(d.id),
      file_name: d.file_name ?? null,
      content_type: d.content_type ?? null,
      course_id: str(d.topic_id) || null,
      course_name: courseName.get(str(d.topic_id)) ?? null,
      is_case_analysis: d.is_case_analysis ?? null,
      extracted_at: d.extracted_at ?? d.created_at ?? null,
      extracted: EXTRACTED_CONTENT_FIELDS.filter((f) => hasContent(d[f])),
      // `extracted-content` is the one route in this file carrying anonUnion (d1.ts:171), so the
      // owner clause widens to `(user_id = $1 OR user_id = ANON_OWNER)` and a read can return the
      // shared demo corpus alongside the owner's own. Flagged rather than dropped: presenting demo
      // material as the owner's coursework is the same class of error as the stale journey fork
      // this bridge exists to remove, and silently dropping rows he CAN see is its own surprise.
      shared_sample: undefined,
    }));

    return {
      ok: true,
      course_id: courseId || undefined,
      course_name: courseId ? (courseName.get(courseId) ?? null) : undefined,
      count: documents.length,
      truncated: documents.length >= limit || undefined,
      documents,
      note:
        documents.length === 0
          ? "No analysed documents are indexed for that scope. Report it as 'nothing is indexed there' and state the scope — if the owner named a course, confirm you resolved the right course_id with get_nexus_courses first. Files he merely HOLDS without having analysed them are a different question: use get_nexus_library."
          : "Each entry lists which extractions exist for that document under `extracted`; the text itself is not included here. Search it with search_nexus_knowledge.",
    };
  }

  // A-RAG-3 -- "summarise the case-study analysis you ran on Marketing Strategy".
  //
  // The row has NO title and NO course: content.case_study_analyses is assignment_id, user_id and
  // sixteen long text columns (002_app_tables.sql:207). So a NAME cannot be resolved here, and the
  // only route from a name to an assignment_id is get_nexus_assignments{title}, which already asks
  // the owner which course he means when a title matches several. Same refusal as
  // get_nexus_writer_transcript, for the same reason: reading a different case brief's analysis
  // back as "the one on Marketing Strategy" is a confidently-wrong answer, not a partial one.
  if (name === "get_nexus_case_study_analysis") {
    const assignmentId = strArg(args.assignment_id);
    if (!assignmentId) {
      return {
        ok: false,
        error: "assignment_id_required",
        note: "Resolve the assignment first with get_nexus_assignments{title} — it will ask the owner which course he means if the title matches more than one — then call this again with that id.",
      };
    }
    const wanted = Array.isArray(args.sections)
      ? new Set(
          (args.sections as unknown[])
            .map((x) => strArg(x))
            .filter((x) => (CASE_STUDY_SECTIONS as readonly string[]).includes(x)),
        )
      : new Set<string>();
    const maxChars = Math.max(200, Math.min(numArg(args.max_chars) ?? 4000, 50_000));

    const r = await nexusGet("case-study-analyses", [["assignment_id", `eq.${assignmentId}`]]);
    if (!r.ok) return { ok: false, error: r.error };
    const row = r.rows[0];
    if (!row) {
      return {
        ok: true,
        assignment_id: assignmentId,
        count: 0,
        sections: {},
        note: "No case-study analysis has been run for that assignment. Say that rather than that the assignment has no case — the analysis is a thing Nexus RUNS, and it may simply not have been run yet.",
      };
    }

    const sections: Record<string, string> = {};
    const truncated: string[] = [];
    const omitted: string[] = [];
    for (const f of CASE_STUDY_SECTIONS) {
      const raw = row[f];
      const text = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
      if (!text.trim()) continue;
      // A section the caller NAMED comes back whole; everything else is trimmed. Trimming is
      // REPORTED per section rather than done quietly -- a model that summarises the first 4000
      // characters as though they were the document is the failure this reporting exists to stop.
      if (wanted.size && !wanted.has(f)) {
        omitted.push(f);
        continue;
      }
      if (!wanted.has(f) && text.length > maxChars) {
        sections[f] = text.slice(0, maxChars);
        truncated.push(f);
      } else {
        sections[f] = text;
      }
    }

    return {
      ok: true,
      assignment_id: assignmentId,
      updated_at: row.updated_at ?? null,
      completed_sections: row.completed_sections ?? null,
      count: Object.keys(sections).length,
      sections,
      truncated_sections: truncated.length ? truncated : undefined,
      available_sections: omitted.length ? omitted : undefined,
      note: truncated.length
        ? `These sections were TRIMMED to ${maxChars} characters and are incomplete: ${truncated.join(", ")}. Do not summarise a trimmed section as though it were the whole thing — call this again with sections:["<name>"] to read one in full.`
        : Object.keys(sections).length === 0
          ? "A case-study analysis row exists for that assignment but every section is empty. Say exactly that — an empty analysis and a failed read look identical from here."
          : undefined,
    };
  }

  return { ok: false, error: `unknown_nexus_tool_${name}` };
}
