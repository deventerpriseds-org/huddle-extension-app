# Plan: Long-Memory, Worker-Grade Conversationalist

Status: **proposed / not started.** Research + gap analysis + implementation & test plan for making
the Huddle agents behave like real coworkers over a sustained (20+ turn) conversation — resolving
pointer words ("what was in that", "how many", "is it finished") from running context, never
fabricating, honestly narrating what the backend can/did/didn't do, and not drifting or forgetting
across turns.

This doc is grounded in three code maps of the live system (memory; routing/tools/grounding;
AC-DoD/reach-out + the existing test harness) and a literature review of long-memory conversational
agents. All `file:line` refs are to `src/features/huddle/lib/` unless noted.

---

## Part 1 — What the research says a "talks-like-a-real-worker" agent needs

Six capabilities, each with its named failure mode and the primary sources.

1. **Tiered memory, not one transcript.** The field converged on episodic / semantic / procedural
   tiers (Letta/MemGPT core-archival-recall is the reference implementation). A single flat message
   list is exactly what produces "forgot it two turns later." Measured by **LoCoMo** (long
   multi-session dialogue: coreference, temporal, ephemeral updates) and **LongMemEval / -v2**
   (info-extraction, multi-session reasoning, temporal reasoning, knowledge-update, **abstention**).

2. **Consolidation/reflection is the hard part — and naive per-turn rewriting corrupts memory.**
   Generative-Agents reflection (recency × relevance × importance → higher-level insights) is the
   canonical consolidation mechanism, but "Useful Memories Become Faulty When Continuously Updated by
   LLMs" (2026) shows full rewrite-each-turn causes drift. Consolidation must be append + targeted
   supersession with provenance, not blind rewrite.

3. **A "story bible" only works if consistency is *enforced*, not merely *included*.** The
   novel-writing lesson (25-chapter tool bake-offs): putting a state doc in context does **not** stop
   contradictions — you need an active check against it. Character amnesia and context fragmentation
   are the failure modes; the fix is generate-one-unit-at-a-time with a state object that is checked,
   not just attached.

4. **Hallucination is two problems with two fixes.** *Factuality* (contradicts the world) → retrieval
   / grounding. *Faithfulness* (contradicts its own tool results / inputs) → verification + abstention
   + constrained output. Combining them beats any single one. "Fabricates instead of surfacing the
   issue" is mostly a **faithfulness + abstention** gap.

5. **Tool-awareness is a measurable self-awareness capability.** "From Knowing to Acting" (KAPRO,
   2026) separates *Knowing* (can I do this / what does it require) from *Acting*. Tool **underuse**
   (falls back on hallucinated knowledge instead of the tool) and **overuse** are both capability-
   boundary failures. Agents must know a tool's preconditions and be able to say *why* it didn't run.

6. **The multi-turn test target has an established shape.** **MT-Bench-101**'s 3-tier taxonomy —
   Perceptivity, Adaptability, Interactivity — with 13 tasks including coreference/anaphora,
   topic-shift, and self-correction, is the scaffold for the 20-turn harness.

---

## Part 2 — Gap analysis: Huddle today vs the six capabilities

