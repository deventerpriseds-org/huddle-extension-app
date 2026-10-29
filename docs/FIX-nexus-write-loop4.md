# FIX nexus-write-tool, loop 4 — M0 (merge main), D13 (1:1 lane steals), D13-ovr (override needs an assignment object)

<!--
WHAT:          Fixes for the loop-4 verifier's blocking findings on huddle PR #114 (branch claude_nexus-write-tool-fixed):
               M0 merge of origin/main (#124 "One ownership judge"), D13 (deterministic 1:1 coursework hand-off
               steals other lanes' asks origin/main keeps), D13-ovr (explicit Nexus override fired on non-coursework).
WHY:           docs/VERIFY-nexus-write-tool-4.md returned REFUTED: M0 (PR does not merge with 4cb2273, conflicts in
               routing.ts + realtime-tools.server.ts), D13 (18 vocabulary lane steals), D13-ovr (3 override steals).
RESPONDS TO:   docs/VERIFY-nexus-write-tool-4.md (branch claude_verify-nexus-write-tool-4).
SUPERSEDES:    nothing. FOLLOWS docs/FIX-nexus-write-routing.md, docs/FIX-nexus-write-voice-gate.md.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; tests in scripts/nexus-write-routing.test.ts; mutation anchors in mut-loop4/.
               Offline only: fetch mocked, no live Nexus/Huddle, no DB or board writes.
-->

Written as the work goes (2026-10-29).

## Step 1 — M0: merge origin/main (4cb2273, #124) with a merge commit

Merged with `--no-ff` (no rebase). Two conflicts, as the verifier predicted:

| File | Resolution | Why |
|---|---|---|
| `lib/voice/realtime-tools.server.ts` (`raw` toolset) | **UNION**: main's multi-line list with `...(opts.journey !== false ? [FOCUS_TOOL] : [])` (AC8 journey gate) **plus** the PR's `...nexusWriteTools()` after `...nexusReadTools()` | taking main drops the voice Nexus write tool; taking the PR re-offers FOCUS_TOOL with journey off |
| `lib/routing.ts` (`resolveOwnerLLM` prompt) | main's #124 `framing: "dm" \| "assigned"` logic intact; new **explicit** `opts.primeHint?: boolean` (default off, ignored when `assigned`). Only with it does the prompt get the `PRIME OWNERS` directory and the roster's `[prime for: …]` markers. | #124 made `resolveOwnerLLM` the grooming judge (groom.ts) and the 1:1 task-creation / produce-task judge (huddle.functions.ts); none of those may see the coursework hint |

Call sites on the merged tree: only the live 1:1 chat hand-off (huddle.functions.ts owner follow-up,
`resolveOwnerLLM(data.text, nextId, {...}, { primeHint: true })`) opts in. Grooming (`{ framing: "assigned" }`),
1:1 task creation (`resolveOwnerLLM(title, winner.id, …)`) and the produce task (`resolveOwnerLLM(askText, agentId, …)`)
pass no `primeHint` and get origin/main's prompt (the roster line also drops `primeMarker` without it). The call
was kept as `resolveOwnerLLM(data.text, nextId, {` on one line so main's `ownership-judge.test.ts` shape check
("the 1:1 hand-off asks the same judge") still matches.

Merge-induced test updates (shape only, no behaviour change): `nexus-write-tool.test.ts` F2-31(2)/F2-32 and
`nexus-read-tools.test.ts` "voice pushes them into its toolset" now read the whole multi-line `raw` array literal
and require a BARE (unconditional) spread line; `nexus-write-routing.test.ts` R-A4 calls the resolver with
`{ primeHint: true }`.

On the merged tree before the D13 work: all 12 nexus suites green (routing 825, tool 115, read 190, …); main's
#124 tests `ownership-judge` / `assign-on-create` / `ask-shape` / `board-delete` ALL PASS; `npx tsc --noEmit -p .`
exit 0.
