// WHAT:  offline tests for the Trinnex Library lane: accepted types, Type, Category, caps, transcript parsing,
//        the passage splitter, extraction from real fixture bytes, and the pipeline/remove state machine.
// WHY:   AC-trinnex-workspace.md section 2 (AC-L1..L12) and S-A file-name rows. No network, no DB, no blob.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.  EVIDENCE: docs/qc-evidence/BUILD-trinnex-library.md
// Run: bun test scripts/trinnex-library.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_UPLOAD_BYTES,
  PASSAGE_MAX_CHARS,
  capSegments,
  cleanCategory,
  guessKind,
  isAcceptedName,
  mergeCategories,
  parseCues,
  partitionFiles,
  speakerStats,
  splitText,
  suggestCategory,
  turnsFromCues,
} from "../src/features/huddle/lib/trinnex/library-core";
import { ExtractError, extractFile } from "../src/features/huddle/lib/trinnex/extract.server";
import { speakerKey, suggestNames } from "../src/features/huddle/lib/trinnex/names";
import { type LibraryItem, type PipelineDeps, runPipeline, runRemoval } from "../src/features/huddle/lib/trinnex/library.server";

const FIX = join(import.meta.dir, "fixtures/trinnex");
const bytes = (n: string) => new Uint8Array(readFileSync(join(FIX, n)));
async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof ExtractError ? e.reason : `other:${String(e)}`;
  }
}

describe("library-core", () => {
  test("L1 accepts the eight types case-insensitively and rejects the rest", () => {
    for (const n of ["a.pdf", "a.docx", "a.pptx", "a.xlsx", "a.txt", "a.md", "a.vtt", "a.srt", "B.PDF"]) expect(isAcceptedName(n)).toBe(true);
    for (const n of ["a.exe", "a.doc", "a.PDF.exe", "README", ""]) expect(isAcceptedName(n)).toBe(false);
    const p = partitionFiles([{ name: "x.pdf" }, { name: "y.exe" }, { name: "z" }]);
    expect(p.accepted.map((f) => f.name)).toEqual(["x.pdf"]);
    expect(p.rejected).toEqual(["y.exe", "z"]);
  });

  test("L2 type is automatic", () => {
    expect(guessKind("call.vtt")).toBe("transcript");
    expect(guessKind("call.SRT")).toBe("transcript");
    expect(guessKind("Team transcript.md")).toBe("transcript");
    expect(guessKind("notes.md")).toBe("document");
    expect(guessKind("deck.pptx")).toBe("document");
    expect(guessKind("transcript.pdf")).toBe("document");
  });

  test("L3 category prefers an existing one, joins case-insensitively, empty is General", () => {
    expect(suggestCategory("Q3 travel expenses.pdf", ["Travel and expenses", "Finance"])).toBe("Travel and expenses");
    expect(suggestCategory("vendor-renewal.docx", ["vendors"])).toBe("vendors");
    expect(suggestCategory("runbook.md", [])).toBe("Engineering");
    expect(suggestCategory("misc.txt", [])).toBe("General");
    expect(mergeCategories(["Finance"], ["finance", "HR "], ["hr"])).toEqual(["Finance", "HR"]);
    expect(cleanCategory("   ")).toBe("General");
    expect(cleanCategory("  New   cat ")).toBe("New cat");
  });

  test("L12 the cap is 25 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(26214400);
  });

  test("L9 splitter keeps every passage under the cap and loses no text", () => {
    const words = Array.from({ length: 6000 }, (_, i) => `w${i}`).join(" ") + "\n\n" + "x".repeat(20000);
    const parts = splitText(words);
    expect(parts.join("")).toBe(words);
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(PASSAGE_MAX_CHARS);
    expect(PASSAGE_MAX_CHARS).toBeLessThan(8000);
    const segs = capSegments([{ text: words, page: "4" }, { text: "   ", page: "5" }]);
    expect(segs.every((s) => s.page === "4" && s.text.length <= PASSAGE_MAX_CHARS)).toBe(true);
    expect(segs.map((s) => s.text).join("")).toBe(words);
  });

  test("L5 transcript cues keep labels verbatim and map speakers per turn", () => {
    const cues = parseCues(readFileSync(join(FIX, "Test-call.vtt"), "utf8"));
    expect(cues.map((c) => c.speaker)).toEqual(["Speaker 1", "Speaker 1", "Speaker 10", ""]);
    const stats = speakerStats(cues, speakerKey);
    expect(stats.map((s) => s.label)).toEqual(["Speaker 1", "Speaker 10", "Unknown speaker"]);
    const turns = turnsFromCues(cues, speakerKey, { "Speaker 1": "Michael R." });
    expect(turns[0]).toEqual({ text: "Test-hello from one\nstill one", speaker: "Michael R.", at: "0:01" });
    expect(turns[1].speaker).toBe("Speaker 10");
    expect(turns[1].at).toBe("1:05");
    const srt = parseCues(readFileSync(join(FIX, "Test-call.srt"), "utf8"));
    expect(srt.map((c) => [c.speaker, c.text])).toEqual([["Von Ellis", "Test-opening line"], ["Speaker 2", "Test-reply"]]);
  });

  test("L4 people come from the file name through the shared parser", () => {
    const ctx = { people: ["Von", "Michael R.", "Priya S.", "Dana K."], owner: "Von" };
    const names = (s: string) => suggestNames(s, ctx).map((n) => n.name);
    expect(names("1on1_Dana.md")).toEqual(["Dana K."]); // S-A4
    expect(names("Priya-budget-notes.docx")).toEqual(["Priya S."]); // S-A6
    expect(names("Q1 planning.pptx")).toEqual([]); // S-A7
    expect(names("Von / Michael 1:1.vtt")).toEqual(["Michael R."]); // S-A2
  });
});

