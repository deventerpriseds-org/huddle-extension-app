# Fix pass: red-team findings W1..W21 against `write_nexus_assignments`

<!--
WHAT:          The fix log for the 21 WRONG findings in docs/REDTEAM-nexus-write-tool.md: per finding,
               fixed / not fixed + why, the test that pins it, and the mutation verdict that proves the
               new guard is load-bearing.
WHY:           The red-team pass (Tier-1 pre-pass) left 51 failing tests (39 tool + 12 routing) against
               builder commit 507e13b. This pass makes them pass without weakening them.
SUPERSEDES:    nothing. RESPONDS TO docs/REDTEAM-nexus-write-tool.md (findings) and builds on
               docs/BUILD-nexus-write-tool.md (builder's log).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch fix/nexus-write-redteam from ad88b5d; suites scripts/nexus-write-redteam.test.ts,
               scripts/router-redteam.test.ts, scripts/nexus-write-tool.test.ts,
               scripts/router-winners.test.ts, scripts/nexus-read-tools.test.ts,
               scripts/cross-app-turn-gate.test.ts, scripts/voice-toolset-hidden.test.ts; mutation runs
               via /usr/local/bin/mutate.sh (anchors/replacements in scratch files, verdicts verbatim).
               Offline only: fetch mocked, no live Nexus/Huddle, no DB or board writes.
-->

Written as the work goes. Status words: **fixed** (test passes, mechanism in code), **not fixed** (with
the reason). Mutation verdicts are `mutate.sh` output, verbatim.

## Per-finding status

| W | Finding | Status | Fix (where) | Test | Mutation |
|---|---|---|---|---|---|
| W8 | stray denial word launders a false save | fixed | `enforceNexusWriteHonesty` rewritten per item/per clause (nexus-write-shared.ts) | RT-H1, RT-H2 | pending |
| W10 | mixed batch: denial of B launders claim about A | fixed | same: a claim NAMING an unsaved item is false whatever else the reply says | RT-H3 | pending |
| W11 | unknown claim phrasings appended-to, not replaced | fixed | wider CLAIM_RE (in nexus / it's in / put…into / ✅) + replace on any false claim | RT-H4, RT-H4b | pending |
| W1 | recurring same-title deliverables collapse | fixed | findDuplicate rule 1 = same title AND same local day (nexus-write.server.ts) | RT-D1 | pending |
| W2 | same-day word-subset over-match | fixed | rule 2 also needs same head noun, same numbers, >=2 words | RT-D2a/b/c | pending |
| W3 | concurrent near-identical inserts | fixed | process-wide write lock (`withWriteLock`) + claim key on normalised (course,title,due) | RT-D3 | pending |
| W7 | undated stored row swallows the date | fixed | `storedUndated` match + note offering the update | RT-D4 | pending |
| W14 | non-Latin titles never dedup | fixed | `dedupTitle` is Unicode-aware (`normTitle` kept identical to Nexus) | RT-D5 | pending |
| W4 | session with incidental deliverable noun filed | fixed | `classifyNonDeliverable`: the title HEAD decides | RT-K1 | pending |
| W5 | meeting vocabulary gaps | fixed | MEETING_WORD + colloquium/class/calls/appointment/advising/guest speaker/study group | RT-K2 | pending |
| W6 | holiday / admin gaps | fixed | ADMIN_DATE (breaks, reading week, last day to withdraw, grades due) + HOLIDAY | RT-K3 | pending |
| W12 | readings filed as assignments | fixed | READING -> `"reading"` refusal unless graded work is named | RT-K4 | pending |
| W9 | `EST` stores an Eastern deadline an hour late | fixed | `resolveZone`: EST/EDT/ET/Eastern -> America/New_York (and CT/PT families); MST/MT refused as ambiguous | RT-T1 | pending |
| W13 | DST-gap time moved earlier | fixed | `zonedLocalToUtcMs` resolves a gap FORWARD; `time_shifted` flagged in the result | RT-T2 | pending |
| W15 | empty-normalised course ref matches | fixed | `resolveCourse` refuses a ref with nothing comparable | RT-C1 | pending |
| W16 | fractional points dropped silently | fixed | refused (never rounded: a weight is not points), `points_note` on the item + in `outcome` | RT-P1 | pending |
| W17 | suppressed group duplicate unguarded | pending | | RT-H5 | |
| W18 | voice path has no runtime honesty | pending | | RT-H6 | |
| W19 | non-coursework asks stolen (group) | pending | | RT-R1 | |
| W20 | 1:1 hand-off out of own lane | pending | | RT-R2 | |
| W21 | coursework asks outside the trigger list | pending | | RT-R3a/b | |
