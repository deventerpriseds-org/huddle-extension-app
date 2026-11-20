# VERIFY-trinnex-workspace-3

- WHAT: Independent verifier loop 3 for PR #289 (Trinnex workspace), head 957bad98.
- WHY: Loop 2 (VERIFY-trinnex-workspace-2.md) said FIX FIRST on claim 2b (VB1c orphan rows). This loop re-derives 2b against the new mechanisms (live-source filter, orphan sweeper, lease-alone beginRemoval), plus G, R, V, M, and re-checks 1, 3-6, Q.
- SUPERSEDES: nothing (loop 2 is the prior loop).
- SUPERSEDED-BY: nothing -- current.
- EVIDENCE: new probes in scripts/verify-trinnex-attack-3.test.ts (this branch); command output pasted per claim below.
- Branch: claude_verify-trinnex-workspace-3, from origin/claude_trinnex-workspace @ 957bad98.

## Claims

### S. Full suite re-run at 957bad98 (one file per process) -- PASS
bun:test files (`bun test ./scripts/<f>`): memory-context 11/0, rag-store-pool-param 3/0, trinnex-bootstrap-allowlist 4/0,
trinnex-integration 13/0, trinnex-library 23/0, trinnex-live-sources 12/0, trinnex-memory 52/0, trinnex-people 5/0,
trinnex-quota-surfacing 5/0, trinnex-redteam-fixes 19/0, -isolation 5/0, -names 5/0, -search 5/0, trinnex-removal-lease 5/0,
trinnex-removal-race 11/0, trinnex-scope-gate 5/0, trinnex-voice-guard 5/0, trinnex-voice-history 1/0,
verify-trinnex-attack 9/0, verify-trinnex-attack-2 5/0.  => 203 pass / 0 fail.
Plain-script files (`bun ./scripts/<f>`; `bun test` reports "0 tests" for these, so they must be run this way):
actions-view-server 50/0, actions-view 264/0, meeting-triage-server 7/0, meeting-triage-sql 34/0, meeting-triage 69/0,
trinnex-meetings 34/0, trinnex-names 43/0, voice-toolset-hidden 36/0, nexus-write-voice-gate "ALL PASS: 43 passed, 0 failed".
=> 580 pass / 0 fail.  Total 783 pass / 0 fail across 29 files.
fireflies-minutes: branch `3 FAILED` = G3, G5, G8; on origin/main (separate detached worktree, same node_modules) the
identical `FAIL G3 ... FAIL G5 ... FAIL G8 ... 3 FAILED`. Pre-existing, not introduced by this PR.
`nice -n 10 npm run build` -> rc=0 (`[nitro] √ You can deploy this build using npx nitro deploy --prebuilt`).

