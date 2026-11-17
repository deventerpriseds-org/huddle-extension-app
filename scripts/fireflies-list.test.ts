// WHAT:       Offline tests (synthetic data) for lib/fireflies/fireflies-list.ts: parsing a transcripts page, the date
//             window, the fallback trigger, the union with known meetings, and per-day counts.
// WHY:        The back-fill now discovers meetings by date range (owner brief 2026-11-16); a wrong union or window
//             silently drops meetings from Azure.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-report-from-ledger.md (piece 2).
// Run: bun scripts/fireflies-list.test.ts
import { dateArgsRefused, dayCounts, inListWindow, meetingMs, normMeetingId, parseListPage, unionMeetings } from "../src/features/huddle/lib/fireflies/fireflies-list";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const MON = Date.parse("2026-11-09T05:00:00Z");
const NOW = Date.parse("2026-11-16T05:00:00Z");
t("FL-1 meeting time from ms number, numeric string, ISO string, dateString; else null", [meetingMs(1762800000000), meetingMs("1762800000000"), meetingMs("2026-11-10T15:00:00Z"), meetingMs(undefined, "2026-11-10T15:00:00Z"), meetingMs("x")], [1762800000000, 1762800000000, Date.parse("2026-11-10T15:00:00Z"), Date.parse("2026-11-10T15:00:00Z"), null]);
const page = parseListPage({ data: { transcripts: [{ id: "m1", date: Date.parse("2026-11-10T15:00:00Z") }, { id: "" }, { date: 1 }, { id: "m2", dateString: "2026-11-11T15:00:00Z" }, { id: "m3" }] } });
t("FL-2 a page keeps rows with an id, with their time (null when absent)", page.map((m) => [m.id, m.atMs !== null]), [["m1", true], ["m2", true], ["m3", false]]);
t("FL-3 bad shapes -> empty page", [parseListPage(null), parseListPage({ data: {} }), parseListPage({ data: { transcripts: "x" } })], [[], [], []]);
t("FL-4 window: inside kept, before / after dropped, no time KEPT", [inListWindow({ id: "a", atMs: MON }, MON, NOW), inListWindow({ id: "b", atMs: MON - 1 }, MON, NOW), inListWindow({ id: "c", atMs: NOW + 1 }, MON, NOW), inListWindow({ id: "d", atMs: null }, MON, NOW)], [true, false, false, true]);
t("FL-5 fallback only when the error names the date arguments", [dateArgsRefused([{ message: 'Unknown argument "fromDate" on field "transcripts"' }]), dateArgsRefused([{ message: "rate limited" }]), dateArgsRefused(undefined)], [true, false, false]);
const u = unionMeetings([{ meeting_id: "k1", owner_email: "owner@work.example" }, { meeting_id: "k2", owner_email: "" }], [{ id: "k2", atMs: 1 }, { id: "l1", atMs: 2 }], "default@work.example");
t("FL-6 union: each meeting once, known first, provenance known/both/listed, owner kept or defaulted", u, [
  { id: "k1", owner: "owner@work.example", from: "known" },
  { id: "k2", owner: "default@work.example", from: "both" },
  { id: "l1", owner: "default@work.example", from: "listed" },
]);
const u6 = unionMeetings(
  [{ meeting_id: " k1 ", owner_email: "owner@work.example" }, { meeting_id: "k2\t", owner_email: "" }, { meeting_id: "   ", owner_email: "" }, { meeting_id: null as unknown as string, owner_email: "" }],
  [{ id: "k1", atMs: 1 }, { id: " k2", atMs: 2 }, { id: "  ", atMs: 3 }, { id: " l1 ", atMs: 4 }],
  "default@work.example",
);
t("VF6-1 union trims ids on BOTH sides: a known ' k1 ' and a listed 'k1' are ONE meeting (both), ids emitted trimmed, blank / non-string ids skipped", u6, [
  { id: "k1", owner: "owner@work.example", from: "both" },
  { id: "k2", owner: "default@work.example", from: "both" },
  { id: "l1", owner: "default@work.example", from: "listed" },
]);
t("VF6-2 normMeetingId: trim only, case kept, non-string -> ''", [normMeetingId(" AbC "), normMeetingId("x"), normMeetingId(undefined), normMeetingId(7)], ["AbC", "x", "", ""]);
t("FL-7 per-day counts by the ET calendar date (a 01:00 UTC meeting is the previous ET day)", dayCounts([Date.parse("2026-11-11T01:00:00Z"), Date.parse("2026-11-10T15:00:00Z"), Date.parse("2026-11-12T15:00:00Z"), null]), { "2026-11-10": 2, "2026-11-12": 1, unknown: 1 });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
