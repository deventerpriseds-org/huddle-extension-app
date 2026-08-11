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
| BACKLOG → groom → stage UP_NEXT (WIP-gated) | ✅ | PROVEN on real dev@ board: seed→groom→UP_NEXT+priority_rank+engagement(awaiting) |
| Reach-out fired (confirm ask DM) | ✅ | PROVEN: backdate confirm_ask_at→autowork confirmDue→`asked`+real DM in dm-flex-grimes (confirmAsked:1, 0 real tasks touched) |
| Process response — **immediate confirm** → confirmed → (approach gate) | ✅ | PROVEN: Playwright reply→confirm_task_intent→confirm_status='confirmed'+confirmed_dod; propose_approach×3→escalated; task held UP_NEXT (approach≠approved) — gate correct |
| Process response — **delayed** (a couple turns later) still closes | ✅ | PROVEN: confirm_status held `asked` across 2 drift turns (1 engagement row, no dup DM), then `confirmed` on late yes; journey DoD non-null (re-confirms fix). Run 31433304273/31433543513/31433811416. |
| Process response — **blocker** → BLOCKED + honest why | ✅ | **FIXED + verified live.** Cause: agents pass a NON-uuid task_id to flag_blocker (title/slug — seen live). Old order wrote reason row first then journey `update_task{BLOCKED}` 0-row-failed → orphan row + phantom "blocked". FIX (3 parts, deployed): journey `updateTask` .maybeSingle()+"No task matched id" (PR #25); huddle flag_blocker BOTH paths journey-BLOCKED-first + gate reason on it + ok:false honest-fail; confirm-reply directive hands exact uuid (huddle 83c0097). **Verifier: PASS** — positive block (finn→journey+mirror BLOCKED+row+honest ack), AND honest-failure on a bad id (ok:false, "No task matched id", NO orphan, agent says "couldn't flag, confirm the id"). Core false-positive bug gone. |
| Reach-out to unblock (surfaceBlocked DM) | ✅ | **PASS.** run-autowork `blocked:1` → `autowork-blocked-…` turn in dm-terry-locke surfacing the blocked task asking the user to weigh in. |
| User unblock — **delayed** | ✅ | **WORKS.** After an unrelated turn, unblock reply in the OWNER's DM → agent `update_task` → journey BLOCKED→READY, mirror READY, blocker row cleared (clearTaskBlocker on non-BLOCKED sync). |
| User unblock — **immediate** | ✅ | **FIXED + verified live (4/4), huddle d34088a.** Both findings addressed, Terry-surfacing unchanged: (1) `getPendingConfirmForAgent` excludes tasks with a `task_blockers` row → confirm-hijack (the false "unblocked") killed. (2) new block B: OWNER flips its own blocked task via update_task and only claims unblocked if it succeeds; a clearance reply to a NON-owner (Terry) routes to each owner via `routeUnblockToOwner` (durable turn in dm-<owner>, exact task_id in text since internal, task-scoped id); 1 blocked→route, "all"→route each, ambiguous→ask which. Adds `getBlockedTasks`+`looksLikeUnblock`. **Verifier PASS 4/4** (task e23ac9b6): confirm-hijack dead (no confirm_task_intent on a blocked task despite `asked`); owner flips (BLOCKED→UP_NEXT, blocker cleared, claim DB-backed); Terry-reply → `unblock-<id>` durable turn → liam flips while Terry defers ("assigned to Liam"); no reply claimed unblocked while BLOCKED; cleanup 0. |
| ⚠ Concurrent-session board contamination | ⚠️ | NOTE: another session was running this exact blocker flow on dev@ mid-verify (Test task 1/2, asked tasks on multiple agents). Two sessions mutating one board — coordinate / use distinct idle agents. |
| ⚠ Pre-existing orphan `task_blockers` rows (user's board) | ⚠️ | 3 orphan rows from past agent errors: task_id='Update on backlog grooming', 'task-msan556s-z56sy', and 'f69938b8…'. Present cleanup candidates to the user (cleanup-board), do NOT auto-delete. |
| ⚠ Arming coverage on a saturated board | ⚠️ | FINDING: the cadence autowork pass arms the confirm reach-out ONLY for each agent's top-of-UP_NEXT (`[0]`) item; a lower-ranked staged task can sit with no confirm ask until it reaches `[0]`. Only grooming's promoteOnly arms the whole plate. |
| Assist vs produce mode proposal | ⬜ | (produce mode observed in the confirm-ask DoD) |
| confirm_task_intent journey DoD write | ✅ | **FIXED + verified live.** journey `execute-tool` `updateTask`/`batchUpdateTasks` now map `definition_of_done` (+ empty-update guard). Root cause: field was never mapped → empty update → coerce error. Independent verifier (8/8) confirmed journey `public.tasks.definition_of_done` NON-NULL after a confirm; toolUse now "DoD confirmed". journey-voice PR #24 merged→main, deployed. |

### Multi-agent (Group)
| Capability | Status | Notes |
|---|---|---|
| Routing / who-answers (right agents) | ⬜ | needs a live group baseline |
| soloOnCoverage — don't drop user-requested collaborators | ✅ | **ALREADY FIXED (CLAUDE.md note was stale).** Behavior changed 2026-07-20 (`5b11bba` "multi-lane router suppression #1"): solo drops adjacency only, keeps `explicitlyRequested`; refactored into `assembleWinners` 2026-07-22 (`20564e3`). Default ON (agent-backends.ts:59). Offline `test:router` 9/9. **DEPRIORITIZED future tuning (user, not urgent):** today "necessary"=user-named; the router's OWN judgment that a supporting agent adds value (nominated `supporting`, not `explicitlyRequested`) is overridden under solo. Consider letting router-necessity count (keep high-value adds, still drop low-value adjacency). Revisit when other items done. |
| Handoffs (@mention + prose) | 🔨 | @mention handoffs pass offline (mention turns 5/5); prose handoff still relies on parseMentions/@handle |
| No cross-talk / echo dedup | ⬜ | |
| Ownership-aware handoff (capability owners) | ⬜ | (capability-ownership-test.mjs exists) |
| Agent resolves NAMED task → id before id-taking tools | ✅ | **FIXED (huddle 4198a42).** taskToolInstructions now: get_tasks{query} title-lookup first, exact id verbatim, never title-as-id, never "can't find" without trying. Closes the flag_blocker non-uuid-id class at source. |

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
- **2026-08-10 — confirm-intent: reach-out + immediate-confirm ✅ PROVEN end-to-end on the real dev@ board.**
  Full chain, all ground-truthed via azure-pg-query + tool traces:
  seed BACKLOG (finn→grooming reassigned to flex-grimes) → run-grooming (staged UP_NEXT, armed confirm_ask_at) →
  backdate confirm_ask_at → run-autowork (`confirmAsked:1, promoted:0` — zero real tasks touched) → confirm_status
  `awaiting→asked` + real DoD-proposing DM in dm-flex-grimes → Playwright reply "Yes, that works. Go ahead."
  (`qa-confirm-reply.yml`, run 31426689932) → `confirm_task_intent` fired → confirm_status='confirmed'+confirmed_dod
  + `propose_approach`×3 → approach gate escalated → task correctly HELD at UP_NEXT (approach≠approved). Agent's ack
  honest (judge=HONEST, no false completion). **Cleanup verified 0/0/0/0/0.**
  - **Identity gotcha (important):** the pipeline runs under **dev@enterpriseds.io** (user a3378f93, profile full_name
    "Von Ellis", board 88616650) — von.ellis@enterpriseds.io (4132de9e) has NO profiles row so its tasks sync with
    NULL user_email and are invisible to grooming/autowork. Seed/groom/autowork under **dev@**.
  - **⚠ BUG found:** `confirm_task_intent`'s journey write of the confirmed DoD fails ("Cannot coerce the result to a
    single JSON object") → journey `public.tasks.definition_of_done` stays NULL. Huddle engagement table has it; canonical
    source doesn't. Intent→plumbing gap to FIX.
- **Next up (confirm-intent):** delayed-confirm (filler turns then confirm) · blocker (reply w/ real blocker → flag_blocker → BLOCKED). Then the DoD-mirror bug fix.
- **Then the matrix:** group multi-agent · cross-huddle recall · tool-chains · long-drift (40+). None dropped.
