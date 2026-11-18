# VERIFY alert-exclusions, loop 1

WHAT: independent verification of PR #286 (branch claude/modest-brown-2hdt5n, head 5c1ceb3f), claims C1..C7.
WHY: owner 2026-11-18, "Meeting minutes should not trigger Iris to send me a draft in the chat. It should be a part of an exclusion list."
SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE: probe scripts run with bun against the worktree source (not the test files); outputs pasted below.

| # | Claim | Verdict |
|---|---|---|
| C1 | Huddle minutes email excluded in every mode, no owed row, no Iris turn | CONFIRMED |
| C2 | Seed never excludes a person's ask unless the original subject contains "meeting minutes:"; replies/forwards screened normally | CONFIRMED |
| C3 | Runner reads the list by the save key; Actions off / read failure -> seed; nothing logged contains a subject or phrase | CONFIRMED |
| C4 | Saved list cannot be silently reset to the seed by any save path | REFUTED (narrow; read-failure paths) |
| C5 | No other caller's behaviour changed | CONFIRMED |
| C6 | UI field round-trips and shows what will be used | CONFIRMED (pure round-trip; not rendered in a browser) |
| C7 | Full suite passes | CONFIRMED |

## C1 -- CONFIRMED

Probe: every `minutesSubject(theme, date, isUpdate)` output for 17 themes (empty, null, "Re: budget", "Fw: thing", 300 chars,
Greek, Japanese, zero-width, Turkish I, ...) x 3 date labels x update/not, each also with "[EXT] ", "[External] ",
upper-cased, and the first colon replaced by a full-width colon, through `screenMessage(m, mode, mailbox, seed)` for
needs-reply / people / all, with a body that asks a question:

    C1 cases 1530 fails 0

Trace (inbound-email.server.ts runInboundEmailWatch): `verdict = screenMessage(m, mode, msgMailbox, skipSubjects)` then
`if (!verdict.keep) continue;`, which sits BEFORE `ledger.recordOwedEmail(...)` and `enqueueTurn(...)`/`runTurnById`.
So an excluded email gets no owed row and no turn, and does not count toward MAX_PER_RUN. grep shows runInboundEmailWatch
is the only caller of recordOwedEmail and inboundEmailDirective, and its only caller is routes/api/public/run-inbound-email.ts.
In screenMessage the exclusion check sits before `if (mode === "all")`, so "all" mode is covered (probe confirms).

## C2 -- CONFIRMED

`subjectExcluded(s, ["meeting minutes:"])` is false for every one of these, and for each one the screenMessage verdict with
the list is identical (JSON) to the verdict without it, in all 3 modes:
"Can you send me the meeting minutes?", "meeting minutes", "Meeting minutes for Tuesday?", "Minutes of the meeting?",
"meetingminutes: x", "Premeeting minutes: x", "The meeting minutesheet: x", and replies "Re:/RE:/Fwd:/FW:/AW:/TR:/WG:/SV:/RV:/ANTW:
Meeting Minutes: ...", "Re[2]:", "RE :", "re:" with no space, "[EXT] RE:", "[EXT][Ext] Fw:", "Re" + full-width colon,
leading zero-width space, "Fwd: Fwd:".

    C2 cases 25 fails 0

The codebase's other prefix rules (graph-email.server.ts:370 `(re|fw|fwd)`, proposals.ts:84 `(re|fw|fwd)`) are subsets
of REPLY_PREFIX, so every prefix the codebase knows is treated as a reply.
Subjects that DO contain the seed are excluded, as the claim allows: "Meeting minutes: Tuesday" true,
"Question on meeting minutes: can you resend?" true (a person's ask whose subject has "meeting minutes:" is silenced,
which is how the seed is meant to work). "Meeting Minutes : x" (space before colon) is NOT excluded; minutesSubject never
produces that shape.

## C3 -- CONFIRMED

Same key: loadAlertSkipSubjects reads `getActionsSettingsRaw(actionsConfig().owner)`; saveActionsSettings writes
`setActionsSettingsRaw(cfg.owner, s)` with `cfg = actionsConfig()`. Same function, same field.
loadAlertSkipSubjects with injected deps (the secret phrase "Secret Phrase Zebra" is placed in the error messages and in
the stored list):

    actions off ["meeting minutes:"]
    config throws ["meeting minutes:"]
    read throws ["meeting minutes:"]
    never saved (null) ["meeting minutes:"]
    saved [] []
    saved custom ["Secret Phrase Zebra"]
    saved non-array ["meeting minutes:"]
    owner key passed to readRaw: o@x
    logs: [... "using the default list Error", ... "using the default list TypeError"] leaks secret: false

