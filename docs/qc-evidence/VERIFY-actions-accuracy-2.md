<!--
WHAT:          Independent verification, loop 2, of branch claude_actions-accuracy (head 905a9360).
WHY:           Owner report 2026-11-17 (Actions view: sender reversed, hallucinated asks, no AI-misread reason,
               label lines as rows, cut-off text, duplicate Teams ask). Loop 1 was killed by an interrupt with no verdicts.
SUPERSEDES:    VERIFY-actions-accuracy-1 (never written: loop 1 recorded nothing).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      commands and outputs inline; repro script scratch-only; synthetic data only (public repo).
-->

# VERIFY: actions-accuracy, loop 2

Verifier, independent. Started 2026-11-17 04:45 UTC. Branch under test `origin/claude_actions-accuracy` 905a9360.

## C0 -- Suite re-run, tsc, build

Command: `bun scripts/<name>.test.ts` for each; `npx tsc --noEmit -p .`; `npx vite build`.

| suite | builder | observed |
|---|---|---|
| actions-accuracy | 25 | 25 passed, 0 failed |
| actions-view | 90 | 90 passed, 0 failed |
| actions-view-server | 28 | 28 passed, 0 failed |
| report-from-ledger | 103 | 103 passed, 0 failed |
| correspondence-ingest | 186 | 186 passed, 0 failed |
| meeting-triage / -sql / -server | 69/34/7 | 69 / 34 / 7 passed, 0 failed |
| task-proposals / -sql | 199/45 | 199 / 45 passed, 0 failed |
| tsc | clean | rc=0 |
| build | clean | rc=0 |

Verdict C0: CONFIRMED.

## Repro scripts

Scratch only (not committed): `repro.ts` and `repro2.ts`, run with `bun`, importing the branch's modules directly.
All names and ids invented. Output lines quoted below verbatim.

## C1 -- Owner recognition (Tier 1)

| test | observed | verdict |
|---|---|---|
| A1 owner id only on ANOTHER chat's older row | `["Pat Example:OTHER","Ellis, Von:OWNER"]`, settled `true` | CONFIRMED |
| A2 name fallback, ownerNames `["Von Ellis"]` | `Ellis, Vonda:false, Von Ellisson:false, Ellis, Von (Contractor):false, Ellis Von:false, VON  ELLIS:true, Ellis, Von:true` | CONFIRMED: no near-namesake is taken |
| A2b app sender named as owner | `[]` | CONFIRMED |
| A2c exact-name namesake once any id is known | `["owner-guid-1"]` only | CONFIRMED |
| A3 DEFAULT owner names with no `correspondence.ownerNames` | `effectiveOwnerNames` for a `von.ellis@` login -> `["Von"]`; with that list `"Ellis, Von"` -> **false**, a sender named exactly `"Von"` -> **true** | see D-3 |
| A4 one row with a WRONG `ownerUserId` | that sender becomes OWNER in **every** chat: `["Sam Other:OWNER"]`, latestOther `null` | see D-4 (risk; not live today, probe says 1 distinct id) |
| A5 uninvolved rule, group chat, rows lack `ownerUserId` | `fromOwner=null`: before `cant_tell_owner_unknown`, after the same. `fromOwner=false`: before `cant_tell_owner_unknown`, after **`uninvolved`** (hidden) | see D-5 |

Verdict C1: CONFIRMED for the live shape (ids exist on older rows; every recent row has `fromOwner` null, so A5 does
not change live hiding). Defects/risks D-3, D-4, D-5 below.

## C1b -- STALE VERDICTS ARE NOT RE-JUDGED (outside the stated radius)

