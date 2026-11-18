# VERIFY-actions-safety-invites-4

WHAT:          Independent verification, loop 4, of PR #278 (branch `claude_actions-held-names`, head 4153330c).
WHY:           Loop 3 verdict FIX FIRST: F3-EMAIL-FWD-EARLIER and F3-EMAIL-SUBJECT (an email ask hidden by the
               code momentary backstop). The fix makes the code backstop Teams-only.
SUPERSEDES:    docs/qc-evidence/VERIFY-actions-safety-invites-3.md (its two findings are re-tested here).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probe = loop-3 probe re-run unchanged plus two rows (untracked, not committed; synthetic
               data only, model stubbed, no billed calls, no workflow dispatches).

Checked out DETACHED at 4153330c in an isolated worktree.

## Claim 3 (F3) -- full re-derivation

### The change
`src/features/huddle/lib/actions/pipeline.ts:228`:
`const latestMessages: string[] = u.email ? [] : u.teams!.messages.map((m) => m.text ?? "");`
`momentaryDropApplies` (`action-classify.ts:475-485`) returns false on an empty list (line 483), so the code
NEVER drops an email.

### Every caller (whole repo except node_modules)
`admitActionVerdict(` / `momentaryDropApplies(` occur in production code only at `pipeline.ts:229` (and
`action-classify.ts:505`, its own internal use). No other email path reaches the drop. The default argument
(`latestMessages` undefined, falls back to the joined haystack) is reached by NO production caller: the only
caller always passes an array. It is reached by tests (see Finding F4-F3-9 below).

### Loop-3 probe, re-run at this head (model stubbed to `open_item:true` quoting the given text)

| case | loop 3 | loop 4 |
|---|---|---|
| E-FWD-EARLIER (msg 1 pleasantry + forward with an ask; msg 2 pleasantry) | none/momentary | **open** |
| E-FWD-EARLIER2 | none/momentary | **open** |
| E-FWD-BOTH | open | open |
| E-SUBJECT-ASK (ask in subject only, body `Thanks!`) | none/momentary | **not_checked/quote_not_found** |
| E-SUBJ-ASK-2 (ask in subject, body `Thanks so much!`) | none/momentary | **open** |
| E-FWD-LATEST | not_checked | not_checked |
| E1 / E1b / E3-ONLY / E-OWNER-MID / E-EMPTY-BODY / E-WINDOW | nc / open / open / open / open / open | identical |

No email case produces `none/momentary`. E-SUBJECT-ASK lands `not_checked` because the stubbed quote `Thanks!` is
below the quote check's minimum: counted "not checked yet", not filed as answered. That is the quote check, not
F3, and the shipped test F3E-3 accepts it (`open` or `not_checked`).

Loop-3 F3-EMAIL-FWD-EARLIER: **RESOLVED.** Loop-3 F3-EMAIL-SUBJECT: **RESOLVED.**

### Mutation proof of the fix
`mutate.sh pipeline.ts <current line 228> <pre-fix line 228> "bun scripts/report-saves-verdicts.test.ts" "F3E-3 GUARD"`
-> `FIRED (control EQUIVALENT)`, exit 0, file restored to HEAD. (A first run with pattern `FAIL F3E-3` returned
UNDETERMINED exit 4 because the matcher adds the FAIL marker itself. That was my pattern spelling, not the guard.)

### Teams chat name
The brief's premise ("the model sees the name and the backstop doesn't") does not hold. `teamsActionInput`
(`action-classify.ts:219-230`) renders FACTS + each message's speaker, time and text. `chatName` is not in it.
`TeamsThreadMessage` (`report-from-ledger.ts:254-261`) has no subject field. So for Teams the backstop and the
model read the same message texts. The model's budget cut (16k, newest kept) can only show the model FEWER
messages than the backstop sees, which can only keep more items. An empty message is `(no text)` to the model
and `""` to the backstop, and `""` is not momentary, so it keeps the item. **No asymmetry, no hidden-ask path.** An
ask written only in a chat's name is invisible to both. That is a scope limit, not an F3 defect.

### FINDING F4-F3-9 -- AC F3-9 now FAILS end to end, and its test is a proxy

AC F3-9 (`docs/qc-evidence/AC-actions-safety-and-invites.md:235`): *"Given an email thread (not Teams) with only
'Thanks, see you there!', when admitted, then the same backstop applies: `none`. One rule for both sources."*

| check | result |
|---|---|
| `actions-view.test.ts:730-731` F3-9 | PASS, but it calls `admitActionVerdict` with NO `latestMessages`, so it runs the default path |
| real pipeline, probe E-F3-9-PLEAS (one email, body `Thanks, see you there!`, model wrongly says open) | **open** |
| real pipeline, probe E-PLEAS-2MSG (`Thanks!` then `See you soon!`) | **open** |

Cause and effect: the fix sets email's list to `[]`, so an empty list never drops, so a model mistake on a
pleasantry-only email reaches the list as an item. The F3-9 test cannot see this because it skips the pipeline.

Direction: this fails OPEN (a non-item is shown; no real ask is hidden), which is the safe side and matches the
fix's stated intent. But it changes an accepted AC ("one rule for both sources") to "Teams only", and the guard
still claims the old AC. Per this repo's rule that an existing behaviour does not change without the owner's
go-ahead, this needs either the owner's sign-off on the AC change or a different fix. Either way, F3-9's test
must exercise the pipeline (or pass `latestMessages: []` the way the pipeline does) so it states what ships.

## Reduced-depth re-checks (F1, F2, F4, F5, X, R1-8, Teams F3)

| suite | expected | observed |
|---|---|---|
| `bun scripts/actions-view.test.ts` | 221/0 | `221 passed, 0 failed` rc=0 |
| `bun scripts/actions-accuracy.test.ts` | 96/0 | `96 passed, 0 failed` rc=0 |
| `bun scripts/report-saves-verdicts.test.ts` | 39/0 | `39 passed, 0 failed` rc=0 (F3E-1, F3E-2, F3E-3 PASS) |
| `bun scripts/actions-view-server.test.ts` | 36/0 | `36 passed, 0 failed` rc=0 |
| `npx tsc --noEmit` | exit 0 | rc=0 |
| `npm run build` | exit 0 | rc=0 (`built in 2.64s` / `2.44s` / `1.22s`) |

Spot check, Teams F3, probe rows vs loop 3: W1 open, W2 nc, W3 nc, A7 open, A8 open, A9 open, GROUP open,
OWNER-LAST nc, NOOWNER-PLEAS none/momentary, ATTACH-EMPTY open, ATTACH-ONLY-ASK open, EMOJI-ONLY none/momentary,
EMOJI+ASK open, LONG-MID-ASK open, LONG-ALL-PLEAS none/momentary, ASK-IN-OWNER open, CAN-YOU-JOIN none/momentary.
All identical to loop 3. The Teams pleasantry-only drop still fires (also `F3V-4` in actions-accuracy PASS).

Blast radius: one line in `pipeline.ts`, one caller. The radius I found beyond the stated one is AC F3-9, above.

## Not checked
- Live model behaviour: the momentary prompt rule (MOMENTARY_RULE) is now the only email defence. Testing it
  needs billed model calls, which this loop was told not to make.
- UI: this change has no UI claims. Nothing is owed a browser run.

## Verdict
FIX FIRST: F4-F3-9 (AC F3-9 "one rule for both sources" no longer holds in the pipeline: a pleasantry-only email the model mis-flags is shown as open; its test passes only on a default path no production caller uses. Fails safe, but it needs the owner's sign-off on the AC change plus a test that exercises the shipped path, or a different fix)
