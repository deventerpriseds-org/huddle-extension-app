// WHAT:       Offline checks for the attention bell's pure rules (lib/attention/attention.ts).
// WHY:        The bell decides what the owner is told still needs him; a wrong filter either hides an
//             email he must answer or nags about one he turned off. Run: npx -y tsx@4.19.2 scripts/attention.test.ts
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:attention-bell.
import {
  DEFAULT_URGENT_KINDS,
  EMAIL_ALERT_HUDDLE,
  attentionId,
  bellItems,
  meetingBellTitle,
  parseUrgentKinds,
  toAttentionItem,
} from "../src/features/huddle/lib/attention/attention";

let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const row = (o: Record<string, unknown>) => ({
  id: "x",
  kind: null,
  huddle_id: null,
  subject: null,
  from_name: null,
  from_address: null,
  received_at: null,
  created_at: null,
  ...o,
});

// A: settings
t("A1 unset setting -> default (email, meeting, appointment)", parseUrgentKinds(null), DEFAULT_URGENT_KINDS);
t("A2 garbage -> default", parseUrgentKinds("email"), DEFAULT_URGENT_KINDS);
t("A3 unknown kinds dropped, duplicates removed", parseUrgentKinds(["meeting", "spam", "meeting"]), ["meeting"]);
t("A4 explicit empty list honoured (everything switched off)", parseUrgentKinds([]), []);

// B: row -> item
t("B1 a pre-existing email row (kind null) is an email", toAttentionItem(row({ id: "e1", subject: "Files?", from_name: "EDS Dev" }))?.kind, "email");
t("B2 email item opens Iris's 1:1 and names the sender", (() => {
  const i = toAttentionItem(row({ id: "e1", kind: "email", subject: "Files?", from_address: "a@b.example" }))!;
  return [i.huddleId, i.title, i.detail];
})(), [EMAIL_ALERT_HUDDLE, "Files?", "From a@b.example"]);
t("B3 meeting item keeps its own conversation", toAttentionItem(row({ id: "m1", kind: "meeting", huddle_id: "dm-iris-chase", subject: "Today: 2 meetings" }))?.huddleId, "dm-iris-chase");
t("B4 an unknown kind is ignored, not shown", toAttentionItem(row({ id: "z", kind: "spam" })), null);
t("B5 email with no subject still renders", toAttentionItem(row({ id: "e2", kind: "email" }))?.title, "(no subject)");

// C: the bell's filter + order
const rows = [
  row({ id: "e1", kind: "email", subject: "old email", received_at: "2026-11-08T10:00:00Z" }),
  row({ id: "m1", kind: "meeting", subject: "meetings", received_at: "2026-11-08T12:00:00Z" }),
  row({ id: "a1", kind: "appointment", subject: "dentist", received_at: "2026-11-08T11:00:00Z" }),
];
t("C1 all kinds counted by default, newest first", bellItems(rows, DEFAULT_URGENT_KINDS).map((i) => i.id), ["m1", "a1", "e1"]);
t("C2 only the kinds the owner counts", bellItems(rows, ["email"]).map((i) => i.id), ["e1"]);
t("C3 everything switched off -> empty bell", bellItems(rows, []).length, 0);

// D: ids + brief title
t("D1 non-email ids are prefixed (never collide with an email hash)", attentionId("meeting", "abc"), "attn-meeting-abc");
t("D2 brief title counts meetings and classes and names the first time", meetingBellTitle(
  [
    { kind: "meeting", startIso: "2026-11-09T15:00:00Z" },
    { kind: "class", startIso: "2026-11-09T14:00:00Z" },
    { kind: "meeting", startIso: null },
  ],
  "America/New_York",
), "Today: 2 meetings, 1 class — first at 9:00 AM");
t("D3 no items -> no bell item", meetingBellTitle([], "America/New_York"), null);

if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