The item key is `teams:<chatId>|<id of the LAST message>` (`pipeline.ts:68`), independent of who is labelled OWNER,
and `buildCandidates` shows a stored verdict whenever `v.key === u.itemKey` (`pipeline.ts:251`). So a verdict stored
by the OLD code (the owner's own sentence judged as an ask) keeps its key after the fix and is still listed.

`bun repro2.ts` (stored verdict shaped exactly as the old code would have stored it for that key):
```
branch itemKey teams:19:a_b@unq.gbl.spaces|19%3Aa_b%40unq.gbl.spaces:m2 | last msg is owner's m2: true | settled true
candidate after fix: {"status":"open","who":"Pat Example","title":"Send the signed form by Friday","quote":"could you send me the signed form by Friday","reason":"Ellis, Von asks you to send the signed form."}
listed teams count: 1
```
After the fix the row is still listed, now attributed to the OTHER person while quoting the owner's own sentence.
Verdict: REFUTED that the deployed fix corrects the rows the owner is already looking at -- each stays until its
chat receives a new message. -> D-1.

## C2 -- settledGuard (Tier 1)

| test | observed | verdict |
|---|---|---|
| B1 other's ask AFTER owner's last | settled `false`; verdict `open`, kind `reply` | CONFIRMED (never dropped) |
| B2 equal timestamps (both insertion orders) | settled `false` both; verdict `open` | CONFIRMED |
| B3 other's time unparseable | settled `false` | CONFIRMED (fails toward showing) |
| edited messages | `at` is `createdDateTime` (`teams-log.ts:296`); an edit keeps its id and time, so ordering is unchanged | CONFIRMED by code read |
| B4 settled: `action` kept / `both` -> `action` / `reply` -> `none` + answeredByReply | as stated | CONFIRMED |
| B5 settled, reason "You haven't replied to Pat yet." | reason `null` | CONFIRMED |
| B5b settled, the TODO says "You have not replied to Pat: send the deck" | todo kept verbatim | D-6 (low) |
| B5c reason "You still need to resubmit the form." | kept (prompt-only, no deterministic guard) | D-6 (low) |
| B5d over-match "You can't reply-all on this list..." | reason nulled (harmless, reason line only) | noted |
| B6 unsettled, "You have not replied yet." | kept (true there) | CONFIRMED |

## C3 -- GROUNDING is additive

`branch.split(GROUNDED).join("") === main` for STEP2_INSTRUCTIONS, STEP3_INSTRUCTIONS, TEAMS_INSTRUCTIONS: `true`
for all three; GROUNDED appears exactly once in each; no other exported string constant differs from origin/main.
Verdict: CONFIRMED.

## C4 -- D1 (quote from ONE message)

Quote spanning two OTHER messages -> `false`; the owner's own sentence -> `false`; a span of one OTHER message -> `true`.
Verdict: CONFIRMED.

## C5 -- Meeting splitter

Input (synthetic): `**Pat Doe**`, `- Pat to send the deck (01:02)`, `Responsible person: Not stated.`, `Timestamp: (01:01-01:32).`,
`- Timing the launch with marketing`, `- Notes from Jane on budget`, `- Owner review of the vendor list`,
`- **Deadline**: submit the grant application by Dec 1`, `- Note: Von to send pricing to the client`, `Timing: Beyond two weeks, inferred`.
```
E items => ["Pat to send the deck","Timing the launch with marketing","Notes from Jane on budget","Owner review of the vendor list"]
E details => [[responsible person, timestamp],[],[],[deadline: submit the grant..., note: Von to send pricing to the client, timing]]
```
- Label-like words WITHOUT a colon stay items: CONFIRMED.
- A genuine bulleted item written `Label: <action>` is swallowed as a detail; `details` is read by nothing outside
  the splitter (grep), so the action disappears from Actions: D-7.
- `Notes:` alone (after a heading) is now a detail, so the next item inherits the PREVIOUS heading
  (`headings: ["Von Ellis","Von Ellis"]` for `Sam to book the room`). Shows more, never hides more: noted.
- meeting-triage suites 69/34/7 green.
Verdict: CONFIRMED with D-7.

## C6 -- Teams de-duplication

| test | kept | verdict |
|---|---|---|
| F1 same sender, different quotes | `["a","b"]` | CONFIRMED |
| F2 same sender, SAME short generic sentence ("Can you take a look at this?") in two different chats | `["b"]` | **REFUTED** -> D-2 |
| F3 different senders, same quote | `["a","b"]` | CONFIRMED |
| F4 shared proposalId, different senders and quotes | `["b"]` | depends on whether two asks can share a proposal; noted |
| F6 no `at` on either | `["a"]` | CONFIRMED (no crash) |
