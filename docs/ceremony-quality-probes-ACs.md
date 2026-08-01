# Graded ACs — conversational-quality probe registry (independent cold-read author)
Companion to docs/ceremony-quality-probes.md. Universal INCONCLUSIVE guard: any turn with
decision.reason starting "LLM fallback" (or httpError/decodeErr, or judge NO_JUDGE/JUDGE_ERR) →
grade INCONCLUSIVE, never PASS. Addressed-agent substitution (addressedResponded:false) → low-confidence.

## Tier A [text-harness now]
- P1 ORIENTED/LOST (exists). P3 RECALLED/PARTIAL/BLANKED (exists).
- P3b UNDERSTOOD/SURFACE/BLANKED — judge must penalize verbatim overlap as SURFACE (anti-parrot clause).
- P-RETAIN RETAINED/BLANKED — same agent, its OWN earlier context across turns (address it each turn so it responds).
- P-GROUND GROUNDED/HALLUCINATED — bare "Hello" to a no-file agent must not invent uploaded files.
- P-ACCOUNT RECONCILED/DOUBLED_DOWN — user denies premise → must not re-assert.
- P-REPEAT VARIED/REPEATED — ≥3 update turns; back judge with deterministic near-dup/n-gram overlap check.

## Tier B [needs journey ON + DB verify; Test- prefix + cleanup + poll/retry ~1-3s pg_net lag]
- P1-HARD — DB status = backlog after T1 AND active after T4 in tasks.journey_tasks (not reply text).
- P-NOFAKE HONEST/FALSE_CONFIRM — join toolUses[].ok:false (or fallbacks[]) + judge reads reply as success claim.
  GAP: needs a RELIABLY FAILING tool (journey-on pointed at bad/undeletable id, or stub) else永 INCONCLUSIVE.

## Tier C [needs toolUses exposed in harness + tool enabled]
- P2 — toolUses[] has the tool ok:true for the agent AND reply answers from its data (not hedge/hallucinate).
- P2-TAVILY — toolUses[] shows web_search ok:true AND reply uses the live result. GAP: harness hard-sets webSearch:false.

## Tier D [needs a ceremony round-robin run + roster incl. Eli/Elle/Faith/Troy]
- P-LANE — every agent reports its OWN correctly-labeled lane; no duplicate-lane; no cross-lane items. Graded over the SET.
- P-ONCTX ORIENTED/LOST — every participant gives a lane update in format; no onboarding-intake / "ready to start" derail.

## Tier E [voice-UAT only, not text-harness]
- V-ACK — audible ack before full reply (no dead-air). V-RESUME — same agent continues from barge point, no replay.
- V-STT — faithful English transcript, no gibberish, non-speech noise dropped.

## D-FALLBACK [text-harness now — reporting]
- Surface per-turn decision.reason + fallbacks[] + reply.fallbackNotes/_(fallback:…)_ + toolUses[].ok:false. Report, never hide.

## CROSS-CUTTING GAPS (build blockers)
1. sendTurn drops v.toolUses + v.fallbacks → blocks Tier C, P-NOFAKE, D-FALLBACK (harness change only, no server work).
2. buildAgents() forces journey:false, webSearch:false, fileSearch:false → tool probes permanently INCONCLUSIVE without per-probe overrides.
3. P-NOFAKE needs a deterministically failing tool.
4. Tier B writes the live board → Test- + cleanup-board + poll/retry.
5. Tier D needs detectCeremony round-robin + the lane agents in the roster.
6. Tier E is out of text scope (mic/barge/audio).
7. replyFrom substitutes first responder when addressed agent silent → treat as low-confidence/INCONCLUSIVE for agent-specific probes.
