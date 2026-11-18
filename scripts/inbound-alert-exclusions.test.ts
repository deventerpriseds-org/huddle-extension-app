// WHAT:       Offline checks for the inbound email ALERT EXCLUSION LIST: a new email whose original subject holds a
//             listed phrase (seed: "meeting minutes") gets no Iris alert, no owed row and no draft.
// WHY:        Owner 2026-11-18: "Meeting minutes should not trigger Iris to send me a draft in the chat. It should be
//             a part of an exclusion list." azure-pg-query run 44369628206: all 9 recent "Meeting Minutes: ..." emails
//             (Huddle's own Fireflies minutes) got an Iris alert and a drafted reply; 7 were still owed.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/AC-inbound-alert-exclusions.md (AC-1..AC-55, spelling table S-1..S-40).
//             Run: bun test scripts/inbound-alert-exclusions.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ALERT_SKIP_SUBJECTS_DEFAULT,
  cleanAlertSkipSubjects,
  isReplyOrForwardSubject,
  screenMessage,
  subjectExcluded,
  type InboundMessage,
} from "../src/features/huddle/lib/email/inbound-email";
import { ACTIONS_SETTINGS_DEFAULT, keepStoredAlertSkipSubjects, resolveActionsSettings } from "../src/features/huddle/lib/actions/actions";
import { minutesSubject } from "../src/features/huddle/lib/fireflies/minutes";
import { loadAlertSkipSubjects } from "../src/features/huddle/lib/email/inbound-email.server";
import { stripReplyPrefixes } from "../src/features/huddle/lib/external-feeds/onedrive-feed";

const MAILBOX = "owner@example.test";
const SEED = [...ALERT_SKIP_SUBJECTS_DEFAULT];
const msg = (subject: string | null, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  id: "m1",
  subject,
  fromAddress: "dev@example.test",
  fromName: "EDS Dev",
  inferenceClassification: "focused",
  headerNames: ["from"],
  bodyText: "Action items below. Please review?",
  ...extra,
});
const KEPT = { keep: true, reason: "from a person and asks something" };
const EXCLUDED = { keep: false, reason: "excluded-subject" };

describe("A. the screen", () => {
  test("AC-1/AC-2: both minutesSubject() shapes are excluded", () => {
    expect(screenMessage(msg(minutesSubject("Weekly Sync", "11/17/2026, 2:30 PM")), "needs-reply", MAILBOX, SEED)).toEqual(EXCLUDED);
    expect(screenMessage(msg(minutesSubject("Weekly Sync", "11/17/2026, 2:30 PM", true)), "needs-reply", MAILBOX, SEED)).toEqual(EXCLUDED);
    expect(screenMessage(msg(minutesSubject(null, "")), "needs-reply", MAILBOX, SEED)).toEqual(EXCLUDED);
  });
  test("AC-3: every mode, 'all' included", () => {
    for (const mode of ["needs-reply", "people", "all"] as const)
      expect(screenMessage(msg("Meeting Minutes: X"), mode, MAILBOX, SEED)).toEqual(EXCLUDED);
  });
  test("AC-4: self wins over the exclusion", () => {
    for (const mode of ["needs-reply", "people", "all"] as const)
      expect(screenMessage(msg("Meeting Minutes: X", { fromAddress: MAILBOX }), mode, MAILBOX, SEED).reason).toBe("self");
  });
  test("AC-5: excluded-subject comes before bulk-header", () => {
    expect(screenMessage(msg("Meeting Minutes: X", { headerNames: ["from", "list-unsubscribe"] }), "needs-reply", MAILBOX, SEED)).toEqual(EXCLUDED);
  });
  test("AC-6/AC-7: no list, or [], is today's verdict", () => {
    expect(screenMessage(msg("Meeting Minutes: X"), "needs-reply", MAILBOX)).toEqual(KEPT);
    expect(screenMessage(msg("Meeting Minutes: X"), "needs-reply", MAILBOX, [])).toEqual(KEPT);
  });
  test("AC-10: no phrase makes the screen throw", () => {
    for (const p of ["((", "[", "\\", "*", "a.b", "$^|"]) expect(() => screenMessage(msg("Meeting (( [ \\ x"), "needs-reply", MAILBOX, [p])).not.toThrow();
  });
  test("AC-12: a reply to minutes goes through the normal screen", () => {
    const quoted = "\n\nOn Tue, Nov 18, 2026 at 9:00 AM EDS Dev <dev@example.test> wrote:\n> Please review?";
    expect(screenMessage(msg("Re: Meeting Minutes: X", { bodyText: "Thanks!" + quoted }), "needs-reply", MAILBOX, SEED).reason).toBe("no-ask");
    expect(screenMessage(msg("Re: Meeting Minutes: X", { bodyText: "Can you add the budget item?" + quoted }), "needs-reply", MAILBOX, SEED).keep).toBe(true);
  });
  test("AC-13/AC-14: empty subjects and body-only mentions are not excluded", () => {
    for (const s of [null, "", "   "]) expect(screenMessage(msg(s), "needs-reply", MAILBOX, SEED).reason).not.toBe("excluded-subject");
    expect(screenMessage(msg("Quick question", { bodyText: "Meeting Minutes: Weekly Sync. Can you look?" }), "needs-reply", MAILBOX, SEED)).toEqual(KEPT);
  });
  test("AC-15: a phrase deep in a 10,000-character subject still matches", () => {
    expect(subjectExcluded("x ".repeat(4500) + "meeting minutes: " + "y".repeat(900), SEED)).toBe(true);
  });
});

