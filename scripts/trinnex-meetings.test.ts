// WHAT:       Offline tests for the Trinnex MEETINGS module core (lib/trinnex/meeting-triage-core.ts) and its seam with
//             today's meeting triage: titles, series, participants suffix, OneDrive file name, people list (owner
//             pinned), owner pick -> the SAME triage targets, speaker rows, segments, and an existing triaged row
//             reading back unchanged.
// WHY:        AC-trinnex-workspace.md section 1. Synthetic names only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-trinnex-meetings.md.
// Run: bun scripts/trinnex-meetings.test.ts
import {
  canRemovePerson,
  cleanSeries,
  cleanSpeakerMap,
  fullTitle,
  oneDriveFileName,
  ownerPickToTriage,
  participantsWithSpeakers,
  peopleList,
  segmentsFor,
  SEGMENT_MAX_CHARS,
  seriesOptions,
  speakerRows,
  splitWarnings,
  validateTitle,
} from "../src/features/huddle/lib/trinnex/meeting-triage-core";
import { TRIAGE_TARGET, groupMeetingQueue, type TriageStore } from "../src/features/huddle/lib/proposals/meeting-triage";
import { triageProposal } from "../src/features/huddle/lib/proposals/engine";
import type { ProposalRow } from "../src/features/huddle/lib/proposals/proposals";
import { transcriptFileName } from "../src/features/huddle/lib/fireflies/minutes";

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
const OWNER = "Von";
const ctx = { people: ["Von", "Michael R.", "Priya S."], owner: OWNER };

// AC-T3
t("AC-T3 empty title refused", validateTitle("   "), { ok: false, error: "A meeting needs a title." });
t("AC-T3 title capped at 120", (validateTitle("x".repeat(200)) as { title: string }).title.length, 120);
t("AC-T3 title collapsed", validateTitle("  Leadership   weekly "), { ok: true, title: "Leadership weekly" });
// AC-T4
t("AC-T4 blank series is NULL", [cleanSeries(""), cleanSeries("  "), cleanSeries(null)], [null, null, null]);
t("AC-T4 series capped at 80", cleanSeries("s".repeat(90))?.length, 80);
t("AC-T4 datalist distinct", seriesOptions(["Engineering Leaders", "engineering leaders", null, "Board"]), ["Board", "Engineering Leaders"]);
// AC-T6
const p2 = ["Michael R.", "Priya S."];
t("AC-T6 suffix ON", fullTitle("Weekly sync", p2, true), "Weekly sync - Michael R., Priya S.");
t("AC-T6 suffix OFF", fullTitle("Weekly sync", p2, false), "Weekly sync");
t("AC-T6 two saves never double the suffix", fullTitle("Weekly sync", p2, true), fullTitle("Weekly sync", p2, true));
// AC-T7
t("AC-T7 file name", oneDriveFileName("2026-11-19T15:00:00Z", 'Q4: plan/"draft"?'), "2026-11-19 Q4 - plan--draft--.md");
t("AC-T7 no date", oneDriveFileName(null, "Sync"), "Sync.md");
t("AC-T8 writer uses the stored name", [transcriptFileName("abc", "2026-11-19 Sync.md"), transcriptFileName("abc", null)], [
  "2026-11-19 Sync.md",
  "fireflies-abc.md",
]);
t("AC-T8 a stored name cannot escape the folder", transcriptFileName("abc", "../x/y.md"), "..-x-y.md");
// AC-T12..T15
t("AC-T12 owner first and pinned", peopleList(OWNER, ["Priya S.", "von", "Jordan  Lee", "jordan lee", ""]), ["Von", "Priya S.", "Jordan Lee"]);
t("AC-T15 owner cannot be removed", [canRemovePerson(OWNER, "von"), canRemovePerson(OWNER, "Priya S.")], [false, true]);
t("AC-T12 Von -> Mine", ownerPickToTriage({ kind: "person", name: "Von" }, OWNER), { choice: "mine" });
t("AC-T12 person -> For someone, exact spelling", ownerPickToTriage({ kind: "person", name: "Priya S." }, OWNER), { choice: "someone", name: "Priya S." });
t("AC-T12 skip", ownerPickToTriage({ kind: "skip" }, OWNER), { choice: "skip" });
t("AC-T12 the same three targets as today", ["mine", "someone", "skip"].map((c) => TRIAGE_TARGET[c as "mine"]), ["proposed", "delegated", "dismissed"]);

// AC-T12 / Q4 through the EXISTING triageProposal: Mine stores what Mine stores today (assignee null).
const calls: Array<[string, string | null]> = [];
const row = (over: Partial<ProposalRow>): ProposalRow =>
  ({ id: "prop-1", owner: "o@x", title: "Test-send deck", state: "untriaged", assignee: null, sources: [], ...over }) as unknown as ProposalRow;
