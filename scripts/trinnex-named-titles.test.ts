// WHAT:  offline tests for using the owner's named transcript files as Meetings titles.
// WHY:   owner, 2026-11-20: "Why aren't the titles from the files on the server kept instead of using the date as a
//        title?" Fireflies titles are date-only ("Nov 10, 09:37 AM"); the OneDrive files are "Nov 10- 09-37 AM-<name>.md".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.  EVIDENCE: docs/qc-evidence/BUILD-trinnex-named-titles.md
// Run: bun test scripts/trinnex-named-titles.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { matchNamedFiles, parseNamedFile, stampKeyFromTitle } from "../src/features/huddle/lib/trinnex/meeting-triage-core";
import { listNamedTranscriptFiles, resetNamedFilesCache } from "../src/features/huddle/lib/trinnex/named-files.server";

describe("stamp parsing (spelling table: the shapes seen in the DB and the owner's screenshot)", () => {
  const T: Array<[string, string | null]> = [
    ["Nov 10, 09:37 AM", "nov 10 09:37 am"],
    ["Nov 9, 9:05 PM", "nov 9 09:05 pm"],
    ["nov 10, 03:01 pm", "nov 10 03:01 pm"],
    ["  Nov 10, 09:37 AM  ", "nov 10 09:37 am"],
    ["Engineering sync", null],
    ["Nov 10, 09:37 AM - Engineering", null],
    ["Xyz 10, 09:37 AM", null],
    ["", null],
  ];
  for (const [title, key] of T) test(`title ${JSON.stringify(title)} -> ${key}`, () => expect(stampKeyFromTitle(title)).toBe(key));

  const F: Array<[string, { key: string; name: string } | null]> = [
    ["Nov 10- 09-37 AM-Weekly planning sync.md", { key: "nov 10 09:37 am", name: "Weekly planning sync" }],
    ["Nov 10- 03-01 PM-Alex Sync t.md", { key: "nov 10 03:01 pm", name: "Alex Sync t" }],
    ["Nov 11- 11-02 AM- Jordan VP of Ops.md", { key: "nov 11 11:02 am", name: "Jordan VP of Ops" }],
    ["Nov 9- 9-05 PM-Late call.txt", { key: "nov 9 09:05 pm", name: "Late call" }],
    ["Nov 10- 09-37 AM-.md", null],
    ["Nov 10- 09-37 AM.md", null],
    ["fireflies-01M7TRBVYZQZZ7YV4RWP94MZ9S.md", null],
    ["Notes.md", null],
  ];
  for (const [file, want] of F) test(`file ${JSON.stringify(file)}`, () => expect(parseNamedFile(file)).toEqual(want));
});

describe("matchNamedFiles", () => {
  const M = (id: string, title: string | null, meetingAt: string | null) => ({ id, title, meetingAt });
  test("NT1 pairs by stamp and returns the descriptive name", () => {
    const m = matchNamedFiles(
      [M("a", "Nov 10, 09:37 AM", "2026-11-10T14:40:00Z"), M("b", "Nov 10, 03:01 PM", "2026-11-10T20:00:00Z")],
      [{ name: "Nov 10- 03-01 PM-Alex Sync.md", createdAt: "2026-11-10T21:00:00Z" }, { name: "Nov 10- 09-37 AM-Planning.md", createdAt: "2026-11-10T15:30:00Z" }],
    );
    expect(m.get("a")).toBe("Planning");
    expect(m.get("b")).toBe("Alex Sync");
  });
  test("NT2 a file far from the meeting (another year) is not used", () => {
    const m = matchNamedFiles([M("a", "Nov 10, 09:37 AM", "2026-11-10T14:40:00Z")], [{ name: "Nov 10- 09-37 AM-Old one.md", createdAt: "2025-11-10T15:00:00Z" }]);
    expect(m.size).toBe(0);
  });
  test("NT3 two files with one stamp: the closer one wins, and each file is used once", () => {
    const m = matchNamedFiles(
      [M("a", "Nov 10, 09:37 AM", "2026-11-10T14:40:00Z"), M("b", "Nov 10, 09:37 AM", "2026-11-10T14:40:00Z")],
      [{ name: "Nov 10- 09-37 AM-Far.md", createdAt: "2026-11-15T00:00:00Z" }, { name: "Nov 10- 09-37 AM-Near.md", createdAt: "2026-11-10T15:00:00Z" }],
    );
    expect(m.get("a")).toBe("Near");
    expect(m.get("b")).toBe("Far");
  });
  test("NT4 a meeting whose title is not a date stamp, or has no file, gets nothing", () => {
    const m = matchNamedFiles([M("a", "Weekly sync", null), M("b", "Nov 12, 10:00 AM", null)], [{ name: "Nov 10- 09-37 AM-X.md" }]);
    expect(m.size).toBe(0);
  });
});

