// WHAT:          Loop-2 LOW (c): a voice-call reply from a Trinnex agent is never written to PERSONAL memory.
// WHY:           VERIFY-trinnex-workspace-2.md claim 1 writer sweep: voice/voice-memory.functions.ts rememberVoiceTurn wrote
//                voice AGENT replies to rag_chunks (scope=global) with no Trinnex guard; a call continuing dm-iris-chase can
//                repeat an earlier Trinnex-based reply.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Verifier loop-2 fix round". Run: bun test scripts/trinnex-voice-guard.test.ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle`;
const search = await import(`${SRC}/lib/trinnex/search.ts`);
const { AGENTS, AGENT_BY_ID } = await import(`${SRC}/data/agents.ts`);

test("VOICE1 every Trinnex agent's voice reply is treated as possibly Trinnex-based; the owner's words and other agents are not", () => {
  const trinnex = (AGENTS as Array<{ id: string; trinnexAccess?: boolean }>).filter((a) => a.trinnexAccess === true).map((a) => a.id);
  expect(trinnex.sort()).toEqual(["eli-vaughn", "iris-chase"]);
  for (const a of AGENTS as Array<{ id: string; trinnexAccess?: boolean }>) {
    expect(search.voiceReplyMayCarryTrinnex(a, "agent")).toBe(a.trinnexAccess === true);
    expect(search.voiceReplyMayCarryTrinnex(a, "user")).toBe(false);
  }
  expect(search.voiceReplyMayCarryTrinnex(undefined, "agent")).toBe(false);
  expect(search.voiceReplyMayCarryTrinnex(AGENT_BY_ID["iris-chase"], "agent")).toBe(true);
});

test("VOICE2 rememberVoiceTurn returns before the personal writeChunk when the guard says so, and fails closed", () => {
  const s = readFileSync(`${SRC}/lib/voice/voice-memory.functions.ts`, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const guard = s.indexOf("if (voiceReplyMayCarryTrinnex(AGENT_BY_ID[data.agentId as keyof typeof AGENT_BY_ID], data.role)) {");
  const write = s.indexOf("azurePgStore.writeChunk(");
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(write);
  expect(s.slice(guard, write)).toContain("return result;");
  const fallback = s.slice(guard, write);
  expect(fallback.match(/return result;/g)?.length).toBe(2); // guard true AND the catch (cannot tell) both return
});
