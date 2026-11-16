// WHAT:       Which minutes recipients Huddle's EXISTING email gate will send to without a draft, using the
//             same policy read (resolveSelfSendPolicy) and the same per-address rule (resolveTier) as
//             sendGraphEmail. Read-only: it never changes the gate.
// WHY:        Owner handoff 2026-11-10 wants minutes emailed to configurable recipients. The gate auto-sends
//             only to the owner's own AUTO-tier addresses; anything else makes the whole send a draft. The
//             Settings panel shows this up front, and the default recipient list uses only sendable ones.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:fireflies-minutes.

export async function sendableTiers(
  owner: string,
  addresses?: string[],
): Promise<Array<{ address: string; tier: string; sends: boolean }>> {
  const { resolveSelfSendPolicy } = await import("../identity/agent-workflow-config.server");
  const { resolveTier } = await import("../email/self-send-gate");
  const policy = await resolveSelfSendPolicy(owner);
  const list = addresses ?? policy.selfRows.map((r) => r.email);
  return list.map((address) => {
    const tier = resolveTier(address, policy);
    return { address, tier, sends: tier === "auto" };
  });
}
