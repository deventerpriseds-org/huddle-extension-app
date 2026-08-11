# A1–A3 build scope — long-memory for GROUP + CROSS-HUDDLE (sign-off doc)

**Status:** proposed, awaiting sign-off. **Rule:** extend the existing memory systems; do NOT stand up a
parallel one. Each item names its exact plug-in point.

## Why (evidence, this session)
- **1:1 already holds** (run 31458699060, 18/18 incl. all supersession) — `memoryMode:"conversation"`
  gives each 1:1 an OpenAI Conversations object (full thread, incl. agent replies). **No change needed.**
- **CROSS-HUDDLE fails** (run 31463140639, valid 1:1-scope probes with empty history → RAG-only):
  - vendors → **STALE**: returned dropped "Cobalt", missed added "Delta" → **A3** (no supersession).
  - budget → **missed**: "I don't have that in context" → **A1/retrieval** (agent-derived state absent).
  - date → **FABRICATED**: invented "November 3rd" + a name never given → **A6** (surfaced; see note).
- **GROUP** = reconstruction (~14-msg window + shared RAG), no conversation object → same gaps as
  cross-huddle once a fact leaves the window. (Faithful group baseline re-running now via the durable path.)

## The build (A1–A3)

### A1 — Persist a distilled agent-reply record (episodic). *Highest leverage, smallest change.*
- **Plug-in:** the RAG write path, `huddle.functions.ts:848–917` (today writes ONLY `data.text`, the
  user message). After replies are produced, also write, per agent reply, a **distilled** chunk:
  `{who, gist (1–2 lines), concrete facts/counts/decisions, tool outcomes}` — embed the gist, keep the
  structured part as JSON. Keep `source="huddle:<id>"`.
- **Extend, not new:** reuses `azurePgStore.writeChunk` + the existing global/agent scoping; no new table.
- **Fixes:** group-stated agent answers survive the window and become retrievable cross-huddle (the
  "budget I don't have in context" miss).

### A2 — Per-huddle running ledger (working memory / "story bible").
- **Plug-in:** assembled + injected next to `memoryBlock` (`huddle.functions.ts:2009–2026`, injected at
  `:2676` `volatileInstructions = scene + memoryBlock + groundingBlock`). A compact, continuously-updated
  structured object: **referent stack** (what "that/it/those" point to), **in-play items + live status**,
  **facts/counts surfaced this session**, **commitments/open questions**.
- **Persist:** on `chat.pending_turns` per huddle (survives the 14-window). Update by **append + targeted
  supersession with provenance** (never full rewrite).
- **Extend, not new:** rides the existing durable-turn store + the existing prompt-injection point.
- **Fixes:** "how many now / which was dropped / is it finished" answerable without reconstructing from a
  window that no longer holds it.

### A3 — Supersession + recency ranking (semantic memory / anti-drift). *Directly fixes the STALE hit.*
- **Plug-in (write):** `rag/azure-pg.server.ts` `writeChunk`/`writeTriples` are bare INSERTs today. When a
  new durable fact contradicts an older one (budget $8k→$10k, drop Cobalt), mark the old row **superseded**
  (keep provenance) instead of leaving two live rows.
- **Plug-in (read):** `searchChunks` (`azure-pg.server.ts`) orders by **pure cosine** today. Add a
  **recency × importance** term so the latest/ledger wins ties; exclude superseded rows. (Auto-retrieval
  floor `MEMORY_MIN_SCORE=0.3` at `:1990` stays.)
- **Extend, not new:** same tables/columns + one status flag; no parallel store.
- **Fixes:** "current budget / vendors now" returns the LATEST value cross-huddle, not the stale chunk.

## Surfaced but OUT of A1–A3 scope (flagging, not building unless you say so)
- **A6 abstention/faithfulness** — the fabricated "November 3rd / Priya". A1–A3 reduce this (the real
  value becomes retrievable), but the *don't-fabricate-when-not-found* behavior is a separate guard
  (house-style rule + a claim-vs-memory check). Recommend as a fast follow after A1–A3.

## Proof plan (before/after, same harness)
- **Before:** the group + cross-huddle baseline (`qa-longdrift-group.mjs`) — cross-huddle 0/3 today;
  group number from the in-flight durable-path run.
- **After A1–A3:** re-run the SAME harness. Success = cross-huddle supersession returns LATEST (not STALE),
  budget recalled, group recall survives the window. Each phase (A1, A2, A3) independently shippable +
  independently measurable by the harness.

## Risk / cost
- All changes are **additive** to the RAG store + prompt-injection point; 1:1 conversation-mode untouched.
- Extra per-turn write (A1) + a small ledger update (A2) — fire-and-forget like the existing RAG write.
- Deploys via push to `main` (auto-deploy). Reversible (git revert); memory writes are non-destructive.