describe("extract", () => {
  test("L9 pdf is read per page", async () => {
    const r = await extractFile("Test-two-pages.pdf", bytes("Test-two-pages.pdf"), "document");
    expect(r.segments.map((s) => s.page)).toEqual(["1", "2"]);
    expect(r.segments[1].text).toContain("Test-second page words");
  });

  test("L9 docx is read per page", async () => {
    const r = await extractFile("Test-policy.docx", bytes("Test-policy.docx"), "document");
    expect(r.segments).toEqual([
      { text: "Test-page one & travel policy\nSecond paragraph", page: "1" },
      { text: "Test-page two text", page: "2" },
    ]);
  });

  test("L9 pptx is read per slide in numeric order", async () => {
    const r = await extractFile("Test-deck.pptx", bytes("Test-deck.pptx"), "document");
    expect(r.segments.map((s) => s.page)).toEqual(["slide 1", "slide 2", "slide 10"]);
  });

  test("L9 xlsx is read per sheet with a row range", async () => {
    const r = await extractFile("Test-budget.xlsx", bytes("Test-budget.xlsx"), "document");
    expect(r.segments).toEqual([{ text: "A: Item | B: Amount\nA: Test-travel | B: 1200", page: "sheet Budget rows 1-2" }]);
  });

  test("L1 server refuses a pdf whose bytes are a zip", async () => {
    expect(await reason(extractFile("Test-fake.pdf", bytes("Test-fake.pdf"), "document"))).toBe("type_mismatch");
    expect(await reason(extractFile("x.docx", bytes("Test-two-pages.pdf"), "document"))).toBe("type_mismatch");
  });

  test("L11 empty, image-only and protected files fail with a named reason", async () => {
    expect(await reason(extractFile("Test-empty.txt", bytes("Test-empty.txt"), "document"))).toBe("no_readable_text");
    expect(await reason(extractFile("Test-image-only.pdf", bytes("Test-image-only.pdf"), "document"))).toBe("no_readable_text");
    expect(await reason(extractFile("Test-protected.docx", bytes("Test-protected.docx"), "document"))).toBe("protected_file");
  });

  test("L2 vtt yields cues, not document pages", async () => {
    const r = await extractFile("Test-call.vtt", bytes("Test-call.vtt"), "transcript");
    expect(r.segments.length).toBe(0);
    expect(r.cues.length).toBe(4);
  });
});

