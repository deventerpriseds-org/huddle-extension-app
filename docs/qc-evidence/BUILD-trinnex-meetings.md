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

- 3. Pure core `lib/trinnex/meeting-triage-core.ts` (validateTitle, cleanSeries, seriesOptions, fullTitle,
  oneDriveFileName, peopleList, canRemovePerson, ownerPickToTriage, speakerRows, splitWarnings,
  participantsWithSpeakers, segmentsFor, cleanSpeakerMap): AC-T3, T4, T6, T7, T10, T11, T12, T14, T15, T19, L9 ->
  `bun scripts/trinnex-meetings.test.ts` (32 green). Includes AC-T12 through the EXISTING `triageProposal` +
  `store.triage` (Von -> proposed/null, person -> delegated/exact spelling, skip -> dismissed) and "an existing
  triaged row reads back unchanged" (`groupMeetingQueue` over a pre-picker delegated row with a typed name).
- 3b. Storage + writer (SHARED FILES, minimal): `minutes-store.server.ts` BOOTSTRAP_SQL gains idempotent
  `ADD COLUMN IF NOT EXISTS` display_title, series, participants text[], speaker_map jsonb, triaged_at,
  title_with_participants, onedrive_file_name, trinnex_state, trinnex_error, plus `chat.trinnex_people`
  (owner_email, name_key, name; PK owner+key). `ensureMinutesSchema` exported. `recordMeetingInfo` untouched, so
  a resend can never overwrite display_title (AC-T2). `minutes.ts` gains pure `transcriptFileName`;
  `fireflies.server.ts` `saveTranscript` now PUTs `transcriptFileName(id, row.onedrive_file_name)` (AC-T8) and a new
  `renameTranscriptFile` does a Graph PATCH name with conflictBehavior fail (AC-T7/T9).
  Regression: `bun scripts/fireflies-minutes.test.ts` has 3 FAIL (G3, G5, G8) -- the SAME 3 fail on the untouched
  base (checked by restoring the three HEAD files and re-running: 3 FAIL), so they predate this lane.
  `meeting-triage.test.ts` 69/0, `actions-view.test.ts` 264/0.

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
- 4. Server: `lib/trinnex/meetings.server.ts` (listMeetings, getMeeting: speakers from `chat.correspondence_ledger` content.sentences, title + invite suggestions, the meeting's triage items; saveMeeting: fields first, then owner picks through the EXISTING `actOnProposal(..., 'triage', ..., {from:'actions'})`, then optional rename (failure -> 'File name not changed (<code>)', old path kept), then `ingestTrinnexSource` only if `trinnexConfigured()`, else 'Trinnex memory is not set up yet'; never fails the save). People: getPeople/addPerson/removePerson (owner pinned, never removable). `meetings.functions.ts` = zod-validated server fns. AC-T1, T2, T5, T9, T12-T17. Tests: trinnex-meetings 34 green incl. AC-T2 source guard. tsc clean for these files. Caught by tsc: a backtick inside the BOOTSTRAP_SQL template comment (fixed).
- 5. UI: `components/MeetingsView.tsx` (WidgetPage + CollapsibleSection like ActionsView; list 'Needs triage'/'Triaged'; triage form: title + Fireflies original, series datalist, participant chips + title/invite suggestions (click to add), one row per voice with lines/talk%/sample+stamp and a person dropdown, split-voice warning, action items with the owner picker + Skip, title-suffix and OneDrive-rename switches, 'Save and add to Trinnex memory' / 'Save without adding to memory'). `components/PeoplePicker.tsx` = the ONE picker (owner '(me)' first, people, 'Add new name' persisted server-side). SHARED FILES (minimal): `store.ts` View += 'meetings'; `HuddleApp.tsx` VIEWS += MeetingsView; `ViewSwitcher.tsx` VIEW_TITLE += Meetings; `ModulesLauncher.tsx` HUDDLE_MODULES += Meetings. tsc: no errors in these files. AC-T1, T3-T6, T10, T12, T14, T16 (UI), T17, T19. Not rendered at 390px here (no browser run in this lane).
