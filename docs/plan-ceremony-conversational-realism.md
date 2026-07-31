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

---

## HANDOFF SUMMARY (2026-07-31) — mid-utterance interrupt + real captions

**Status when this was written: code-complete design, ZERO implementation started.** A first
implementation attempt (proportional-estimate caption reveal + "interrupt = conclude the turn,
skip to next speaker") was written, then explicitly discarded (`git checkout --`) after the user
corrected the design twice. Nothing from that attempt survives in the codebase. Pick this up from
the design below, not from any half-built code — there isn't any.

### The problem, in the user's own words
- Screenshot proof (dated live, ~5 min old when shown) confirms the ceremony DOES start and run —
  so the earlier "500 errors / hang" diagnosis (ACT-huddle-3/4, both fixed+verified, see above in
  this repo's actions.md) is real but is NOT the same complaint as this one.
- The actual complaint: "it's just scripted with recordings being read without me being able to
  barge in, and if they ever notice after a large delay that I sent a message they begin answering
  overtop of the script being run. It's not a natural group conversation at all."
- When I proposed "the ceremony continues with the next item still on its list" (i.e., treat an
  interrupted turn as concluded, move to the next speaker), the user corrected this explicitly:
  **"I said the agent continues from where they were before interrupted and on to the next item on
  the list."** — true resume-in-place of the SAME turn, not skip-ahead.
- The user explicitly said mid-utterance interruption (stop wherever the agent is, handle whatever
  is thrown at it, THEN continue) has been asked for multiple times and was not being delivered:
  **"I want mid utterance... I don't know how many times to say that with you acknowledging but
  doing something different."**
- The user rejected a prior "verified" claim for a related fix (ACT-huddle-4) because the
  verification was API/server-function-level only, never a real browser, never a screenshot:
  **"I have no proof verifier did vs say."** Any claim of "done" on this feature needs real
  Playwright screenshots (actual saved PNG files), not prose describing what a test supposedly
  observed.
- The user asked a sharp technical question that changed the design for the better: "or the text
  is a true transcript of what they say rather than pre cursor... that way stopping doesn't matter
  because it is slightly trailing. which is more feasible?" — see Root cause #3 below.

### Root causes found (all confirmed by reading the actual code, not inferred)
1. **Text appears before audio plays, not synced to it.** In `MeetingBar.tsx`'s `runCeremony()` →
   `emit()`, `addMeetingTurns([{agentId, text: r.text}])` (full text) runs BEFORE
   `speakCeremonyTurn()` even starts synthesizing/playing audio. This is why it "looks like reading
   a recording" — the full sentence is already on screen before the voice starts.
2. **Barges are architecturally only handled BETWEEN speakers, never mid-utterance.** The ceremony
   driver's `handleBarges()` (server-side, `huddle.functions.ts`) runs "before each scheduled
   speaker... never mid-speaker" by explicit design comment. There is currently no mechanism at all
   for interrupting an agent while it's actively speaking — this is the literal gap behind "I want
   mid utterance."
3. **TTS currently returns audio only, no timing data — so any caption reveal today can only be an
   estimate, not a real transcript.** `elevenlabs.server.ts`'s `textToSpeech()` calls ElevenLabs'
   plain `/v1/text-to-speech/{voice_id}` endpoint. ElevenLabs also offers
   `/v1/text-to-speech/{voice_id}/with-timestamps`, which returns the SAME audio plus a real
   per-character `alignment` object (`characters`, `character_start_times_seconds`,
   `character_end_times_seconds`). Switching to this endpoint lets the caption trail the actual
   audio by a small deliberate lag (~100-150ms), so pausing/interrupting always shows real text
   that's genuinely already been spoken — never an approximation, never ahead of the audio. This
   directly answers the user's "which is more feasible" question: the real-alignment approach, and
   it's feasible today (ElevenLabs already supports it; the integration just isn't using it yet).
4. **A non-obvious complexity found while writing ACs (independent subagent, cold-read of the
   code): the server races ahead of real-time client playback.** The ceremony driver generates each
   speaker's full turn text via an LLM call (fast, a few seconds) while the CLIENT plays that turn's
   TTS audio aloud (slow, can be 10-20+ seconds of natural speech). So by the time a user's barge is
   claimed and answered server-side, the server may have ALREADY generated multiple SUBSEQUENT
   speakers' replies that are sitting in the turn's `replies` array ahead of wherever the client's
   audio playback currently is. This means "resume after interrupt" is not just "replay one barge
   reply then continue" — it must correctly play through however many already-generated-but-not-yet
   -played replies accumulated during the pause, in their original order, with none skipped and
   none played twice (including the barge reply itself, which also lands in that same array).

### The corrected design (not yet built)
1. Switch `elevenlabs.server.ts`/`tts.functions.ts` to the `/with-timestamps` endpoint; thread the
   real alignment data through `SpeakResult` to the client. Graceful fallback to full-text-immediate
   if alignment is missing/malformed (never crash, never hang).
2. Client-side (`MeetingBar.tsx`): reveal transcript text progressively per real alignment
   timestamps (not a linear estimate), trailing playback by ~100-150ms.
3. On a mid-ceremony user message while a turn is actively playing: freeze BOTH the audio (`pause()`
   at its current `currentTime`, not reset to 0) AND the caption reveal (frozen exactly at whatever
   character was mid-reveal — including mid-word, no snapping to a word boundary) at the same
   instant. This is the "stopped mid-sentence" moment that needs to be screenshot-provable.
4. Answer the barge (existing reliable `bargeCeremony` + `kickNextChunk`, already fixed in
   ACT-huddle-4).
5. Resume: the SAME interrupted turn continues from its exact frozen point — same audio element/
   source resumed via `el.play()` from its paused `currentTime`, caption reveal continuing forward
   from the frozen character offset. Not regenerated, not restarted, not skipped.
6. After that turn truly finishes, play through any OTHER replies that had already accumulated in
   the array during the pause (root cause #4) — each exactly once, in original order — before
   reaching the genuinely next NEW scheduled speaker.
7. No duplicate playback anywhere: the barge reply itself, and any of the "raced ahead" replies from
   point 6, must each be spoken/shown exactly once total, even though the normal sequential
   emit()-loop cursor and any out-of-band playback path both touch the same underlying `replies`
   array.

### Acceptance criteria (already written — 30 ACs, independent subagent, cold-read of the code)
Full checklist grouped under: Alignment data (AC-1–5) / Caption reveal (AC-6–9) / Interrupt
(AC-10–13) / Resume (AC-14–17) / No-duplicate (AC-18–20, including the root-cause-#4 scenario as
its own explicit AC-18) / Ordering (AC-21–23) / Regression guards (AC-24–27, including the shared
`synthesizeSpeech` consumer `useGroupVoice.ts` used by 1:1 voice calls — do not regress that path)
/ Verification approach (AC-28–30, real Playwright screenshots only, live-deployed-app confirmation
required before "done"). These 30 ACs are the actual, current, sign-off-ready checklist — reuse
them rather than re-deriving; ask the user for explicit go-ahead before implementing given the
scope (a shared-function change touching a second consumer, plus a real API endpoint switch).

### What's already fixed and verified (separate, don't re-do)
- **ACT-huddle-3** (commit `f8d07bb`): `enqueueHuddleTurn`/`getTurnUpdates` now return real error
  messages instead of opaque 500s. Verified live by an independent verifier (triggered a real
  Postgres error, confirmed the structured response).
- **ACT-huddle-4** (commit `94cfc02`): `kickNextChunk`'s self-kick now retries (3x, backoff) and
  logs failures/misconfig instead of silently falling through to the 60s cron backstop. Verified
  live via `ceremony-barge-test.mjs` against production (full 12-reply ceremony, barge answered
  between speakers, idempotent, no drops) — but note this verification was later correctly
  challenged by the user as insufficient (server-function-level, no screenshots) for the BEHAVIORAL
  claim of "feels like a real interruption" — it only proves the barge-answer plumbing is reliable,
  not that the experience matches what the user is asking for here.
