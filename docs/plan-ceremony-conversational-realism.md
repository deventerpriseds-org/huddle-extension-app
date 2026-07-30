# Plan: ceremony conversational realism (cross-talk relaxation, staged validation)

## Why
User's complaint, direct quote: ceremonies are "scripted with recordings being read... not a
natural group conversation at all." Confirmed by independent code investigation (not inferred):
ceremony participants are deliberately denied visibility into what other agents in the same run
just said. The cross-talk block that already exists for normal group turns (`buildPrior()`,
`huddle.functions.ts:1250-1251, 3298-3301`) is explicitly gated off whenever a ceremony directive
is active (`priorInThisTurn && !ceremonyDirective`), each participant's directive says "do NOT
comment on other lanes" (`tasks/ceremonies.ts:176`), and the mid-reply `@mention` re-queue is
hard-disabled during ceremonies (`chained = ceremonyActive ? [] : parseMentions(...)`,
`huddle.functions.ts:3255`).

This is NOT an API/architecture gap — ceremony turns are already genuinely LLM-generated per agent
via the OpenAI Responses API with full tool access, grounded in a real data-driven checklist
(`buildCeremonyReport`). The fix is narrow: let participants see and briefly react to what was just
said, without losing the checklist structure or lane discipline.

## Design — relax the gate, don't rebuild
1. Change the gate at `huddle.functions.ts:1250` from `priorInThisTurn && !ceremonyDirective` to
   also include ceremony turns, passing a trimmed version of `buildPrior()`'s output (just the
   immediately-prior speaker's content, not the full transcript, to avoid runaway prompt growth
   across a 12+ agent roster).
2. Update the per-role directives in `tasks/ceremonies.ts` (`ownerDirective`/`openerDirective`/
   `closerDirective`) from "do NOT comment on other lanes" to something like: "you may briefly
   acknowledge or react to what the previous speaker said (a sentence, not a debate) before giving
   your own update — stay in your own lane's facts, don't take over theirs."
3. Barge replies get the same prior-turn context (`bargeDirective`, `ceremonies.ts:234-236`
   currently only sees the raw user text) — so a reply to a mid-ceremony message can reference
   where the ceremony currently stands instead of answering "from nowhere."
4. `parseMentions` stays disabled during ceremonies (out of scope — that's a bigger structural
   change, not needed for "acknowledge the prior speaker").

## Staged validation (the user's proposed approach — adopted as the right validation strategy,
independent of who proposed it: cheaper to prove incrementally than to flip it for all 15 agents
at once and hope)

### Stage 1 — 2 participants, prove clean barge + return-to-checklist
- Minimal ceremony: host + one lane owner only (smallest possible roster).
- Prove: (a) the owner's turn genuinely acknowledges the host's opener before giving its own
  update — real LLM-generated reaction, not a canned phrase; (b) a mid-ceremony user barge is
  answered with visible awareness of where the ceremony stands (not the pre-fix "from nowhere"
  reply); (c) after the barge is answered, the ceremony cleanly returns to the checklist — the
  next scheduled speaker's turn is not skipped, duplicated, or confused by the interjection.
- This is the smallest reproducible case — validate it fully before adding complexity.

### Stage 2 — 3 participants, real cross-agent Q&A
- Add a third agent whose directive includes a plausible reason to ask the second agent a
  question or build on their point (not scripted — let the LLM decide whether/how, driven by the
  real task data each lane actually has).
- Prove: agents can reference EACH OTHER's content (not just the user's barge), and the checklist
  still gets fully covered — realism doesn't come at the cost of dropping agenda items.

### Stage 3 (not started until 1–2 are proven) — scale to the full roster
- Only after Stage 1 and 2 are independently verified live, extend the same directive change to
  the full ceremony roster. Watch for: prompt-length growth (mitigate via "prior speaker only,
  not full transcript" from the design above), and whether realism holds up at 12+ participants
  or degrades into cross-talk noise — if the latter, that's a real finding, not a failure to hide.

## Acceptance criteria
See `.claude/actions.md` ACT-huddle-5 for the caption-reveal ACs (a separate, already-scoped piece
of this same complaint). Cross-talk relaxation ACs to be written (independent AC-writing subagent,
per this repo's `define-acceptance-criteria` discipline) once Stage 1's exact directive wording is
drafted — not written yet; this doc records the validation STRATEGY, not yet the binary criteria.

## Verification
Per `verify-work`: an independent verifier subagent drives each stage live (not the implementing
session self-reporting), using `test-agent-serverfn` for the Responses-API-level behavior and the
`gha-playwright-uat` pattern (`run-uat.mjs` + `huddle-checks.mjs`) for the real browser ceremony
flow — the same harness ACT-huddle-3 already built and iterated on this session. Do not claim any
stage "done" without a fresh, cold verifier confirming it against the live deployed app.

## Explicitly not in scope here
Re-enabling `parseMentions` during ceremonies; changing ceremony agenda/checklist content; the
barge-in latency/reliability fix (ACT-huddle-4, a separate reliability issue, not a realism one);
the 500-visibility fix (ACT-huddle-3).