// The spelling table (AC file). [subject, phrase list, expected: "EXCLUDE" | "PASS"]; PASS = the no-list verdict.
const TAB = "\t", NBSP = " ";
const SPELLINGS: [string, string | null, string[] | null, "EXCLUDE" | "PASS"][] = [
  ["S-1", "Meeting Minutes: Weekly Sync 11/17/2026, 2:30 PM", null, "EXCLUDE"],
  ["S-2", "Updated Meeting Minutes: Weekly Sync 11/17/2026, 2:30 PM", null, "EXCLUDE"],
  ["S-3", "Meeting Minutes: Team Meeting", null, "EXCLUDE"],
  ["S-4", "meeting minutes: weekly sync", null, "EXCLUDE"],
  ["S-5", "MEETING MINUTES: WEEKLY SYNC", null, "EXCLUDE"],
  ["S-6", "Meeting   Minutes: X", null, "EXCLUDE"],
  ["S-7", `Meeting${TAB}Minutes: X`, null, "EXCLUDE"],
  ["S-8", `Meeting${NBSP}Minutes: X`, null, "EXCLUDE"],
  ["S-9", "  Meeting Minutes: X", null, "EXCLUDE"],
  ["S-10", "[EXT] Meeting Minutes: X", null, "EXCLUDE"],
  ["S-11", "Test-Meeting Minutes: X", null, "EXCLUDE"],
  ["S-12", "Re: Meeting Minutes: X", null, "PASS"],
  ["S-13", "RE: Updated Meeting Minutes: X", null, "PASS"],
  ["S-14", "Fw: Meeting Minutes: X", null, "PASS"],
  ["S-15", "Fwd: Meeting Minutes: X", null, "PASS"],
  ["S-16", "Re : Meeting Minutes: X", null, "PASS"],
  ["S-17", "Re:Meeting Minutes: X", null, "PASS"],
  ["S-18", "AW: Meeting Minutes: X", null, "PASS"], // red-team RT-1: a German reply (was EXCLUDE in the first ACs)
  ["S-19", "[EXT] Re: Meeting Minutes: X", null, "PASS"], // red-team RT-3: gateway tag before Re:
  ["S-20", "Meeting Minutes: X", ["minutes:"], "EXCLUDE"],
  ["S-21", "Plan (draft) v2", ["(draft)"], "EXCLUDE"],
  ["S-22", "Plan draft v2", ["(draft)"], "PASS"],
  ["S-23", "axb notes", ["a.b"], "PASS"],
  ["S-24", "C++ review notes", ["c++ review"], "EXCLUDE"],
  ["S-25", "Running 5 minutes late", null, "PASS"],
  ["S-26", "Minute-by-minute plan for the meeting", null, "PASS"],
  ["S-27", "Meeting at 3? minutes to follow", null, "PASS"],
  ["S-28", "Minutes of the meeting", null, "PASS"],
  ["S-29", "Meeting-minutes template", null, "PASS"],
  ["S-30", "Meetingminutes", null, "PASS"],
  ["S-31", "Meeting Minutesheet attached", null, "PASS"],
  ["S-32", "Premeeting minutes", null, "PASS"],
  ["S-33", "Meeting minutes for Tuesday?", null, "PASS"], // red-team RT-2: the seed is "meeting minutes:" (colon)
  ["S-33b", "Meeting minutes: Tuesday standup", null, "EXCLUDE"],
  ["S-35", null, null, "PASS"],
  ["S-36", "Réunion budget", ["union"], "PASS"],
  ["S-37", "Meeting Minutes: X", [], "PASS"],
  ["S-40", "Weekly sync - meeting minutes", null, "PASS"], // no colon: not the minutes shape
  ["S-40b", "Weekly sync - meeting minutes", ["meeting minutes"], "EXCLUDE"], // the owner can widen it
];
describe("spelling table", () => {
  for (const [id, subject, list, want] of SPELLINGS)
    test(`${id} ${JSON.stringify(subject)} ${list ? JSON.stringify(list) : ""} -> ${want}`, () => {
      const m = msg(subject);
      const got = screenMessage(m, "needs-reply", MAILBOX, list ?? SEED);
      expect(got).toEqual(want === "EXCLUDE" ? EXCLUDED : screenMessage(m, "needs-reply", MAILBOX));
    });
  test("S-38 own mailbox -> self; S-39 mode all -> excluded", () => {
    expect(screenMessage(msg("Meeting Minutes: X", { fromAddress: MAILBOX }), "needs-reply", MAILBOX, SEED).reason).toBe("self");
    expect(screenMessage(msg("Meeting Minutes: X"), "all", MAILBOX, SEED)).toEqual(EXCLUDED);
  });
});

