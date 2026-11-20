// WHAT:          RED-TEAM failing tests for the Trinnex question filters (lib/trinnex/search.ts recencyFromQuestion,
//                selectSources) and source selection through searchTrinnex. Each test is a wrong answer the pre-pass found.
// WHY:           Tier 1 red-team pre-pass, docs/qc-evidence/REDTEAM-trinnex-workspace.md. The builder turns these green.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/REDTEAM-trinnex-workspace.md rows S1-S5. Run: bun test scripts/trinnex-redteam-search.test.ts
import { test, expect } from "bun:test";

const { recencyFromQuestion, selectSources } = await import(`${import.meta.dir}/../src/features/huddle/lib/trinnex/search.ts`);

const NOW = new Date("2026-11-20T12:00:00Z");

test("RT-S1 'the previous Engineering Leaders meeting' applies a recency filter (one meeting), not none", () => {
  expect(recencyFromQuestion("to-dos from the previous Engineering Leaders meeting", NOW)).toEqual({ mostRecent: 1 });
});

test("RT-S2 'the second most recent' = skip 1, not the most recent", () => {
  expect(recencyFromQuestion("what was decided in the second most recent Engineering Leaders meeting", NOW)).toEqual({
    mostRecent: 1,
    skip: 1,
  });
});

test("RT-S3 'the last 10 meetings' is 10 meetings, not 1", () => {
  const r = recencyFromQuestion("summarise the last 10 Engineering Leaders meetings", NOW);
  expect(r?.mostRecent).toBe(10);
});

test("RT-S4 'last quarter' / 'last month' are date ranges, not 'the single most recent meeting'", () => {
  expect(recencyFromQuestion("what did we decide last quarter about the vendor", NOW)?.mostRecent).toBeUndefined();
  expect(recencyFromQuestion("what did Michael say last month", NOW)?.mostRecent).toBeUndefined();
});

test("RT-S5 'the last meeting' (S-C7) selects the newest MEETING, never a newer uploaded document", () => {
  const catalog = [
    { source: "trinnex:meeting:m1", title: "Test-Weekly", date: "2026-11-10T15:00:00Z", series: null, participants: [], speakers: ["Michael R."] },
    { source: "trinnex:upload:u1", title: "Test-budget.docx", date: "2026-11-15", series: null, participants: [], speakers: [] },
  ];
  const rec = recencyFromQuestion("what were the to-dos from the last meeting", NOW) ?? {};
  const sel = selectSources(catalog, { mostRecent: rec.mostRecent, skip: rec.skip });
  expect(sel).toEqual({ kind: "sources", sources: ["trinnex:meeting:m1"], speaker: undefined });
});
