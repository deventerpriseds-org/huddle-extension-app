# BUILD -- correspondence tuning fixes (branch `claude_correspondence-tuning-fixes`)

WHAT:       Progress log for the owner's 2026-11-16 tuning batch: forwarded emails stored without their forwarded part,
            stale proposals-preview defaults, DB firewall cleanup, the browser UAT suite starting a real stand-up, and
            anything else small found on the correspondence path.
WHY:        Owner 2026-11-16: "about 3 of 5 forwarded emails lost the forwarded part when they were stored, so the AI
            only sees the cover note. That's a tuning fix that should be handled now along with anything else noticed
            besides the meetings action items."
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   this file; commits on the branch; docs/qc-evidence/BUILD-report-from-ledger.md finding 3.

Out of scope on purpose: the "From meetings" action-item selection (owner tunes later) and the Actions-view UI
files (branch `claude_actions-view` owns them). THIS REPO IS PUBLIC: every fixture below is synthetic.

Base: origin/main `046ec493` (contains `ece03e60`).

## Log

- Started. Baseline suites on main: forwarded 22/0, correspondence-ingest 186/0, report-from-ledger 39/0,
  redteam-correspondence 77/0, needs-you 77/0, onedrive-feed all passed.

## Fix 1 -- forwarded emails stored without the forwarded part

**Root cause (read from the code, reproduced with synthetic fixtures).** `emailContent()` (source-item.ts) stores
`bodyText = mapFeedMessage(rec).bodyText`, which for an HTML body is `htmlToText()` (onedrive-feed.ts). That function
deliberately drops everything from Outlook's `<div id="divRplyFwdMsg">` / `<div id="appendonsend">` on, and every
`<blockquote>` -- correct for Iris's live text (quoted history is not this email's ask), but it was the ONLY stored
copy. `forwardedText()` (forwarded.ts) does read the forwarded part, but only on RAW records in the files-path scan;
the ledger path could only call it on the already-cut stored text, so it recovered plain-text forward headers only.

Reproduction (bodyText the ledger stores, before the fix):

| shape | stored bodyText | forwarded ask in store? |
|---|---|---|
| Outlook web / mobile (`divRplyFwdMsg`) | cover note only | NO |
| new Outlook (`appendonsend` + `divRplyFwdMsg`) | cover note only | NO |
| `[EXTERNAL] FW:` / `EXT: FW:` (same Outlook marker) | cover note only | NO |
| Apple Mail (`<blockquote type="cite">`) | cover note only | NO (and `forwardedText` returned null) |
| classic Outlook desktop (border-top header div, no id) | full text | yes |
| Gmail (`---------- Forwarded message ---------`) | full text | yes |
| plain text (`-----Original Message-----`) | full text | yes |

That matches "about 3 of 5": the Outlook-marker shapes lose it, the plain-header shapes keep it.

**Change.**
- `forwarded.ts`: new pure `forwardedPart(subject, rawBody, isHtml)` -> `{from, sent, to, cc, subject, body}` (header
  labels in English + the locales `newTextOnly` already knows; separator lines skipped; the body's OWN history cut
  by `newTextOnly`), and `forwardedPartText()` to render it for the judge. `forwardedText()` gains ONE fallback: when
  no Outlook marker and nothing else was found, the FIRST `<blockquote>` is read as content (Apple Mail); nested
  blockquotes are still dropped.
- `onedrive-feed.ts`: the raw-body read inside `mapFeedMessage` moved to an exported `feedRecordBody(rec)` (same
  logic, so the store reads the forwarded part from the exact raw body the mapper read).
- `source-item.ts`: `EmailContent.forwarded?` (present only for a forward with a readable forwarded part). `bodyText`,
  the content hash and the in-memory `item.email` the processors read are UNCHANGED. `planForwardRefill()` (pure)
  picks the stored forwards the back-fill can give the part to.
- `report-from-ledger.ts`: `forwardsFromLedger` uses the stored `forwarded` first, then the old fallback.
- `scripts/correspondence-backfill.ts`: after the version loops, reads the ledger FLAGS for stored forwards (has
  content / has `forwarded` / purged -- never content), logs counts, and on apply re-writes CONTENT ONLY
  (`storeContent`) for rows that would gain the part -- the same content-only approach the Teams-mentions refill used,
  because the hash did not change.

