// WHAT:       Verifier loop 12, claim 5(a): inDailyWindow + teamsLoadAt parse at DST edges, midnight, and odd spellings.
// WHY:        New since loop 11 (Teams daily 6pm window). SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-12.md. Run under node AND bun. All data synthetic.
const { inDailyWindow } = await import("../src/features/huddle/lib/correspondence/ingest-pass.ts");
const rows: [string, string, boolean][] = [
  ["2026-03-08T06:59:00Z", "18:00", false], // 01:59 EST, spring-forward day
  ["2026-03-08T07:00:00Z", "18:00", false], // 03:00 EDT
  ["2026-03-08T21:59:00Z", "18:00", false], // 17:59 EDT
  ["2026-03-08T22:00:00Z", "18:00", true], // 18:00 EDT
  ["2026-03-07T22:59:00Z", "18:00", false], // 17:59 EST (day before)
  ["2026-03-07T23:00:00Z", "18:00", true], // 18:00 EST
  ["2026-11-01T22:59:00Z", "18:00", false], // 17:59 EST, fall-back day
  ["2026-11-01T23:00:00Z", "18:00", true], // 18:00 EST
  ["2026-11-01T05:30:00Z", "18:00", false], // 01:30 EDT (first)
  ["2026-11-01T06:30:00Z", "18:00", false], // 01:30 EST (repeat)
  ["2026-11-16T04:59:00Z", "18:00", true], // 23:59 EST
  ["2026-11-16T05:00:00Z", "18:00", false], // 00:00 EST midnight
  ["2026-11-16T05:00:30Z", "18:00", false],
  ["2026-11-16T05:00:00Z", "00:00", true], // window all day
  ["2026-11-16T04:59:00Z", "23:59", true],
  ["2026-11-16T04:58:00Z", "23:59", false],
  ["2026-11-16T23:00:00Z", "18:00", true],
  ["2026-11-16T23:00:00Z", "7:05", true],
  ["2026-11-16T12:04:00Z", "7:05", false], // 07:04 EST
];
let bad = 0;
for (const [iso, hh, want] of rows) {
  const got = inDailyWindow(Date.parse(iso), hh);
  if (got !== want) bad++;
  console.log(`${got === want ? "OK " : "BAD"} ${iso} at=${hh} got=${got} want=${want}`);
}
// bad clock value -> "in window" (keep-loading)
for (const hh of ["", "xx", "18", "18:00:00"]) console.log(`odd at=${JSON.stringify(hh)} -> ${inDailyWindow(Date.parse("2026-11-16T12:00:00Z"), hh)}`);
console.log(`window rows bad=${bad} of ${rows.length}`);
