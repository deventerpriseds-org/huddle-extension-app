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
