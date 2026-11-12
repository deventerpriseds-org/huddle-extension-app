# VERIFY-handoff-confirm-flow-3

WHAT:       independent verification (loop 3) of the handoff-confirm-flow build on claude/modest-brown-2hdt5n @ f3d94a5f
WHY:        loops 1 and 2 were killed by container restarts; C2 urgency was refuted twice and re-fixed (96060f39, f3d94a5f)
SUPERSEDES: docs/qc-evidence/VERIFY-handoff-confirm-flow-2.md (autosave ref only; never completed)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   probes + mutation anchors in docs/qc-evidence/verify-handoff-confirm-flow-3/

Spec: origin/claude_ac-handoff-confirm:docs/qc-evidence/AC-handoff-confirm-flow.md
Scope: C1-C6 (F5/F6/F7 out of scope). Offline only. Start 04:00 UTC, budget 40 min.

## Claims
(filled per claim; unreached = NOT REACHED)

### C2 Urgency (classifyAsk().urgency) -- REFUTED (third loop)

Re-run of both earlier probes at f3d94a5f:
- `urgency-probe.ts` (loop 1): **38 passed, 0 failed** -- every S-U / V row correct.
- `urgency-probe-2.ts` (loop 2): **23 passed, 7 failed** -- ALL 19 HIGH (unsafe) rows now `default` (fixed).
  The 7 failures are LOW (safe direction, an extra confirm): N-2, N-20, N-21, N-22, N-25, N-26, N-30.

New hunt, `urgency-probe-3.ts`: **19 passed, 26 failed** (15 HIGH, 11 LOW). Raw output:

HIGH -- classify `now` where a reader says not-now (every one also classifies intent=`perform`, so the 1:1
directive becomes "The user asked for this NOW ... do NOT ask them to confirm first", and the lane hand-off is
suppressed):

| id | input | got |
|---|---|---|
| U-1 | `just leave it for now` | now |
| U-2 | `keep it on the backlog for now` | now |
| U-11 | `park it for now` | now |
| U-13 | `skip the research for now` | now |
| U-3 | `hold off on it right now` | now |
| U-4 | `I'm busy right now, do it later` | now |
| U-5 | `I'm in a meeting right now, remind me later about the deck` | now |
| U-6 | `wait until tomorrow instead of right away` | now |
| U-7 | `instead of right away, do it Friday` | now |
| U-21 | `maybe next week instead of now` | now |
| U-8 | `now doesn't work for me` | now |
| U-9 | `now won't work, maybe Friday` | now |
| U-10 | `Not. Now.` | now |
| U-20 | `please do not, under any circumstances, start this immediately` | now |
| U-23 | `nothing right now, thanks` | now |

Root causes (observed from the regexes at capabilities.ts:148-171):
1. **"for now" (= "for the time being") is the trailing-`now` rule** `/\bnow\b\s*[!.]*$/` with no veto.
2. Negators missing: `instead of`, `hold off`, `busy`, `later`; "now doesn't/won't" (the post-`now` veto only
   knows `is not / isn't / 's not / a bad ...`).
3. The negation window is whitespace-only, so punctuation between the negator and the urgency word ("Not. Now.",
   "do not, under any circumstances, start this immediately") breaks it.

LOW -- over-matches (urgent asks classified `default`). The most important is a NEW defect introduced by f3d94a5f:
the negator alternative `[a-z]+n['’]?t` makes the apostrophe OPTIONAL, so ANY word ending in "nt" is a negator:

| id | input | got |
|---|---|---|
| W-1 | `I want it now` | default |
| W-2 | `I want it done right away` | default |
| W-3 | `this is urgent so do it now` | default |
| W-4 | `it's important to do it right away` | default |
| W-5 | `the client needs it right now` | default |
| W-6 | `I want this researched asap` | default |
| O-3 | `why don't you do it right now` | default |
| O-4 | `can't you just do it now?` | default |
| O-5 | `it's not complicated so do it right away` | default |
| O-6 | `I don't care just do it now` | default |
| O-7 | `I need this now, no need to ask first` | default (URGENCY_RE never fires: "now," is not trailing) |

Requested checks: O-1 `don't wait, do it right away` -> now (PASS); O-2 `can you do it now? I can't wait` -> now (PASS).

VERDICT C2: **REFUTED** -- concrete failing input `just leave it for now` (and 14 more HIGH rows) classifies `now`.
Secondary: f3d94a5f's `[a-z]+n['’]?t` turns "want"/"urgent"/"important"/"client" into negators (W-1..W-6).
