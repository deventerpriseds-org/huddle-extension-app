// WHAT:       Proves the schedule brief's two SHAPES are right: which EDITION an hour produces, and
//             which DATE that edition covers. Plus the two rules that decide whether a push is sent
//             at all (empty = silent; a read failure is never silence) and that a double fire in one
//             slot cannot double-push.
// WHY:        Owner, 2026-10-01: "I want seperate alerts (8am and 8pm). for the evening before
//             looking at the day after and the morning of looking at the current day." A probe on
//             2026-10-05 proved NONE of it existed. The edition/date mapping IS the feature -- get
//             it backwards and the 8pm brief tells him about the day he has just finished.
//             It is also the one piece that cannot be caught by eye: `editionForHour` and a
//             `+1 day` look equally plausible either way round in a diff.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:schedule-brief. Run: bun scripts/schedule-brief.test.ts
//
// PURE FUNCTIONS ONLY, DELIBERATELY. Everything asserted here takes its clock as an argument, so no
// assertion waits for 8pm or depends on the machine's zone. The delivery half is covered by a live
// dry-run against the deployed route, which is a different kind of evidence and is not faked here.

import {
  dateForEdition,
  editionForHour,
  localDate,
  localHour,
  type BriefItem,
  type ScheduleBrief,
} from "../src/features/huddle/lib/tasks/schedule-brief.server";
import { briefLines } from "../src/features/huddle/lib/tasks/schedule-brief-run.server";

let pass = 0,
  fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want);
  console.log(`  ${ok ? "✔" : "✘"} ${name}: ${got}${ok ? "" : `  (EXPECTED ${want})`}`);
  // The machine-readable line scripts/mutate.sh greps for (`FAIL <name>`). Without it a mutation
  // against this suite reports UNDETERMINED -- "nothing proven" -- rather than proving the guard.
  if (!ok) console.log(`  FAIL ${name}`);
  ok ? pass++ : fail++;
};

const TZ = "America/New_York";

console.log("A. THE TWO SHAPES — which edition an hour produces");

// A1/A2 — the shipped pair. 8 is the morning brief, 20 is the evening one.
t("A1 08:00 produces the MORNING edition", editionForHour(8), "morning");
t("A2 20:00 produces the EVENING edition", editionForHour(20), "evening");

// A3 — the boundary, and it is a deliberate choice rather than an accident. A brief about "today"
// delivered AT noon is still about today; calling 12:00 the evening edition would skip today
// entirely for a user who set a single midday hour.
t("A3 12:00 is still MORNING (a midday brief about today is not about tomorrow)", editionForHour(12), "morning");
t("A4 11:59's hour (11) is MORNING", editionForHour(11), "morning");
t("A5 13:00 is EVENING", editionForHour(13), "evening");

// A6 — the shape survives the owner moving the hours, which is the whole reason edition is DERIVED
// rather than stored on the job row.
t("A6 a user who moves the hours to 7/21 still gets one of each",
  `${editionForHour(7)}/${editionForHour(21)}`, "morning/evening");

console.log("B. WHICH DATE AN EDITION COVERS — the half that is invisible in a diff");

// 2026-10-05T12:00:00Z is 08:00 in New York — the real morning slot.
const morningMs = Date.parse("2026-10-05T12:00:00Z");
// 2026-10-06T00:00:00Z is 20:00 on Oct 5 in New York — the real evening slot, and note it falls on
// the NEXT UTC DAY. A naive UTC implementation gets B2 wrong and only this zone-aware case shows it.
const eveningMs = Date.parse("2026-10-06T00:00:00Z");

t("B0 the evening slot really is 20:00 local (fixture sanity)", localHour(eveningMs, TZ), 20);
t("B0b the morning slot really is 08:00 local (fixture sanity)", localHour(morningMs, TZ), 8);

// B1/B2 go through dateForEdition -- the function that CHOOSES the offset -- not through
// localDate with the offset handed to it. Calling localDate(ms, TZ, 1) directly proves only that
// localDate can add a day; it leaves the `evening ? 1 : 0` decision completely uncovered, which is
// exactly what a mutation of that line proved (INERT) before this was fixed.
t("B1 the MORNING edition covers TODAY", dateForEdition(morningMs, TZ, "morning"), "2026-10-05");
t("B2 the EVENING edition covers TOMORROW", dateForEdition(eveningMs, TZ, "evening"), "2026-10-06");
t("B2b the MORNING edition at the evening instant still covers that same day",
  dateForEdition(eveningMs, TZ, "morning"), "2026-10-05");

// B3 — the defect this catches: an evening brief that covers today is a brief about the day he has
// just lived through. `addDays` of 0 vs 1 is one character in the source.
t("B3 the evening edition does NOT cover the day just finished",
  dateForEdition(eveningMs, TZ, "evening") !== dateForEdition(eveningMs, TZ, "morning"), "true");

// B4 — at 20:00 ET the UTC date has already rolled over. A UTC-based `toISOString().slice(0,10)`
// would say 2026-10-06 for "today" and 2026-10-07 for "tomorrow": both off by one.
t("B4 zone-aware, not UTC-aware (20:00 ET is already the next UTC day)",
  localDate(eveningMs, TZ, 0), "2026-10-05");
t("B4b and the evening edition lands on the NEXT local day, not the next UTC one",
  dateForEdition(eveningMs, TZ, "evening"), "2026-10-06");

console.log("C. WHETHER ANYTHING IS SENT AT ALL");

const item = (over: Partial<BriefItem> = {}): BriefItem => ({
  sourceId: "cls-1",
  kind: "class",
  title: "MGT-782-W1",
  startIso: "2026-10-05T23:00:00Z", // 19:00 ET — tonight's real DBA class
  endIso: "2026-10-06T02:00:00Z",
  location: null,
  ...over,
});

const mk = (over: Partial<ScheduleBrief> = {}): ScheduleBrief => ({
  ok: true,
  edition: "morning",
  forDate: "2026-10-05",
  items: [item()],
  errors: [],
  ...over,
});

// C1 — an empty day is SILENT. A nightly "you have nothing tomorrow" push is how a useful alert
// becomes a muted one.
t("C1 an empty edition carries no lines to send", briefLines(mk({ items: [] }), TZ).length, 0);

// C2 — but an empty edition WITH a read error is not the same fact, and the brief says so. This is
// the "you have nothing" vs "we could not look" distinction, and conflating them is the lie.
const failed = mk({ items: [], errors: ["classes: nexus timeout", "meetings: Graph 403"], ok: false });
t("C2 empty-with-errors is NOT reported as ok", failed.ok, false);
t("C2b and it carries the reasons, so the gap is visible", failed.errors.length, 2);

console.log("D. WHAT THE LINES ACTUALLY SAY");

const lines = briefLines(mk(), TZ);
t("D1 a timed item renders its local start and end", lines[0], "7:00PM–10:00PM — MGT-782-W1 (class)");

// D2 — an all-day meeting has no start instant. Rendering it as midnight would put a 12:00AM entry
// at the top of the brief every time one exists.
const allDay = briefLines(mk({ items: [item({ kind: "meeting", title: "Offsite", startIso: null, endIso: null })] }), TZ);
t("D2 an item with no start renders 'all day', never a guessed midnight", allDay[0], "all day — Offsite (meeting)");

// D3 — location rides along only when there is one, so a null never prints a dangling separator.
const located = briefLines(mk({ items: [item({ location: "Van Munching Hall" })] }), TZ);
t("D3 a location is appended when present", located[0].endsWith("· Van Munching Hall"), true);
t("D3b and nothing dangles when absent", lines[0].includes("·"), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