### 2b. Remove during processing -- new backstops -- PASS (no FIX-FIRST condition), one MEDIUM liveness finding
Re-run (inside S): verify-trinnex-attack VA1-VA9 9/0, verify-trinnex-attack-2 VB1/VB1c/VB2/VB2b/VB3 5/0,
trinnex-removal-race 11/0, trinnex-removal-lease 5/0, trinnex-live-sources 12/0.
New probes `scripts/verify-trinnex-attack-3.test.ts` -> `9 pass 0 fail` (bun test, 51ms):
- VC1a meeting passage owner A, fireflies row owner B: `search candidates=2 cited=1 not_live=1` -> only m-a. Not visible.
- VC1b library row stuck `removing` forever: search `miss`; sweep at 5 min since updated_at keeps it (`sources=0`), at 11 min deletes it (`sources=1 chunks=1`). Not permanent.
- VC1c meeting row under the owner's alias: searchable, NOT swept.
- VC2a LIVE upload in uploaded/read/split/facts/waiting_memory/failed/searchable with writes 30 days old: sweep `sources=0`, all rows kept. Live rows are never swept: liveness is the row's status, the grace only applies to non-live.
- VC2b no row, newest write 9 min: kept; 11 min: swept.
- VC2c A's orphan and B's live upload with the same id: only A's deleted (owner-scoped deleteTrinnexSource).
- VC3c Remove completes while the worker is between writes: worker's next check cancels, 0 passages remain.
- **VC3a FINDING (MEDIUM, liveness, not a leak):** "lease renewed every 60 s" does not hold in the FACTS phase. runPipeline renews only from `removed()`, which ingestTrinnexSource calls via `shouldStop` after each embed and only before a `writeTriples` that HAS facts. Real ingest, 40 passages, 15 s/extraction, 0 facts: `shouldStop calls=41 maxGapSec=600 lease=180s`. With facts on every passage: `maxGapSec=15` (VC3b). When the lease lapses mid-facts: (i) heartbeat `claim()` can re-claim the item (status still `split`) and run a SECOND concurrent ingest that re-embeds/re-extracts (double AI spend) and deletes the first worker's passages; the first worker's `finally release()` then clears the second worker's lease; (ii) a Remove gets `inFlight=false` and deletes under the worker, but the worker writes nothing more without a `stopped()` check, so VC3c holds and the backstops catch any write that slips the check window. No derived row survives without a live source; no live source's rows are swept. Not a FIX-FIRST category.
- Read, not executed: `liveTrinnexSources` SQL (library.server.ts ~588-640) scopes uploads by `lower(owner_email) = $1` and meetings by `lower(owner_email) = ANY(owner aliases)`; alias-resolution failure sets `meetingsChecked=false`, which keeps search owner-only and makes the sweeper skip meetings. The probe's main-DB model is written from that reading (stated, not proven against Postgres).
- LOW: claim() re-takes a `removing` row every ~2 min and bumps its updated_at, so a removal that keeps throwing before its memory delete keeps resetting the sweeper's grace. Not visible meanwhile (not live, so filtered).

### G. 1:1 gate with members -- PASS (behaves as specified); trust model stated
Probes G1-G12 in verify-trinnex-attack-3 (all pass): only `{huddleId:"dm-iris-chase", scope:"one-to-one", members:["iris-chase"]}`
is offered; refused: extra member, duplicated self, other agent as sole member, group scope, group id, `DM-` case spoof,
trailing space, ceremony flag, members missing, other agent's dm id; a non-Trinnex agent in its own 1:1 is never offered.
Both dispatch paths read the same predicate: huddle.functions.ts:4131 (OpenAI tools), :6929 (Lovable tools), and the executor
wrapper re-checks at :2532 (`search_trinnex · not_here`).
**What is client-trusted:** huddleId, scope, members, ceremonyBarge/ceremonyRunId, and the caller identity
(`trinnexOwner = resolveTaskEmail(data.caller) ?? data.caller?.entra_email`, :2538). **Worst case of a spoof:** a client can
always submit the genuine 1:1 shape (G1 is indistinguishable from a real 1:1), so the gate keeps a well-behaved client
from offering search in a group; it cannot stop a hand-built request. Results stay scoped to the resolved caller's
email, so a spoofed huddle shape exposes only the caller's own Trinnex material, inside a turn the caller labelled as
their 1:1. A spoofed CALLER would be a cross-owner read, but that is the app-wide identity model every owner-scoped
server fn here shares (board, library, meetings), not something this PR introduced. Not a FIX-FIRST item for this PR.

### R. Recency -- PASS on RT-S6a-g and RT-S5; 2 new LOW over-matches
RT-S6a-g and RT-S5a-h re-ran green inside trinnex-memory (52/0). Four of my own (NOW 2026-11-20):
- R3 "in the last two weeks" -> `{"dateFrom":"2026-11-06","dateTo":"2026-11-20"}` PASS
- R4 "the most recent meeting" -> `{"mostRecent":1}` PASS
- **R1 "who had the last laugh in the vendor fight" -> `{"mostRecent":1}` (expected null) LOW over-match**
- **R2 "who gets the last word on pricing" -> `{"mostRecent":1}` (expected null) LOW over-match**
Effect: the search is narrowed to the single newest source, so the answer can be a false miss or come from the wrong
meeting. Narrowing only; never widens scope or crosses owners. R1/R2 are committed as `test.failing` (suite: 25 pass 0 fail).
