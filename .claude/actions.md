# Action Tracker — huddle-extension-app
Last updated: 2026-07-24

> Enforced by `.claude/settings.json` (SessionStart surfaces this; the Stop gate blocks
> claiming any item "done" without ACs + the verifier subagent / observed evidence).

## Open

_(ACT-1 moved to Closed 2026-07-24 — see below.)_

### ACT-2: Enforce mandatory skills (AC / verify / track / remember / verifier)
**Status:** done (pending activation) — hard gate (a–d) in huddle `.claude/settings.json` + eds-skills
`setup.sh` (merged PRs #7/#8/#9). Activates next session/env build. **Evidence:** merge-logic validated
(idempotent, non-clobbering); condition (c) now requires memory.md on every completion.

### ACT-3: create_huddle_task cross-turn dedup (board-clutter prevention)
**Status:** open — deployed (PR #5) but **UNVERIFIED** (no verifier run yet).

### ACT-4 (NEW): Auto backlog grooming + assignment (agile leader proactively runs it)
**Asked for:** "auto backlog grooming and assigning." The scrum master should proactively groom/triage
and assign the backlog on a cadence (not only when asked), and surface the result.
**Status:** open — needs AC definition + design (cadence/trigger, who fires it, how it surfaces).

### ACT-5 (NEW): Agents self-start doable tasks, else classify blocked
**Asked for:** "agents attempting to get started on tasks that they have the ability to do (e.g. Tavily)
… or classify them as blocked." An assigned agent should begin work it can actually do with its tools
(e.g. Cam/research via Tavily) and mark tasks it cannot do as blocked with the reason.
**Status:** open — needs AC definition + design (capability→task matching, progress writeback, blocked tagging).

### ACT-6 (NEW): Agile ceremonies actually fire + standup summaries delivered
**Asked for:** "I haven't received standup summaries or any of the things previously discussed to ensure
the agile leaders are aware of the ceremonies that need to take place and carrying them out."
Scrum master / team lead should track which ceremonies are due (standup, review, retro), run them, and
deliver the summary to the user.
**Status:** open — needs AC definition + design; ceremony infra exists (ceremonies.ts, run-ceremony) —
verify why summaries aren't reaching the user.

## Closed

### ACT-1: 1:1 ownership hand-off — natural defer + proactive owner follow-up
**Closed 2026-07-24.** In a 1:1, when the ask belongs to another agent (exclusive tool OR domain/theme),
the addressed agent defers by NAME (no @ — group-only), and the runtime brings the owner in via a
deterministic back-channel: the owner posts a REAL durable turn in their own DM (`dm-<owner>`) — which
rides the existing send_push away-notification — acknowledging who passed it and asking to confirm first.
**Acceptance criteria (all PASS — independent verifier over live turns on the deployed SWA):**
- AC-1: 1:1 grooming ask → Iris defers to Terry by name, no grooming performed. — **PASS**.
- AC-2: 1:1 budget ask → Iris defers to Finn by name. — **PASS**.
- AC-3: In-lane ask → Finn answers self, no handoff. — **PASS**.
- AC-4: OWNER proactively messages in their OWN DM, names who passed it + context, natural
  "passed/mentioned by X" phrasing, asks to confirm before acting. Observed in dm-terry-locke +
  dm-finn-reid. — **PASS**.
- AC-5: Defer reads naturally, NO @handle in the 1:1. — **PASS**.
- AC-6 (regression guard): non-owner leaves NO meta-task card even if the tool is attempted
  (`capabilityOwnerFor(title)` code guard). RE-TEST: attempted, `tasks:[]`. — **PASS**.
**Evidence:** commits 2b2fef2 (back-channel + durable follow-up + no-@) + 658144b (meta-task guard);
deployed via deploy-swa.yml (runs 30132395350 + follow-on, both success); verifier verdict all-PASS.
**Residual (non-blocking):** model still *attempts* the blocked meta-task on one wording (guard catches
it); away-push reaching the phone is by-design (proven send_push path) but not separately re-proven here.
**Branch:** `fix-1to1-capability-defer` (PR open).

### ACT-0: Remove test-task clutter from the production board
**Closed 2026-07-24.** Evidence: journey-voice `cleanup-test-tasks` run — spam 176/176 + dups deleted;
523 → 247 tasks. Workflow removed after use (PR #19). **Verification:** PASS (run log).

## Decisions & scope changes
- [2026-07-24] Ownership = tools AND domains/themes; systematic, no per-agent hardcodes.
- [2026-07-24] Enforcement = Both (huddle + eds-skills); Stop gate = hard block; memory required every completion.
- [2026-07-24] Standing harness `huddle.mjs` (auto fn-id resolve).
- [2026-07-24] **@ is group-only.** 1:1 hand-off uses a back-channel (deterministic ownership), not @-parsing.
- [2026-07-24] **Present a potential fix for logic-check BEFORE executing** (standing process rule).

## Known issues
- Day-plan TIMEZONE wrong (Iris scheduled off-tz). Diagnosed, unfixed.
- create_huddle_task dedup / quota surfacing / file-search fix: deployed, UNVERIFIED.
