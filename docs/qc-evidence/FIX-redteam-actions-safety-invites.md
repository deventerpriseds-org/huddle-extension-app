# FIX: red-team findings on the Actions safety / invites / held-names change

WHAT:       Source fixes for the BROKEN rows of `REDTEAM-actions-safety-invites.md` (RT-1, RT-2, RT-3, RT-7, RT-11,
            RT-13, RT-14) plus the untested "deleted rescue proposal" finding. One row per fix, appended as it lands.
WHY:        The red-team pre-pass left 7 failing tests in `scripts/actions-accuracy.test.ts` (source untouched).
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   `bun scripts/actions-accuracy.test.ts`, `bun scripts/actions-view.test.ts`; mutation proofs via `mutate.sh`
            (anchors under the session scratchpad `sinv-RT/`). Synthetic data only; no model calls, no dispatches.

| Fix | Finding | Source change | Guard test(s) | Contract change |
|---|---|---|---|---|
| RT-3 | NFC quote vs NFD message refused | `canonQuote` (action-classify.ts) runs `normalize("NFC")` first; quote AND haystack both pass through it | RT-3, RT-3b | none |
| RT-2 | combining mark counted as a word boundary | `isWordChar` adds `\p{M}` | RT-2b (q + U+0307, does not compose under NFC, so only `\p{M}` decides) | none |
| RT-1 | `...` could elide words inside one sentence (dropped `not`) | `fragmentsInOrder`: a fragment before a gap must END a sentence in the message, a fragment after a gap must START one; a leading / trailing ellipsis counts as a gap. Applies to sentence-split gaps too (`Please do. Send ...` vs `Please do. Do not send ...`), same rule. | RT-1, RT-1b, RT-1c (whole sentences still admitted), S1-14c, S1-x2, S1-x3 | AC S1-14 tightened (dated note). Test rows S1-14 / S1-14b / S1-x1 now expect held (`not_checked`), per that decision. |
| RT-7 | F3 backstop hid a real ask (looked only at the model's quote) | new `momentaryDropApplies`: drop only when the momentary quote sits in a message that is momentary IN FULL and is the sender's LATEST message. `admitActionVerdict` takes optional `latestMessages`; `runClassify` passes each Teams OTHER sender's latest message; email uses the latest OTHER message + forward joined. | RT-7, RT-7b, RT-7c | none (F3 already said fail open). Test row S1-11 (`Thanks. Thanks.` vs a message with a real ask) now expects held, not none. |
| RT-11 | `meeting_invite` + kind `both` listed under Needs your reply | `admitActionVerdict`: that pair is admitted as kind `action` | RT-11, RT-11b, RT-11c | AC F2-6 extended (dated note) |
| RT-13 / RT-14 | NFD display name / trailing U+200B not his name | `foldPersonName` (report-from-ledger.ts): `normalize("NFC")` and strip `\p{Cf}` before trimming | RT-13, RT-14, RT-13b, RT-14b | none |
| X-5b (knock-on) | `report-saves-verdicts.test.ts` X-5b expected a "Thanks!" quote on an email with a real ask to drop to `none` | none (this is RT-7 working: the message is not momentary in full) | X-5b now expects held (`not_checked`); its X-5 invariants (0 proposals, P attached) are unchanged | follows RT-7 |
| DEL | held item whose written-back proposal was deleted retried the missing id forever | `HeldActDeps.proposalExists?` (pipeline.ts); `actOnHeldItem` re-uses a written-back id only if it still exists, else proposes fresh and writes the new id back. `actOnHeldItemFor` wires it to an owner-scoped `EXISTS` on `chat.task_proposals` (a read error throws: click fails, nothing stored). | F5-DEL, F5-DEL-b | none |

## Mutation proofs (`mutate.sh`, every FIRED controlled; anchors in the session scratchpad `sinv-RT/m1..m8`)

| # | Guard | Mutation (defect reinstated) | Test that must fail | Verdict | Exit |
|---|---|---|---|---|---|
| m1 | RT-1 gap rule | drop the needStart / needEnd sentence-boundary checks in `fragmentsInOrder` | RT-1b GUARD | FIRED (control EQUIVALENT) | 0 |
| m2 | RT-2 `\p{M}` | `isWordChar` back to `[\p{L}\p{N}]` | RT-2b GUARD | FIRED (control EQUIVALENT) | 0 |
| m3 | RT-3 NFC | remove `.normalize("NFC")` from `canonQuote` | RT-3b GUARD | FIRED (control EQUIVALENT) | 0 |
| m4 | RT-7 fail open | `momentaryDropApplies` returns true for any message | RT-7c GUARD | FIRED (control EQUIVALENT) | 0 |
| m5 | RT-11 both -> action | remove the meeting_invite + both remap | RT-11b GUARD | FIRED (control EQUIVALENT) | 0 |
| m6 | RT-13 NFC in names | remove `normalize("NFC")` from `foldPersonName` | RT-13b GUARD | FIRED (control EQUIVALENT) | 0 |
| m7 | RT-14 `\p{Cf}` | remove the `\p{Cf}` strip from `foldPersonName` | RT-14b GUARD | FIRED (control EQUIVALENT) | 0 |
| m8 | DEL fresh proposal | re-use any written-back id (`true`) | F5-DEL GUARD | FIRED (control EQUIVALENT) | 0 |

Not mutation-proved: the Teams `latestMessages` WIRING in `runClassify` (pipeline.ts) -- no offline runClassify test
drives a Teams chat whose sender's latest message is momentary while an earlier one is not; the rule itself is m4. The
`proposalExists` SQL in `actOnHeldItemFor` (actions.server.ts) is exercised only by tsc / build, not by a test.

## Results (2026-11-18)

- `bun scripts/actions-view.test.ts`: 221 passed, 0 failed
- `bun scripts/actions-accuracy.test.ts`: 91 passed, 0 failed (RT-1, 2, 3, 7, 11, 13, 14 now pass)
- `bun scripts/report-saves-verdicts.test.ts`: 36 passed, 0 failed
- `bun scripts/actions-view-server.test.ts`: 36 passed, 0 failed
- `npx tsc --noEmit`: exit 0
- `npm run build`: exit 0
