// Scratch probe for VERIFY-second-mailbox-2c (not to be merged). Exercises mailboxAccess's cache and
// screenMessage's self-filter with the real modules; only journey's proxy is mocked.
import { mock } from "bun:test";
const calls: unknown[] = [];
mock.module("../src/features/huddle/lib/journey/proxy.functions", () => ({
  invokeJourneyTool: async (req: { caller: { entra_email: string } }) => {
    calls.push(req);
    return { ok: true, output: JSON.stringify({ access_token: `TOKEN-FOR-${req.caller.entra_email}`, expires_in: 3600 }) };
  },
}));
const { mailboxAccess } = await import("../src/features/huddle/lib/email/graph-email.server");
const a = await mailboxAccess("x@trinnex.io", "ownerA@enterpriseds.io");
const b = await mailboxAccess("X@Trinnex.io", "ownerB@enterpriseds.io");
let c: unknown;
try { c = await mailboxAccess("x@trinnex.io"); } catch (e) { c = `THREW: ${(e as Error).message}`; }
console.log("A:", a.token, "| B:", b.token, "| no-owner:", typeof c === "string" ? c : (c as { token: string }).token, "| journey calls:", calls.length);

const { screenMessage } = await import("../src/features/huddle/lib/email/inbound-email");
const m = { id: "1", fromAddress: "von.ellis@enterpriseds.io", subject: "s" } as never;
console.log("own EDS mail in trinnex inbox (mode=all):", JSON.stringify(screenMessage(m, "all" as never, "von@trinnex.io")));
console.log("own EDS mail in EDS inbox (mode=all):", JSON.stringify(screenMessage(m, "all" as never, "von.ellis@enterpriseds.io")));