| # | Capability | Huddle today | Verdict |
|---|---|---|---|
| 1 | Tiered memory | Short-term = hard **14-message** per-huddle window, no summary (`huddle.functions.ts:1889-1898`, client `HuddleView.tsx:714-715`). Long-term = pgvector `rag_chunks`, but **only the USER's message is ever embedded** (`:761`, both `writeChunk` sites `:773/:785` use `data.text`) — **agent replies are never persisted.** | **Critical gap** |
| 2 | Consolidation / anti-drift | **None.** `writeChunk` is a plain `INSERT`, no upsert/supersession (`rag/azure-pg.server.ts:412`). Ranking is **pure cosine** `ORDER BY embedding <=> $1` (`:466`) — no recency, importance, or decay. Contradictions across 20 turns both persist; nothing reconciles them. | **Critical gap** |
| 3 | Enforced consistency ("story bible") | **No dialogue-state object, no referent/"current thing" slot, no running summary.** `rag_triples` exists but is gated to durable facts only (`triples.server.ts:4-9`, "skip ephemeral chit-chat") and is **never auto-retrieved** (only the model-elected `lookup_facts` tool). Grep for `summariz|consolidat|reflect|corefer|referent|dialogue state` → zero conversational hits. | **Critical gap** |
| 4 | Hallucination control | **Prompt-only grounding + narrow code backstops.** `HOUSE_STYLE:219-221` ("tool results are ground truth… never paper over a failed tool") + `OPERATING_CONTRACT:249-254`. Backstops strip fake doc links / file-mention narration / echoes (`:384-404`). Tool errors *are* surfaced to the model as JSON (`openai-responses.server.ts:316-323`, `runToolSafely:411-436`). **But there is NO claim-vs-result reconciliation** — nothing checks "I created 3 tasks" against the tool's `created:1`. | **Partial — needs a validator** |
| 5 | Tool / capability self-awareness | Tool existence + usage hints exist and are rich (`:2509-2526`). Honesty-on-failure guidance exists but is **generic** (`HOUSE_STYLE:220`). **Precondition-specific narration is absent**: a calendar 403 returns a raw string with **no `needsConsent`** signal (`email/graph-email.server.ts:198-207`); the "grant Calendars.Read" hint lives only in a code comment. `needsConsent` is wired **only** for the OneDrive mirror, not agent-facing tools. Confirm-intent never prompts disclosure of an unconfigured capability. | **Partial — real gap** |
| 6 | Multi-turn eval | `conversational-quality.mjs` has a solid engine — threaded `sendTurn`, LLM `judge()`, `decision.reason` fallback detection, `toolUses` ground-truth capture — and probes for pointer-word, topic-switch, no-repeat, false-premise honesty, anti-hallucination. **But** it runs **8 separate 3–4-turn conversations**, never one 20-turn thread; every probe is `journey:{enabled:false}` so **no board/DB state is ever asserted**; and **the entire confirm-intent / DoD / reach-out half is untested by any harness.** | **Partial — extend, don't rebuild** |

### The single biggest root cause (memory)
> Cross-conversation memory stores **only the user's messages** — agent replies are never embedded —
> so the only place an agent's own words survive is the fixed 14-message per-huddle transcript, and
> nothing summarizes what falls out of it. In a 20-turn conversation with multiple agents replying
> per turn, "I found 3 vendors" scrolls out of the window within a few turns and is **unrecoverable**:
> auto-retrieval can't bring it back (agent text was never written), and a bare pointer query ("how
> many?", "is it done?") won't clear the cosine ≥ 0.3 floor (`:1839`) against the current message.
> **This is architecture, not a prompt bug.**

### Notable code-vs-doc discrepancy (feeds complaint #5, "unaware of tools")
The runtime `get_calendar_events` tool is **not** the Microsoft Graph read CLAUDE.md describes — it is
an alias to `dispatchPrioritize` (tasks+schedule mirror), `huddle.functions.ts:3131-3146`. The real
Graph/Outlook read is a separate explicit-only tool `get_external_calendar_events` (`:3279-3295`).
So even the documentation of what the tools do is out of sync — worth fixing while we're here.

---

## Part 3 — The plan

Design rule throughout: **extend the existing memory/turn/harness systems; do not stand up a parallel
one.** Every change below names its exact plug-in point in the current code.

### A. Architecture changes

**A1 — Persist agent replies (episodic memory). [highest leverage, smallest change]**
At the write path (`huddle.functions.ts:754-794`), in addition to the user chunk, write a **distilled
turn record** for each agent reply — not raw text (raw is noisy and drift-prone). A turn record =
`{who, gist (1–2 lines), any concrete facts/counts/decisions, tool outcomes}`. Embed the gist; store
the structured part as JSON alongside. Keep `source="huddle:<id>"` (already stored) and start
**actually using it** so within-huddle recall can be preferred. This alone fixes "forgot what it said
two turns ago."

