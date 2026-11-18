# REDTEAM: Actions safety check, invites, momentary chat, owner names, held items

WHAT:       Red-team pre-pass (Tier 1, before the PR) against branch `claude_actions-held-names` @ d7bfd284.
WHY:        Try to make F1 to F5 / X-5 of the contract give a WRONG answer before a verifier sees it.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   contract `docs/qc-evidence/AC-actions-safety-and-invites.md`; builds `BUILD-actions-safety-invites-A.md`,
            `BUILD-actions-held-names-B.md`. Tests `RT-*` in `scripts/actions-accuracy.test.ts` and
            `scripts/actions-view.test.ts` (run with `bun <file>`). Synthetic data only; no model calls, no dispatches.

Rule: a "held" row has a PASSING regression test. A "BROKEN" row has a test that asserts the CORRECT behaviour and
FAILS now. The source code was NOT changed.

| # | Area | Input (synthetic) | Expected | Actual | Verdict |
|---|---|---|---|---|---|
| RT-1 | F1 | quote `Please do ... send the contract to the client.` vs message `Please do not send the contract to the client.` | REJECT (the elided quote inverts the meaning) | ADMITTED: the ellipsis may elide words inside one sentence, so a dropped `not` passes | **BROKEN** (spec-level: S1-14 explicitly allows mid-sentence elision; needs an AC decision, e.g. an ellipsis may only stand for whole sentences, or a gap may not hold a negation) |
| RT-2 | F1 rule 4 | quote fragment `We reviewed the cafe` vs NFD message `café menu` | REJECT (ends mid-word) | ADMITTED: `isWordChar` tests `\p{L}\p{N}` only, so a combining mark (`\p{M}`) counts as a boundary | **BROKEN** (minor) |
| RT-3 | F1 | NFC quote `The café notes are due Friday` vs NFD message (same visible text) | ADMIT | REJECTED (held): `canonQuote` does not `normalize("NFC")` | **BROKEN** (false refusal; fails safe into the held group) |
| RT-4 | F1-3 | fragment 1 in OTHER message A, fragment 2 in OTHER message B | REJECT | REJECT | held |
| RT-5 | F1-5 | `Please confirm the venue. ... Please confirm the venue.` vs one occurrence | REJECT | REJECT | held |
| RT-6 | F1 rule 1 / 6 | 7-sentence quote that is one contiguous span; and 7 fragments with a gap | ADMIT (whole path); REJECT (>6 fragments) | as expected | held |
| RT-7 | F3 | quote `Thanks!`, to-do "Send the signed contract", message `Thanks! Can you send me the signed contract by Friday?` | NOT `none` (held at least: the quote is under 8 chars, so before F3 it was held and visible) | `none` / `momentary`: the backstop runs BEFORE the quote check and looks only at the model's quote, never at the message it came from, so a real ask is hidden outright | **BROKEN** (fails CLOSED; the contract says the backstop must fail open) |
| RT-8 | F3 | `Thanks — can you send the deck` (em dash is not a split char) | not momentary | not momentary | held |
| RT-9 | F3 | `Running late… can you start the review` | not momentary | not momentary | held |
| RT-10 | F3 | `See you there; bring the contract` | not momentary | not momentary | held |
| RT-11 | F2-6 | bare dinner invite, model says `meeting_invite`, `open_item: true`, kind `both`, verbatim quote (hide switch OFF) | not under Needs your reply (owner: "must NOT become a reply item") | `open`, section `needs_reply`: F2-6 only drops kind `reply`; `both` maps to `needs_reply` in `actionSectionFor` | **BROKEN** (spec gap: AC F2-6 SD keeps `both` on today's path; one enum value away from the case F2-6 closes. Candidate: `meeting_invite` + `both` admitted as `action`) |
| RT-12 | F2-6 | `meeting_invite`, kind `action`, real ask quoted verbatim | `open` | `open` | held |
| RT-13 | F4 | second account display name in NFD `Sámuel Okafor`, list entry in NFC `Sámuel Okafor` | OWNER | OTHER: `foldPersonName` does not normalize | **BROKEN** (false refusal: his own account labelled OTHER; the AC gap list says NFC/NFD was not measured) |
| RT-14 | F4 | display name `Samuel Okafor​` (trailing zero-width space) | OWNER | OTHER: `String.trim()` does not strip U+200B | **BROKEN** (minor) |
| RT-15 | F4 S4-3 | `Okafor , Samuel` | OWNER | OWNER | held |
| RT-16 | F4-4 | namesake `Sam Rivera`, list has bare `Sam` | OTHER | OTHER | held |
| RT-17 | F4 S4-8 | `Samuel Okafor-Diaz` | OTHER | OTHER | held |
| RT-18 | F4 S4-11 | `Okafor Samuel` (no comma) | OTHER unless listed | OTHER | held |
| RT-19 | F4-6 | app sender named `Samuel Okafor` | OTHER | OTHER | held |
| RT-20 | F4 S4-10 | `Samuel Okafor (External)` | OTHER unless listed | OTHER | held |
| RT-21 | F5-7 | `actOnHeldItem` on a held verdict that already carries rescue proposal P (already decided, second tab) | 0 new proposals; the action runs on P (actOnProposal then decides; not offline-testable here) | as expected | held |
| RT-22 | F5 D5 gate | `actOnHeldItem` on `not_checked` / `bad_shape` | refused, 0 propose, 0 act | as expected | held |
| RT-23 | F5 D5 gate | held verdict at an OLDER `inputVersion` | refused | refused (`verdictIsCurrent`) | held |
| RT-24 | F5 | stored verdict whose key is ANOTHER thread's item key | refused | refused | held |
| RT-25 | F5 D5 gate | `status: open` verdict sent to the held action | refused | refused | held |
| RT-26 | F5-5 | fresh held item | exactly 1 proposal, id written back, status stays `not_checked` | as expected | held |
| RT-27 | F5-1/2 | `isHeldCandidate` with bad_shape / null / status none / status open + quote_not_found | only not_checked + quote_not_found | as expected | held |
| RT-28 | F5 selection | held items with P dismissed, P approved, onBoard, P still proposed | dismissed / approved / onBoard leave; undecided rescue stays held; none leak to unchecked or rows | as expected | held |
| RT-29 | F5-10 | counts over that selection | heldCounts = held rows; tabCounts include held; notChecked excludes held | as expected | held |
| RT-30 | F5-9 | held `meeting_invite`, default switches | hidden + counted, not held | as expected | held |
| RT-31 | X-5 / F5-14 | prior held `{not_checked, P}`, re-judge comes back `open` | P kept, 0 proposals | as expected | held |

Not attacked offline (needs a live store / caller): `actOnHeldItemFor` acting on another owner's item. Read in source:
it is gated by `ownedScope(caller, cfg)` and loads only `cfg.ownerLogins` data, then finds the unit by `itemKey` in
that plan, so a foreign item key is "That item isn't in your list." (inference from reading, not executed here).
A held row whose rescue proposal P was DELETED from the store reads as `proposalId: null` on the page but `cur.proposalId`
= P in `actOnHeldItem`, so every click re-acts on the missing P and fails (a stuck row). Recorded, not tested.

## Summary

BROKEN (failing tests, source untouched): RT-1, RT-2, RT-3, RT-7, RT-11, RT-13, RT-14. Most serious: RT-7 (F3 hides a
real ask outright because the backstop reads only the model's quote) and RT-11 (a bare invite of kind `both` lands in
Needs your reply). RT-1 is a spec-level question (S1-14 allows mid-sentence elision).
