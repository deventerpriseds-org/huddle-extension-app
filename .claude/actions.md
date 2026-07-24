# Action Tracker — huddle-extension-app
Last updated: 2026-07-24

> Enforced by `.claude/settings.json` (SessionStart surfaces this; the Stop gate blocks
> claiming any item "done" without the verifier subagent / observed evidence for every AC).

## Open

### ACT-1: 1:1 ownership hand-off — non-owner defers AND the owner actually follows up
**Requested:** 2026-07-24
**Asked for:** "I believe Terry would be better suited… I will let him know" then a SEPARATE
message from Terry confirming. Later: "what they do vs pass has to be related to domain and
themes as well not just tools… if I say look for ways to tighten my budget, Finn should be
brought in despite us not having specific tool ownership."
**Expected outcome:** In a 1:1, when the ask belongs to another agent (by exclusive tool OR by
domain/theme), the addressed agent defers + names the owner, AND the owner sends a real
follow-up message to the user.
**Acceptance criteria:**
- AC-1: 1:1 grooming ask to Tess → Tess does NOT groom/improvise, no tool, no task; says Terry is
  better suited + she'll let him know; @mentions terry-locke. — **OBSERVED PASS** (harness, journey off).
- AC-2: 1:1 budget ask to Tess → Tess defers to Finn (finance lane), does NOT answer herself. — **UNVERIFIED** (deployed to `fix-1to1-capability-defer`; not yet tested with verifier).
- AC-3: In-lane ask to Tess (a product question) → Tess answers herself, NO handoff (no over-handoff). — **UNVERIFIED**.
- AC-4: After a 1:1 deferral, the owner (Terry/Finn) sends a SEPARATE follow-up message the user
  can see (dm-<owner> turn and/or push). — **NOT BUILT** — delivery plumbing does not exist yet.
**Status:** in-progress
**Branch/PR:** `fix-1to1-capability-defer` (capability defer + domain lane handoff; NOT merged)

### ACT-2: Enforce mandatory skills (AC / verify / track / verifier subagent)
**Requested:** 2026-07-24
**Asked for:** "treat the actions, tracking, acceptance, verify skills as mandatory… refresh the
repo for the enforcement layer or implement one of your own." Scope: Both (repo + org). Strictness: Hard block.
**Expected outcome:** I cannot claim work done without ACs + independent verification.
**Acceptance criteria:**
- AC-1: SessionStart surfaces the discipline + actions.md. — built (`.claude/settings.json`).
- AC-2: Stop gate blocks a turn that claims completion without ACs + observed evidence. — built; **activation is next session** (settings watcher).
- AC-3: Same enforcement added org-wide via eds-claude-skills setup. — **OPEN**.
**Status:** in-progress

### ACT-3: create_huddle_task cross-turn dedup (board-clutter prevention)
**Asked for:** stop the board filling with duplicate/near-duplicate tasks.
**Acceptance criteria:** AC-1: creating a task whose title already exists open on the board is
skipped (deduped). **UNVERIFIED** (merged PR #5 + deployed; not tested live with verifier).
**Status:** open (needs verification)

## Closed

### ACT-0: Remove test-task clutter from the production board
**Requested:** 2026-07-24  **Closed:** 2026-07-24
**Asked for:** "so many test tasks… my production app isn't usable… get rid of the tasks."
**Evidence:** journey-voice `cleanup-test-tasks` workflow run (execute) log: spam 176/176 +
duplicates deleted; TOTAL 523 → 247. Workflow removed after use (PR #19).
**Verification:** PASS — final count observed in the run log.

## Decisions & scope changes
- [2026-07-24] Ownership = tools AND domains/themes (not just exclusive tools). Must be systematic
  for unforeseen lanes, not per-agent hardcodes.
- [2026-07-24] Enforcement placement = Both (huddle repo + eds-skills); Stop gate = Hard block.
- [2026-07-24] Standing test harness required (`huddle.mjs`) so sessions don't rebuild it each time.
