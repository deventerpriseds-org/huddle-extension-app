// WHAT:          Proves text chat and the voice call use ONE memory step and the same Executive Profile:
//                the selection rules in rag/memory-context.server.ts, and that the voice instructions
//                (assembleRealtimeInstructions) carry the profile + the shared retrieval's output.
// WHY:           Voice had its own retrieval (k=5, no floor, no topic ranking) and no profile at all, so a
//                spoken 1:1 knew less than a typed one. Owner, 2026-10-28: "why can't voice trigger the
//                same jobs instead of needing to be configured separately."
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      Run: bun test scripts/memory-context.test.ts
// Failing tests also print `FAIL <name>` (bun prints "(fail)"), so scripts/mutate.sh can attribute them.
import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
const P = (rel: string) => require.resolve(`${SRC}/${rel}`);

const t = (name: string, fn: () => Promise<void> | void) =>
  test(name, async () => {
    try {
      await fn();
    } catch (e) {
      console.log(`FAIL ${name}`);
      throw e;
    }
  });

let searchCalls: any[] = [];
let storeHits: any[] = [];
let profile: any = null;
mock.module(P("rag/azure-pg.server.ts"), () => ({
  azurePgStore: {
    searchChunks: async (input: any) => {
      searchCalls.push(input);
      return storeHits;
    },
  },
}));
mock.module(P("identity/user-context.server.ts"), () => ({
  getUserContext: async () => profile,
  renderExecutiveContext: (ctx: any) => (ctx ? `\n\nWHO YOU SERVE: ${ctx.goals}` : ""),
}));
mock.module(P("journey/identity.ts"), () => ({ resolveTaskEmail: async (c: any) => c?.entra_email }));

const { selectMemoryHits, MEMORY_INJECT_N, MEMORY_CANDIDATE_K } = await import(`${SRC}/rag/memory-context.server.ts`);
const { assembleRealtimeInstructions } = await import(`${SRC}/voice/realtime-tools.server.ts`);
const { AGENT_BY_ID } = await import(`${SRC}/../data/agents.ts`);

const row = (text: string, score: number, authorAgentIds: string[] = []) =>
  ({ id: text, scope: "global", agentId: null, text, source: null, authorAgentIds, score, createdAt: "" }) as any;
const FINN = { id: "finn-reid", domains: ["budgeting"], themes: ["refinance"] };

beforeEach(() => {
  searchCalls = [];
  storeHits = [];
  profile = null;
});

t("drops hits below the relevance floor", () => {
  expect(selectMemoryHits([row("weak", 0.29), row("strong", 0.31)], FINN).map((h) => h.text)).toEqual(["strong"]);
});

t("drops what the agent can already see", () => {
  expect(selectMemoryHits([row("said just now", 0.9), row("older", 0.5)], FINN, ["said just now"]).map((h) => h.text)).toEqual(["older"]);
});

t("ranks the agent's own topics first without hiding the rest", () => {
  const out = selectMemoryHits([row("dog is called Waffles", 0.45), row("budgeting for Q4 is tight", 0.4)], FINN).map((h) => h.text);
  expect(out).toEqual(["budgeting for Q4 is tight", "dog is called Waffles"]);
});

t("ranks chunks the agent co-authored first", () => {
  const out = selectMemoryHits([row("a", 0.45), row("b", 0.4, ["finn-reid"])], FINN).map((h) => h.text);
  expect(out).toEqual(["b", "a"]);
});

t("collapses near-duplicates", () => {
  const boiler = "x".repeat(90);
  expect(selectMemoryHits([row(boiler + " one", 0.5), row(boiler + " two", 0.49)], FINN)).toHaveLength(1);
});

t("caps what is injected", () => {
  const many = Array.from({ length: 15 }, (_, i) => row(`fact number ${i} ${"y".repeat(i)}`, 0.5));
  expect(selectMemoryHits(many, FINN)).toHaveLength(MEMORY_INJECT_N);
});

t("voice uses the shared retrieval: wide fetch, agent scope, topic ranking", async () => {
  storeHits = [row("dog is called Waffles", 0.45), row("budgeting for Q4 is tight", 0.4), row("noise", 0.1)];
  const out = await assembleRealtimeInstructions("finn-reid", { memoryQuery: "how is money looking" });
  expect(searchCalls).toHaveLength(1);
  expect(searchCalls[0].k).toBe(MEMORY_CANDIDATE_K);
  expect(searchCalls[0].agentId).toBe("finn-reid");
  expect(out).not.toContain("noise");
  const finn = AGENT_BY_ID["finn-reid"];
  const laneHit = [...finn.domains, ...finn.themes].some((d: string) => "budgeting for q4 is tight".includes(d.toLowerCase()));
  if (laneHit) expect(out.indexOf("budgeting for Q4")).toBeLessThan(out.indexOf("Waffles"));
});

t("voice carries the user's Executive Profile when a caller is known", async () => {
  profile = { goals: "Test-launch the consultancy" };
  const out = await assembleRealtimeInstructions("finn-reid", { caller: { entra_email: "owner@test" } });
  expect(out).toContain("WHO YOU SERVE: Test-launch the consultancy");
});

t("voice without a caller still builds (profile is best-effort)", async () => {
  profile = { goals: "Test-should not appear" };
  const out = await assembleRealtimeInstructions("finn-reid", {});
  expect(out).not.toContain("WHO YOU SERVE");
});

t("the mint passes the caller through, on both the real mint and the warm-up", () => {
  const src = readFileSync(`${SRC}/voice/realtime.functions.ts`, "utf8");
  const calls = src.match(/assembleRealtimeInstructions\(data\.agentId, \{[^}]*\}\)/g) ?? [];
  expect(calls.length).toBe(2);
  for (const c of calls) expect(c).toContain("caller: data.caller");
});

t("text chat uses the same retrieval step (no second copy)", () => {
  const src = readFileSync(`${SRC}/huddle.functions.ts`, "utf8");
  expect(src).toContain("retrieveAgentMemory({");
  expect(src).not.toMatch(/MEMORY_MIN_SCORE\s*=/);
  const voice = readFileSync(`${SRC}/voice/realtime-tools.server.ts`, "utf8");
  expect(voice).not.toContain("searchChunks(");
});
