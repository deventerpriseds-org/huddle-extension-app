<!--
WHAT:          Independent verification (loop 4) of claude_task-proposals @ 2cf5fa8d: re-check of loop-3 confirmed
               items, full re-derivation of loop-3 defects D1-D6/M1/M2, and full-depth check of the new
               file-staleness alert (correspondence.staleAlerts) and scripts/proposals-preview.ts.
WHY:           Tier 1 (model output stored as proposals; live bell + live email screens touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-3.md (origin/claude_verify-correspondence-3)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify3-*.ts (loop 3) and scripts/verify4-*.ts (this loop)
-->

# VERIFY correspondence-proposals, loop 4

Started 2026-11-13 14:28 UTC. Budget 90 min. Isolated worktree; no live system touched; synthetic `.example` data.

## Claim 0: full suite re-run at 2cf5fa8d

| suite | result |
|---|---|
| task-proposals | 198 passed, 0 failed |
| redteam-correspondence | 70 passed, 0 failed |
| correspondence-ingest | 149 passed, 0 failed |
| onedrive-feed | all passed |
| inbound-email | 72 passed, 0 failed |
| cross-app-turn-gate | 92 passed, 0 failed |
| feed-staleness | 66 passed, 0 failed |
| attention | all passed |
| `npx tsc --noEmit -p .` | exit 0, no output |

Matches the implementer's numbers exactly.

## Claim 1: loop-3 repro inputs re-run at head (scripts/verify3-*.ts, unchanged)

| loop-3 item | loop-3 result | head result |
|---|---|---|
| M1 `teams`/`sent` `{"enabled":"false"}`, `{"enabled":0}` | enabled:true | **enabled:false** (both keys); `{}`/`true` still on; `"on"`, `1`, `"true"` off |
| D1 V1 stray `</span>` | `""` | "Please approve the budget by Friday.\n Thanks" |
| D1 V2 `title="a hidden gem"` | ask cut | full text |
| D1 V5 `<font size>`, V6 class, V7 max-height alone, V13 visibility:visible child, V19 unclosed `<p>` in td | `""` | ask kept in all five |
| D1 negatives H7-H10, H13-H15 | hidden | still hidden |
| D1 H1-H6, H11, H12, H16 | kept (hidden text leaks) | still kept -- unchanged, documented as out of scope |
| D2 N1, N2, N3, N4, N7, N8, N9 | cut | **all kept in full**; controls N5 (Outlook header) and N6 (Gmail attribution) still cut |
| D3 image-only / emoji-only / Giphy owner reply | skipped, chat stays OWED | kept; decision **answered** |
| D3 whitespace-only code block | -- | still `empty` (skipped) |
| D4 19:30-EST rerun | false DROP on next UTC day | unioned into 2026-11-12, `drop:false` |
| F4 a-d (invented detail) | c, d ACCEPTED | all four rejected |
| F5a "Redo the deck you sent" | ACCEPTED | rejected `task_not_grounded` |
| F5b "Send the budget review" from "Thanks for sending..." | ACCEPTED | still ACCEPTED (implementer documents as not addressed) |
| F7 a-e, h | ACCEPTED | all `evidence_negated` |
| F7f negation on the previous line | ACCEPTED | still ACCEPTED (documented: newline is a boundary by design) |
| M2 F10 `"3"`, F11a `"may"` as dueText | kept | dueText null |
| F3, F11b/c, F12, F13 | closed | still closed |
| sanitize S0-S5 vs main | S3 differs (correct) | identical result |
