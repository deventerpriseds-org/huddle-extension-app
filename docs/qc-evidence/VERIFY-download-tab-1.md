# VERIFY download-tab, loop 1

WHAT: independent verification of the "Download" settings tab feature (Huddle + TaskOS APK links)
WHY: verifier pass required before the claims are reported as done
SUPERSEDES: nothing (an earlier run of this pass was killed by a container restart and pushed nothing)
SUPERSEDED-BY: nothing -- current
EVIDENCE: this file; started 2026-11-11 02:06 UTC

Note: local branch `claude_verify-download-tab` is held by a stale locked worktree from the killed run
(agent-a76c43f869f7a1909, never pushed), so this pass commits on its own worktree branch and pushes
`HEAD:claude_verify-download-tab`.

## Claims
| # | Claim | Verdict |
|---|---|---|
| C1 | bridge-builder getLatestApk | pending |
| C2 | journey app-downloads edge fn | pending |
| C3 | sync-bridge-builder-token workflow + runs | pending |
| C4 | journey Settings "Download" tab + typecheck run | pending |
| C5 | huddle SettingsSheet tab + server fn + test + deploy | pending |
| C6 | verify-uat run 42817517451 8/8 | pending |

## Evidence
