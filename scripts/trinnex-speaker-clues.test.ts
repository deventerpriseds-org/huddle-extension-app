// WHAT:  offline tests for speakerClues: the lines shown under each speaker in Meetings triage.
// WHY:   owner, 2026-11-20 (phone screenshot): "I'm unable to see enough text to determine who is speaking". Each
//        speaker showed ONE line, cut to 200 characters and then to one screen line.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.  EVIDENCE: docs/qc-evidence/BUILD-trinnex-speaker-clues.md
// Run: bun test scripts/trinnex-speaker-clues.test.ts
import { describe, expect, test } from "bun:test";
import { CLUE_MAX, speakerClues, speakerRows } from "../src/features/huddle/lib/trinnex/meeting-triage-core";

const S = (speaker: string, start: number, text: string) => ({ speaker, start, end: start + 2, text });
const MEETING = [
  S("Speaker 1", 0, "Okay let's get started."),
  S("Speaker 1", 2, "Casey, go ahead."),
  S("Speaker 2", 4, "Thanks. So pipeline is up this quarter."),
  S("Speaker 2", 6, "We closed two deals."),
  S("Speaker 3", 9, "Hi all, this is Alex from engineering, quick update on the portal."),
  S("Speaker 1", 12, "Thanks, Alex."),
  S("Speaker 2", 14, "One more thing on pricing that we should discuss in detail next week with the whole leadership group present."),
  S("Speaker 1", 20, "ok"),
];

describe("speakerClues", () => {
  test("SC1 an introduction is picked and marked intro", () => {
    const c = speakerClues(MEETING).get("Speaker 3")!;
    expect(c[0].why).toBe("intro");
    expect(c[0].text).toContain("this is Alex");
  });

  test("SC2 a turn where the previous speaker called on someone carries that line and is marked called-on", () => {
    const c = speakerClues(MEETING).get("Speaker 2")!;
    const first = c.find((x) => x.at === "00:04")!;
    expect(first.why).toBe("called-on");
    expect(first.before?.label).toBe("Speaker 1");
    expect(first.before?.text).toContain("Casey, go ahead.");
  });

  test("SC3 consecutive lines by one speaker are one turn (joined), and turns stay in spoken order", () => {
    const c = speakerClues(MEETING).get("Speaker 2")!;
    expect(c.map((x) => x.at)).toEqual(["00:04", "00:14"]);
    expect(c[0].text).toBe("Thanks. So pipeline is up this quarter. We closed two deals.");
  });

  test("SC4 at most CLUE_MAX clues, preferring identifying turns over short ones", () => {
    const many = Array.from({ length: 12 }, (_, i) => [S("Speaker 1", i * 10, `filler ${i}`), S("Speaker 9", i * 10 + 5, "x")]).flat();
    many.splice(6, 0, S("Speaker 1", 31, "this is the part"), S("Speaker 9", 32, "Over to you, Morgan"));
    many.push(S("Speaker 1", 500, "I'm Morgan, I run product."));
    const c = speakerClues(many).get("Speaker 1")!;
    expect(c.length).toBe(CLUE_MAX);
    expect(c.some((x) => x.why === "intro")).toBe(true);
  });

  test("SC5 'thanks everyone', 'It's Monday', 'it's Acme Corp' and 'hi team' are NOT taken as names", () => {
    const m = [S("Speaker 1", 0, "Thanks everyone."), S("Speaker 2", 2, "It's Monday so a short one."), S("Speaker 3", 4, "Hi team."), S("Speaker 4", 6, "So if it's Acme Corp, there is a standard.")];
    const all = [...speakerClues(m).values()].flat();
    expect(all.every((x) => x.why === "long")).toBe(true);
  });

  test("SC6 long text is cut with an ellipsis; lines out of time order are put back in order", () => {
    const long = "word ".repeat(200).trim();
    const c = speakerClues([S("Speaker 1", 50, "later"), S("Speaker 1", 10, long)]).get("Speaker 1")!;
    expect(c.length).toBe(1);
    expect(c[0].at).toBe("00:10");
    expect(c[0].text.endsWith("…")).toBe(true);
    expect(c[0].text.length).toBeLessThanOrEqual(320);
  });

  test("SC7 speakerRows carries clues for every label and keeps the old sample unchanged", () => {
    const rows = speakerRows(MEETING, { people: [], owner: "Von" });
    for (const r of rows) expect(r.clues.length).toBeGreaterThan(0);
    expect(rows.find((r) => r.label === "Speaker 1")!.sample!.text).toBe("Okay let's get started.");
  });

  test("SC8 empty and text-less lines produce no clues", () => {
    expect(speakerClues([]).size).toBe(0);
    expect(speakerClues([{ speaker: "Speaker 1", text: "" }]).size).toBe(0);
  });

  test("SC9 real-transcript shapes (shapes seen in a real transcript, 2026-11-20): 'punt over to Pat' is a hand-off; 'have Robin here' is not an intro", () => {
    const m = [
      S("Speaker 1", 0, "We're so thrilled to have Robin here and we counted the days."),
      S("Speaker 1", 3, "So with that said, I'll punt over to Pat Rivera."),
      S("Speaker 3", 6, "Thank you. I run the data group."),
    ];
    const c = speakerClues(m);
    expect(c.get("Speaker 1")!.every((x) => x.why === "long")).toBe(true);
    const m3 = c.get("Speaker 3")![0];
    expect(m3.why).toBe("called-on");
    expect(m3.before?.text).toContain("Pat Rivera");
  });

  test("SC10 'Casey here' at the start of a sentence is still an introduction", () => {
    expect(speakerClues([S("Speaker 4", 0, "Morning. Casey here, sales update.")]).get("Speaker 4")![0].why).toBe("intro");
  });
});
