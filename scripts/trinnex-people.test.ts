// WHAT:          Guards for the integration pass's people seams: ONE people list (the Library reads and writes the
//                meetings lane's chat.trinnex_people) and AC-T13 (the owner picker in the chat checklist and in
//                Actions > Meetings, with the stored assignee shape unchanged -- decision Q4).
// WHY:           BUILD-trinnex-library.md left the Library on an interim list; BUILD-trinnex-meetings.md left both
//                existing triage surfaces on the typed "For someone" box.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      Run: bun test scripts/trinnex-people.test.ts. Fake pool and identity; no live DB.
// Failing tests also print `FAIL <name>` so scripts/mutate.sh can attribute them.
import { test, expect, mock } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle`;
const P = (rel: string) => require.resolve(`${SRC}/lib/${rel}`);
const t = (name: string, fn: () => Promise<void> | void) =>
  test(name, async () => {
    try {
      await fn();
    } catch (e) {
      console.log(`FAIL ${name}`);
      throw e;
    }
  });

const writes: Array<{ sql: string; params: unknown[] }> = [];
mock.module(P("db/shared-pool.server.ts"), () => ({
  SHARED_POOL_MAX: 8,
  TRINNEX_POOL_MAX: 2,
  getSharedPool: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (/trinnex_people/.test(sql)) writes.push({ sql, params });
      return { rows: [] };
    },
  }),
  trinnexPgConfigured: () => false,
  getTrinnexPool: () => {
    throw new Error("never");
  },
}));
mock.module(P("fireflies/minutes-store.server.ts"), () => ({ ensureMinutesSchema: async () => {} }));
mock.module(P("proposals/proposals.server.ts"), () => ({
  callerOwners: async () => ["test.owner@example.com"],
  actOnProposal: async () => ({ ok: true }),
}));

const meetings = await import(`${SRC}/lib/trinnex/meetings.server.ts`);
const core = await import(`${SRC}/lib/trinnex/meeting-triage-core.ts`);
const { triageProposal } = await import(`${SRC}/lib/proposals/engine.ts`);
const { groupMeetingQueue, cleanTriageName } = await import(`${SRC}/lib/proposals/meeting-triage.ts`);
const read = (rel: string) => readFileSync(`${SRC}/${rel}`, "utf8");
const caller = { entra_email: "test.owner@example.com" };

// ── ONE people list ──────────────────────────────────────────────────────────────────────────────────
t("ONE1 Library names are written into chat.trinnex_people, deduped, owner never stored", async () => {
  writes.length = 0;
  await meetings.rememberPeople(caller, ["Michael R.", "michael  r.", "Test", "", "  ", 42, "Priya S."]);
  const inserted = writes.filter((w) => /INSERT INTO chat\.trinnex_people/.test(w.sql)).map((w) => w.params);
  expect(inserted).toEqual([
    ["test.owner@example.com", "michael r", "Michael R."],
    ["test.owner@example.com", "priya s", "Priya S."],
  ]);
});

t("ONE2 the Library listing and saves use the meetings people list, not an interim one", () => {
  const fns = read("lib/trinnex/library.functions.ts");
  expect(fns).toContain("getPeople(data.caller)");
  expect(fns.match(/rememberPeople\(data\.caller,/g)?.length).toBe(2); // upload + set speakers
  expect(fns).not.toContain("peopleFrom(");
  expect(read("lib/trinnex/library.server.ts")).not.toMatch(/export function peopleFrom/);
  // Meetings and every picker read the same server fn
  expect(read("components/PeoplePicker.tsx")).toContain("getTrinnexPeopleFn");
});

// ── AC-T13 owner picker on the existing triage surfaces ──────────────────────────────────────────────
t("T13 a pick sends exactly the old typed-box shape", () => {
  expect(core.triageForPick("Test", "Test")).toEqual({ choice: "mine" });
  expect(core.triageForPick("test", "Test")).toEqual({ choice: "mine" });
  expect(core.triageForPick("Michael R.", "Test")).toEqual({ choice: "someone", name: "Michael R." });
  expect(core.triageForPick("x".repeat(100), "Test")).toEqual({ choice: "someone", name: "x".repeat(80) });
  expect(core.triageForPick(core.OWNER_FALLBACK_LABEL, null)).toEqual({ choice: "mine" });
  expect(core.triageForPick("Priya S.", null)).toEqual({ choice: "someone", name: "Priya S." });
});

t("T13 an existing delegated row still reads and acts the same", async () => {
  // A row delegated with the OLD typed box ("jordan from finance", lower-case, never in any people list).
  const old = { id: "p1", title: "Test-send the deck", state: "delegated", assignee: "jordan from finance", meetingId: "m1", sources: [] } as any;
  const before = groupMeetingQueue([old]);
  expect(before.meetings[0].forSomeone).toEqual([expect.objectContaining({ id: "p1", assignee: "jordan from finance", state: "delegated" })]);
  expect(before.counts.forSomeone).toBe(1);

  // Acting through the picker reaches store.triage with the SAME (target, assignee) the typed box produced.
  const calls: Array<[string, string | null]> = [];
  const store = {
    triage: async (_o: string[], _id: string, target: string, assignee: string | null) => {
      calls.push([target, assignee]);
      return { applied: true, row: { ...old, state: target, assignee } };
    },
  } as any;
  const viaTyped = { choice: "someone" as const, name: "Jordan Lee".slice(0, 80) };
  const viaPicker = core.triageForPick("Jordan Lee", "Test");
  await triageProposal(["o"], "p2", viaTyped.choice, viaTyped.name, store);
  await triageProposal(["o"], "p2", viaPicker.choice, viaPicker.name, store);
  expect(calls[0]).toEqual(["delegated", cleanTriageName("Jordan Lee")]);
  expect(calls[1]).toEqual(calls[0]);
  // Mine via the picker = today's Mine: proposed, no assignee.
  const mine = core.triageForPick("Test", "Test");
  await triageProposal(["o"], "p3", mine.choice, mine.name, store);
  expect(calls[2]).toEqual(["proposed", null]);
});

t("T13 both existing triage surfaces use the one picker", () => {
  for (const f of ["components/ProposalChecklistItem.tsx", "components/ActionsView.tsx"]) {
    const s = read(f);
    expect(s).toContain("<OwnerTriageMenuItems");
    expect(s).toContain("rememberPersonName(pickerCaller, n)");
    // the old menu item that opened the typed box directly is gone
    expect(s).not.toMatch(/<Users size=\{12\} className="mr-2" \/> For someone/);
  }
});
