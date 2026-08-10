# Test Coverage Matrix — worker-grade conversationalist (LIVING checklist)

Guardrail so nothing we committed to testing gets dropped. Everything here is measured against the
baseline harness on the REAL system (write-through-app / read-from-server, verified cleanup). A1–A6
(the plan) are built **data-driven** where a cell proves weak — not blindly.
Status legend: ✅ done · 🔨 building · ⬜ todo · ⚠️ gap found.

Related: `docs/plan-long-memory-conversationalist.md` (research + A1–A6 + harness design).

---

## Focus dimensions — assert on EVERY scenario (the user's core asks)
- **F1 Tool usage** — the RIGHT tool actually fires (proven by the `toolUses` trace / a real DB row), not just narrated.
- **F2 Pipeline understanding** — correct grasp of the flow/state it operates in (e.g. BACKLOG→UP_NEXT→confirm→DOING; what feeds what; WIP limits).
- **F3 Honest "why I can't / did / didn't"** — narrates the REAL reason; abstains / `flag_blocker`s / surfaces the issue instead of fabricating.

---

## Capability × surface matrix
Surfaces: **1:1** (dm-<agent>), **Group** (all-members, multi-agent), **X-huddle** (group→1:1 bridge), **Long** (40+ turns, drift).

### Memory & continuity
| Capability | 1:1 | Group | X-huddle | Long | Notes |
|---|---|---|---|---|---|
| Pointer-word / anaphora ("what was in that") | ✅ | ⬜ | — | ⬜ | 1:1 strong (Finn) |
| Running counts ("how many left") | ✅ | ⬜ | — | ⬜ | |
| Status recall — single-mention fact ("is it finished / the 14th") | ✅ | ⬜ | ⬜ | ⬜ | the invalid baseline "dropped" it; real 1:1 held it |
| Topic-switch then return by pointer | ✅ | ⬜ | — | ⬜ | |
| Long-range recall (turn 1 → turn 19) | ✅ | ⬜ | — | ⬜ | |
| No-repeat / no broken-record | ✅ | ⬜ | — | ⬜ | |
| **Cross-huddle recall** (group→1:1) | — | — | ⬜ | — | needs a memory write; not in zero-write 1:1 |
| Consistency sweep (no drift at end) | ✅ | ⬜ | — | ⬜ | |
| **Novel-writer consistency over long runs** (drift = catastrophic) | ⬜ | ⬜ | — | ⬜ | 40+ turn drift, indirect reference |

### Honesty & trust
| Capability | 1:1 | Group | Long | Notes |
|---|---|---|---|---|
| Abstention (never-established → don't fabricate) | ✅ | ⬜ | ⬜ | |
| Tool-failure honesty ("why I can't") | ✅ | ⬜ | ⬜ | F3 — calendar 403 was honest in 1:1 |
| Faithfulness (claim matches real tool result) | ✅ | ⬜ | ⬜ | F1 — didn't fake-send email |
| Commitment recall ("did it go out?") honest | ✅ | ⬜ | ⬜ | |
| Reconcile under challenge (no double-down) | ⬜ | ⬜ | ⬜ | (server-fn probe only, invalidated) |
| Groundedness (no invented files/context) | ⬜ | ⬜ | ⬜ | |

### Tool usage & pipeline understanding
| Capability | Status | Notes |
|---|---|---|
| Tool-awareness (knows its tools + preconditions) | ⬜ | F1/F2 |
| Correct tool invocation for the intent | ⬜ | F1 |
| Gap-closing multi-step tool chains | ⬜ | the "plumbing" |
| Explains the pipeline / its own state | 🔨 | F2 — confirm-intent test |

### Flows (auto-work / confirm-intent / reach-out)
| Capability | Status | Notes |
|---|---|---|
| BACKLOG → groom → stage UP_NEXT (WIP-gated) | 🔨 | validated: groom required; WIP cap blocks a full agent |
| Reach-out fired (confirm ask DM) | 🔨 | qa-confirm-intent.yml |
| Process response — **immediate confirm** → confirmed → DOING | 🔨 | F1 confirm_task_intent |
| Process response — **delayed** (a couple turns later) still closes | 🔨 | retention under drift |
| Process response — **blocker** → BLOCKED + honest why | 🔨 | F1 flag_blocker + F3 |
| Assist vs produce mode proposal | ⬜ | |

### Multi-agent (Group)
| Capability | Status | Notes |
|---|---|---|
| Routing / who-answers (right agents) | ⬜ | |
| soloOnCoverage — don't drop user-requested collaborators | ⬜ | documented bug |
| Handoffs (@mention + prose) | ⬜ | |
| No cross-talk / echo dedup | ⬜ | |
| Ownership-aware handoff (capability owners) | ⬜ | |

### Voice / ceremony (separate track)
| Capability | Status | Notes |
|---|---|---|
| Barge / VAD / TTS realism | ⬜ | user-live only (synthetic = smoke test) |

---

## A1–A6 (the plan — built data-driven where the matrix shows ⚠️)
| Item | Targets | Build trigger | Status |
|---|---|---|---|
| A1 persist agent replies | memory across window | if group/X-huddle/long shows drop | ⬜ (1:1 didn't need it) |
| A2 per-huddle running ledger (story bible) | referent stack, in-play state | if long-drift/consistency weak | ⬜ |
| A3 consolidation + recency/importance rank + reflection | anti-drift | if long-drift shows contradiction | ⬜ |
| A4 claim-vs-result guard | faithfulness | if tool-chains show fabricated "I did X" | ⬜ |
| A5 capability/precondition registry (needsConsent) | tool self-awareness, "why I can't" | if tool-failure honesty generic/wrong | ⬜ |
| A6 abstention (first-class) | don't fabricate | prove across the board | ⬜ (1:1 strong) |

---

## Status log
- **2026-08-10 — 1:1 core (20-turn): ✅ DONE, strong.** Real Finn (gpt-5.6, RAG): pointer/count/status/return/long-range/abstention/tool-honesty/faithfulness/commitment/no-repeat/consistency all pass (run 31413285202). Memory-drop premise did NOT reproduce in 1:1.
- **2026-08-10 — confirm-intent flow: 🔨 building.** Setup + grooming-required + WIP-cap all validated; `qa-confirm-intent.yml` (immediate/delayed/blocker + free-WIP-agent reach-out) next.
- **Next up:** group multi-agent · cross-huddle recall · tool-chains · long-drift (40+). None dropped.
