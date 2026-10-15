# VERIFY inbound-email-watch loop 1

WHAT: independent verifier verdicts for PR #82 (claude/festive-bardeen-ao1ghj @ 65ab157).
WHY: owner never heard about Amy Corriveau's email; PR adds an inbound email watch.
SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE: bun probes in verifier scratchpad; file:line refs below.

## AC-1 Screen — CONFIRMED (core) with false negatives
Probe of screenMessage(mode=needs-reply): Amy -> keep. list-unsubscribe / list-id / Precedence bulk /
Auto-Submitted auto-replied -> bulk-header. no-reply@ -> automated-sender. inference "other" -> other-folder.
Upper-case owner address -> self.
False negatives (all dropped, all plausibly real people):
- hello@ / info@ / team@ / support@ local parts (inbound-email.ts:58) — founder at hello@startup, law firm info@.
- PREFIX bleed: regex suffix `([-_.+].*)?` drops `team.lead@`, `info.sarah@`, `news.anchor.jones@`.
- Calendar invite with no "?" -> no-ask. "Send me the deck by Friday." -> no-ask. "I need you to sign..." -> no-ask.
False positive: a reply whose only "?" is in quoted history ("> Can you send it?") -> keep.

## AC-2 Once-per-email — REFUTED (production path)
enqueueTurn (turns.server.ts:202-209) is ON CONFLICT (id) DO NOTHING -> repeat id returns false. Correct.
BUT scheduler fireJob passes `runId: slotId` (scheduler.server.ts:176) where slotId = `${job.id}-${local hour}`
(scheduler.server.ts:270-280), and inboundEmailTurnId appends runId (inbound-email.ts:122-123).
Repro: same message id, slots ...T09 vs ...T10 -> `inbound-email-1d6aa4e067386e77-...T09` vs `...-T10`, equal=false.
With a 12h lookback and hourly 7-22 cadence, ONE email is re-announced (with a phone push) every hour for up to 12 hours.
Fix: in runInboundEmailWatch use `inboundEmailTurnId(m.id)` with no runId for scheduled fires (e.g. ignore runId unless
an explicit `force`/manual flag), or drop runId from the id entirely.
