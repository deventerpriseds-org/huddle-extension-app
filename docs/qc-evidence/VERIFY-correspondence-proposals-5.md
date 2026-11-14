<!--
WHAT:          Independent verification (loop 5) of claude_task-proposals @ 03cabacc: re-derivation of every loop-4
               REFUTED / PARTIAL / MINOR item (D1 W1-W4/W7, D2 X1/X2, D3, D5, D6, STALE 4c/4d, 8.3), the 14
               implementer claims, the Chromium truth file, and the flags-OFF live-change table.
WHY:           Tier 1 (model output stored as proposals; live bell + live email screens touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-4.md (origin/claude_verify-correspondence-4)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify3-*.ts, scripts/verify4-*.ts (loops 3-4) and scripts/verify5-*.ts
-->

# VERIFY correspondence-proposals, loop 5

Started 2026-11-13 23:10 UTC, budget 3 h (ends 02:10 UTC). Isolated worktree at detached 03cabacc; compared against
origin/main 502e34e2 (live; 1 commit ahead of 03cabacc, ledger-only). No live system touched; synthetic `.example`
data only.

**Restart note (this run, 23:16 UTC):** the stub above came from a killed earlier start and is treated as unverified.
This run tests the verify branch checkout, whose `src/` is byte-identical to 03cabacc (`git diff 03cabacc HEAD -- src`
is empty; the only differences are this file and `scripts/verify3-*` / `scripts/verify4-*` probe scripts).
origin/main has since moved to 9a22b0cc (3 ledger-only commits ahead of 03cabacc: 502e34e2, 64170e84, 9a22b0cc).
Budget re-based: ends 02:16 UTC.

## Claim 0: full suite re-run at 03cabacc

| suite | implementer | observed (this run) |
|---|---|---|
| task-proposals | 203/0 | 203 passed, 0 failed |
| redteam-correspondence | 75/0 | 75 passed, 0 failed |
| correspondence-ingest | 149/0 | 149 passed, 0 failed |
| inbound-email | 72/0 | 72 passed, 0 failed |
| cross-app-turn-gate | 92/0 | 92 passed, 0 failed |
| feed-staleness | 73/0 | 73 passed, 0 failed |
| onedrive-feed-truth | 11/0 | 11 passed, 0 failed |
| proposals-preview | 5/0 | 5 passed, 0 failed |
| onedrive-feed, attention, attention-focus | -- | all passed |
| confirm-ask-context (main-side file) | -- | 21/21 passed |
| feed-staleness-sql (local PG 16) | 23/0 | 23 passed, 0 failed |
| task-proposals-sql | 45/0 | 45 passed, 0 failed |
| correspondence-ledger-sql | 50/0 | 50 passed, 0 failed |
| fireflies-queue-sql | -- | all passed |

Every implementer count reproduces exactly.

## Claim 0b: the two merges kept main's files intact

- Merge 0cb6d8a0 (parents 2cf5fa8d / main 8972f632, base e710fe27): 13 files touched only by main; all 10 non-ledger ones
  (`autowork.server.ts`, `PolishView.tsx`, `attention/focus.ts`, 2 tests, 2 skill check scripts, 2 workflows, 1 doc)
  are byte-identical to main (`git diff --stat 8972f632 0cb6d8a0 -- <files>` empty). One file touched by both sides,
  `HuddleView.tsx`: `git diff origin/main 03cabacc -- HuddleView.tsx` contains ONLY the branch's proposal-checklist
  code (2 imports, `propIds` reconcile, proposal row render); main's bell-jump `focusStep`/`FOCUS_WAIT_MS` code is
  present unchanged.
- Merge 03cabacc (parents 21928c16 / main aa29eef5, base 8972f632): main side touched only `.claude/actions.md`,
  `.claude/memory.md`, `graph-permission-check.yml`; the workflow is byte-identical to main.
- vs today's origin/main 9a22b0cc: every main-side code/workflow/skill file above is byte-identical. **CONFIRMED.**

---

## RESTART 2 (2026-11-14 00:02 UTC) -- re-targeted to b7dd9343

**The two claims above were run at 03cabacc, which is NOT the target.** The target b7dd9343 is 2 commits newer
(84b4a613 + b7dd9343, the urgent incomplete-file alert; `git merge-base --is-ancestor 03cabacc b7dd9343` true). This
run merged b7dd9343 into the verify branch (52964877); `git diff b7dd9343 HEAD -- src` is empty, so every probe below
runs against the target's source. Budget re-based: this run ends 03:02 UTC. Claim 0b (merge integrity) still holds:
b7dd9343 adds no merge; `git log 03cabacc..b7dd9343` is the 2 feature commits only.

## Claim 0 (re-run at b7dd9343)

| suite | implementer | observed at b7dd9343 |
|---|---|---|
| task-proposals | 203/0 | 203/0 |
| redteam-correspondence | 75/0 | 75/0 |
| correspondence-ingest | 149/0 | 149/0 |
| inbound-email | 72/0 | 72/0 |
| cross-app-turn-gate | 92/0 | 92/0 |
| feed-staleness | 95/0 | **95/0** (was 73 at 03cabacc: +22 new) |
| onedrive-feed-truth | 11/0 | 11/0 |
| proposals-preview | 5/0 | 5/0 |
| onedrive-feed / attention / attention-focus | -- | 61/0, 15/0, 27/0 |
| confirm-ask-context | -- | 21/0 |
| feed-staleness-sql (local PG 16) | 23/0 | **23/0 -- unchanged, so the 22 new incomplete-alert tests are in-memory only; none runs the real SQL** |
| task-proposals-sql / correspondence-ledger-sql / fireflies-queue-sql | 45, 50, -- | 45/0, 50/0, 14/0 |
| fireflies-minutes | -- | 64 pass / **3 FAIL (G3, G5, G8)** -- **pre-existing: origin/main bc6bd661 fails the same 3**; the branch's only fireflies diff is `export` on `fetchTranscript`. Not caused by this branch. |
| `tsc --noEmit` | -- | 0 errors at b7dd9343; 0 at origin/main |

---

## RESTART 3 (2026-11-14 01:35 UTC) -- re-targeted to 0396f71a

Budget re-based: this run ends 04:35 UTC. Verify branch = fb22507b + merge of 0396f71a (ec4d4c29).
`git diff b7dd9343 0396f71a --stat` = exactly 3 files: `scripts/fixtures/preview-fetch-stub.ts` (2 +-),
`scripts/proposals-preview.test.ts` (+1), `scripts/proposals-preview.ts` (+33 -3). **No `src/` change**, so every
Claim-0 suite result at b7dd9343 carries to 0396f71a except the preview suite. `git diff 0396f71a HEAD -- src
scripts/proposals-preview* scripts/fixtures` is empty.

## Claim 0c: suites changed by 0396f71a

| suite | implementer | observed at 0396f71a |
|---|---|---|
| proposals-preview | 6/0 | **6/0** (PV-1..PV-6) |
| `tsc --noEmit` | -- | **exit 0, no output** |

## Claim 11: the Chromium truth fixture is real -- CONFIRMED

`node scripts/html-visible-text-truth.mjs` re-run here against `/opt/pw-browsers/chromium-1243`: wrote 81 cases and
`git diff -- scripts/fixtures/html-visible-text-truth.json` is **empty** (byte-identical, incl. the recorded chromium
path). The fixture has one commit (ac0a5a8f) and is reproducible from the generator, so it was not hand-edited.
`bun scripts/onedrive-feed-truth.test.ts`: 11/0. 80/81 rows match exactly; the 81st is `LEAK-formatting-reopened`
(keeps more). CONFIRMED.

## Claims 1-3 (D1 W1-W3, W4, W7): fixed on the recorded shapes -- REFUTED on new shapes

W1, W2, W3, W4 (one copy survives), W7 match Chromium exactly (fixture rows, truth suite 11/0). To test beyond the
implementer's 81 rows, `scripts/verify5-html-cases.mjs` records 44 NEW shapes x {doctype, quirks} = 88 rows through the
same Chromium extraction, and `scripts/verify5-html-compare.ts` scores branch and origin/main `htmlToText` against it
(DROP = a word Chromium shows is missing). Branch: 47 OK / 16 KEEP+ / **25 DROP**; main: 22 OK / 64 KEEP+ / 2 DROP.
**23 rows are DROP on the branch and not on main** (flags OFF, live work-email screen):

| shape (synthetic) | Chromium | branch | main | realism |
|---|---|---|---|---|
| F1 `<p><b style="display:none">pre<table><tr><td>Can you sign the NDA?</td></tr></table>` | ask | **""** | kept | medium: W1-class unclosed hidden element; ask in a layout table |
| F2 same with `<font>`, `<strong>` (+ `<p>Thanks</p>` after: "Thanks" survives, ask dropped), `<a>`+`<center>` | ask | **""** | kept | as F1 |
| F3 `<ul><li><b style="display:none">pre<li><table><tr><td>ASK` and `<p><b ...>pre<p><table>...ASK` | ask (doctype AND quirks) | **""** | kept | as F1 |
| C1 `style="color:red; /* display:none */"` | ask | **""** | kept | low |
| C2 `style="display:none; display:block"` (later declaration wins) | ask | **""** | kept | low |
| C3 `style="display:nonex"` (invalid value) | ask | **""** | kept | very low |
| K1 `<!-->ASK<!-- x -->` / `<!--->ASK...` (abrupt empty comment) | ask | **""** | kept | low |
| K2 `<!-- x --!><p>ASK</p><!-- y -->` (`--!>` closes a comment) | ask | **""** | kept | very low |
| G1 `<div style="display:none"><img alt="a > <div>">pre</div><p>ASK</p>` (`>` inside a quoted value) | ask | **""** | kept (+junk) | very low |

Root causes:
- F1-F3: `onedrive-feed.ts:581` skips the ancestor-close rule for every FORMATTING element ("the browser re-opens
  it"), so `elementEnd` runs to the end of the document. The browser re-opens a formatting element only up to the
  last **marker** in the active-formatting list; a `<td>`/`<th>`/`<caption>` pushes a marker, so text in the next
  table cell is NOT re-wrapped in the hidden `<b>` and is visible. The code has no marker notion.
- C1-C3: `HIDDEN_STYLE` (`:408`) is a substring regex over the raw style text: it sees declarations inside CSS
  comments, ignores the cascade inside one attribute, and has no word boundary after `none`.
- K1/K2: `htmlToText` (`:700`) strips comments with `/<!--[\s\S]*?-->/`; the HTML tokenizer also ends a comment at
  `<!-->`, `<!--->` and `--!>`. Main never stripped comments, so this is new on the branch.
- G1: every tag regex (`:456`, `:573`, `:643`) ends a tag at the first `>`, including one inside a quoted value
  (`attrsOf` itself is correct; the tag it is handed is already truncated). Main shares the regex but never stripped.

Also observed, keep-more only (acceptable direction): self-closing `<span style="display:none"/>` (browser keeps the
span open), `<noscript>`, `<template>`, `visibility:collapse`, an unclosed trailing `<!--`, `<textarea>` content, the
known re-opened `<b>` (`FMT-b-div-div`), and `>` in a hidden tag's own attribute (junk kept).

**Verdict for claims 1-3: the five recorded shapes are fixed; the D1 class ("flag-off live screen drops visible
text") is NOT closed.** F1-F3 is the same class loop 4 blocked on (an unclosed hidden inline element whose parent
closes implicitly), reached with a formatting tag and an ask in a table cell -- the commonest place for an ask in
an HTML email. Blocking under this loop's rule ("any OTHER flag-off live change, especially dropped visible text, is
still a defect"). C/K/G are rarer; listed for the fix pass.

## Claims 4 + 12 (D2 X1/X2, `newTextOnly` vs main) -- X1/X2 FIXED; sweep REPRODUCED; guard weaker than claimed

`scripts/verify5-newtext-probes.ts` (branch vs origin/main `newTextOnly`), `scripts/verify5-literal-sweep.ts`.

- X1, X2 verbatim: branch output == main output (ask kept). **FIXED.**
- Sweep (TypeScript AST over the inbound-email, redteam, ingest and task-proposals suites): **1486 literals, 19 differ**
  (implementer counted 1436; my walker also joins template expressions). The 19 are exactly the implementer's list:
  7 one-line foreign attributions, 6 foreign header blocks, 6 two-line wrapped attributions; every one keeps only the
  greeting line before quoted history. **REPRODUCED.**
- NEW spellings, cut direction (branch cuts, main keeps the whole body):

| id | body (synthetic) | branch keeps | why it passes `isWrappedAttribution` |
|---|---|---|---|
| X3 | `Quick note.` / `On the 12 open items from 2024 we may still owe Finance, and Dana` / `wrote:` / `Can you send the ledger by Monday?` | "Quick note." | `may` is in DATE_NAME |
| X4 | `On the 3 invoices from 2025 it turns out Pat` / `Kim wrote:` / `Can you approve the PO by Friday?` | "" | `out` (Portuguese Oct) |
| X5 | `On Friday 14 at 10:30 the vendor called and Legal` / `wrote:` / `Can you sign the NDA today?` | "" | weekday + day + time |
| X6 | `On the 2 dates set for 2026 Ops` / `wrote:` / `Can you confirm the venue?` | "" | `set` (Portuguese Sep) |
| N-da | `Da: the team` / `Data: attached below` / `Can you review it today?` | "" | it header pair `Da:` + `Data:` |

  `DATE_NAME` (`inbound-email.ts:118`) includes 3-letter foreign abbreviations that are common English words
  (`may`, `out`, `set`, `sun`, `sat`, `mar`, `dom`, `ago`), so the "weekday or month name" test is satisfied by
  ordinary English. Every X3-X6 joined line is a sentence main's OWN single-line rule (`^\s*On .+wrote:\s*$`) already
  cuts when it is not wrapped, so this extends a false-positive main already has rather than creating a new class.
- Keep direction: real Gmail wraps (`On Mon, Nov 10, 2025 at 9:14 AM Dana Kim <dana@...>` / `wrote:`; name-only
  variant), a real French header block and a real German one-line attribution are all cut. CONFIRMED.

**Verdict: claim 4 PARTIAL (X1/X2 fixed; the shape guard is satisfied by English words). Claim 12 CONFIRMED on its
corpus; new spellings X3-X6/N-da cut English text main keeps.** Not blocking on its own: it is main's existing
single-line false positive reaching a hard-wrapped line, and the cut content is always text after "<X> wrote:". The
two-line English wrap cut is itself NOT one of the three owner-approved changes (only non-English quoted history
is); it should be listed to the owner as a fourth live change. Fix candidate: English-only names in DATE_NAME for
the English opener.

## Claims 7, 8, 9 + real-file note (D5, D6, D3, Teams dedup) -- CONFIRMED (two minor residues)

`scripts/verify5-d356-probes.ts`, synthetic data.

| claim | probe | observed |
|---|---|---|
| 9 / D3 | owner reply = only `<customemoji>`, `<CUSTOMEMOJI>` (upper), `<emoji>`, `<animatedemoji>` | kept 1 each (not skipped) |
| 9 / D3 negatives | whitespace-only `<pre><code>`, `<span class="emoji">` (class, no element), empty body | `empty`, skipped -- correct |
| 9 / D3 left open | `<video>`-only reply | skipped `empty` (the documented open item) |
| 7 / D5 | "Nobody should", "No one should", "No-one should", "NO ONE is to", "No one, repeat, should", "Nobody here may", "No one else should" ... send the contract | all `evidence_negated` |
| 7 / D5 positive | "Nobody forget to send ..." | accepted (affirmative) |
| 7 / D5 residue | `No‑one` (non-breaking hyphen) | **accepted** -- minor, the separator class is `[\s-]` |
| 7 / D5 residue | "No one objected, so send the contract ..." | refused -- safe direction (a missed proposal, not a wrong one) |
| 8 / D6 | titles "Do not / Don't / Never / Cannot / Hold off on sending / Stop sending / Send no deck ..." from evidence "send the deck to finance" | all refused (`task_not_grounded`; the claim's wording says `evidence_negated`, the reason code is `task_not_grounded` -- either way refused) |
| 8 / D6 positive | "Send the deck to finance" | accepted |
| real-file note | lines `(c1,m1)`, `(c1,m1)` edited, `(c2,m1)`; each line carries `ownerUserId` plus unknown keys `futureKey`, `zz` | 2 messages: `(c1,"edited copy")` (last copy wins) and `(c2, ...)`; nothing skipped -- dedup on (chatId, message.id) and unknown keys ignored. CONFIRMED |

**Claims 7, 8, 9 CONFIRMED.** The two D5 residues are minor and non-blocking (the proposals flag is off).

## Claims 5, 6, 14, 15, 16 (staleness + the urgent incomplete alert) against the REAL bell SQL

`scripts/verify5-staleness-sql.ts`: real `applyFeedStaleness` + real `raiseFeedAttention` / `clearFeedAttention` /
`notePendingFeedAttention` / `listOpenAttention` on a throwaway local PostgreSQL 16, with a counting notifier.
(The implementer's `feed-staleness-sql.test.ts` has NO incomplete case: its count is still 23 at b7dd9343.)

### Claim 5 (4c) and 6 (4d) -- CONFIRMED

| probe | observed |
|---|---|
| dismissed stale row + a transient read | stays `dismissed` |
| dismissed stale row + ONE 403 | stays `dismissed` (pending only) |
| dismissed stale row + 403, transient, 403 | reopened `owed/unreadable` (2 non-transient checks; a different hard reason = something new) |
| fresh owner, ONE 403 | 0 listed; 403, fresh, 403 -> 0 listed (a fresh check breaks the run); then a 2nd consecutive 403 -> 1 listed |
| `readFeedFileMeta` | 404 -> missing, 403 -> unreadable, every other status / throw / bad date -> transient (read in code, `onedrive-feed.server.ts` readFeedFileMeta) |
| `feed_pending` | `ALTER TABLE ... ADD COLUMN IF NOT EXISTS feed_pending TEXT` (nullable, no default): harmless to existing rows |
| 4d: 60 newer open email rows + a feed row 12 days older | `listOpenAttention` returns 50, feed row FIRST; the other 49 still newest-first |
| no feed rows (flags OFF) | order identical to main's `ORDER BY coalesce(received_at, created_at) DESC` (`(kind='feed') DESC` is false for every row) |

### Claim 14 -- CONFIRMED

`validateEnvelope` (`onedrive-feed.ts:280`, `e.complete !== true -> "incomplete"`) is not in the branch diff (no
diff line in `onedrive-feed.ts` mentions it), so a `complete:false` email/sent file is refused exactly as main.
`feedStateKey(cfg, kind)` = `` `${kind}:${cfg.driveUser}:${cfg[kind].path}` `` and main's inline key is
`` `${kind}:${cfg.driveUser}:${file.path}` `` with `file = cfg[kind]` -- identical for `email` and `appointments`; the
`sent` key is new. `fetchDriveFile`'s eTag short-circuit receives `state.last_good ? state.etag : null`, which is
main's `etag && state.etag === etag && state.last_good` condition. No live key changed.

### Claim 15 (`incomplete` state) -- CONFIRMED as specified

`decideFeedStaleness` probes: read at/after lm -> incomplete; incomplete beats a 3-day-stale lm; missing and
unreadable beat incomplete; a copy republished after the read -> `transient` for 1h59 and falls through at 2h01;
`teams` with an incomplete read -> `fresh` (never incomplete); the server passes `read: null` for teams
(`feed-staleness.server.ts` `f.file !== "teams"`). `readFeedStatus` is one `SELECT last_status, checked_at` (no
Graph call). `readFeed`'s `fail()` records `checked_at = now()` on every refused read, so `checkedMs` advances on
each re-read of an incomplete copy.

### Claim 16 ("once per incident") -- REFUTED

| step (ONE incident: every copy the flow publishes is `complete:false`) | decision | bell row | announced |
|---|---|---|---|
| U1a Thu 22:10 ET, reader saw the 21:30 copy incomplete at 22:00 | incomplete | owed/incomplete | **#1** |
| U1b 22:20 re-check | incomplete | unchanged | -- |
| U1c 23:10, flow republished (still incomplete) at 23:00, unread | transient | unchanged | -- |
| U1d Fri 00:10, last read 2h10m ago | **fresh** | **replied (auto-cleared)** | -- |
| U1e Fri 07:10, hourly reader read the 23:00 copy: still incomplete | incomplete | reopened owed | **#2** (chat + push + email) |

Same incident announced twice, and between 00:10 and 07:10 the bell showed the alert cleared while the file was
still incomplete. Cause: `feed-staleness.ts:164-168` -- once `checkedMs < lm` for 2 h, the decision falls through to
plain staleness, and a recently-modified UNREAD copy is "fresh", which clears the row (`applyFeedStaleness` ->
`store.clear`). A fresh last-modified time says nothing about completeness. Reachable in practice: the email
reader runs from the inbound watch (hourly 07-22 ET, `scheduling-config.server.ts:100`) and the ingest heartbeat
only when `correspondence.ingest` is on; the SENT reader runs only inside `reconcileRepliedFromSentItems` when an
owed feed row exists, so sent can go unread for hours or days while the flow republishes on every sent mail.

U4 (second path): a row created as incomplete has `received_at NULL`; the owner DISMISSES it; the flow republishes
(incomplete) and it is unread for 2 h+ and older than 6 working hours -> decision `stale`, and the dismissed row
REOPENS (`raiseFeedAttention` reopens a dismissed row when `e.received_at IS NULL`); the reader then reads the copy
-> `incomplete` differs from the open `stale` episode -> row written -> **announced again** (2 announcements; the
owner's dismiss did not hold for the incident).

Held: re-checks of an open incomplete row write nothing (U1b); a dismissed incomplete row stays dismissed and
silent while the reader keeps seeing incomplete copies (U2a/U2b, 0 announcements); an open stale row turning
incomplete announces exactly once and repeated checks add nothing (U3, 1 announcement).

Not blocking for merge with flags OFF (staleAlerts gates all of it), but it blocks switching `staleAlerts` on:
the urgent channel (chat + push + email) can repeat for one incident, and the bell can show it cleared while the
file is still incomplete. Minimal fix direction: while the last read is `rejected:incomplete`, an UNREAD newer copy
should stay `transient` (or `incomplete`) until the reader actually reads it, never fall through to `fresh`.

## Claim 13 + 19: mutation proofs re-run with `mutate.sh` -- CONFIRMED (7/7, every exit code 0)

Anchors/replacements in files (`scratchpad/mut/*.anchor|*.repl`), each run alone; `git status --short` empty after.

| mutation | file | named test | verdict | exit |
|---|---|---|---|---|
| W1-W3: ancestor-close rule off (`if (false && ancestors.length ...`) | onedrive-feed.ts | TRUTH W1-W3 | FIRED (control EQUIVALENT) | 0 |
| X1/X2: shape guard back to "any digit" | inbound-email.ts | D2 X1/X2 hard-wrapped | FIRED (control EQUIVALENT) | 0 |
| staleness 2-check: notePending bypassed (`&& false &&`) | feed-staleness.ts | T3 a 403 ... 2nd consecutive check | FIRED (control EQUIVALENT) | 0 |
| D6: title-negator check always ok | proposals.ts | D6 loop 4: a title that negates ... | FIRED (control EQUIVALENT) | 0 |
| M2 (claim 19): drop `ok &&` before announce | feed-staleness.ts | I12 | FIRED (control EQUIVALENT) | 0 |
| M3 (claim 19): drop the 2 h reader wait | feed-staleness.ts | I4 | FIRED (control EQUIVALENT) | 0 |
| PV-6 (claim 20): HTML PUT only with PREVIEW_EMAIL=1 | scripts/proposals-preview.ts | PV-6 | FIRED (control EQUIVALENT) | 0 |

The guards are real. Note M2/I12 prove "an already-showing row is not re-announced"; neither covers the clear-then-
reopen path of claim 16 (U1/U4), which no test exercises.

## Claim 17 (channels independent, send gate, caller) -- CONFIRMED (send gate: inference)

- `announceUrgentFeed` (`feed-staleness.server.ts`): chat and email are two separate try/catch blocks; `sent` is
  true if either succeeded; it never throws, and `applyFeedStaleness` wraps the notifier in its own try/catch after
  the row is written, inside the per-file loop -- a notifier failure cannot undo the bell row or stop the next file.
- `caller: { entra_email }` + `internal: true` + `enqueueTurn` then `runTurnById` is the same shape the live
  reminders close-out (`reminders.ts:290-307`), job-check and inbound-email (`inbound-email.server.ts:231-237`)
  turns use. CONFIRMED by precedent.
- Self-email: `sendGraphEmail` -> `resolveRecipientScope` -> `classifySendScope`: a recipient that is the caller's
  own `profile_emails` row with tier `auto` (explicit, or source `entra`) is `send` and skips the global send flag.
  `ownerLogins[0]` is the owner's Huddle (Entra) sign-in, so it should resolve `auto` -- **inference, not proven**:
  it depends on the live `profile_emails` row, which this loop may not read. If it resolves `on-request`, the email
  is refused by the gate (logged `urgent email not sent file=<f> (send gate)`) and the chat still goes out.
- Logs: `urgent chat failed file=<f>`, `urgent email not sent file=<f>`, error class name only. CONFIRMED.
- Observation (not a defect): `runTurnById` runs the whole Iris turn inline, inside the heartbeat's
  `Promise.all([pass, stale])`, before the next file is checked; the live reminder close-out does the same.

## Claim 18 (flag) -- CONFIRMED

`runFeedStalenessCheck` with `correspondence.staleAlerts` = absent, `"true"`, `1`, `"yes"`, `false`: parsed to
`false`, returns `null`, zero dependency calls (no meta read, no status read, no store, no notify, no log). Only
literal `true` runs. `runCorrespondenceIngest` returns before even importing `feed-staleness.server` when off.

## Claims 10 + 20 (preview script) -- CONFIRMED

- 8.3: PV-1 passes (a non-JSON file logs `<label>: not JSON` and none of its content). Every `console.log` in the
  script (14 lines) prints statuses, counts, reason names, the model name and OneDrive paths only; the two new
  ones are `teams: owner taken from the file's ownerUserId field` / `... disagrees across lines (<n> values)`.
- HTML report: `PUT /automation/Huddle Preview/open-vs-replied-report-<stamp>.html` now runs on every run (PV-6,
  mutation FIRED); `sendMail` is still inside `if (process.env.PREVIEW_EMAIL === "1")`, unchanged.
- `ownerUserId`: used only when the config has no `ownerSenderIds`, and only when every line that states it
  agrees (set size 1); the id is never printed. Upper-case ids in the file match a lower-cased owner list in the
  parser (probe: `fromOwner: true`).
- Nit: the HTML footer still says "identified by a best guess for this run" even when the file's `ownerUserId`
  was used. Cosmetic, preview-only.

## Reduced-depth re-checks of loop-4 CONFIRMED items

Basis: the Claim 0 suite re-run at b7dd9343 (every count reproduces; 0396f71a changes no `src/`) plus one probe each
(`scripts/verify5-spot-probes.ts`, `scripts/verify5-d356-probes.ts`, claim 18 above).

| item | spot probe | result |
|---|---|---|
| 4.5 / 4.13 | external ask then owner reply: text / `<customemoji>`-only / image-only -> `decideChatThread` | answered x3; control with no owner reply -> open. CONFIRMED |
| 5.19 | D5/D6 table above | CONFIRMED (two minor D5 residues) |
| 6.1 | `runCorrespondenceIngest()` with no config, and with config but no correspondence flags | `null`, `null`. CONFIRMED |
| STALE flag OFF | claim 18 | zero calls. CONFIRMED |

## The flags-OFF live-change table, rebuilt at 0396f71a

Files that changed in `src/` since loop 4's head 2cf5fa8d: the fix files plus `autowork.server.ts`, `PolishView.tsx`,
`focus.ts`, `HuddleView.tsx` -- the first three are byte-identical to origin/main (`git diff --stat origin/main
0396f71a` empty) and HuddleView differs from main only by the proposal checklist (Claim 0b). `AttentionBell.tsx`,
`attention.ts`, `tools.ts`, `huddle.functions.ts`, `scheduler.server.ts`: no change since 2cf5fa8d, so loop-4 rows
3, 4, 8, 9 carry over unchanged.

| # | change on merge with every flag OFF | status |
|---|---|---|
| 1a | work-email `htmlToText`: hidden text removed; more entities decoded | **owner-approved** |
| 1b | work-email `htmlToText`: HTML comments stripped (so Outlook-only `[if mso]` copies are no longer shown) | part of "hidden text ignored"; acceptable |
| 1c | work-email `htmlToText`: **visible text dropped** -- F1-F3 (hidden unclosed `<b>/<strong>/<font>/<a>` in a `<p>`/`<li>` closed implicitly, ask in a table cell), C1-C3 (CSS comment / later declaration / invalid value), K1-K2 (`<!-->`, `--!>`), G1 (`>` in a quoted value). W1-W4/W7 themselves are fixed | **DEFECT (F1-F3 blocking)** |
| 2a | `newTextOnly` (main mailbox + work feed): non-English quoted history cut | **owner-approved** |
| 2b | `newTextOnly`: an English Gmail attribution hard-wrapped over two lines is now cut (main cut it only on one line); X3-X6 / N-da show it also cuts some English text after "<X> wrote:" | **not in the approved list -- tell the owner**; non-blocking (extends main's own one-line false positive) |
| 3 | Bell settings "Teams chats" checkbox; `chat` in defaults (loop 4 row 3) | unchanged from loop 4 |
| 4 | Bell renders `link` / uses `badgeCount` (no effect without chat rows) | unchanged |
| 5 | `settleAttentionForHuddle` excludes `chat` and `feed` (no effect without such rows) | unchanged in effect |
| 6 | `chat.email_replies` gains nullable `needs_context`, `source_link` **and `feed_pending`** at the next bootstrap | additive DDL, harmless |
| 7 | drive metadata `$select=id,eTag,size`, `method:"GET"` forced; `feedStateKey` extraction | no live key or behaviour change (claim 14) |
| 8 | heartbeat imports the ingest / proposals modules; staleness module NOT imported when off | no work done |
| 9 | `build_checklist` gains `proposals` (returns `not_enabled`) | unchanged |
| 10 | feed owed rows settle from sent.json only when `sent` is configured (opt-in) | unchanged with it off |
| 11 | `listOpenAttention` `ORDER BY (kind='feed') DESC, ...` | **no effect without feed rows** (real SQL, V3) |

## Judgement calls asked for

| item | judgement |
|---|---|
| keep-more: re-opened `<b>` (`LEAK-formatting-reopened`, `FMT-b-div-div`) | acceptable: extra hidden text is noise, never a missed ask |
| keep-more: `display:/*x*/none` | acceptable (same direction) |
| keep-more: `<table>` in an open `<p>` without a doctype (quirks) | acceptable (same direction). NOTE its mirror image is F1-F3, which drops |
| open: `<video>`-only Teams reply | non-blocking: the chat stays owed (a nag, not a lost ask); bell is flag-gated |
| open: bell client sorts by time | non-blocking: the server now always includes the feed row (V3); it may not render first |
| open: missing-file alert one check later | non-blocking: the 2-check rule costs ~10 minutes by design and is what fixed V1/V2 |

## Per-AC / per-claim table (target 0396f71a)

Basis: S = suite re-run green (Claim 0 at b7dd9343 + Claim 0c at 0396f71a); P = my probe this loop; M = mutate.sh this
loop; R = code read; Q = real SQL on local PG this loop; C = real Chromium this loop.

| item | verdict | basis |
|---|---|---|
| 1.1-1.13, 2.1-2.7, 3.1-3.10, 4.1-4.4, 4.6-4.12, 5.1-5.5, 5.7-5.18, 5.20-5.23, 6.3, 6.5, 6.7, 7.1-7.3, 8.1, 8.2 | CONFIRMED (carried; no `src/` change touches them that the suites do not cover) | S |
| 4.5 / 4.13 | CONFIRMED (incl. `<customemoji>`-only reply) | S + P |
| 5.19 | CONFIRMED; minor residue `No‑one` accepted | S + P |
| 6.1 | CONFIRMED | S + P |
| **6.4** (flags OFF: no unapproved live change) | **REFUTED**: F1-F3 / C1-C3 / K1-K2 / G1 drop visible text; row 2b is an unapproved (benign) change | C + P |
| 8.3 | CONFIRMED | S + P |
| Claim 1-3 (W1-W3, W4, W7) | recorded shapes FIXED; D1 class **NOT closed** (F1-F3) | C + S + M |
| Claim 4 (X1/X2) | PARTIAL: X1/X2 fixed; `DATE_NAME` matches English `may/out/set/...` (X3-X6) | P + M |
| Claim 5 (4c staleness) | CONFIRMED | Q + M |
| Claim 6 (4d ordering) | CONFIRMED | Q |
| Claim 7 (D5) | CONFIRMED | P |
| Claim 8 (D6) | CONFIRMED (reason code is `task_not_grounded`) | P + M |
| Claim 9 (D3) | CONFIRMED | P |
| Claim 10 (preview 8.3, header) | CONFIRMED | S + R |
| Claim 11 (Chromium truth fixture) | CONFIRMED: regenerated byte-identical; 80/81 exact, 1 documented keep-more | C + S |
| Claim 12 (`newTextOnly` vs main) | CONFIRMED on its corpus (1486 literals here, 19 differ, all quoted history); new spellings X3-X6 differ | P |
| Claim 13 (mutation proofs) | CONFIRMED: W1-W3, X1/X2, 2-check, D6 all FIRED (control EQUIVALENT), exit 0 | M |
| Claim 14 (`complete:false` refused; `feedStateKey` pure) | CONFIRMED | R |
| Claim 15 (`incomplete` state) | CONFIRMED as specified | P + R |
| **Claim 16 (once per incident)** | **REFUTED**: U1 / U4 re-announce one incident; bell shows it cleared while the file is still incomplete | Q |
| Claim 17 (independent channels, gate, caller) | CONFIRMED; self-send `auto` tier is inference | R |
| Claim 18 (flag) | CONFIRMED | P |
| Claim 19 (M1-M4) | CONFIRMED for M2, M3 (FIRED, control EQUIVALENT, exit 0); M1/M4 not re-run | M |
| Claim 20 (preview HTML to OneDrive, ownerUserId, logs) | CONFIRMED; cosmetic footer nit | S + M + P |
| STALE working-hours / Teams rule / one row per file / auto-clear / Iris does not clear / counts-only logs | CONFIRMED (carried) | S |
| STALE flag OFF | CONFIRMED | P |
| Real-file note (dedup on chatId+message.id; unknown keys ignored) | CONFIRMED | P |

UI note: none of this loop's claims is browser-only; the bell / checklist UI rows (loop-4 rows 3, 4) were not driven
in a browser in this loop. If this lands, it lands MERGE-PENDING-UAT for those rows.

## Verdict: FIX FIRST

PASS (CONFIRMED) 22 claim rows | FAIL (REFUTED) 3 (6.4, claims 1-3 class, claim 16) | PARTIAL 1 (claim 4) |
UNVERIFIED 1 (claim 17 self-send tier, needs the live profile row) | UI-UNVERIFIED: bell/checklist UI (not in scope here)

### Blocking for merge (live with every flag OFF)

1. **`src/features/huddle/lib/external-feeds/onedrive-feed.ts:581`** -- the ancestor-close rule is skipped for every
   formatting element, so a hidden unclosed `<b>/<strong>/<font>/<a>` runs to the end of the document. The browser
   re-opens it only up to the last marker (`td`/`th`/`caption`), so an ask in the next table cell is visible.
   Minimal repro (Chromium shows the ask with or without a doctype for the `li`/`p` variants; main keeps it):
   ```
   htmlToText('<ul><li><b style="display:none">pre<li><table><tr><td>Can you sign the NDA?</td></tr></table></ul>')  // branch "" ; main "pre Can you sign the NDA?"
   htmlToText('<p><b style="display:none">pre<table><tr><td>Can you sign the NDA?</td></tr></table>')              // branch "" (doctype: Chromium shows it)
   ```
   Rarer drops for the same fix pass: `onedrive-feed.ts:408` `HIDDEN_STYLE` (CSS comment, later declaration,
   `display:nonex`), `:700` comment regex (`<!-->`, `--!>`), `:456/:573/:643` tag regex ending at a `>` inside a
   quoted value.

### Blocking before `staleAlerts` is switched on (not live at merge)

2. **`src/features/huddle/lib/correspondence/feed-staleness.ts:164-168`** -- after 2 h with an unread newer copy, the
   decision falls through to plain staleness; a recently modified unread copy is `fresh` and CLEARS the incomplete
   row; the next read of the (still incomplete) copy reopens it and the urgent chat + push + email go out again.
   Repro: `scripts/verify5-staleness-sql.ts` U1 (2 announcements for one incident; bell cleared 00:10-07:10 ET while
   the file stayed incomplete) and U4 (an owner-dismissed incomplete row comes back as `stale`, then re-announces).
   At most one repeat per >= 2 h reader gap, not per heartbeat.

### Tell the owner (non-blocking)

3. Row 2b: the two-line English Gmail attribution cut is a fourth flag-off live change, not one of the three approved.
4. `inbound-email.ts:118` `DATE_NAME` lets English words (`may`, `out`, `set`, ...) satisfy the date test (X3-X6).
5. D5 residue `No‑one`; preview footer wording.
