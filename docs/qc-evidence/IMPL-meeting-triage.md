<!--
WHAT:          Implementation log for part B of the correspondence redesign: meeting-minutes TRIAGE (AC section R5,
               plus the R9 flag / zero-call ACs that apply to R5). Spelling rows S-C were DROPPED as a matcher on
               the owner's redirect (see "Owner redirect" below).
WHY:           Owner 2026-11-14: "a ping when I receive meeting minutes with a drop list ... pick it, type who the
               action items are for or skip it. Then and only then can they go in the meeting action item queue."
SUPERSEDES:    the automatic Fireflies-transcript -> proposals path (engine.ts runTranscriptProposals), which the
               owner rejected. Its tests (scripts/task-proposals.test.ts section H) are replaced, see below.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_redesign-meeting-triage (from claude_task-proposals @ b7ddbdca);
               ACs: docs/qc-evidence/AC-correspondence-redesign.md on claude_ac-correspondence-redesign @ 5b8ba7d3;
               probes: docs/qc-evidence/PROBES-correspondence-redesign.md (P-4).
-->

# IMPL: meeting-minutes triage (R5)

Synthetic fixtures only. Nothing here touched a live system: no Graph, Fireflies, live DB, deploy or workflow.

## Status: implemented, mechanism verified locally (offline + local PG16). NOT live, NOT merged, flag OFF.

## Owner redirect (2026-11-14, mid-build)

> "The problem is you are trying to apply keyword capture instead of using ai's ability to determine it contextually"

| What I had built | What happened to it |
|---|---|
| `lib/correspondence/minutes-signal.ts`: subject / vendor-domain / keyword matcher for minutes EMAILS (spelling table S-C) | **Deleted** (commit `ff45891b`). Whether an email IS minutes is the parallel lane's AI conversation judge. The S-C rows are that judge's eval cases, not a regex. |
| `proposalSourceFromItem(..., {skipMinutes})`: skipped minutes emails as proposal sources (AC-R5.1) | **Removed.** `proposalSourceFromItem` is byte-identical to `b7ddbdca` again. AC-R5.1 / R5.4 now belong to the judge (R6.1 "minutes -> zero extraction calls"). |
| Triage trigger = finished Fireflies meetings | **Kept** (structured source). |
| Split `action_items` on lines / bullets / trailing `(mm:ss)` | **Kept** (format parsing, P-4). |
| Owner inference | **Never built.** Rows carry `assignee: null`; a test and a mutation (M17) pin it. |
| Optional "looks like yours" model hint | **Not built** (optional; see Not done). |

## Design (extend, don't duplicate)

```mermaid
flowchart LR
  FF[chat.fireflies_meetings<br/>finished meetings] --> L[correspondence ledger<br/>source 'transcript']
  L --> P[runMeetingTriage<br/>split action_items]
  P --> S[(chat.task_proposals<br/>state 'untriaged')]
  P --> T[ONE durable turn per meeting<br/>meeting-triage-&lt;hash(owner,meeting)&gt;<br/>Iris 1:1 + push]
  T --> C[existing checklist card<br/>Mine / For someone / Skip]
  C -->|Mine| PR[state 'proposed'<br/>evening checklist]
  C -->|For someone + name| DL[state 'delegated'<br/>name = text only]
  C -->|Skip| DM[state 'dismissed'<br/>ref kept = never back]
```

- **No new table, widget or tool.** Rows live in `chat.task_proposals` / `chat.task_proposal_refs`; the card is
  the existing proposal row (`kind:"proposal"`) with a `triage` flag; the action is a new `triage` value on the
  existing `actOnProposalFn`; the ping reuses the evening delivery's durable-turn payload shape.
- **Migration (AC-R5.13):** `BOOTSTRAP_SQL` gains an idempotent `DO` block: if no CHECK on `state` mentions
  `untriaged`, drop `task_proposals_state_check` and add the 6-state one (`duplicate_object` swallowed for a
  concurrent bootstrap). The `CREATE TABLE` text also carries the new CHECK for fresh databases.