Returned result: a decisions row is `{received, fromDomain, verdict, turnId?, delivered?}`; for an excluded email the
verdict is `{keep:false, reason:"excluded-subject"}`, with no subject and no phrase. No other new console call is in the diff.

## C4 -- REFUTED (narrow)

What holds: saveActionsSettings. A payload with no list, `null` or a string keeps the stored list, and an array is used
exactly:

    save missing lacks true -> ["custom one"]   save null -> ["custom one"]   save string -> ["custom one"]
    save array -> ["new"]   save empty array -> []

A failed stored read refuses the save (RT-6a). A stored list is idempotent under resolve, so correctActionItem's rewrite
keeps it when the read succeeds.

DEFECT: two writers can still put the seed over a saved list. Both go through `settingsFor` (actions.server.ts:51-53),
which turns a failed read into defaults with `getActionsSettingsRaw(cfg.owner).catch(() => null)`. `resolveActionsSettings(null).alertSkipSubjects`
evaluates to `["meeting minutes:"]`.
1. correctActionItem, "stop_list" path (actions.server.ts:477-483): `const s = await settingsFor(cfg)` then
   `setActionsSettingsRaw(cfg.owner, { ...s, hiddenSenders })`. Failing input: the owner has saved `["weekly digest"]`;
   `correctActionItem(caller, { reason: "stop_list", listSender: "x@y.com", ... })` runs while getActionsSettingsRaw
   rejects once (a pool timeout, say) and setActionsSettingsRaw then succeeds. The stored list becomes
   `["meeting minutes:"]`. hiddenSenders becomes `["x@y.com"]` and every other field goes back to its default too.
2. Page load (actions.server.ts:404, `const s = await settingsFor(cfg)`): a failed read silently serves the default
   settings, so the field shows the seed. The owner then changes any other setting (for example the range buttons at
   ActionsView:238, `saveSettings({ ...ok.settings, range })`). The payload now holds the seed as an array, so
   payloadLacksAlertSkipList is false and the seed is saved over his list.
Also (a design limit, not a reset path the PR introduced): a tab opened before the owner saved holds the seed array, and
any later save from that tab writes it back, because the whole object is replaced and the last write wins.
Both reset paths are the same exposure the other fields already had (hiddenSenders, ownNames). They need a read
failure followed by a successful write, so they are unlikely, but the claim as stated ("any save path") does not hold.

## C5 -- CONFIRMED

- proposals.ts:80 calls `screenMessage(m, "people", mailbox)` with no list. The new check is guarded by
  `excludeSubjects?.length &&`, so the verdict is unchanged and "excluded-subject" can never reach the `as SourceSkip` cast.
- stripReplyPrefixes: the new regex is `REPLY_PREFIX.source + "\\s*"` with flag i, which is byte-identical to the old
  literal `/^\s*(re|fw|fwd|aw|tr|wg|sv|rv|antw)(\[\d+\])?\s*:\s*/i`. 10 sample subjects compared against the old function: diff 0.
- bell.ts imports asksSomething, isAutomatedAddress, shortHash, and needs-you.ts imports newTextOnly. The diff does not touch
  any of these. `git diff --stat origin/main...HEAD -- src/.../correspondence src/.../proposals` is empty.
- inbound-email.ts has no imports, so the new actions.ts -> inbound-email.ts import cannot create a cycle or pull
  server code into the client.

## C6 -- CONFIRMED (logic only)

The onBlur logic, then the server resolve, then a JSON round-trip through the DB, then load(), gives back what the box shows:

    "meeting minutes:\nWeekly digest" -> box same, reload==box true
    "" -> box "", reload==box true (a cleared list stays empty)
    "  \n\nab\nMEETING MINUTES:\nmeeting minutes:\n  Status   report  " -> box "MEETING MINUTES:\nStatus report", reload==box true
    130-char line + "ok phrase" -> box "ok phrase" (the long line is dropped and visibly removed), reload==box true

The textarea `key` is the joined list, so a failed save rolls back (ActionsView:171) and remounts the field with the stored value.
Not rendered in a browser this loop. Nit: the comments at ActionsView.tsx:1039-1040 and actions.ts (alertSkipSubjects doc)
still say the seed is "meeting minutes" without the colon. The code seed is "meeting minutes:".

## C7 -- CONFIRMED

    bun test scripts/inbound-alert-exclusions.test.ts   -> 71 pass, 0 fail, 141 expect() calls
    bun scripts/inbound-email.test.ts                   -> 72 passed, 0 failed
    bun scripts/onedrive-feed.test.ts                   -> all passed
    bun scripts/actions-view.test.ts                    -> 264 passed, 0 failed
    bun scripts/actions-view-server.test.ts             -> 50 passed, 0 failed
    bun scripts/needs-you.test.ts                       -> 77 passed, 0 failed
    npx tsc --noEmit -p .                               -> exit 0, no output
