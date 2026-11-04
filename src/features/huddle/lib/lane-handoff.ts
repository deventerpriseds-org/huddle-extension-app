// WHAT:       The out-of-lane wording every agent is handed in its scene, and the 1:1 lane directive.
//             Pure strings, so the group/1:1 split is testable offline (scripts/plan-and-answer-first.test.ts).
// WHY:        Owner-approved 2026-11-03: in a 1:1 an out-of-lane question was REFUSED ("Do NOT answer it
//             yourself") or answered with an @handle the 1:1 cannot use. Now the agent answers first when it
//             reasonably can, then names the owning teammate. Group wording is unchanged, byte for byte.
// SUPERSEDES: the inline scene sentence + laneDirective literal in huddle.functions.ts (moved here; the
//             GROUP sentence is the original text verbatim).
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/BUILD-plan-and-answer-first.md

/** The GROUP out-of-lane sentence — the original scene text, verbatim. Group behaviour must not change. */
export const GROUP_OUT_OF_LANE_LINE =
  "If a question is outside your lane, keep it to one short line and @mention the right specialist by their handle — the mention IS the handoff, do not narrate it or say \"I'll pass this to\".";

/** The 1:1 out-of-lane sentence: answer first, then name the owner (no @handle — @ is group-only). */
export const ONE_TO_ONE_OUT_OF_LANE_LINE =
  "If a question is outside your lane, ANSWER IT FIRST when you reasonably can — briefly and accurately — then, in one short line, name the teammate who owns that area by their NAME and offer to loop them in. Do NOT use an @handle: this is a 1:1, they are not in this conversation (@ is for group rooms). Only skip answering when it is an exclusive capability you do not own (see the capability rules) or substantial work that belongs in that teammate's lane — then just say, by name, that they're better suited.";

export function outOfLaneSceneLine(scope: "group" | "1:1"): string {
  return scope === "group" ? GROUP_OUT_OF_LANE_LINE : ONE_TO_ONE_OUT_OF_LANE_LINE;
}

/**
 * The 1:1 directive for an ask that resolves (laneOwnerFor) to ANOTHER agent's lane. Answer-first for a
 * question the agent can reasonably answer; hand off for substantive lane work. The deterministic
 * follow-up (deliverOwnerFollowup) still fires exactly as before, so the owner is told the teammate WILL
 * follow up — never "want me to?" when the system brings them in regardless.
 */
export function laneAnswerFirstDirective(owner: { name: string; role: string; domains: readonly string[] }): string {
  const o = owner.name;
  return (
    `\n\nThis request touches ${o}'s lane (${owner.role}: ${owner.domains.slice(0, 3).join(", ")}). ` +
    `If it is a question or a quick ask you can reasonably answer yourself, ANSWER IT FIRST — briefly, helpfully and accurately — ` +
    `then add ONE short line naming ${o} by NAME as the specialist and saying you're looping them in so they can go deeper ` +
    `(e.g. "${o} knows this area best — I'm looping them in if you want to dig deeper"). ` +
    `If it is instead substantial work that belongs in ${o}'s lane (building their plan, model or budget, or anything that needs ${o}'s own tools or data), ` +
    `do NOT do it or improvise it yourself — tell the user plainly, by NAME, that ${o} is better suited and that you'll loop them in. ` +
    `Either way, do NOT use an @handle: ${o} is not in this 1:1 (@ is for group rooms). ` +
    `The system brings ${o} in automatically — they'll follow up with the user in their own channel. ` +
    `Exclusive capabilities (if any are listed in your capability rules) still hand off exactly as those rules say.`
  );
}