describe("listNamedTranscriptFiles (fake Graph)", () => {
  beforeEach(() => {
    resetNamedFilesCache();
    process.env.AZURE_TENANT_ID = "t";
    process.env.AZURE_CLIENT_ID = "c";
    process.env.AZURE_CLIENT_SECRET = "s";
    process.env.FIREFLIES_ONEDRIVE_MAILBOX = "owner@example.com";
    delete process.env.FIREFLIES_NAMED_FOLDER;
  });
  const realFetch = globalThis.fetch;
  function fakeFetch(pages: Array<{ status: number; body?: unknown }>, seen: string[]) {
    let i = 0;
    return (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      seen.push(u);
      const p = pages[Math.min(i++, pages.length - 1)];
      return new Response(JSON.stringify(p.body ?? {}), { status: p.status });
    }) as typeof fetch;
  }

  test("NF1 lists files (not folders) across pages from the probe's folder path", async () => {
    const seen: string[] = [];
    const f = fakeFetch(
      [
        { status: 200, body: { value: [{ name: "Nov 10- 09-37 AM-A.md", file: {}, createdDateTime: "2026-11-10T15:00:00Z" }, { name: "sub", folder: {} }], "@odata.nextLink": "https://graph.microsoft.com/next" } },
        { status: 200, body: { value: [{ name: "Nov 11- 10-35 AM-B.md", file: {} }] } },
      ],
      seen,
    );
    globalThis.fetch = f;
    try {
      const files = await listNamedTranscriptFiles(f);
      expect(files.map((x) => x.name)).toEqual(["Nov 10- 09-37 AM-A.md", "Nov 11- 10-35 AM-B.md"]);
      expect(seen[0]).toContain("/users/owner%40example.com/drive/root:/automation/Fireflies%20Transcripts:/children");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("NF2 a Graph error (403) returns [] and never throws, so Meetings falls back to the Fireflies title", async () => {
    const f = fakeFetch([{ status: 403 }], []);
    globalThis.fetch = f;
    try {
      expect(await listNamedTranscriptFiles(f)).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("NF3 no Graph credentials -> [] without any call", async () => {
    delete process.env.AZURE_CLIENT_SECRET;
    delete process.env.GRAPH_CLIENT_SECRET;
    const seen: string[] = [];
    expect(await listNamedTranscriptFiles(fakeFetch([{ status: 200 }], seen))).toEqual([]);
    expect(seen.length).toBe(0);
  });

  test("NF4 FIREFLIES_NAMED_FOLDER overrides the folder", async () => {
    process.env.FIREFLIES_NAMED_FOLDER = "/Other/Place/";
    const seen: string[] = [];
    const f = fakeFetch([{ status: 200, body: { value: [] } }], seen);
    globalThis.fetch = f;
    try {
      await listNamedTranscriptFiles(f);
      expect(seen[0]).toContain("/drive/root:/Other/Place:/children");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("NF5 a network failure (fetch rejects) returns [] and never throws", async () => {
    const f = (async (url: string | URL) => {
      if (String(url).includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    globalThis.fetch = f;
    try {
      expect(await listNamedTranscriptFiles(f)).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
