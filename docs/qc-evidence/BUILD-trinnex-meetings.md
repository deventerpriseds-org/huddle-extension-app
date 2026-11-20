<!--
WHAT:          build log for the MEETINGS lane of the Trinnex workspace (Meetings module, people list, shared name parser,
               speaker mapping, owner picker, title/file rename, save + Trinnex ingest call).
WHY:           the lane is built by a background subagent that can be killed by an interrupt or a container reclaim;
               each step is logged and pushed so the work survives.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      spec docs/qc-evidence/AC-trinnex-workspace.md (sections 1, 5 S-A/S-B, 9, 10); branch claude_trinnex-meetings
-->

# BUILD: Trinnex Meetings lane

Branch `claude_trinnex-meetings`, cut from `origin/claude_trinnex-workspace` (dd88c0f2).

## Steps (one line each: what, AC ids, test)

- 0. Branch cut, BUILD file created.
- 1. Shared parser `lib/trinnex/names.ts` (suggestNames, matchSpeaker, speakerKey): S-A1..S-A22 + S-B1..S-B9 -> `bun scripts/trinnex-names.test.ts` (43 checks green). Follows the TABLE where prototypes disagree: 1on1_Dana -> Dana K., Budget/Forecast -> none, ACME -> none, José -> José.
- 2. `lib/trinnex/memory.server.ts` created as a STUB (did not exist on this branch): exact section-10 signatures,
  returns {chunks:0,facts:0}, `trinnexConfigured()` = false. The memory lane replaces it wholesale.

## Speaker-label shapes: ANSWERED (was "QUERY FOR THE SESSION")

azure-pg-query run 44671380860 (2026-11-20, run by the coordinator; label SHAPE only, never names) over every stored
Fireflies transcript in `chat.correspondence_ledger` (`content->'sentences'[].speaker`):

| shape | sentences | meetings |
|---|---|---|
| `Speaker N` | 18988 | 30 |

No other shape: no blank labels, no named speakers, not even the owner. Consequences built into this lane:
1. Every voice normally starts UNMAPPED, so triage must make mapping all voices fast (one picker per voice row).
2. `matchSpeaker` keeps the S-B2 tolerant `^speaker\s*\d+$`i (the spelling table pins case/spacing variants); any
   other label is kept verbatim, so the strict real shape is a subset of what is handled.
3. Ingested passages carry the MAPPED person; an unmapped voice is stored as the literal label ("Speaker 3"),
   never a guess.
