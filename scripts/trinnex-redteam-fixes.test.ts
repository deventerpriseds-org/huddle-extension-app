// WHAT:          Guards added by the red-team FIX round (2026-11-20) for the Trinnex workspace: the personal-DB URL guard
//                spelling table (I1/I2), owner-scoped delete with a stateful fake (I3), the reply-persistence exclusion on
//                BOTH dispatch paths (I5), and the meeting metadata keys (I4).
// WHY:           docs/qc-evidence/REDTEAM-trinnex-workspace.md found 15 BROKEN rows; the red team's own tests pin the
//                reported input, these pin the wider spelling set and the behaviour around it.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Red-team fix round (2026-11-20)".
//                Run: bun test scripts/trinnex-redteam-fixes.test.ts. Every pool is a fake; no live DB or model.
// Failing tests also print `FAIL <name>` so scripts/mutate.sh can attribute them.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const LIB = `${import.meta.dir}/../src/features/huddle/lib`;
const t = (name: string, fn: () => Promise<void> | void) =>
  test(name, async () => {
    try {
      await fn();
    } catch (e) {
      console.log(`FAIL ${name}`);
      throw e;
    }
  });

const PERSONAL = "postgresql://admin:pw@eds-postgresql.postgres.database.azure.com:5432/RAG_AI_Agents?sslmode=require";
process.env.AZURE_PG_URL = PERSONAL;
const pool = await import(`${LIB}/db/shared-pool.server.ts`);

// ── I1 / I2: spelling table for the personal-database guard ─────────────────────────────────────────
const H = "postgresql://u:p@eds-postgresql.postgres.database.azure.com:5432";
const REFUSED: Array<[string, string]> = [
  [`${H}/RAG_AI_Agents`, "plain"],
  [`${H}/rag_ai_agents`, "lower case"],
  [`${H}/RAG_AI_AGENTS?sslmode=require`, "upper case + query"],
  [`${H}/RAG%5FAI%5FAgents?sslmode=require`, "RT-I1 percent-encoded underscores"],
  [`${H}/%52%41%47_AI_Agents`, "percent-encoded letters"],
  [`${H}/RAG_AI_Agents#x`, "RT-I2 fragment"],
  [`${H}/RAG_AI_Agents?x=1#frag`, "query + fragment"],
  [`${H}/RAG_AI_Agents/`, "trailing slash"],
  [`${H}/RAG_AI_Agents%2F`, "encoded trailing slash %2F"],
  [`${H}/%2FRAG_AI_Agents`, "encoded leading slash %2F"],
  [`${H}/x%2FRAG_AI_Agents`, "%2F-joined part"],
  [`${H}/RAG_AI_Agents%20`, "encoded trailing space"],
  [`${H}/%20RAG_AI_Agents`, "encoded leading space"],
  [`  ${H}/RAG_AI_Agents  `, "surrounding whitespace"],
  [`${H}/RAG_AI_Agents%09`, "encoded tab"],
  [`postgres://u:p@other-host:5432/RAG_AI_Agents`, "other host, same name"],
  [`socket://u:p@/var/run/postgresql?db=RAG_AI_Agents`, "socket form ?db="],
  [PERSONAL, "identical to AZURE_PG_URL"],
  [`postgresql://admin:pw@EDS-POSTGRESQL.postgres.database.azure.com/rag_ai_agents?sslmode=require`, "AZURE_PG_URL normalised"],
  [`${H}/RAG%ZZ`, "malformed escape (fail closed)"],
  [`not a url`, "unparseable (fail closed)"],
  [`/var/run/postgresql RAG_AI_Agents`, "pg unix-socket string form (fail closed)"],
  [`${H}/`, "no database (fail closed)"],
  [`${H}`, "no path (fail closed)"],
];
const ALLOWED = [`${H}/Trinnex_Memory?sslmode=require`, `${H}/Trinnex_Memory#x`, `${H}/RAG_AI_Agents_archive`];