**Tests.** New `scripts/forwarded-store.test.ts` 82/0 (8 shapes incl. classic Outlook, OWA, new Outlook, Gmail,
`[EXTERNAL] FW:`, `EXT: FW:`, Apple Mail, plain text, plus German; Iris behaviour inside the forwarded part --
entities decoded, hidden text ignored, tag-span fix, own history cut; PINs that live `htmlToText` still cuts and that
bodyText / hash / processor input are unchanged; refill plan). Existing: forwarded 22/0, correspondence-ingest 186/0,
report-from-ledger 39/0, redteam-correspondence 77/0, needs-you 77/0, correspondence-ledger-sql 76/0, onedrive-feed
all passed. `npx tsc --noEmit` clean.

## Fix 2 -- proposals-preview.yml defaults (ccf69287)

`ref` now defaults to `main` (it was an old branch). `max_sources` now defaults to 250: the old default left 60 items
unchecked, and a real run needed 137 calls.

## Fix 3 -- DB workflows' temporary firewall rule (8d695643)

Every per-runner create and delete used `--rule-name`. `az postgres flexible-server firewall-rule` does not accept
that flag (it names the rule `--name`/`-n`; `--rule-name` is MySQL's), so both calls failed in under a second and
`2>&1` hid the failure. The log said "Cleanup skipped". The rule is now `--name` and the server is `--server-name`.
Errors are shown and flagged as warnings. `migrate-huddle-db` and `deploy-pg-mcp` now remove the rule from an EXIT
trap, so a failed step cannot leave it behind. Files: azure-pg-query, bootstrap-memory-db, correspondence-backfill,
deploy-pg-mcp, migrate-huddle-db, qa-1on1-cleanup.

## Fix 4 -- the default browser UAT suite no longer starts a real stand-up (4849948f)

On 2026-11-15, four full verify-uat runs started four real stand-ups in the owner's account, and the long-task barge
saved real artifacts. The ceremony check moved, assertions unchanged, into the opt-in
`.claude/skills/test-agent-serverfn/scripts/ceremony-voice-checks.mjs`. Its park line and long-task line now carry the
`Test-` prefix. The unused typed-barge helper `bargeOnce` was dropped with the move. The guard is
`scripts/uat-suite-safety.test.ts`.

## Back-fill shape counts (21b5cda0, 15719b07)

For a stored forward that still has no readable forwarded part, the back-fill now logs WHY, counted by shape per
source (email and Sent Items). It logs counts only, never content.

## "Anything else noticed"

Nothing else was listed as open on this branch. The meeting action-item logic is excluded by the owner and was not
touched.

## Resumed 2026-11-16 after a container restart (head 15719b07)

Re-ran both new suites on the restored branch: forwarded-store 82/0, uat-suite-safety 19/0. Next: mutation proofs,
then final runs, then the refill dispatch.

## Mutation proofs (mutate.sh, every FIRED controlled by a comment-only negative control)

Every row was run with `mutate.sh <file> <anchor-file> <replacement-file> <test-cmd> <must-fail-pattern>`, with
anchors kept in files. "Exit" is mutate.sh's exit code. After every run the tree was restored and matched HEAD.

| id | guard | mutation | must-fail test | verdict | exit |
|---|---|---|---|---|---|
| M1a | forwarded part stored | drop `...(forwarded ? { forwarded } : {})` | B "stored content carries the forwarded ask" | FIRED (control EQUIVALENT) | 0 |
| M1b | own history cut inside the part | `newTextOnly(...)` -> raw join | first run: C-4 named | UNDETERMINED | 4 |
| M1b | (re-run after adding C-4b) | same | C-4b "plain-text forward: its OWN older history is cut" | FIRED (control EQUIVALENT) | 0 |
| M1c | Apple Mail blockquote fallback | `if (!out && bq)` -> `if (false && bq)` | A "Apple Mail" | FIRED (control EQUIVALENT) | 0 |
| M1d | header fields parsed | header assignment removed | A "header from" | FIRED (control EQUIVALENT) | 0 |
| M1e | part read from the RAW body, not bodyText | `feedRecordBody(rec)` -> `mapped.bodyText` | B "stored content carries the forwarded ask" | FIRED (control EQUIVALENT) | 0 |
| M2a | bodyText unchanged | bodyText gets the forwarded body appended | B "bodyText is exactly the live mapper's text" | FIRED (control EQUIVALENT) | 0 |
| M2b | content hash unchanged | the raw body is added to the hash parts | B-2 "content hash is unchanged" | FIRED (control EQUIVALENT) | 0 |
| M3a | refill skips rows that already have the part | `if (s.hasForwarded) continue` removed | E-2 | FIRED (control EQUIVALENT) | 0 |
| M3b | refill only when a version HAS the part | `withPart.get` -> `newest.get` | E-3 | FIRED (control EQUIVALENT) | 0 |
| M3c | purged rows never re-written | `if (s.purged)` -> `if (false)` | E-5 | FIRED (control EQUIVALENT) | 0 |
| M3d | newest version wins | first version kept instead | E-4 | FIRED (control EQUIVALENT) | 0 |
| M3e | a reply is not a forward | `!c.isForward` check removed | E-1 | FIRED (control EQUIVALENT) | 0 |
| M4a | default UAT suite has no stand-up | a `standupCeremonyTiming` check that clicks Start is added | A-1 | FIRED (control EQUIVALENT) | 0 |
| M4b | default UAT suite sends no message | a check that `.fill`s a textarea is added | A-4 | FIRED (control EQUIVALENT) | 0 |
| M4c | ceremony park line carries Test- | `Test-` removed | C-2 "2-park" | FIRED (control EQUIVALENT) | 0 |
| M4d | verify-uat defaults to the safe suite | default -> ceremony-voice-checks.mjs | B-1 | FIRED (control EQUIVALENT) | 0 |
| M4e | long-task line carries Test- | `Test-` removed | C-2 "4-long-task" | FIRED (control EQUIVALENT) | 0 |

Why M1b first came back UNDETERMINED: the mutation did break the suite, but only C-6 (the German plain-text case)
failed, not C-4. For HTML, `forwardedText` already stops at the next Outlook marker, so C-4 cannot see the cut that
`forwardedPart` makes. The English plain-text version of that cut had no test. C-4b was added (forwarded-store 82 ->
83 tests), and the re-run FIRED.

NOT PROVEN by mutation: the back-fill script's SQL flag read, the shape-count logging, and the workflow firewall flag
changes (fix 3). Those are shell and SQL, with no offline suite.

Observation, not changed: the `planForwardRefill` docstring says a row is refilled "only when it has content".
The code does not check `hasContent`. The script passes NULL-content rows only when a file version marks the item
as a forward, so such a row gains its whole content. That matches the content-fill behaviour, but the comment
over-claims.

## Final runs (2026-11-17)

forwarded-store 83/0, uat-suite-safety 19/0, forwarded 22/0, correspondence-ingest 186/0, report-from-ledger 39/0,
needs-you 77/0, redteam-correspondence 77/0, onedrive-feed "all passed", and `npx tsc --noEmit` clean (exit 0).

## Refill dispatch, for the coordinator to run (not run from this branch)

The refill code lives on this branch. Once it is merged, run with `ref: main`. Before merging, run with
`ref: claude_correspondence-tuning-fixes`.

1. **Dry run first:** `correspondence-backfill.yml` with `ref` = `main`, `since` = `2026-11-09T05:00:00Z` (the
   default), and `apply` = `false`.
2. **Apply:** the same inputs with `apply` = `true`.

The run is a full back-fill pass. On apply it also re-runs the email, Sent, Teams and Fireflies loops. Those are
idempotent: an unchanged hash means no rewrite.

Log lines that prove it worked. They hold counts only, never content:

- Dry run: `forwards: read R (with forwarded part P) | stored S, stored without forwarded part M | would gain it G |
  still missing X | purged U | DRY RUN: nothing written`. Expect `G > 0` and `G + X + U = M`.
- Apply: the same line ending `| content re-written W, failed 0`. Proof is `W = G` and `failed 0`.
- A second dry run after apply shows `stored without forwarded part` dropped by `W` and `would gain it 0`.
- `forwards still missing by shape: {...}` gives per-source counts of why the rest have no part (for example
  `email:no_header_has_attachments`). A non-zero `outlook_marker_unread` or `blockquote_unread` would point to a
  parser gap.
- `forwards: could not read the ledger flags -- refill skipped` means the refill did NOT run. Check the DB
  connection and firewall step.
- The firewall step should log `Opened firewall rule ghquery-...` and `Removed ghquery-...`. A `::warning::` on
  either line means fix 3 did not take.
