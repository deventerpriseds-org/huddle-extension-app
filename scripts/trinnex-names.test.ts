// WHAT:       Table tests for the ONE shared Trinnex name parser (lib/trinnex/names.ts): every S-A row (people from
//             meeting titles and file names) and every S-B row (Fireflies speaker labels) of the spelling table.
// WHY:        Tier 1: the parser decides who is suggested as a participant / speaker. The prototype's two parsers
//             disagreed on 1on1_Dana, Budget/Forecast, ACME and José; these rows pin the table's verdict.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/AC-trinnex-workspace.md section 5; docs/qc-evidence/BUILD-trinnex-meetings.md.
// Run: bun scripts/trinnex-names.test.ts      (synthetic names only)
import { matchSpeaker, speakerKey, suggestNames, UNKNOWN_SPEAKER } from "../src/features/huddle/lib/trinnex/names";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
};

const ctx = { people: ["Von", "Michael R.", "Priya S.", "Dana K."], owner: "Von" };
const names = (s: string, c = ctx) => suggestNames(s, c).map((x) => x.name);

// ── S-A ──
t("S-A1 Meeting with Priya", names("Meeting with Priya"), ["Priya S."]);
t("S-A2 owner never offered, / trigger", names("Von / Michael 1:1"), ["Michael R."]);
t("S-A3 1on1_Dana as a title", names("1on1_Dana"), ["Dana K."]);
t("S-A4 1on1_Dana.md as a file", names("1on1_Dana.md"), ["Dana K."]);
t("S-A5 Sync w/ Jordan -> new name", suggestNames("Sync w/ Jordan", ctx), [{ name: "Jordan", known: false }]);
t("S-A6 Priya-budget-notes.docx", names("Priya-budget-notes.docx"), ["Priya S."]);
t("S-A7 Q1 planning.pptx", names("Q1 planning.pptx"), []);
t("S-A8 Marchesi review (no trigger)", names("Marchesi review"), []);
t("S-A9 Sync with Marchesi (whole-token month check)", names("Sync with Marchesi"), ["Marchesi"]);
t("S-A10 Weekly sync", names("Weekly sync"), []);
t("S-A11 Meeting with the team", names("Meeting with the team"), []);
t("S-A12 Sync with Von", names("Sync with Von"), []);
t("S-A13 Budget/Forecast review", names("Budget/Forecast review"), []);
t("S-A14 Lunch with ACME", names("Lunch with ACME"), []);
t("S-A15 Sync with José (not Jos)", names("Sync with José"), ["José"]);
t("S-A16 lower-case known name", names("meeting with priya"), ["Priya S."]);
t("S-A17 two triggers, order kept", names("Meeting with Priya and Dana"), ["Priya S.", "Dana K."]);
t("S-A17b reverse order kept", names("Meeting with Dana and Priya"), ["Dana K.", "Priya S."]);
t("S-A18 Call with May (month)", names("Call with May"), []);
t("S-A18b May on the people list", names("Call with May", { people: [...ctx.people, "May"], owner: "Von" }), ["May"]);
t("S-A19 possessive", names("Michael's 1:1"), ["Michael R."]);
t("S-A20 Q3/Q4 planning", names("Q3/Q4 planning"), []);
t(
  "S-A21 two Michaels: both offered",
  names("Sync with Michael", { people: ["Von", "Michael R.", "Michael T."], owner: "Von" }),
  ["Michael R.", "Michael T."],
);
t("S-A22 markup in a title", names('"Meeting with Priya" <script>'), ["Priya S."]);
// extra negatives / shapes
t("S-A+ no duplicates when trigger repeats a known name", names("Priya with Priya"), ["Priya S."]);
t("S-A+ known full name with initial", names("Sync with Michael R."), ["Michael R."]);
t("S-A+ two-word new name", suggestNames("Sync with Jordan Lee", ctx), [{ name: "Jordan Lee", known: false }]);
t("S-A+ 1-1 spelling", names("Dana 1-1"), ["Dana K."]);
t("S-A+ empty / null input", [names(""), suggestNames(null, ctx).length], [[], 0]);
t("S-A+ lowercase owner never offered", names("sync with von"), []);
t("S-A+ prefix of a known name is not a match", names("Danaher review"), []);

// ── S-B ──
const m = (l: unknown, c = ctx) => matchSpeaker(l, c);
t("S-B1 Speaker 1 numbered", m("Speaker 1"), { kind: "numbered", label: "Speaker 1" });
t(
  "S-B2 case / spacing variants stay numbered and verbatim",
  ["speaker 2", "Speaker  3", "SPEAKER 4"].map((l) => m(l)),
  [
    { kind: "numbered", label: "speaker 2" },
    { kind: "numbered", label: "Speaker  3" },
    { kind: "numbered", label: "SPEAKER 4" },
  ],
);
t("S-B3 bare Speaker -> one unknown bucket", m("Speaker"), { kind: "unknown", label: UNKNOWN_SPEAKER });
t(
  "S-B4 missing / null / empty / blank -> same bucket",
  [undefined, null, "", "   "].map((l) => speakerKey(l)),
  [UNKNOWN_SPEAKER, UNKNOWN_SPEAKER, UNKNOWN_SPEAKER, UNKNOWN_SPEAKER],
);
t("S-B5 Von Ellis pre-maps to Von", m("Von Ellis"), { kind: "person", label: "Von Ellis", person: "Von" });
t("S-B6 Sam not on the list", m("Sam"), { kind: "unmatched", label: "Sam" });
t(
  "S-B7 Michael with two Michaels",
  m("Michael", { people: ["Von", "Michael R.", "Michael T."], owner: "Von" }),
  { kind: "ambiguous", label: "Michael", candidates: ["Michael R.", "Michael T."] },
);
t("S-B8 Speaker 10 vs Speaker 1 distinct", [speakerKey("Speaker 10"), speakerKey("Speaker 1")], ["Speaker 10", "Speaker 1"]);
t("S-B9a (Guest) suffix exact match", m("Priya S. (Guest)"), { kind: "person", label: "Priya S. (Guest)", person: "Priya S." });
t("S-B9b email-shaped label unmatched", m("priya@x.example"), { kind: "unmatched", label: "priya@x.example" });
t("S-B9c loose substring never matches", m("Dana-Karina Fox"), { kind: "unmatched", label: "Dana-Karina Fox" });
t("S-B+ exact full name", m("Michael R."), { kind: "person", label: "Michael R.", person: "Michael R." });

console.log(`trinnex-names: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