t("GUARD1 every spelling of the personal database is refused with a code", () => {
  for (const [url, why] of REFUSED) {
    const code = pool.trinnexUrlRefusal(url, PERSONAL);
    if (code === null) throw new Error(`not refused: ${why}`);
    expect(code).toMatch(/^[a-z_]+$/);
  }
});
t("GUARD2 the Trinnex database itself is allowed", () => {
  for (const url of ALLOWED) expect(pool.trinnexUrlRefusal(url, PERSONAL)).toBeNull();
});
t("GUARD3 a refused URL is fail-closed: not configured, no pool, the log carries the code and never the URL", () => {
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    process.env.TRINNEX_PG_URL = `${H}/RAG%5FAI%5FAgents`;
    expect(pool.trinnexPgConfigured()).toBe(false);
    expect(() => pool.getTrinnexPool()).toThrow(/refused \(code=personal_db_name\)/);
  } finally {
    console.error = orig;
    delete process.env.TRINNEX_PG_URL;
  }
  expect(logged.some((l) => l.includes("code=personal_db_name"))).toBe(true);
  expect(logged.some((l) => l.includes("eds-postgresql") || l.includes("RAG"))).toBe(false);
});

// ── I3: owner-scoped delete, against a STATEFUL fake that honours the bound predicates ─────────────
type Row = { id: string; text: string; source: string; agent_id: string | null; metadata: Record<string, unknown> };
type Fact = { id: string; agent_id: string; source_chunk_id: string };
const chunks: Row[] = [];
const facts: Fact[] = [];
let seq = 0;
const ownerOf = (r: Row) => String(r.metadata.owner_email ?? "").toLowerCase();
const fake = {
  query: async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO rag_chunks/.test(sql)) {
      const md = typeof params[5] === "string" ? JSON.parse(params[5] as string) : (params[5] as Record<string, unknown>);
      // CHUNK_DEDUP_KEY: (scope, agent_id, source, text) -- a repeat returns the existing row.
      const hit = chunks.find((c) => c.agent_id === (params[1] ?? null) && c.source === params[3] && c.text === params[2]);
      if (hit) return { rows: [{ id: hit.id }] };
      const r = { id: `c-${++seq}`, text: String(params[2]), source: String(params[3]), agent_id: (params[1] as string) ?? null, metadata: md };
      chunks.push(r);
      return { rows: [{ id: r.id }] };
    }
    if (/INSERT INTO rag_triples/.test(sql)) {
      const f = { id: `f-${++seq}`, agent_id: String(params[1]), source_chunk_id: String(params[6]) };
      facts.push(f);
      return { rows: [{ id: f.id }] };
    }
    if (/DELETE FROM rag_triples/.test(sql)) {
      const sources = params[0] as string[];
      const scoped = /owner_email'\) = \$2/.test(sql);
      const keys = (/agent_id = ANY\(\$3/.test(sql) ? params[2] : params[0]) as string[];
      const mine = new Set(
        chunks.filter((c) => sources.includes(c.source) && (!scoped || ownerOf(c) === params[1])).map((c) => c.id),
      );
      const gone = facts.filter((f) => keys.includes(f.agent_id) || mine.has(f.source_chunk_id));
      for (const g of gone) facts.splice(facts.indexOf(g), 1);
      return { rows: gone.map((g) => ({ id: g.id })) };
    }
    if (/DELETE FROM rag_chunks/.test(sql)) {
      const sources = params[0] as string[];
      const scoped = /owner_email'\) = \$2/.test(sql);
      const gone = chunks.filter((c) => sources.includes(c.source) && (!scoped || ownerOf(c) === params[1]));
      for (const g of gone) chunks.splice(chunks.indexOf(g), 1);
      return { rows: gone.map((g) => ({ id: g.id })) };
    }
    return { rows: [] };
  },
};
const mem = await import(`${LIB}/trinnex/memory.server.ts`);
mem.__setTrinnexDepsForTest({
  getPool: () => fake,
  configured: () => true,
  embed: async () => [0.1, 0.2, 0.3],
  extractTriples: async () => ({ triples: [{ subject: "vendor", predicate: "outcome", object: "passed", confidence: 0.9 }], failureKind: null }),
  reportFailure: async () => {},
});
const A = "test-owner-a@example.com";
const B = "test-owner-b@example.com";
const shared = (ownerEmail: string) => ({
  ownerEmail,
  sourceId: "ff-shared-1",
  sourceKind: "meeting" as const,
  title: "Test-Shared meeting",
  firefliesTitle: "Test-Weekly sync",
  date: "2026-11-18T15:00:00Z",
  series: "Engineering Leaders",
  participants: [],
  segments: [{ text: "Test-we agreed to ship on Friday", speaker: "Michael R.", speakerLabel: "Speaker 1", at: "00:01:05" }],
});