describe("B. the settings resolver", () => {
  test("AC-16/AC-18: no usable stored list -> the seed", () => {
    expect(ACTIONS_SETTINGS_DEFAULT.alertSkipSubjects).toEqual(["meeting minutes:"]);
    for (const raw of [null, {}, "garbage", [1, 2], { alertSkipSubjects: "meeting minutes" }, { alertSkipSubjects: null }, { alertSkipSubjects: 42 }, { alertSkipSubjects: {} }])
      expect(resolveActionsSettings(raw).alertSkipSubjects).toEqual(["meeting minutes:"]);
  });
  test("AC-17: a saved [] stays []", () => expect(resolveActionsSettings({ alertSkipSubjects: [] }).alertSkipSubjects).toEqual([]));
  test("AC-19: junk dropped, too-long DROPPED (not cut), spacing collapsed, first casing kept", () =>
    expect(resolveActionsSettings({ alertSkipSubjects: [42, null, "  ", "ab", "  Weekly   Digest  ", "x".repeat(121)] }).alertSkipSubjects).toEqual(["Weekly Digest"]));
  test("AC-20: duplicates folded to the first spelling", () =>
    expect(cleanAlertSkipSubjects(["Meeting Minutes", "meeting   minutes", "MEETING MINUTES"])).toEqual(["Meeting Minutes"]));
  test("AC-21: at most 50, in order", () => {
    const many = Array.from({ length: 60 }, (_, i) => `phrase ${i}`);
    expect(cleanAlertSkipSubjects(many)).toEqual(many.slice(0, 50));
  });
  test("AC-23: a huge junk array resolves fast", () => {
    const junk = Array.from({ length: 200_000 }, (_, i) => (i % 2 ? 7 : "x"));
    const t0 = performance.now();
    const r = resolveActionsSettings({ alertSkipSubjects: junk }).alertSkipSubjects;
    expect(r.length).toBeLessThanOrEqual(50);
    expect(performance.now() - t0).toBeLessThan(50);
  });
  test("AC-40: a save without the key keeps the stored list; with the key it is used", () => {
    const stored = { alertSkipSubjects: ["weekly digest"], dailyCap: 3 };
    expect(resolveActionsSettings(keepStoredAlertSkipSubjects({ dailyCap: 9 }, stored)).alertSkipSubjects).toEqual(["weekly digest"]);
    expect(resolveActionsSettings(keepStoredAlertSkipSubjects({ alertSkipSubjects: [] }, stored)).alertSkipSubjects).toEqual([]);
    expect(resolveActionsSettings(keepStoredAlertSkipSubjects({ dailyCap: 9 }, null)).alertSkipSubjects).toEqual(["meeting minutes:"]);
    // RT-6(b): a present-but-null list keeps the stored one too.
    expect(resolveActionsSettings(keepStoredAlertSkipSubjects({ alertSkipSubjects: null }, stored)).alertSkipSubjects).toEqual(["weekly digest"]);
  });
});