- **Flag (AC-R9.1):** `correspondence.meetingTriage`, ON only when literally `true`, and only effective inside
  `correspondence.proposals` (its store, Iris's 1:1, its actions). `meetingTriageOn(cfg)` in `proposals.server.ts`.
- **Lookback:** the triage pass only considers meetings created in the last **2 days** (was 7 for the old
  automatic pass), so switching triage on does not post a week of pings at once. Reversible constant
  `TRIAGE_LOOKBACK_DAYS`.

### Decisions taken (reversible, flagged for the owner)

| # | Decision | Why | Reverse by |
|---|---|---|---|
| D1 | Mine on a to-do that is ALREADY an active proposal (e.g. the same ask came by email) merges: the meeting's ref moves to that proposal, the triage row leaves the queue (`dismissed`), the toast says "It's already in your proposed tasks." | The active-title unique index allows one proposal per to-do (OQ-9). | `triage()` merge branch in `proposals-store.server.ts` |
| D2 | A **Skipped** meeting item never suppresses the same to-do asked by email/Teams. `priorRelated`'s cross-source "dismissed" rule (red-team F15) now ignores rows whose first source is a meeting. An email Dismiss still suppresses everywhere, as before. | Skip often means "not mine"; suppressing a later direct ask would be a false refusal. | one `AND` line in `priorRelated` |
| D3 | OQ-9 "new items join the existing checklist": the ping message is a stored payload, so an update's new items are NEW untriaged rows that show (after the proposals) in the on-request checklist (`build_checklist proposals:true`, only when triage is ON). No second ping. | The posted card cannot grow; a second ping is what OQ-9 rejects. | `proposalChecklistForUser` |
| D4 | Ping when the meeting has >= 1 untriaged row; a ping that fails to RUN after enqueue is not retried by the pass (the turn is durable; the turn runner's heartbeat claims queued turns). | Avoid a double ping. | `runMeetingTriage` |

## Read function for the report's third list ("Meeting action items for you")

Server: `getMeetingActionQueue(ownerEmail: string): Promise<MeetingQueueReport | null>` in
`src/features/huddle/lib/proposals/proposals.server.ts` (null when triage is off; zero DB calls then).
Pure, for a report that already holds rows: `groupMeetingQueue(rows)` in `lib/proposals/meeting-triage.ts`, fed by
`pgProposalStore.listMeetingQueue(owners)` (every row reached through a meeting ref, with `meetingId`).

```ts
interface MeetingQueueReport {
  meetings: Array<{                 // newest meeting first; only meetings with a Mine or For someone item
    meetingId: string;
    title: string | null;           // meeting title (owner display only, never log it)
    at: string | null;              // meeting time ISO
    mine: MeetingQueueItem[];       // <- THE list "Meeting action items for you" renders (AC-R7.4)
    forSomeone: MeetingQueueItem[]; // the owner's own tracking; NOT "for you" (AC-R5.10)
  }>;
  counts: { mine: number; forSomeone: number; untriaged: number; skipped: number }; // counts line (AC-R7.5)
}
interface MeetingQueueItem { id: string; title: string; state: ProposalState; assignee: string | null }
```
`mine` includes states `proposed`, `approved`, `completed` (it stays the owner's after Approve). A merged Mine
(D1) appears as the active email proposal under its meeting.

**Note for the report lane:** `scripts/proposals-preview.ts` runs from files with no DB. To render list 3 it
needs either DB access (call `getMeetingActionQueue`) or rows passed in (call `groupMeetingQueue`).

## ACs

| AC | Status | Where (code) | Proof (test) |
|---|---|---|---|
| R5.1 minutes email never needs_reply / proposal source | **Moved to the AI judge (owner redirect).** Not built here. | n/a | n/a |
| R5.2 parsing from P-4's measured shape | Done (P-4 in `PROBES-...md`) | `splitActionItems` | meeting-triage B (12 checks) |
| R5.3 transcript pass makes zero `proposed` rows | Done (behaviour change) | `engine.ts runMeetingTriage`; old `runTranscriptProposals` deleted | meeting-triage D; -sql "AC-R5.3 ... untriaged"; -server "AC-R5.3"; task-proposals H |
| R5.4 forwarded minutes with an ask stays a source | Unchanged path; judge's call | n/a | meeting-triage I (still read; never a ping) |
| R5.5 one durable turn in Iris's 1:1, push, N rows | Done | `meetingTriagePayload`, `runMeetingTriage` | meeting-triage D; -server |
| R5.6 no second ping (retry, re-send, update) | Done | `meetingTriageTurnId` + `enqueueTurn` ON CONFLICT | meeting-triage D (re-run, new hash, enqueue failure retry) |
| R5.7 update adds rows, no ping | Done (D3) | refs dedup in `addTriageRows` | meeting-triage D; -sql resend |
| R5.8 three choices per row | Done in code; **UI not run in a browser** | `ProposalChecklistItem.tsx` (triage menu) | tsc only; no Playwright run (no live system allowed) |
| R5.9 Mine -> proposed, evening list | Done | `triage()` | meeting-triage E; -sql |
| R5.10 For someone = text only, not "for you" | Done | `triageProposal`, `cleanTriageName` | meeting-triage E (store-only deps), G; -sql |
| R5.11 Skip remembered | Done | refs + `dismissed`; D2 | meeting-triage D/E; -sql |
| R5.12 zero items -> no ping, processed | Done | `runMeetingTriage` | meeting-triage D |
| R5.13 no new table; explicit migration tested on OLD CHECK | Done | `BOOTSTRAP_SQL` DO block | -sql (starts from the OLD table, re-runs bootstrap x3 incl. 2 concurrent) |
| R5.14 untriaged / delegated not in listActive | Done (existing `state='proposed'` filter) | `listActive` | meeting-triage E; -sql |
| R5.15 same card, `triage` flag, sanitizer fallback | Done | `proposals.ts` `isTriageRow`, `sanitizeChecklistPayload` | meeting-triage F |
| R5.16 name trimmed, 80 cap, text, empty saves nothing | Done | `cleanTriageName`, `triageProposal`, UI `saveName` | meeting-triage C, E |
| R5.17 double tap -> one applies | Done | `triage()` FOR UPDATE + state check | -sql concurrent; meeting-triage E |
| R9.1 flag literal true | Done | `correspondenceFlags`, `meetingTriageOn` | meeting-triage H; -server |
| R9.2 flags off -> zero calls | Done for the meeting pass | `runProposalsPass` gate | -server (spied modules: 0 calls) |
| R9.3 triage off -> no proposals from meetings | Done | gate; old pass deleted | -server |
| R9.6 mutation proofs | Done (below) | | |

## Tests (final run, `bash runall`, all on this branch)

| Suite | PASS | FAIL |
|---|---|---|
| scripts/meeting-triage.test.ts (NEW) | 69 | 0 |
| scripts/meeting-triage-sql.test.ts (NEW, PG16, starts from the OLD CHECK) | 34 | 0 |
| scripts/meeting-triage-server.test.ts (NEW, bun mock.module zero-call) | 7 | 0 |
| scripts/task-proposals.test.ts | 199 | 0 |
| scripts/task-proposals-sql.test.ts | 45 | 0 |
| scripts/redteam-correspondence.test.ts | 77 | 0 |
| scripts/correspondence-ingest.test.ts | 149 | 0 |
| scripts/fireflies-queue-sql.test.ts | 14 | 0 |
| scripts/proposals-preview.test.ts | 6 | 0 |
| scripts/correspondence-ledger-sql.test.ts | 50 | 0 |
| scripts/fireflies-minutes.test.ts | 64 | 3 (pre-existing at b7ddbdca: G3, G5, G8; untouched) |
| `npx tsc --noEmit -p .` | clean | |

### Existing tests changed (and why)

- **scripts/task-proposals.test.ts section H** (204 -> 199): its 6 checks pinned "a finished meeting's action
  items become proposals automatically" (AC-5.18 transcript / AC-5.22 / AC-3.4 / 3.5 / 3.7 on transcripts). The
  owner rejected that behaviour, so they are replaced by ONE check pinning the new rule (the automatic pass no
  longer exists) and by scripts/meeting-triage.test.ts section D (which also re-covers needs_context and re-run
  idempotency for meetings).
- **scripts/correspondence-ingest.test.ts AC-6.1** pins the full default-flags object; it gains
  `meetingTriage: false` (the new switch, OFF by default; same precedent as `staleAlerts`). Nothing weakened.

## Mutation proofs (`mutate.sh`, each with its control)

| # | Guard (file) | Must-fail test | Verdict |
|---|---|---|---|
| M01 | sanitizer: triage row unknown state -> untriaged (proposals.ts) | AC-R5.15 sanitize: triage row with an UNKNOWN state -> untriaged | FIRED (control EQUIVALENT) |
| M02 | empty name refused before any write (engine.ts) | AC-R5.16 empty name -> error, NO store write | FIRED (control EQUIVALENT) |
| M03 | name capped at 80 (meeting-triage.ts) | AC-R5.16 capped at 80 characters | FIRED (control EQUIVALENT) |
| M04 | turn id per meeting only (engine.ts) | AC-R5.6 re-sent minutes (new hash) -> no second ping | FIRED (control EQUIVALENT) |
| M05 | strip ALL trailing stamps (meeting-triage.ts) | P-4 two trailing stamps stripped | FIRED (control EQUIVALENT) |
| M06 | flag literal true (onedrive-feed.ts) | AC-R9.1 meetingTriage: absent / 'true' / 1 / false -> OFF | FIRED (control EQUIVALENT) |
| M07 | triage needs proposals (proposals.server.ts) | AC-R9.1 triage runs only inside proposals | FIRED (control EQUIVALENT) |
| M08 | server gate before any Fireflies call (proposals.server.ts) | AC-R9.3 triage OFF: zero Fireflies ... calls | FIRED (control EQUIVALENT) |
| M09 | rows inserted untriaged (store SQL) | AC-R5.3 meeting items are stored untriaged, never proposed | FIRED (control EQUIVALENT) (first run UNDETERMINED: harness error, test then made to observe state directly) |
| M10 | CHECK migration runs on an OLD table (store SQL) | AC-R5.13 after bootstrap the OLD table accepts untriaged rows | FIRED (control EQUIVALENT) |
| M11 | CAS state check in `triage()` (store) | AC-R5.17 Mine tapped again ... no self-merge | FIRED (control EQUIVALENT) |
| M12 | `WHERE state='untriaged'` on the triage UPDATE | AC-R5.17 concurrent Mine + Skip -> exactly ONE applied | **INERT: redundant.** The row is read `FOR UPDATE` and M11's state check returns first, so this WHERE never decides. Not proven on its own; the guard it backs (M11) is proven. |
| M13 | Skip is not a cross-source dismissal (priorRelated) | Skip of a meeting item does NOT appear as a cross-source dismissal | FIRED (control EQUIVALENT) |
| M14 | Mine merges into an active proposal (store) | OQ-9 Mine on an active to-do -> applied, merged | FIRED (control EQUIVALENT) (first run UNDETERMINED, same fix as M09) |
| M15 | refs "seen" early return in `addTriageRows` | AC-R5.11 / R5.7 re-sent minutes: skipped + delegated not re-created | **INERT: equivalent.** Ids are deterministic (`prop-` hash of owner+meeting+title) and both inserts are `ON CONFLICT DO NOTHING`, so a skipped row is never resurrected even without it. Skip memory is enforced by the id + ref PK. |
| M16 | zero items -> no ping (engine.ts) | AC-R5.12 the meeting with ZERO action items: no ping | **INERT: equivalent.** The second guard `open.length &&` before `enqueue` also blocks a ping with no rows. |
| M17 | no owner guessed (meeting-triage.ts) | P-4 no owner is ever guessed: rows carry no assignee | FIRED (control EQUIVALENT) |
| M18 | bullet stripped (meeting-triage.ts) | P-4 one string, every line a bullet -> ... bullet stripped | FIRED (control EQUIVALENT) |

## Not done

- **UI not exercised in a browser** (AC-R5.8 says Playwright UAT). Typechecked only; needs a UAT run after deploy.
- **Optional model hint** ("looks like yours", per the redirect) not built.
- **S-C spelling rows**: no matcher here by owner direction; they should become eval cases for the AI judge.
- **Report list 3 is not rendered** (parallel lane); this lane exposes `getMeetingActionQueue` / `groupMeetingQueue`.
- `transcriptProposalText` in `proposals.ts` is now unused by runtime code (kept: a test still covers it, and
  removing it is outside R5's need).

## ACs I believe are wrong or need the owner

- **AC-R5.1 / R5.4 and table S-C** assume a keyword rule; superseded by the owner's redirect (AI judge).
- **AC-R5.11** says the Skip is "a `task_proposal_refs` row with state `dismissed`": refs have no state column;
  the ref points at the proposal row, which is `dismissed`. Implemented that way.
- **AC-R5.6** names re-processing triggers; with a 2-day lookback (decision above) a meeting older than 2 days is
  never pinged at all on first switch-on. Owner may prefer a different window.