t("OWN1 owner B ingesting and deleting the same sourceId leaves owner A's passages AND facts intact", async () => {
  chunks.length = 0;
  facts.length = 0;
  await mem.ingestTrinnexSource(shared(A));
  const aChunks = chunks.filter((c) => ownerOf(c) === A).map((c) => c.id);
  const aFacts = facts.map((f) => f.id);
  expect(aChunks.length).toBe(1);
  expect(aFacts.length).toBe(1);
  // identical text from a second owner is its OWN row (owner is in the dedup identity), not A's row
  await mem.ingestTrinnexSource(shared(B));
  expect(chunks.filter((c) => ownerOf(c) === B).length).toBe(1);
  await mem.deleteTrinnexSource("ff-shared-1", B);
  expect(chunks.map((c) => c.id)).toEqual(aChunks);
  expect(facts.map((f) => f.id)).toEqual(aFacts);
  // and A's own delete still removes A's rows
  await mem.deleteTrinnexSource("ff-shared-1", A);
  expect(chunks.length + facts.length).toBe(0);
});
t("OWN2 a delete with no owner is refused before any query", async () => {
  await expect(mem.deleteTrinnexSource("ff-shared-1", "  ")).rejects.toThrow("ownerEmail");
});
t("OWN3 the Library removal passes the item's owner to the memory delete", () => {
  const src = readFileSync(`${LIB}/trinnex/library.server.ts`, "utf8");
  expect(src).toContain("deps.memory.remove(item.id, item.ownerEmail)");
  expect(src).not.toMatch(/deps\.memory\.remove\(item\.id\)/);
  expect(src).toContain("mem.deleteTrinnexSource(id, ownerEmail)");
});

// ── I4: meeting metadata ────────────────────────────────────────────────────────────────────────────
t("META1 a meeting passage stores the Fireflies title and the ORIGINAL speaker label; meetings.server passes both", async () => {
  chunks.length = 0;
  await mem.ingestTrinnexSource(shared(A));
  expect(chunks[0].metadata.fireflies_title).toBe("Test-Weekly sync");
  expect(chunks[0].metadata.speaker_label).toBe("Speaker 1");
  expect(chunks[0].metadata.speaker).toBe("Michael R.");
  const src = readFileSync(`${LIB}/trinnex/meetings.server.ts`, "utf8");
  expect(src).toContain("speakerLabel: x.speakerLabel");
  expect(src).toMatch(/firefliesTitle: row\.title/);
});