describe("C. the runner's list", () => {
  test("AC-24: read by the Actions owner key", async () => {
    const keys: string[] = [];
    const r = await loadAlertSkipSubjects({ config: () => ({ owner: "actions-owner@example.test" }), readRaw: async (k) => (keys.push(k), { alertSkipSubjects: ["weekly digest"] }) });
    expect([r, keys]).toEqual([["weekly digest"], ["actions-owner@example.test"]]);
  });
  test("AC-25: Actions off -> the seed", async () =>
    expect(await loadAlertSkipSubjects({ config: () => null, readRaw: async () => ({ alertSkipSubjects: [] }) })).toEqual(["meeting minutes:"]));
  test("AC-26: a failed read -> the seed (never 'no exclusions'), and the log carries no phrase", async () => {
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      const r = await loadAlertSkipSubjects({ config: () => ({ owner: "o@example.test" }), readRaw: async () => { throw new Error("meeting minutes o@example.test"); } });
      expect(r).toEqual(["meeting minutes:"]);
    } finally {
      console.error = orig;
    }
    expect(logged.join("\n")).not.toContain("o@example.test");
    expect(logged.join("\n")).not.toContain("meeting minutes o@");
  });
});

const strip = (p: string) => readFileSync(`${import.meta.dir}/../src/features/huddle/lib/${p}`, "utf8").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
describe("wiring and scope", () => {
  test("AC-27/AC-28/AC-35: the runner loads the list once, before the loop, passes it to its ONE screen call, and an excluded message stops before the ledger", () => {
    const src = strip("email/inbound-email.server.ts");
    expect((src.match(/await loadAlertSkipSubjects\(\)/g) ?? []).length).toBe(1);
    expect(src.indexOf("await loadAlertSkipSubjects()")).toBeLessThan(src.indexOf("for (const m of msgs)"));
    expect((src.match(/screenMessage\(/g) ?? []).length).toBe(1);
    expect(src).toContain("screenMessage(m, mode, msgMailbox, skipSubjects)");
    const loop = src.slice(src.indexOf("for (const m of msgs)"));
    expect(loop.indexOf("if (!verdict.keep) continue;")).toBeLessThan(loop.indexOf("recordOwedEmail("));
  });
  test("AC-45: proposals pass no list", () => expect(strip("proposals/proposals.ts")).toContain('screenMessage(m, "people", mailbox)'));
  test("AC-36/AC-37: the field and the hint exist", () => {
    const view = readFileSync(`${import.meta.dir}/../src/features/huddle/components/ActionsView.tsx`, "utf8");
    expect(view).toContain('data-testid="actions-alert-skip"');
    expect(view).toContain("onChange({ ...settings, alertSkipSubjects: next })");
    expect(view).toContain("Replies and forwards (Re:/Fw:) still alert");
    expect(readFileSync(`${import.meta.dir}/../src/features/huddle/components/SchedulingPanel.tsx`, "utf8")).toContain("exclusion list (meeting minutes, to start)");
  });
  test("AC-40 wiring: the save carries the stored list over", () =>
    expect(strip("actions/actions.server.ts")).toContain("resolveActionsSettings(keepStoredAlertSkipSubjects(raw, stored), ownNamesSeed(cfg))"));
});

// Red-team pre-pass (docs/qc-evidence/REDTEAM-inbound-alert-exclusions.md): each finding is a test.
describe("red-team findings", () => {
  const person = (subject: string) => msg(subject, { fromAddress: "colleague@example.test", fromName: "A Colleague", bodyText: "Can you fix item 3?" });
  test("RT-1: every reply/forward prefix the codebase knows is a reply (and the ONE rule is shared with stripReplyPrefixes)", () => {
    for (const s of ["AW: Meeting Minutes: X", "SV: Meeting Minutes: X", "Antw: Meeting Minutes: X", "RE[2]: Meeting Minutes: X", "WG: Meeting Minutes: X", "TR: Meeting Minutes: X", "RV: Meeting Minutes: X"]) {
      expect(stripReplyPrefixes(s)).toBe("Meeting Minutes: X");
      expect(screenMessage(person(s), "needs-reply", MAILBOX, SEED)).toEqual(screenMessage(person(s), "needs-reply", MAILBOX));
    }
    for (const s of ["Re\uFF1A Meeting Minutes: X", "\u200BRe: Meeting Minutes: X", "Re\u200B: Meeting Minutes: X"]) expect(subjectExcluded(s, SEED)).toBe(false);
    expect(readFileSync(`${import.meta.dir}/../src/features/huddle/lib/external-feeds/onedrive-feed.ts`, "utf8")).toContain("new RegExp(REPLY_PREFIX.source");
  });
  test("RT-2: a person ASKING about minutes is kept by the seed", () => {
    for (const s of ["Can you send me the meeting minutes from Tuesday?", "Question about the meeting minutes", "Missing meeting minutes - urgent"])
      expect(screenMessage(person(s), "needs-reply", MAILBOX, SEED).keep).toBe(true);
  });
  test("RT-3: a gateway tag before Re: is still a reply; before the subject it is not", () => {
    expect(isReplyOrForwardSubject("[EXT] Re: Meeting Minutes: X")).toBe(true);
    expect(isReplyOrForwardSubject("[EXT] [Partner] Fwd: x")).toBe(true);
    expect(subjectExcluded("[EXT] Meeting Minutes: X", SEED)).toBe(true);
  });
  test("RT-4: accent marks and astral letters count as part of the word", () => {
    expect(subjectExcluded("Pr\u00E9meeting minutes: x", SEED)).toBe(false);
    expect(subjectExcluded("Pre\u0301meeting minutes: x", SEED)).toBe(false);
    expect(subjectExcluded("\u{10400}meeting minutes: x", SEED)).toBe(false); // Deseret: NFKD keeps it astral (𝐀 folds to "A")
    expect(subjectExcluded("Meeting minutes\u0301x", ["meeting minutes"])).toBe(false);
  });
  test("RT-5: invisible and compatibility characters do not hide the phrase", () => {
    for (const s of ["Meeting\u200BMinutes: X", "Meeting \u200BMinutes: X", "Meeting\u00ADMinutes: X", "\uFF2D\uFF45\uFF45\uFF54\uFF49\uFF4E\uFF47 \uFF2D\uFF49\uFF4E\uFF55\uFF54\uFF45\uFF53: X", "MEET\u0130NG M\u0130NUTES: X"])
      expect(subjectExcluded(s, SEED)).toBe(true);
  });
  test("RT-6(a): a save whose stored read fails is REFUSED, never written with the seed", () => {
    const srv = strip("actions/actions.server.ts");
    const i = srv.indexOf("if (payloadLacksAlertSkipList(raw)) {");
    expect(i).toBeGreaterThan(0);
    const block = srv.slice(i, srv.indexOf("setActionsSettingsRaw(cfg.owner, s)", i));
    expect(block).toContain("} catch {");
    expect(block).toContain("return { ok: false");
  });
  test("RT-7: the field shows the cleaned list after blur", () => {
    const view = readFileSync(`${import.meta.dir}/../src/features/huddle/components/ActionsView.tsx`, "utf8");
    const block = view.slice(view.indexOf('data-testid="actions-alert-skip-field"'), view.indexOf('data-testid="actions-alert-skip"'));
    expect(block).toMatch(/e\.target\.value = next\.join\("\\n"\)/);
    expect(block).not.toContain("maxLength");
  });
  test("RT-8: letter-less phrases are dropped and never match", () => {
    expect(cleanAlertSkipSubjects(["\u200B\u200B\u200B", "...", "?!?"])).toEqual([]);
    expect(subjectExcluded("Hmm ... can you check the budget?", ["..."])).toBe(false);
  });
});