**A2 — Per-huddle running ledger (working memory / the "story bible"). [core of the fix]**
A compact, continuously-maintained, structured object injected every turn **right next to the existing
`memoryBlock`** (`:1875` on the Lovable branch; via `volatileInstructions` at `:2525-2526` on the
OpenAI branch — a `groundingBlock` already assembles there, so this slots in cleanly). Contents:
- **Referent stack** — what "that / it / the one / those" currently point to (the antecedents), so
  pointer words resolve without the user restating.
- **In-play tasks & their live status** — so "is it finished?" is answerable.
- **Facts/counts surfaced this session** — so "how many are left?" is answerable and consistent.
- **Commitments made** ("I said I'd draft X") and **open questions / blockers**.

Persist it per-huddle on `chat.pending_turns` so it survives beyond the 14-window. Update it each turn
via **append + targeted supersession with provenance** (NOT full rewrite — per the "faulty when
continuously updated" finding). This is the story-bible; A4 makes it *enforced*, not just attached.

**A3 — Consolidation & retrieval ranking (semantic memory + anti-drift).**
- Add **supersession** to memory writes: when a new durable fact contradicts an old one, mark the old
  superseded (keep provenance) instead of leaving two live rows (`rag/azure-pg.server.ts:412` today is
  a bare INSERT). Same for `rag_triples` (confidence field exists but nothing prunes/merges).
- Add a **recency × importance** term to retrieval ranking (today pure cosine, `:466`) so the ledger
  and recent turns win ties — the generative-agents formula.
- Periodic **reflection** (every N turns / on session end): promote durable facts from the ledger into
  `rag_triples`, and auto-retrieve triples into the prompt (today they're only reachable via the
  model-elected `lookup_facts` tool — make the high-confidence ones automatic like `searchChunks` is).

**A4 — Claim-vs-result consistency guard (enforced consistency + faithfulness).**
The novel-writing lesson: attaching state isn't enough. Add a lightweight post-reply validator that
reconciles the agent's prose against ground truth **before the reply is emitted**:
- Compare success/quantity claims ("created 3", "sent", "scheduled", "done") against the turn's real
  `toolUses` trace (`recordToolUse:716-732` already records true `{ok, summary, detail}`).
- Compare status/count claims against the running ledger (A2).
- On mismatch → force a correction or **abstention** ("I couldn't confirm that — let me check")
  rather than let it ship. This generalizes the existing narrow regex backstops (`:384-404`) into a
  real faithfulness check, which the gap analysis flagged as the missing piece (#4).

**A5 — Capability & precondition registry (tool self-awareness / KAPRO "Knowing").**
- Introduce a structured, data-driven registry: each tool → `{preconditions, whatToSayWhenUnmet}`.
  Surface the relevant entries into the prompt alongside the tool schemas (`:2509-2526`).
- Wire **structured `needsConsent`** (and similar) for the agent-facing calendar/email tools by
  extending the existing OneDrive pattern into `email/graph-email.server.ts:198-207` — so a 403 comes
  back as `{ok:false, needsConsent:true, capability:"Calendars.Read"}`, and the registry tells the
  agent to say "I can't read your Outlook calendar until Calendars.Read is granted," not a raw 403.
- Add to `confirmIntentDirective` (`autowork.server.ts:125-158`) an instruction to **disclose an
  unconfigured/unavailable capability up front**, at intent time — today honesty is only reachable
  *after* work starts, via `flag_blocker` (`task-agent-tools.ts:11-29`).
- Fix the `get_calendar_events` alias/doc discrepancy so "what's on my calendar" reaches the right
  tool (or the agent correctly explains which calendar it can see).

**A6 — Abstention as a first-class instruction + behavior.**
Explicit house-style rule: if the answer isn't in memory/ledger/tools, **say so and offer to
retrieve — never fabricate.** This is a LongMemEval scored ability and directly targets "fabricates
instead of surfacing the issue." Tested in the harness (B, scenario turn on a never-established fact).

**Sequencing.** A1 (agent-reply persistence) and A2 (running ledger) are the backbone and unlock the
pointer-word / "how many" / "is it finished" behavior — do them first and measure with B. A4 (consistency
guard) and A5 (capability registry) address trust/honesty. A3 (consolidation) is the anti-drift
hardening that matters most as conversations lengthen. Each phase is independently shippable and
independently measurable by the harness.

### B. The 20-turn test harness (extend `conversational-quality.mjs`)

Keep the proven engine — threaded `sendTurn`, `judge()`, `decision.reason` fallback guard, `toolUses`
capture. Add three primitives, then script one sustained scenario.

**New primitives:**
1. **A single persistent 20+-turn `conversation` driver** that carries one thread (the concat loop is
   already turn-count-agnostic) and can **switch `huddleId`/scope mid-thread** (compose `sendTurn`
   with `verify-memory-model.mjs:90-97`'s huddle switch) to test cross-huddle recall.
2. **A ground-truth board/DB assertion helper** — run with `journey:{enabled:true}` and `Test-`
   prefixed titles (per the repo's hard naming rule), asserting real `BACKLOG→UP_NEXT→DOING→IN_REVIEW`
   transitions, `confirm_status`/`confirmed_dod` capture, counts, and reach-out firing via
   `getBoardTasks` / the `azure-pg-query.yml` workflow. This closes the biggest harness gap: the
   entire confirm-intent / DoD / reach-out half is currently unasserted. Clean up `Test-` rows after.
3. **A referent + missing-capability probe** — inject an arbitrary referent, drift, then resolve it by
   pointer word and assert the RIGHT task id was acted on (not just judge-on-text); and assert honest
   disclosure when a capability is unconfigured (the A5 case).

**The 20-turn scenario** (one thread, scored per MT-Bench-101 abilities). Illustrative arc:
1–3. Establish work: ask an agent to research something → it produces a count/list (seed a referent).
4. **Pointer word:** "what was in that?" (resolve without naming it).
5. **Running count:** "how many of those are left?"
6–7. **Topic switch** to an unrelated lane (finance/calendar) — distractors.
8. **Gap-closing / plumbing:** an intent that needs a multi-step tool chain; assert the chain ran.
9. **AC/DoD:** confirm-intent flow — assert the DoD was proposed and `confirm_task_intent` locked it.
10. **Tool-failure honesty:** trigger a precondition-unmet tool (calendar consent) — assert it says
    *why*, doesn't fabricate.
11–12. **Return to the original topic** by pointer word only ("is that first thing finished?") —
    assert referent survived the drift (this is where today's system fails).
13. **Abstention:** ask about something never established — assert it declines, doesn't invent.
14–16. **Cross-huddle:** switch to a 1:1, reference a fact stated in the group — assert recall.
17. **No-repeat:** re-ask around a covered point — assert no broken-record (reuse `probeRepeat`
    Jaccard + judge over a rolling window).
18. **Reach-out:** drive the scheduled `runScheduledAutoWork` path — assert a proactive DM fired once.
19. **Self-correction:** feed a false premise about earlier state — assert it reconciles, not doubles
    down.
20. **Consistency sweep:** ask for a summary of the whole session — assert counts/statuses match the
    ground-truth ledger + board (no drift).

**Scoring.** Per turn: (a) LLM judge verdict on the reply, (b) `decision.reason` is a real router (not
`LLM fallback` — otherwise INCONCLUSIVE), (c) `toolUses` outcomes, (d) board/DB ground truth where
applicable. A run **fails** on any blanked referent, hallucinated count/success, drift in the turn-20
sweep, or a fabricated answer where abstention was correct. Report only observed evidence (transcript
rows, tool trace, DB rows, screenshots) — never "should work."

---

## Open questions for sign-off before building
1. Scope of first slice — recommend A1 + A2 + the B harness (prove the memory backbone end-to-end)
   before A3/A4/A5.
2. Where the running ledger lives — new column on `chat.pending_turns` vs a small side table.
3. Whether the consistency guard (A4) runs inline (adds latency) or as a fast post-check with a
   correction hop only on mismatch.
4. Harness ground-truth path — journey-on `Test-` tasks vs `azure-pg-query.yml` reads (or both).
