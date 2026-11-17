# VERIFY: report-saves-verdicts, loop 1

WHAT:          Independent verification of branch `claude_report-saves-verdicts` (head 543df6af) against origin/main 23c04496.
WHY:           Tier-1 path (verdict admission, daily cap, proposal creation). Builder claims in BUILD-report-saves-verdicts.md.
SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file (written as the pass progresses).

PUBLIC REPO: counts only. No names, addresses, ids or message content.

## Scope observations

- Branch = 5 commits over main, 1 behind. Base commit 76043a49 is "WIP: All time catch-up ... (server half)" from
  `claude_actions-all-time-catchup`, which is NOT on main and has two later commits (22d8b9e1 "revert heartbeat backlog
  sizing", 96c1f099) that this branch does NOT carry.
- On this branch the WIP symbols `heartbeatPassShape`, `HEARTBEAT_BACKLOG_PER_PASS`, `pendingUnitCount`,
  `catchUpStopReason`, `catchUpContinue`, `CATCHUP_*`, `tabAfterRangeChange` have zero callers (grep of src + scripts).
  `selectActionItems` now also fills `unchecked`/`uncheckedCounts`; ActionsView.tsx on this branch does not render them.
  Live effect of the WIP commit on this branch = the runClassify batch refactor (used by the report) + dead code.