const store: TriageStore = {
  addTriageRows: async () => ({ created: [], existing: [] }),
  triage: async (_o, _id, target, assignee) => {
    calls.push([target, assignee]);
    return { applied: true, row: row({ state: target, assignee }) };
  },
  getMany: async () => [],
  listMeetingQueue: async () => [],
  listUntriaged: async () => [],
};
for (const pick of [{ kind: "person", name: "Von" }, { kind: "person", name: "Priya S." }, { kind: "skip" }] as const) {
  const c = ownerPickToTriage(pick, OWNER);
  await triageProposal(["o@x"], "prop-1", c.choice, c.name, store);
}
t("AC-T12 store.triage targets + assignee", calls, [
  ["proposed", null],
  ["delegated", "Priya S."],
  ["dismissed", null],
]);
// The regression the brief asks for: an EXISTING triaged row (typed name, before the picker) reads back unchanged.
const existing = [
  { ...row({ id: "prop-a", state: "delegated", assignee: "pat from finance", sources: [{ source: "transcript", sourceItemId: "m1", at: "2026-11-01", context: "Old" }] as never }), meetingId: "m1" },
  { ...row({ id: "prop-b", state: "proposed", assignee: null, sources: [{ source: "transcript", sourceItemId: "m1", at: "2026-11-01", context: "Old" }] as never }), meetingId: "m1" },
];
const g = groupMeetingQueue(existing as never);
t("AC-T12 existing triaged rows read back unchanged", [g.meetings[0].forSomeone[0].assignee, g.meetings[0].mine[0].assignee, g.counts], [
  "pat from finance",
  null,
  { mine: 1, forSomeone: 1, untriaged: 0, skipped: 0 },
]);

// AC-T10 / S-B (measured: every real label is "Speaker N")
const sentences = [
  { speaker: "Speaker 1", text: "Hello everyone thanks for joining", start: "5" },
  { speaker: "Speaker 2", text: "Thanks", start: 9 },
  { speaker: "Speaker 2", text: "Let me share the vendor numbers now", start: 12 },
  { speaker: "Von Ellis", text: "Great let us start", start: 65.2 },
  { speaker: null, text: "inaudible", start: 70 },
];
const rows = speakerRows(sentences, ctx);
t("AC-T10 one row per label, first-spoken order", rows.map((r) => r.label), ["Speaker 1", "Speaker 2", "Von Ellis", "Unknown speaker"]);
t("AC-T10 lines + talk %", rows.map((r) => [r.lines, r.talkPct]), [[1, 28], [2, 44], [1, 22], [1, 6]]);
t("AC-T10 sample with timestamp", rows[1].sample, { text: "Let me share the vendor numbers now", at: "00:12" });
t("AC-T10 Von Ellis pre-maps, Speaker N does not", rows.map((r) => r.match.kind), ["numbered", "numbered", "person", "unknown"]);
t("AC-T10 mapping adds participant, never Von, never twice", participantsWithSpeakers(["Priya S."], { "Speaker 1": "Michael R.", "Speaker 2": "Priya S.", "Von Ellis": "Von" }, OWNER), [
  "Priya S.",
  "Michael R.",
]);
t("AC-T10 split warning", splitWarnings({ "Speaker 1": "Michael R.", "Speaker 3": "Michael R.", "Speaker 2": "Priya S." }), ["Michael R."]);
t("AC-T10 map keeps only real labels", cleanSpeakerMap({ "Speaker 1": " Michael  R. ", "Speaker 9": "X", "Speaker 2": "" }, ["Speaker 1", "Speaker 2"]), { "Speaker 1": "Michael R." });
// AC-T11
const seg = segmentsFor(sentences, { "Speaker 2": "Priya S." });
t("AC-T11 mapped person, else the literal label (never a guess)", seg.map((s) => [s.speaker, s.speakerLabel, s.at]), [
  ["Speaker 1", "Speaker 1", "00:05"],
  ["Priya S.", "Speaker 2", "00:09"],
  ["Von Ellis", "Von Ellis", "01:05"],
  ["Unknown speaker", "Unknown speaker", "01:10"],
]);
t("AC-T11 consecutive lines of one voice merge", seg[1].text, "Thanks Let me share the vendor numbers now");
const long = segmentsFor([{ speaker: "Speaker 1", text: "a".repeat(SEGMENT_MAX_CHARS * 2 + 5) }], {});
t("AC-L9 passages under the cap, no text lost", [long.length, Math.max(...long.map((s) => s.text.length)) <= SEGMENT_MAX_CHARS, long.map((s) => s.text).join("").length], [3, true, SEGMENT_MAX_CHARS * 2 + 5]);
// AC-T19
t("AC-T19 empty transcript", [speakerRows([], ctx), segmentsFor([], {})], [[], []]);

console.log(`trinnex-meetings: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
