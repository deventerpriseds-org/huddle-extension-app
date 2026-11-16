// WHAT: verifier loop-1 probe for listTranscriptsInRange paging/fallback (claim 4), fetch mocked. Synthetic ids only.
process.env.FIREFLIES_API_KEY = "test-key";
const { listTranscriptsInRange } = await import("../../src/features/huddle/lib/fireflies/fireflies.server.ts");
const { unionMeetings } = await import("../../src/features/huddle/lib/fireflies/fireflies-list.ts");
const FROM = "2026-11-09T05:00:00Z", TO = "2026-11-16T05:00:00Z";
const day = (i: number) => Date.parse(FROM) + i * 3_600_000; // hourly from window start
const out: string[] = [];
const chk = (n: string, got: unknown, want: unknown) => out.push(`${JSON.stringify(got) === JSON.stringify(want) ? "PASS" : "FAIL"} | ${n} | got ${JSON.stringify(got)} | want ${JSON.stringify(want)}`);
const run = async (handler: (q: string, v: any) => any) => {
  const calls: any[] = [];
  (globalThis as any).fetch = async (_u: string, init: any) => { const b = JSON.parse(init.body); calls.push(b.variables); return new Response(JSON.stringify(handler(b.query, b.variables)), { status: 200 }); };
  const r = await listTranscriptsInRange(FROM, TO);
  return { ids: r.meetings.length, mode: r.mode, pages: r.pages, calls: calls.map((c) => c.skip) };
};
// 120 meetings in window, date args accepted
const all = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, date: day(i) }));
chk("date args: 120 meetings -> 3 pages, all kept", await run((_q, v) => ({ data: { transcripts: all.slice(v.skip, v.skip + v.limit) } })), { ids: 120, mode: "date_args", pages: 3, calls: [0, 50, 100] });
chk("date args: exactly 100 -> extra empty page then stop", await run((_q, v) => ({ data: { transcripts: all.slice(0, 100).slice(v.skip, v.skip + v.limit) } })), { ids: 100, mode: "date_args", pages: 3, calls: [0, 50, 100] });
// refused -> fallback, newest first, includes older-than-window meetings
const mixed = [...Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, date: day(150 - i) })), ...Array.from({ length: 120 }, (_, i) => ({ id: `o${i}`, date: Date.parse(FROM) - (i + 1) * 3_600_000 }))];
chk("refused -> paged_all, window applied, stops on a full all-older page", await run((q, v) => (q.includes("fromDate") ? { errors: [{ message: 'Unknown argument "fromDate" on field "transcripts"' }], data: null } : { data: { transcripts: mixed.slice(v.skip, v.skip + v.limit) } })), { ids: 60, mode: "paged_all", pages: 3, calls: [0, 0, 50, 100] });
chk("duplicate ids across pages counted once", await run((_q, v) => ({ data: { transcripts: v.skip === 0 ? all.slice(0, 50) : all.slice(25, 45) } })), { ids: 50, mode: "date_args", pages: 2, calls: [0, 50] });
let threw = ""; try { await run(() => ({ errors: [{ message: "rate limited" }], data: null })); } catch (e) { threw = (e as Error).message; }
chk("non-date error, no data -> throws (caller logs and falls back to known)", threw, "fireflies_list_errors");
chk("union: known + listed overlap, no duplicates", unionMeetings([{ meeting_id: "a", owner_email: "x@example.test" }, { meeting_id: "a", owner_email: "x@example.test" }, { meeting_id: "b", owner_email: "" }], [{ id: "b", atMs: 1 }, { id: "c", atMs: null }], "d@example.test").map((m) => `${m.id}:${m.from}`), ["a:known", "b:both", "c:listed"]);
chk("union: known id with whitespace vs listed trimmed id", unionMeetings([{ meeting_id: "a ", owner_email: "" }], [{ id: "a", atMs: 1 }], "d").length, 1);
console.log(out.join("\n"));
