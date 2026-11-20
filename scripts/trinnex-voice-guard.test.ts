// WHAT:          The voice-call writer keeps a Trinnex agent's reply out of PERSONAL memory ONLY when that agent's 1:1
//                history holds a turn that ran search_trinnex. Every other voice turn is written exactly as on main.
// WHY:           Loop-2 (VERIFY-trinnex-workspace-2.md claim 1 writer sweep) found rememberVoiceTurn had no Trinnex guard.
//                The loop-2 fix skipped EVERY Iris/Eli voice reply, which changed today's behaviour for every call without
//                the owner's sign-off (huddle CLAUDE.md "NEVER change ... existing design"). Narrowed 2026-11-20.
// SUPERSEDES:    the loop-2 VOICE1-2 (blanket skip). SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Voice guard narrowed (2026-11-20)".
//                Run: bun test scripts/trinnex-voice-guard.test.ts
import { test, expect, mock } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle`;
const search = await import(`${SRC}/lib/trinnex/search.ts`);
const { AGENTS, AGENT_BY_ID } = await import(`${SRC}/data/agents.ts`);
type A = { id: string; trinnexAccess?: boolean };
const ALL = AGENTS as A[];
const OWNER = "test-owner@example.com";

// ---- Drive the REAL rememberVoiceTurn handler with every I/O module faked (no live calls, no real data). ----
const writes: Array<{ text: string; source: string }> = [];
const lookups: Array<{ owner: string; huddle: string; tool: string }> = [];
let historyMarked: Record<string, boolean> = {};
let lookupThrows = false;

mock.module("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (raw: unknown) => unknown = (x) => x;
    const b = {
      inputValidator(v: (raw: unknown) => unknown) {
        validate = v;
        return b;
      },
      handler(h: (a: { data: unknown }) => Promise<unknown>) {
        return async (a: { data: unknown }) => h({ data: validate(a.data) });
      },
    };
    return b;
  },
}));
mock.module(require.resolve(`${SRC}/lib/journey/identity.ts`), () => ({ resolveTaskEmail: async () => OWNER }));
mock.module(require.resolve(`${SRC}/lib/rag/conversation-store.server.ts`), () => ({
  getOrCreateConversationId: async () => "conv_test",
  appendConversationItems: async () => true,
}));
mock.module(require.resolve(`${SRC}/lib/rag/embed.server.ts`), () => ({ embed: async () => [0.1, 0.2] }));
mock.module(require.resolve(`${SRC}/lib/rag/azure-pg.server.ts`), () => ({
  azurePgStore: { writeChunk: async (c: { text: string; source: string }) => void writes.push({ text: c.text, source: c.source }) },
}));
mock.module(require.resolve(`${SRC}/lib/tasks/turns.server.ts`), () => ({
  oneToOneHasToolTurn: async (owner: string, huddle: string, tool: string) => {
    lookups.push({ owner, huddle, tool });
    if (lookupThrows) throw new Error("db down");
    return historyMarked[huddle] === true;
  },
}));
const { rememberVoiceTurn } = await import(`${SRC}/lib/voice/voice-memory.functions.ts`);

async function call(agentId: string, role: "user" | "agent", text = "Test- the budget is twelve thousand") {
  writes.length = 0;
  lookups.length = 0;
  const r = (await rememberVoiceTurn({ data: { caller: { entra_email: OWNER }, agentId, role, text } })) as {
    ok: boolean;
    conversation: boolean;
    rag: boolean;
  };
  return { r, writes: [...writes], lookups: [...lookups] };
}

test("VOICE1 the predicate needs ALL of: an agent reply, a Trinnex agent, and a Trinnex-marked turn in its 1:1 history", () => {
  const trinnex = ALL.filter((a) => a.trinnexAccess === true).map((a) => a.id);
  expect(trinnex.sort()).toEqual(["eli-vaughn", "iris-chase"]);
  for (const a of ALL) {
    expect(search.voiceReplyMayCarryTrinnex(a, "agent", true)).toBe(a.trinnexAccess === true);
    expect(search.voiceReplyMayCarryTrinnex(a, "agent", false)).toBe(false);
    expect(search.voiceReplyMayCarryTrinnex(a, "user", true)).toBe(false);
  }
  expect(search.voiceReplyMayCarryTrinnex(undefined, "agent", true)).toBe(false);
});

test("VOICE2 rememberVoiceTurn decides before the personal writeChunk, passes the real 1:1 lookup, and fails closed", async () => {
  const s = readFileSync(`${SRC}/lib/voice/voice-memory.functions.ts`, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const guard = s.indexOf("const skip = await voiceReplySkipsPersonalMemory({");
  const write = s.indexOf("azurePgStore.writeChunk(");
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(write);
  expect(s.slice(guard, write)).toContain("historyHasToolTurn: oneToOneHasToolTurn,");
  expect(s.slice(guard, write).match(/return result;/g)?.length).toBe(2);
  // Marked history is read from the SAME breadcrumb the text path writes (tool name search_trinnex), keyed dm-<agent>.
  historyMarked = { "dm-iris-chase": true };
  const { lookups: l } = await call("iris-chase", "agent");
  expect(l).toEqual([{ owner: OWNER, huddle: "dm-iris-chase", tool: search.SEARCH_TRINNEX_TOOL.name }]);
  // Cannot tell (lookup throws, or no owner) -> treated as marked: no personal write.
  lookupThrows = true;
  historyMarked = {};
  expect((await call("iris-chase", "agent")).writes).toEqual([]);
  lookupThrows = false;
  expect(
    await search.voiceReplySkipsPersonalMemory({
      agent: AGENT_BY_ID["eli-vaughn"],
      agentId: "eli-vaughn",
      role: "agent",
      ownerEmail: null,
      historyHasToolTurn: async () => false,
    }),
  ).toBe(true);
});

test("VOICE3 with no Trinnex turn in the 1:1 history, Iris's and Eli's replies are written exactly as on main", async () => {
  historyMarked = {};
  for (const id of ["iris-chase", "eli-vaughn"]) {
    const { r, writes: w } = await call(id, "agent");
    expect(w).toEqual([{ text: `${id} (on a voice call): Test- the budget is twelve thousand`, source: `voice:dm-${id}` }]);
    expect(r).toEqual({ ok: true, conversation: true, rag: true });
    const u = await call(id, "user", "Test- what did we decide");
    expect(u.writes).toEqual([{ text: "Test- what did we decide", source: `voice:dm-${id}` }]);
  }
});

test("VOICE4 a call whose 1:1 history holds a Trinnex-marked turn writes nothing from Iris or Eli to personal memory", async () => {
  historyMarked = { "dm-iris-chase": true, "dm-eli-vaughn": true };
  for (const id of ["iris-chase", "eli-vaughn"]) {
    const { r, writes: w } = await call(id, "agent");
    expect(w).toEqual([]);
    expect(r).toEqual({ ok: true, conversation: true, rag: false }); // still joins its own 1:1 conversation
    // The owner's own spoken words are unchanged.
    expect((await call(id, "user", "Test- what did we decide")).writes.length).toBe(1);
  }
  // Marked history is per 1:1: Eli's unmarked 1:1 is not affected by Iris's marked one.
  historyMarked = { "dm-iris-chase": true };
  expect((await call("eli-vaughn", "agent")).writes.length).toBe(1);
});

test("VOICE5 every other agent is unaffected: written as on main, and no history lookup is made", async () => {
  historyMarked = Object.fromEntries(ALL.map((a) => [`dm-${a.id}`, true]));
  for (const a of ALL.filter((x) => x.trinnexAccess !== true)) {
    const { r, writes: w, lookups: l } = await call(a.id, "agent");
    expect(w).toEqual([{ text: `${a.id} (on a voice call): Test- the budget is twelve thousand`, source: `voice:dm-${a.id}` }]);
    expect(r.rag).toBe(true);
    expect(l).toEqual([]);
  }
});