// ── I5: replies from a Trinnex turn never reach personal memory, on BOTH dispatch paths ────────────
const { turnUsedTrinnex } = await import(`${LIB}/trinnex/search.ts`);
t("PERS1 turnUsedTrinnex: the turn flag OR a resumed search_trinnex breadcrumb excludes the turn", () => {
  expect(turnUsedTrinnex(false, [])).toBe(false);
  expect(turnUsedTrinnex(false, [{ tool: "search_memory" }, { tool: "tool_catalog" }])).toBe(false);
  expect(turnUsedTrinnex(true, [])).toBe(true);
  expect(turnUsedTrinnex(false, [{ tool: "search_memory" }, { tool: "search_trinnex" }])).toBe(true);
  expect(turnUsedTrinnex(false, null)).toBe(false);
});
t("PERS2 both dispatch paths go through the ONE wrapper that marks the turn, and persistence checks it before writing", () => {
  const src = readFileSync(`${LIB}/huddle.functions.ts`, "utf8");
  const w = src.indexOf("const runTrinnexSearch = async");
  expect(w).toBeGreaterThan(0);
  const body = src.slice(w, src.indexOf("};", w));
  // marks BEFORE dispatching (a failed search still excludes the turn) and records the breadcrumb
  expect(body.indexOf("trinnexSearchedThisTurn = true")).toBeGreaterThan(0);
  expect(body.indexOf("trinnexSearchedThisTurn = true")).toBeLessThan(body.indexOf("dispatchTrinnexTool("));
  expect(body).toContain('recordToolUse(winner.id, "search_trinnex"');
  // OpenAI path
  expect(src).toMatch(/if \(c\.name === "search_trinnex"\) \{[\s\S]{0,200}return await runTrinnexSearch\(c\.arguments\)/);
  // Lovable path
  // (verifier loop 1: the agent passed in is scope-gated, trinnexHere(winner) ? winner : null)
  expect(src).toMatch(/trinnexLovableToolsFor\(trinnexHere\(winner\) \? winner : null, \(def\) =>[\s\S]{0,400}execute: async \(args\) => await runTrinnexSearch\(/);
  // no other executor call
  expect(src.match(/dispatchTrinnexTool\(/g)?.length).toBe(1);
  // persistResearchedMemory returns before the reply-chunk loop when the turn used Trinnex
  const p = src.indexOf("function persistResearchedMemory()");
  const guard = src.indexOf("if (turnUsedTrinnex(trinnexSearchedThisTurn, toolUses)) return;", p);
  const write = src.indexOf("azurePgStore.writeChunk(", p);
  expect(guard).toBeGreaterThan(p);
  expect(guard).toBeLessThan(write);
});

// ── N1-N5: the name parser, wider spellings than the red team's own rows ───────────────────────────
const N = await import(`${LIB}/trinnex/names.ts`);
const ctxN = { people: ["Von", "Michael R.", "Priya S.", "Dana K."], owner: "Von" };
const twoM = { people: ["Von", "Michael R.", "Michael T."], owner: "Von" };
const nm = (s: string, c = ctxN) => N.suggestNames(s, c).map((x: { name: string }) => x.name);
t("NAME1 apostrophe and hyphen names are whole names after a trigger; file-name hyphens still split", () => {
  expect(nm("Sync with O'Brien")).toEqual(["O'Brien"]);
  expect(nm("Call with D’Angelo")).toEqual(["D’Angelo"]);
  expect(nm("Meeting with Jean-Luc")).toEqual(["Jean-Luc"]);
  expect(nm("Meeting with Jean-Luc Picard")).toEqual(["Jean-Luc Picard"]);
  expect(nm("Priya-budget-notes.docx")).toEqual(["Priya S."]);
  expect(nm("O'Brien review")).toEqual([]); // no trigger, not on the list
});
t("NAME2 a trailing initial or surname that differs is a different person", () => {
  expect(nm("Sync with Michael T.", twoM)).toEqual(["Michael T."]);
  expect(nm("Michael T. review", twoM)).toEqual(["Michael T."]);
  expect(nm("Sync with Michael R.", twoM)).toEqual(["Michael R."]);
  expect(nm("Sync with Michael", twoM)).toEqual(["Michael R.", "Michael T."]); // S-A21 unchanged
  expect(nm("Michael's 1:1")).toEqual(["Michael R."]); // S-A19 unchanged
  expect(nm("Sync with Michael Smith", twoM)).toEqual(["Michael Smith"]); // neither Michael
  expect(nm("Michael Roberts sync")).toEqual(["Michael R."]); // consistent initial
});
t("NAME3 a speaker label never maps on a first name whose surname/initial conflicts", () => {
  const kind = (l: string, c = ctxN) => N.matchSpeaker(l, c);
  expect(kind("Dana Smith")).toEqual({ kind: "unmatched", label: "Dana Smith" });
  expect(kind("Dana K.")).toEqual({ kind: "person", label: "Dana K.", person: "Dana K." });
  expect(kind("Dana Kowalski")).toEqual({ kind: "person", label: "Dana Kowalski", person: "Dana K." });
  expect(kind("Von Ellis")).toEqual({ kind: "person", label: "Von Ellis", person: "Von" });
  expect(kind("Michael T.", twoM)).toEqual({ kind: "person", label: "Michael T.", person: "Michael T." });
  expect(kind("Michael", twoM).kind).toBe("ambiguous");
  expect(kind("Michael Smith", twoM)).toEqual({ kind: "unmatched", label: "Michael Smith" });
});
t("NAME4 holidays, roles and product names are not names; a listed person with such a name still is", () => {
  for (const w of ["Candidate", "Christmas", "Easter", "Microsoft", "Fireflies", "Recruiter", "Thanksgiving"]) {
    expect(nm(`Sync with ${w}`)).toEqual([]);
  }
  expect(nm("Sync with Jordan")).toEqual(["Jordan"]); // S-A5 unchanged
});
t("NAME5 a speaker label that is an Object.prototype key stays a literal label on both transcript paths", async () => {
  const core = await import(`${LIB}/trinnex/meeting-triage-core.ts`);
  const lc = await import(`${LIB}/trinnex/library-core.ts`);
  const labels = ["constructor", "toString", "__proto__", "hasOwnProperty"];
  const seg = core.segmentsFor(labels.map((l, i) => ({ text: `line ${i}`, speaker: l, start: i })) as never, {});
  expect(seg.map((s: { speaker: unknown }) => s.speaker)).toEqual(labels);
  const map = core.cleanSpeakerMap({ constructor: "Priya S." }, ["constructor"]);
  expect(core.segmentsFor([{ text: "hi", speaker: "constructor", start: 1 }] as never, map)[0].speaker).toBe("Priya S.");
  expect(Object.getPrototypeOf(map)).toBeNull();
  const turns = lc.turnsFromCues(labels.map((l, i) => ({ speaker: l, text: `cue ${i}`, start: i })) as never, (x: string) => x, {});
  expect(turns.map((x: { speaker: unknown }) => x.speaker)).toEqual(labels);
});

// ── S1-S5: the ONE recency table, section-5 rows plus the red-team rows ────────────────────────────
const S = await import(`${LIB}/trinnex/search.ts`);
const NOW = new Date("2026-11-20T12:00:00Z"); // Friday
const REC: Array<[string, string, unknown, string?]> = [
  ["S-C1", "the last Engineering Leaders meeting", { mostRecent: 1 }],
  ["S-C2", "most recent Eng Leaders sync", { mostRecent: 1 }],
  ["S-C3", "last week's Engineering Leaders meeting", { dateFrom: "2026-11-09", dateTo: "2026-11-15" }],
  ["S-C3b", "the previous week", { dateFrom: "2026-11-09", dateTo: "2026-11-15" }],
  ["S-C4", "the last two Engineering Leaders meetings", { mostRecent: 2 }],
  ["S-C5", "the Engineering Leaders meeting before last", { mostRecent: 1, skip: 1 }],
  ["S-C5b", "the second to last sync", { mostRecent: 1, skip: 1 }],
  ["S-C6", "last time we discussed the vendor", null],
  ["S-C7", "the last meeting", { mostRecent: 1 }],
  ["S-C10", "what did Michael say last", { mostRecent: 1 }],
  ["S-C11", 'the "Last Mile" review', null],
  ["RT-S1", "to-dos from the previous Engineering Leaders meeting", { mostRecent: 1 }],
  ["RT-S1b", "the previous sync", { mostRecent: 1 }],
  ["RT-S1 neg", "prior to the launch what did we decide", null],
  ["RT-S1 neg2", "previous decisions about the vendor", null],
  ["RT-S2", "the second most recent Engineering Leaders meeting", { mostRecent: 1, skip: 1 }],
  ["RT-S2b", "the third latest standup", { mostRecent: 1, skip: 2 }],
  ["RT-S3", "summarise the last 10 Engineering Leaders meetings", { mostRecent: 10 }],
  ["RT-S3b", "the last twelve meetings", { mostRecent: 12 }],
  ["RT-S3c", "the last 9999 meetings", { mostRecent: 50 }],
  ["RT-S4 quarter", "what did we decide last quarter", { dateFrom: "2026-07-01", dateTo: "2026-09-30" }],
  ["RT-S4 month", "what did Michael say last month", { dateFrom: "2026-10-01", dateTo: "2026-10-31" }],
  ["RT-S4 year", "last year's planning", { dateFrom: "2025-01-01", dateTo: "2025-12-31" }],
  ["RT-S4 span", "the last 2 weeks", { dateFrom: "2026-11-06", dateTo: "2026-11-20" }],
  ["RT-S4 yesterday", "yesterday's sync", { dateFrom: "2026-11-19", dateTo: "2026-11-19" }],
  // owner time zone: 03:30 UTC Monday 16th is still SUNDAY 15th in New York, so "last week" there is Nov 2-8
  ["TZ week", "last week's sync", { dateFrom: "2026-11-02", dateTo: "2026-11-08" }, "America/New_York"],
  ["TZ week UTC", "last week's sync", { dateFrom: "2026-11-09", dateTo: "2026-11-15" }, "UTC"],
  // 05:00 UTC Jan 1 2027 is still Dec 31 (Q4) in Los Angeles, so "last quarter" there is Q3; in UTC it is Q4
  ["TZ quarter Jan 1", "last quarter", { dateFrom: "2026-07-01", dateTo: "2026-09-30" }, "America/Los_Angeles"],
  ["TZ quarter Jan 1 UTC", "last quarter", { dateFrom: "2026-10-01", dateTo: "2026-12-31" }, "UTC"],
];
t("REC1 every recency row in the ONE table gives the specified filter", () => {
  for (const [row, q, want, tz] of REC) {
    const now =
      row.startsWith("TZ week") ? new Date("2026-11-16T03:30:00Z") : row.startsWith("TZ quarter") ? new Date("2027-01-01T05:00:00Z") : NOW;
    const got = S.recencyFromQuestion(q, now, tz ?? "UTC");
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${row}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  }
});
t("REC2 an unknown time zone falls back to UTC instead of throwing", () => {
  expect(S.recencyFromQuestion("last week", NOW, "Not/AZone")).toEqual({ dateFrom: "2026-11-09", dateTo: "2026-11-15" });
});
const CAT = [
  { source: "trinnex:meeting:m1", title: "Test-A", date: "2026-11-10T15:00:00Z", series: "EL", participants: [], speakers: [] },
  { source: "trinnex:meeting:m2", title: "Test-B", date: "2026-11-03T15:00:00Z", series: "EL", participants: [], speakers: [] },
  { source: "trinnex:upload:u1", title: "Test-doc", date: "2026-11-15", series: null, participants: [], speakers: [] },
  { source: "trinnex:meeting:m3", title: "Test-C", date: "2026-11-16T03:30:00Z", series: "EL", participants: [], speakers: [] },
];
t("REC3 recency counts meetings only; an upload is picked only when asked for", () => {
  expect(S.selectSources(CAT, { mostRecent: 1 })).toEqual({ kind: "sources", sources: ["trinnex:meeting:m3"], speaker: undefined });
  expect(S.selectSources(CAT, { mostRecent: 2, skip: 1 })).toEqual({
    kind: "sources",
    sources: ["trinnex:meeting:m1", "trinnex:meeting:m2"],
    speaker: undefined,
  });
  expect(S.selectSources(CAT, { mostRecent: 1, recencyKind: "upload" })).toEqual({
    kind: "sources",
    sources: ["trinnex:upload:u1"],
    speaker: undefined,
  });
});
t("REC4 a date range compares the meeting's day in the OWNER's zone", () => {
  const wk = { dateFrom: "2026-11-09", dateTo: "2026-11-15" };
  const ny = S.selectSources(CAT, { ...wk, timeZone: "America/New_York" });
  expect(ny.kind === "sources" && ny.sources.includes("trinnex:meeting:m3")).toBe(true); // Sunday 22:30 NY
  const utc = S.selectSources(CAT, { ...wk, timeZone: "UTC" });
  expect(utc.kind === "sources" && utc.sources.includes("trinnex:meeting:m3")).toBe(false); // Monday in UTC
  // the START of the range too: 03:00 UTC Mon 9th is Sun 8th 22:00 in New York, so it is OUT of Nov 9-15 there
  const early = [{ source: "trinnex:meeting:e1", title: "Test-E", date: "2026-11-09T03:00:00Z", series: null, participants: [], speakers: [] }];
  expect(S.selectSources(early, { ...wk, timeZone: "America/New_York" }).kind).toBe("none");
  expect(S.selectSources(early, { ...wk, timeZone: "UTC" }).kind).toBe("sources");
});
t("REC5 searchTrinnex threads the owner's zone; huddle.functions resolves it the shared way", () => {
  const src = readFileSync(`${LIB}/huddle.functions.ts`, "utf8");
  expect(src).toContain("ident.resolveTimeZone(data.caller, data.timeZone)");
  const ms = readFileSync(`${LIB}/trinnex/memory.server.ts`, "utf8");
  expect(ms).toContain("recencyFromQuestion(str(args.question), now, timeZone)");
  expect(ms).toContain("filters.timeZone = timeZone;");
});
