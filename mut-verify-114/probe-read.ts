// WHAT: verifier probe -- read tools stay read-only: nexusReadTools() count, every read call is a bare GET with no auth header.
// WHY: C6. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current. EVIDENCE: docs/VERIFY-nexus-write-tool-1.md
import { nexusReadTools, NEXUS_TOOL_NAMES, executeNexusTool } from "../src/features/huddle/lib/nexus/nexus.server";
Object.assign(process.env, { NEXUS_API_URL: "https://nexus.test", NEXUS_OWNER_ID: "o1", UAT_BYPASS_TOKEN: "tok", JOURNEY_PROXY_TOKEN: "jt" });
const seen: Array<{ url: string; init: unknown }> = [];
globalThis.fetch = (async (u: string, init?: RequestInit) => {
  seen.push({ url: String(u), init });
  return new Response("[]", { status: 200 });
}) as unknown as typeof fetch;
const tools = nexusReadTools() as Array<{ name: string }>;
console.log("read tools:", tools.length, "NEXUS_TOOL_NAMES:", NEXUS_TOOL_NAMES.size, "write tool among reads:", tools.some((t) => /write/.test(t.name)));
for (const t of tools) {
  try {
    await executeNexusTool(t.name, { course: "MGT-782", query: "x", date: "2026-10-30", assignment_id: "a1" }, "UTC");
  } catch {
    /* shape errors are irrelevant here */
  }
}
const bad = seen.filter((s) => Object.keys((s.init ?? {}) as Record<string, unknown>).some((k) => k !== "signal"));
console.log("read fetches:", seen.length, "| with any init key other than signal:", bad.length, JSON.stringify(bad.slice(0, 2)));
