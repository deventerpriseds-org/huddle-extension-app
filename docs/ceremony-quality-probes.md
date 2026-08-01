# Ceremony / conversational QUALITY probes — canonical registry

**Purpose.** The single source of truth for every conversational-quality probe we run against the live
Huddle agents. This is graded QUALITY (oriented/lost, grounded/hallucinated, retained/blanked), NOT
functional 1s-and-0s ("did it respond"). We re-run this over and over until each probe passes; a probe
only leaves this list when the underlying failure is corrected and confirmed live.

**Reusable by construction.** Text-graded probes live in `e2e/conversational-quality.mjs` (driven via
the deployed `sendHuddleMessage` server fn, threaded history, LLM judge, router-fallback→INCONCLUSIVE
guard, `===STRUCTURED_RESULTS_JSON===` block) and run through `.github/workflows/conversational-quality.yml`.
Each probe is a self-contained function returning `{probe, grade, why, inconclusive, ...evidence,
decision_reasons}` so the run reports every probe's grade in one pass. Journey-on / ceremony-run /
voice-layer probes are noted with their harness so they're not silently skipped.

Every probe cites the REAL live-transcript failure that motivated it (ground truth, not hypothetical).

---

## Tier A — text-graded (group-turn harness, journey OFF) — build/extend `conversational-quality.mjs`

| id | Probe | Real failure (evidence) | Grade labels |
|----|-------|-------------------------|--------------|
| **P1** | Follow-through + state memory (EXISTS) | — (orientation across a reversal) | ORIENTED / LOST |
| **P3** | Cross-agent cross-turn recall (EXISTS) | — | RECALLED / PARTIAL / BLANKED |
| **P3b** | Deeper-than-surface recall (harden P3) | recall must test COMPREHENSION, not verbatim parroting (user note) | UNDERSTOOD / SURFACE / BLANKED |
| **P-RETAIN** | Within-call context retention (same agent, its OWN earlier context) | Iris discussed "Call the dentist" 5× in one call, then "I couldn't locate the previous context about the dentist task" (run ba9a6791 seq 32) | RETAINED / BLANKED |
| **P-GROUND** | Groundedness / anti-hallucination | Flex to a bare "Hello" → "What would you like to do with the uploaded files?" (Flex has no file store) | GROUNDED / HALLUCINATED |
| **P-ACCOUNT** | Accountability under challenge / no double-down | user "I don't know what uploaded files you speak of" → Flex insisted "You've uploaded files…" ×4 | RECONCILED / DOUBLED_DOWN |
| **P-REPEAT** | No broken-record / verbatim repetition | Iris "Everything's moving smoothly here!" ×3 (ba9a6791 seq 19/27/28) | VARIED / REPEATED |

## Tier B — journey ON (real DB write + verify in `tasks.journey_tasks`)

| id | Probe | Real failure (evidence) | Grade / hard check |
|----|-------|-------------------------|--------------------|
| **P1-HARD** | #1 hardened — real status flip TWICE | probe1 grades orientation from TEXT only; user demands the DB proof | status actually flipped → distract → flipped back, verified in DB (Test- task) |
| **P-NOFAKE** | No false confirmation on tool failure | Iris "I'll handle that adjustment now" but the journey delete FAILED (`_(fallback: journey tool failed)_`, ba9a6791 seq 14–17) — claimed success it didn't deliver | HONEST (reports failure) / FALSE_CONFIRM |

## Tier C — tool-use (needs the response to expose tool-use events + webSearch on)

| id | Probe | Real failure (evidence) | Grade / hard check |
|----|-------|-------------------------|--------------------|
| **P2** | Tool-use when access exists | must invoke a tool it HAS (prioritize/calendar/file_search) + answer from real data, not hedge/hallucinate | tool INVOKED (observed in toolUses) + answered from it |
| **P2-TAVILY** | Real-time info via Tavily / web search | Flex refused "prove this from the web" / "prove from body beast not general knowledge" (dm-flex 23:07) | web_search FIRED + answered from live result, not stale guess |

## Tier D — ceremony round-robin run (not a plain group turn)

| id | Probe | Real failure (evidence) | Grade / check |
|----|-------|-------------------------|---------------|
| **P-LANE** | Own-lane correctness | Tess, Iris AND Eli all claimed the "Ventures" lane; Iris (team lead) reported gym/$40k/Amex as "Ventures" (standup 11:30 seq 3/5/6) | each agent reports its OWN correctly-labeled lane; NO duplicate-lane claims |
| **P-ONCTX** | Ceremony on-context adherence | Elle answered a stand-up with onboarding intake ("how many hours can you study per day?"); Faith "I'm ready to start" at turn 9 (standup 11:30 seq 7/9) | every participant gives a lane update in format, no derail/restart |

## Tier E — voice-layer (NOT text-harness testable — needs voice/UAT, flagged not skipped)

| id | Item | Real failure (evidence) | Note |
|----|------|-------------------------|------|
| **V-ACK** | Acknowledgment / no dead-air | user had to say "Iris are you there?" (ba9a6791 seq 12) | ack-layer FEATURE (filler now / streamed later, per user) — verify by voice/UAT |
| **V-RESUME** | Resume-in-place ("return to where you were") | after a barge Iris replayed already-spoken scripted lines instead of continuing | FIX + verify: same agent continues from its point, no replay |
| **V-STT** | STT accuracy + noise rejection | English → gibberish ("Ласкаво", "نصбته", "Gerhard"); background noise (screenshot click) transcribed as text | voice-input layer; verify by voice/UAT, not text harness |

## Diagnostic signals (KEEP visible while debugging — do NOT hide)

| id | Item | Note |
|----|------|------|
| **D-FALLBACK** | Surface tool failures / `_(fallback: …)` markers | Per the user: do NOT compress/hide these while debugging — they are signal. The harness should REPORT when a fallback/tool-failure fired (a quality signal), not require removing it. |

---

## Run cadence
Re-run Tier A every change via `conversational-quality.yml`; Tiers B/C when the corresponding fix lands
(journey-on / ceremony harness); Tier E via voice UAT. A probe stays here (graded, tracked) until its
underlying failure is corrected AND confirmed live — then it becomes a standing regression guard, not
removed.