// ── pipeline + removal (fake deps: no DB, no blob, no AI) ────────────────────────────────────────
function fakeItem(over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "00000000-0000-4000-8000-000000000001", ownerEmail: "test@example.invalid", name: "Test-policy.docx", sizeBytes: 529,
    fileType: "docx", kind: "document", category: "General", participants: [], speakerMap: {}, docDate: null,
    status: "uploaded", failedStep: null, failReason: null, chunks: 0, facts: 0, blobPath: "t/x.docx", createdAt: "", ...over,
  };
}
function fakeDeps(o: { configured?: boolean; ingestThrows?: unknown; removeThrows?: boolean; blobDeleteOk?: boolean; file?: string } = {}) {
  const statuses: string[] = [];
  const calls = { removed: 0, rowDeleted: 0, ingested: [] as unknown[] };
  const deps: PipelineDeps = {
    getBytes: async () => bytes(o.file ?? "Test-policy.docx"),
    deleteBytes: async () => o.blobDeleteOk ?? true,
    extract: extractFile,
    memory: {
      configured: () => o.configured ?? true,
      ingest: async (input) => {
        if (o.ingestThrows) throw o.ingestThrows;
        calls.ingested.push(input);
        return { chunks: input.segments.length, facts: 3 };
      },
      remove: async () => {
        calls.removed++;
        if (o.removeThrows) throw new Error("db down");
        return { chunks: 0, facts: 0 };
      },
    },
    update: async (_id, patch) => {
      if (patch.status) statuses.push(patch.status);
    },
    deleteRow: async () => {
      calls.rowDeleted++;
    },
  };
  return { deps, statuses, calls };
}

describe("pipeline", () => {
  test("L6 status follows the server steps to searchable", async () => {
    const f = fakeDeps();
    expect(await runPipeline(fakeItem(), f.deps)).toBe("searchable");
    expect(f.statuses).toEqual(["read", "split", "facts", "searchable"]);
    expect((f.calls.ingested[0] as { segments: unknown[] }).segments.length).toBe(2);
  });

  test("L6 waiting for Trinnex memory when it is not configured", async () => {
    const f = fakeDeps({ configured: false });
    expect(await runPipeline(fakeItem(), f.deps)).toBe("waiting_memory");
    expect(f.calls.ingested.length).toBe(0);
  });

  test("C5 quota failure is named and leaves no half-searchable rows", async () => {
    const f = fakeDeps({ ingestThrows: Object.assign(new Error("x"), { status: 429, code: "insufficient_quota" }) });
    expect(await runPipeline(fakeItem(), f.deps)).toBe("failed");
    expect(f.calls.removed).toBe(1);
    expect(f.statuses.at(-1)).toBe("failed");
  });

  test("L11 protected file fails at Read", async () => {
    const f = fakeDeps({ file: "Test-protected.docx" });
    expect(await runPipeline(fakeItem(), f.deps)).toBe("failed");
    expect(f.statuses).toEqual(["failed"]);
  });

  test("L5 transcript passages carry the mapped speaker", async () => {
    const f = fakeDeps({ file: "Test-call.vtt" });
    await runPipeline(fakeItem({ name: "Test-call.vtt", fileType: "vtt", kind: "transcript", speakerMap: { "Speaker 1": "Michael R." } }), f.deps);
    const segs = (f.calls.ingested[0] as { segments: Array<{ speaker: string }> }).segments;
    expect(segs.map((s) => s.speaker)).toEqual(["Michael R.", "Speaker 10", "Unknown speaker"]);
  });
});

describe("remove", () => {
  test("L7 remove deletes memory, file and row", async () => {
    const f = fakeDeps();
    const r = await runRemoval(fakeItem({ status: "searchable", chunks: 2, facts: 3 }), f.deps);
    expect(r).toEqual({ removed: true, remaining: [] });
    expect(f.calls.removed).toBe(1);
    expect(f.calls.rowDeleted).toBe(1);
  });

  test("L8 a failed blob delete keeps the row as removal incomplete", async () => {
    const f = fakeDeps({ blobDeleteOk: false });
    const r = await runRemoval(fakeItem({ status: "searchable", chunks: 2 }), f.deps);
    expect(r).toEqual({ removed: false, remaining: ["file"] });
    expect(f.calls.rowDeleted).toBe(0);
    expect(f.statuses.at(-1)).toBe("remove_incomplete");
  });

  test("L8 a failed memory delete keeps the row as removal incomplete", async () => {
    const f = fakeDeps({ removeThrows: true });
    const r = await runRemoval(fakeItem({ status: "searchable", chunks: 2 }), f.deps);
    expect(r.remaining).toEqual(["memory"]);
    expect(f.calls.rowDeleted).toBe(0);
  });

  test("L8 ingested rows with memory unavailable are never reported removed", async () => {
    const f = fakeDeps({ configured: false });
    const r = await runRemoval(fakeItem({ status: "searchable", chunks: 4 }), f.deps);
    expect(r.removed).toBe(false);
    expect(f.calls.rowDeleted).toBe(0);
  });
});
