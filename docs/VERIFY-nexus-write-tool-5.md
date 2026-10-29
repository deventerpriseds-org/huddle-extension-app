# VERIFY nexus-write-tool, loop 5 — pre-merge independent re-verification of huddle PR #114 (head ec6127a)

<!--
WHAT:          Independent, offline, pre-merge re-verification of PR #114 (branch claude_nexus-write-tool-fixed,
               head ec6127a): M0 + per-claim verdicts C1..C9 with observed evidence, every defect classified
               BLOCKING / NON-BLOCKING with realistic likelihood.
WHY:           Loop 4 (docs/VERIFY-nexus-write-tool-4.md) returned REFUTED on M0 (conflict with origin/main #124)
               and D13 / D13-ovr (deterministic 1:1 lane steals). Fixers (docs/FIX-nexus-write-loop4.md) report all
               three fixed. This is the check before the owner's merge.
SUPERSEDES:    nothing. FOLLOWS docs/VERIFY-nexus-write-tool-4.md (branch claude_verify-nexus-write-tool-4).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probes, outputs, mutation anchors in mut-verify-114-5/ on branch
               claude_verify-nexus-write-tool-5. Offline only: fetch mocked, no live Nexus/Huddle, no DB/board writes.
-->

Started 2026-10-29 13:27 UTC (budget 40 min, ends 14:07). Worktree branch `verify-nexus-write-tool-5` from
`origin/claude_nexus-write-tool-fixed` @ `ec6127a`. Written as the work goes.

## M0 — merge with origin/main

- `git merge-tree --write-tree origin/claude_nexus-write-tool-fixed origin/main` -> **exit 0** (no conflict).
- `git merge --no-edit origin/main` on the checkout -> `Already up to date.` (a no-op): `origin/main` @ `4bad00f`
  is already an ancestor of `ec6127a` (`git merge-base --is-ancestor` exit 0; `rev-list --left-right` 0/0).
  So every check below ran on a tree that already contains origin/main. **M0: CONFIRMED** (loop-4 M0 resolved).
- The two loop-4 conflict sites, read on ec6127a: covered in C4/C8 below (voice `raw` union; `resolveOwnerLLM` opts).

## C7 — suites + tsc (re-run, not trusted)

`bash scripts/run-nexus-fix-suites.sh` -> EXIT 0 (`mut-verify-114-5/suites.out`): redteam 39/0, router-redteam 12/0,
nexus-write-tool 115/0, router-winners 39/0, nexus-read-tools 190/0, cross-app-turn-gate 92/0, voice-toolset-hidden
36/0, fix 51/0, loop2 185/0, loop3 315/0, voice-gate 43/0, **routing 1315/0**. #124 suites on the PR tree:
ownership-judge ALL PASS, assign-on-create ALL PASS, ask-shape ALL PASS, board-delete ALL PASS.
`npx tsc --noEmit -p .` -> exit 0, no output (`tsc.out`).

`scripts/focus.test.ts`: PR tree 24 passed / 1 failed (`FAIL F22 a voice call to Iris can do it too`);
**`git archive origin/main` export: identical 24/1, same F22**. F22 greps the one-line `[PRIORITIZE_TOOL, FOCUS_TOOL,`
which #124 made multi-line. **Pre-existing on origin/main, not caused by #114.** **C7: CONFIRMED.**

## C2 / C5 / C6 / C3 — loop-4 probes re-run on ec6127a

| Probe (copied verbatim into mut-verify-114-5/) | Result vs loop 4's stored output |
|---|---|
| `l3-probe-exec.ts` (C5 owner/URL/body/headers, C6 read-only, C2 canonicalisation/dedup/update) | **byte-identical** (`diff` empty) |
| `l3-probe-voice.ts` (C3 voice gate) | **byte-identical** |
| `probe-c9-voice.ts` (C3 W1-W6 orders) | **byte-identical** (W4 residual unchanged) |

**C2: CONFIRMED. C5: CONFIRMED. C6: CONFIRMED. C3: CONFIRMED as scoped** (residuals W4 very low, H15 owner-accepted,
unchanged).
