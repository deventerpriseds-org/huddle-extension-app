<!--
WHAT:          acceptance criteria for the Trinnex workspace in Huddle: Meetings triage, Trinnex Library, Trinnex memory + Ask.
WHY:           the work is Tier 1. It stores model output (facts), decides what an agent may retrieve, and parses names from titles.
               The ACs had to be written cold by an independent writer, before any code exists.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      owner decisions 2026-11-20 ("A", "Huddle Iris and Eli first", "go on prototype");
               prototype origin/claude_trinnex-prototype:docs/trinnex/prototype/*; code read cold from origin/main cb5aa714.
-->

# Acceptance Criteria: Trinnex workspace

Task: build the owner-approved prototype (`docs/trinnex/prototype/` on `origin/claude_trinnex-prototype`) as real
Huddle features. That means a Meetings triage module, a Trinnex Library app, and a separate Trinnex memory database
that only `iris-chase` and `eli-vaughn` can search, with cited answers.

Sources read (origin/main `cb5aa714`, prototype branch tip):
- prototype: `data.js`, `index.html`, `meetings.html`, `library.html`, `ask.html`
- `lib/rag/{types.ts, azure-pg.server.ts, memory-context.server.ts, tools.ts, triples.server.ts, embed.server.ts}`
- `lib/fireflies/{fireflies.server.ts, minutes-store.server.ts, minutes.ts}`; `lib/proposals/{meeting-triage.ts, engine.ts}`
- `lib/artifacts/blob.server.ts`; `data/agents.ts`; `.github/workflows/deploy-swa.yml`
- Not read: `lib/db/shared-pool.server.ts` (outside the extracted set; cited only through its importers),
  `ActionsView.tsx`, `minutes.functions.ts` body, `actions/*.ts` bodies (grepped only).

Paths below are relative to `src/features/huddle/` unless they start with `.github/` or `docs/`.

## 0. Existing systems this EXTENDS (not duplicates)

| Need | Existing system | AC consequence |
|---|---|---|
| Passage + fact store | `rag_chunks` / `rag_triples`, `BOOTSTRAP_SQL` (`lib/rag/azure-pg.server.ts:101-207`), `RagStore` interface (`lib/rag/types.ts:86-93`) | Trinnex runs the SAME `BOOTSTRAP_SQL` and the SAME store code against a second database. It must not add a second schema (AC-M1, AC-M2). |
| Fact extraction | `extractTriples` (`lib/rag/triples.server.ts:47`, model `gpt-5.5` at :52) | It is reused, not re-implemented (AC-M8). |
| Embeddings | `embed` (`lib/rag/embed.server.ts`, `text-embedding-3-large`, 3072 dims at :5-6, input truncated at 8000 chars at :18) | It is reused. Chunking must keep each passage under 8000 chars, or the tail is silently not embedded (AC-L9). |
| Raw meeting transcript | `storeTranscriptContent` writes the sentences to `chat.correspondence_ledger` (`lib/fireflies/fireflies.server.ts:530-547`, called at :580) | Ingestion reads the sentences from there or from Fireflies. It does not create a third transcript copy (AC-T11). |
| Meeting record | `chat.fireflies_meetings` (`lib/fireflies/minutes-store.server.ts:34-53`); `recordMeetingInfo` COALESCEs the title (`:265-272`) | The new title, series and participants are columns ADDED to this table. The Fireflies title is never overwritten (AC-T1, AC-T2). |
| Action-item triage | `TriageChoice` mine/someone/skip → proposed/delegated/dismissed (`lib/proposals/meeting-triage.ts:196-204`); `cleanTriageName`, 80 chars (`:33`, `:208-212`); `engine.ts:368-372` | The picker produces the SAME three targets through the SAME `store.triage` (AC-T7). |
| Uploaded file storage | Azure Blob, private container `huddle-artifacts`, `AZURE_STORAGE_CONNECTION_STRING` (`lib/artifacts/blob.server.ts:16,28`), `deleteArtifactBlob` (`:74-77`) | Library files use the same storage account and connection string in a separate container (AC-C2). |

**Fact-check on the prototype's wording.** `index.html` says a meeting goes "into a Trinnex collection in your
existing memory". Owner decision "A" supersedes that: a separate database. The ACs follow decision "A".

---

## 1. Meetings triage module (Tier 2)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-T1 | Given a Fireflies meeting whose title arrived as "Weekly sync", when the owner edits it to "Leadership weekly" and saves, then `chat.fireflies_meetings` holds BOTH: the original (`title` = "Weekly sync") and the edit (new column, e.g. `display_title` = "Leadership weekly"). The list and the detail show the edit. | happy-path | `azure-pg-query.yml` SELECT; UI text |
| AC-T2 | Given an edited title, when Fireflies redelivers the webhook (`recordMeetingInfo`, `minutes-store.server.ts:265`), then the owner's edit is unchanged, and only the Fireflies-original column may update. | regression | resend fixture + SELECT |
| AC-T3 | Given the title input, when the owner saves an empty or whitespace-only title, then the save is refused with "A meeting needs a title." and nothing is written. A title over 120 chars is refused or capped at 120 (prototype `maxlength="120"`, `meetings.html:353`). | error/edge | UI toast; row unchanged |
| AC-T4 | Given two saved meetings with series "Engineering Leaders", when the owner opens a third, then the series field offers "Engineering Leaders" (the datalist is built from existing values, `meetings.html:358-371`). Series is optional; blank stores NULL, not "". Series is capped at 80 chars. | happy/edge | DOM datalist; SELECT `series IS NULL` |
| AC-T5 | Given a meeting with invite attendees ["Von", "Michael R.", "Priya S."] and Fireflies title "Meeting with Priya", when triage opens, then "Priya S." is suggested once (from the title), "Michael R." is suggested from the invite, and "Von" is never offered as a participant tag (`meetings.html:221-224`, `:404-406`). No suggestion is added until clicked. | happy/negative | DOM chips; participants column empty before click |
| AC-T6 | Given participants ["Michael R.", "Priya S."], when "Add participants to the title" is ON and the owner saves, then the displayed title is "<title> - Michael R., Priya S." (`fullTitle`, `meetings.html:247-249`). When it is OFF, the title has no suffix. The stored edited title never contains the suffix twice after two saves. | happy/edge | SELECT after 2 saves |
| AC-T7 | Given "Rename the OneDrive file to match" ON, when the owner saves, then the OneDrive item previously at `/Automation/transcripts/fireflies-<id>.md` (`fireflies.server.ts:51,325`) is MOVED (Graph PATCH name), not copied, to `<YYYY-MM-DD> <full title>.md` with `\ / * ? " < > \|` replaced by `-` and `:` replaced by ` - ` (`meetings.html:250-253`). `onedrive_path` is updated. Exactly one file exists afterwards. | happy | Graph list of the folder; SELECT `onedrive_path` |
| AC-T8 | Given a renamed file, when Fireflies redelivers the meeting, then the transcript writer either writes to the stored `onedrive_path` or leaves the renamed file alone. It must NOT recreate `fireflies-<id>.md` beside it. Today's writer always PUTs the id-path (`fireflies.server.ts:324-326`), so this needs a code change. | regression | folder listing after a resend shows 1 file |
| AC-T9 | Given rename ON and the Graph rename fails (403/409/5xx), when the owner saves, then the triage save still succeeds, the owner sees "File name not changed" with the reason code, and `onedrive_path` keeps the old path. A silent success is a failure. | error | forced 409; toast text; SELECT |
| AC-T10 | Given a meeting whose sentences carry "Speaker 1", "Speaker 2" and "Von Ellis", when triage opens, then one row per distinct label shows lines, talk %, and a sample line with its timestamp. "Von Ellis" pre-maps to Von by full or first name (`meetings.html:207-212`). Mapping "Speaker 1" to "Michael R." adds him to participants (`:221-225`). Mapping two labels to one person shows the "Fireflies sometimes splits one person" warning and is allowed. | happy/edge | DOM; stored map |
| AC-T11 | Given a saved speaker map {"Speaker 1": "Michael R."}, when ingestion runs, then every passage from Speaker 1's lines has `metadata.speaker = "Michael R."` and keeps `metadata.speaker_label = "Speaker 1"`. Unmapped labels are stored as the raw label and can be remapped later; a remap rewrites the speaker on existing passages and creates no duplicates. | happy/regression | SELECT on the Trinnex DB |
| AC-T12 | Given the owner picker in triage, when it opens, then "Von (me)" is first and pinned, followed by the people list, then "add new name". Picking Von writes target `proposed`, with an assignee of NULL or the owner. Picking any other name writes `delegated` with `assignee` = that exact list spelling. Skip writes `dismissed`. These are the same targets as `TRIAGE_TARGET` (`meeting-triage.ts:200-204`), through the same `store.triage` (`engine.ts:372`). | happy/regression | SELECT proposals: state + assignee |
| AC-T13 | Given the same picker in Actions > Meetings, when the owner reassigns an item, then it is the SAME component and the SAME people list, and the item moves between the mine and forSomeone groups (`meeting-triage.ts:290-296`). A name typed in one place is offered in the other. | cross-surface | UI both places; one list row |
| AC-T14 | Given the owner types a new name "Jordan Lee" in any picker (owner, participant, speaker), when they confirm, then it is cleaned by the same rule as `cleanTriageName` (whitespace-collapsed, at most 80 chars, `meeting-triage.ts:208-212`) and persisted server-side per owner. It is offered on the next page load and on another device. Case-insensitive duplicates ("jordan lee") are NOT added twice. | happy/edge | reload + 2nd browser; SELECT people table |
| AC-T15 | Given the people list, when the owner tries to remove Von, then there is no control to do it. Removing another person asks for confirmation, and existing meetings and items keep the name (`meetings.html:582-593`). An empty or whitespace name adds nothing. | negative | DOM has no remove for Von; SELECT |
| AC-T16 | Given triage complete, when the owner clicks "Save and add to Trinnex memory", then title, series, participants, speaker map and owners are committed in one request. The meeting is enqueued for Trinnex ingestion as a durable row with state `queued`, and the toast says "queued", never "added". "Save without adding to memory" commits the same fields and enqueues NOTHING. Re-saving an already-ingested meeting re-ingests it (passages replaced, not duplicated). | happy/negative | SELECT queue row; Trinnex DB row count unchanged on plain save |
| AC-T17 | Given items with no owner, when the owner saves, then they are saved untriaged ("saved without one", `meetings.html:611-612`) and stay in the triage queue. They are not dropped and not made Mine. | edge | SELECT state `untriaged` |
| AC-T18 | Given today's chat-based triage checklist (`meetingTriageDirective`, `meeting-triage.ts:252-256`), when the module ships, then that path still works unchanged, OR its removal appears as an impact-table row approved by the owner. Either outcome is checked by a test. | regression | existing proposals tests green |
| AC-T19 | Given a meeting with 0 action items and 0 speakers, when triage opens, then the Actions and Speakers sections show empty states and the save still works. | edge | Playwright |

---

## 2. Trinnex Library (Tier 2 UI; ingestion is Tier 1)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-L1 | Given the upload control, when the owner drops one file each of `.pdf .docx .pptx .xlsx .txt .md .vtt .srt`, then all 8 are accepted. A `.exe`, a `.doc`, a `.PDF.exe` and an extensionless file are rejected with "Not added, unsupported type: <names>" (`library.html:405-415`). The extension test is case-insensitive (`.PDF` is accepted, `library.html` `ext()` lowercases). The server re-checks the type from the file's magic bytes and refuses a `.pdf` that is really a zip of something else. | happy/negative | Playwright + direct server-fn call with a forged file |
| AC-L2 | Given an uploaded file, when it is saved, then Type is set automatically: `.vtt`/`.srt` is Transcript; `.md`/`.txt` whose name contains "transcript" is Transcript; everything else is Document (`library.html:294-299`). The owner can override Type. Type decides the split: by speaker turn for a transcript, by page/slide/sheet for a document. | happy | DB `metadata.kind`; passage boundaries |
| AC-L3 | Given a file, when the form opens, then Category is pre-filled with a suggestion, and an EXISTING category is preferred over a new one (`library.html:300-305`). The owner can accept it, pick another, or type a new one. A new category joins the list for all later uploads, server-side and persistent. There is no fixed list and no "Policy" default; an empty category stores "General" (`library.html:642`). Case-insensitive duplicates do not create a second category. | happy/edge | reload shows the new category; SELECT distinct |
| AC-L4 | Given file names, when the form opens, then people names are suggested from the file name using the SAME parser as the meeting titles (spelling table S-A). Suggestions are never applied without a click. | happy | DOM |
| AC-L5 | Given a transcript upload (`.vtt`/`.srt` with voice labels), when the form opens, then the speakers are listed and can be mapped exactly as in AC-T10, with the same people list. Mapping is optional; unmapped labels are stored raw (AC-T11). Speakers can be set later from the file's detail drawer, and that rewrites the passages' speaker. | happy | DB metadata.speaker |
| AC-L6 | Given an upload, when it is processing, then its status moves through Uploaded, Read, Split into passages, Facts pulled out, Searchable (`library.html:272`), driven by the SERVER state, not a client timer. A failure at any step shows "Failed: <step> (<reason code>)" with a Retry button and leaves no half-searchable rows. A triaged meeting not yet ingested shows "Waiting for triage" or "Queued". The passage and fact counts shown equal `count(*)` in the Trinnex DB for that source. | happy/error/reconcile | SELECT counts vs UI |
| AC-L7 | Given a Searchable item, when the owner chooses Remove from memory and confirms, then in the Trinnex DB 0 `rag_chunks` and 0 `rag_triples` rows (including superseded ones) remain for that source, and the stored blob is deleted (`deleteIfExists`). For a meeting, the item returns to "not in memory" while the meeting record and the OneDrive file stay. Every one of these must be an EXPLICIT delete: `rag_triples.source_chunk_id` is `ON DELETE SET NULL` (`azure-pg.server.ts:177`), so deleting chunks alone ORPHANS the facts, which stay searchable. | Tier 1 / happy | SELECT counts = 0 incl. `source_chunk_id IS NULL` orphans; blob HEAD = 404 |
| AC-L8 | Given Remove, when one of the three deletes fails, then the item shows "Removal incomplete" and the remaining deletes can be retried. The item is never shown as removed while any row or blob survives. | error | forced failure |
| AC-L9 | Given a 14-page PDF, when it is ingested, then every passage is at most 8000 chars (the embed cap, `embed.server.ts:18`) and carries `metadata.page`. A pptx passage carries `metadata.slide`, an xlsx passage carries `metadata.sheet` (+ row range). No text from the file is lost between passages. | Tier 1 / edge | SELECT max(length(text)); concatenation covers the source |
| AC-L10 | Given the same file uploaded twice, when the second upload finishes, then the passage count does not double (the dedup key includes `source` and `md5(text)`, `azure-pg.server.ts:79`), and the Library shows one item or asks "replace?". | edge | SELECT count before/after |
| AC-L11 | Given an empty file, a scanned image-only PDF (no text layer) or a password-protected file, when it is uploaded, then it ends as "Failed: no readable text" or "Failed: protected file". It never ends as Searchable with 0 passages, and nothing tries to break the protection. | edge/error | UI status; 0 rows |
| AC-L12 | Given a file over the size cap (the cap is an open question; propose 25 MB), when it is uploaded, then it is refused before upload with the cap stated. | edge/perf | UI |
| AC-L13 | Given the Library list, when the owner filters by category or searches, then the results match name, category, tags and participants (`library.html:684-686`), and the category pill counts equal the item counts. | happy | DOM |
| AC-L14 | Given a 10-page PDF, when it is uploaded, then it is Searchable within 120 s (proposed default, owner to confirm), and the upload request itself returns within the SWA ~45 s ceiling: the work is queued, not done in the request. | performance | timed run |

---

## 3. Trinnex memory and Ask (Tier 1)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-M1 | Given the server `eds-postgresql`, when Trinnex is provisioned, then a new database (proposed name `Trinnex_Memory`) exists beside `RAG_AI_Agents`, and its connection string comes from a NEW pinned app setting (e.g. `TRINNEX_PG_URL`). That setting is assembled in `deploy-swa.yml` the same way as `AZURE_PG_URL` (`deploy-swa.yml:321-368`), with its own default DB override that can never fall back to `postgres` or to `RAG_AI_Agents`. The deploy log prints "Assembled TRINNEX_PG_URL for eds-postgresql/<db>". | Tier 1 | deploy log line; SWA app setting |
| AC-M2 | Given the Trinnex DB, when the explicit bootstrap runs (a button or workflow, NOT auto on first read, matching how memory is bootstrapped today; see `CLAUDE.md`), then it runs byte-identical `BOOTSTRAP_SQL` (`azure-pg.server.ts:101`). Both dedup indexes are reported present (`:257-271`), and the `vector` extension is present. A Trinnex read before bootstrap returns a clear "Trinnex memory not set up" error, not a crash, and never falls back to the personal DB. | Tier 1 | runBootstrap result JSON |
| AC-M3 | Given the store code, when Trinnex is built, then the SAME store functions serve both databases with the pool as a parameter (today `getPool()` is a module singleton over `getSharedPool()`, `azure-pg.server.ts:43-51`). There is no copy of `writeChunk`/`searchChunks`/`writeTriples`/`lookupTriples`. A unit test proves a Trinnex write lands in the Trinnex pool and NOT in the shared pool. | Tier 1 / extend | test with two fake pools |
| AC-M4 | Given an ingested meeting passage, then `metadata` holds `meeting_id`, `title` (the edited one), `fireflies_title`, `meeting_at` (ISO), `series` (or null), `participants[]`, `speaker`, `speaker_label`, `start_s`, `end_s`, `kind: "transcript"`, `source_ref`. A document passage holds `doc_id`, `file_name`, `category`, `page`/`slide`/`sheet`, `kind: "document"`. `source` = `trinnex:meeting:<id>` or `trinnex:doc:<id>`, so delete-by-source is one predicate. | Tier 1 | SELECT metadata keys |
| AC-M5 | Given a renamed meeting (title or series changed after ingestion), when it is saved, then the passages' `metadata.title`/`series` are updated in place. A series filter finds the meeting under its new series and NOT under its old one. | Tier 1 / regression | filter query before/after |
| AC-M6 | Given personal memory writes (huddle turns writing `scope='global'` rows), when any turn runs in any huddle, then 0 rows are written to the Trinnex DB. Given Trinnex ingestion, then 0 rows are written to `RAG_AI_Agents.public.rag_chunks`/`rag_triples`. | Tier 1 isolation | row counts in both DBs before/after a marker turn and a marker ingestion |
| AC-M7 | Given auto-retrieval (`retrieveAgentMemory`, `memory-context.server.ts:69-90`, every turn), when ANY agent (Iris and Eli included) answers in personal or group chat with Trinnex scope off, then no Trinnex row appears in the injected memory block. Given every agent other than `iris-chase` and `eli-vaughn` (`agents.ts:423,595`), in any huddle, with any switch value, then the Trinnex DB is never queried. A test enumerates every agent id in `agents.ts`, so a newly added agent is covered automatically. | Tier 1 isolation | pool spy: 0 Trinnex queries per non-allowed agent |
| AC-M8 | Given fact extraction on a Trinnex passage, when `extractTriples` (`triples.server.ts:47`) returns triples, then EVERY stored Trinnex triple has a non-null `source_chunk_id` pointing to an existing Trinnex chunk. A triple without one is not stored. A triple whose subject, predicate or object is empty, or longer than the existing caps, is dropped. The model's output is DATA: an instruction inside a document ("ignore previous instructions…") is stored as text at most, never followed. | Tier 1 provenance | `SELECT count(*) FROM rag_triples WHERE source_chunk_id IS NULL` = 0 |
| AC-M9 | Given two Trinnex sources asserting different values for the same (subject, predicate), when both are ingested, then supersede does NOT hide the older source's fact silently: either both are kept (no `supersede` on Trinnex writes) or the newer one supersedes AND the answer cites the newer date. Deleting the newer source must restore the older fact as live, or there must be no supersede at all. Today supersede keys on (scope, agent_id, subject, predicate) with no source in the key (`azure-pg.server.ts:657-662`). | Tier 1 | two-source fixture, delete one, lookup |
| AC-M10 | Given Iris or Eli in a 1:1, when the Trinnex/Everything switch is "Trinnex", then retrieval queries ONLY the Trinnex DB and the answer uses no personal memory. When it is "Everything", it queries both, and each source card is labelled with where it came from. The switch value is per conversation, persisted, and visible. It defaults to "Trinnex" in the Ask surface (prototype `ask.html:233`). | Tier 1 | pool spy: personal pool 0 queries in Trinnex mode |
| AC-M11 | Given "What did Michael say was the outcome of the vendor review?", when Iris answers, then retrieval is filtered to `metadata.speaker = "Michael R."` (resolved through the people list; "Michael" alone matches only if exactly one person has that first name, otherwise Iris asks which Michael). The answer cites only Michael's passages. | Tier 1 / filter | retrieved chunk ids all have speaker Michael R. |
| AC-M12 | Given "to-dos from the last Engineering Leaders meeting", when Iris answers, then the filter is series = "Engineering Leaders" (case-insensitive) AND the single max `meeting_at`. Only that meeting's items are cited, NOT the last 3 meetings mixed. If the series has no meetings, Iris says so (AC-M14). | Tier 1 / filter | cited meeting_id = argmax |
| AC-M13 | Given any Trinnex answer, then each claim carries a source card: title, date, speaker and timestamp for a transcript, or file name and page/slide for a document, plus the quoted passage text verbatim from the stored chunk. A card whose quote is not a substring of a stored chunk's text fails. The answer contains no claim that cites no source. | Tier 1 | quote ⊂ chunk.text check |
| AC-M14 | Given a Trinnex-mode question with no hit above the floor (0.3, `memory-context.server.ts:24`), then Iris says "I couldn't find that in your Trinnex material" with a link to the Library (`ask.html:296`) and states no fact. This deliberately REVERSES today's silent-miss rule (`EMPTY_RESULT_GUIDANCE`, `tools.ts:63-72`; house text `tools.ts:158`), so the reversal is scoped to Trinnex mode only. Personal chat keeps the silent miss unchanged, and a test pins both. | Tier 1 / error / regression | two scripted turns |
| AC-M15 | Given a deleted source (AC-L7), when the same question that cited it is asked again, then no card cites it and no fact derived from it is used. This must hold within one turn of deletion: there is no cache. | Tier 1 | re-ask after delete |
| AC-M16 | Given a Trinnex retrieval error (DB down, not bootstrapped, 429 on embeddings), when Iris answers in Trinnex mode, then she says Trinnex memory is unavailable right now. She never answers from general knowledge as though it were sourced, and never silently switches to personal memory. | error | forced pool error |
| AC-M17 | Given Iris's voice 1:1 (`assembleRealtimeInstructions` also calls `retrieveAgentMemory`, `memory-context.server.ts:3-4`), then voice obeys the same isolation and switch as text. Until voice is in scope, voice NEVER queries Trinnex. | Tier 1 isolation | pool spy on the voice path |
| AC-M18 | Given a Trinnex question, when Iris answers, then retrieval adds at most 2 s p50 over today's turn (one embed + one ANN query per DB queried). | performance | timed harness, 10 runs |

---

## 4. Cost and safety (Tier 1 where it touches logs)

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-C1 | Given the new resources, when the plan is stated, then idle cost is $0: a new DATABASE on the existing `eds-postgresql` (no new server), and no always-on compute. Workers ride the existing once-a-minute heartbeat that already drives Fireflies (`minutes-store.server.ts` work-queue note at :54-57), with no new timer or keep-warm. | cost | `az` resource list shows no new billable resource |
| AC-C2 | Given uploaded files, then they go to a NEW private container (e.g. `trinnex-library`) on the SAME storage account already behind `AZURE_STORAGE_CONNECTION_STRING` (`blob.server.ts:28`). That costs $0 idle beyond pennies per GB stored. Reads go through a short-lived SAS like artifacts (`blob.server.ts:3`). A bare GET returns 409/404, never the file. | cost/security | unauthenticated GET status |
| AC-C3 | Given the build, then no new org secret is created. The Trinnex connection string is assembled from the same SP and admin credential as `AZURE_PG_URL` (`deploy-swa.yml:328-368`). | cost/secret | diff of `deploy-swa.yml` secrets list (`:54`) |
| AC-C4 | Given ingestion, retrieval, triage and delete paths, when any of them logs, then a log line contains ids, counts, step names and error CODES only. No transcript text, passage text, quote, meeting title, file name or person name appears, matching the existing "Never logs ids or titles" rule (`fireflies.server.ts:247`) and the ERR-code-only logging at `:544`. A test greps captured logs for a marker string planted in a fixture transcript and finds 0 hits. | security | log-capture test |
| AC-C5 | Given an AI failure in ingestion (embed or extract), then the failure KIND is logged (HTTP status / `insufficient_quota` / timeout). A quota failure marks the item "Failed: AI quota" visibly to the owner. It is never only counted. | error | forced 429 |
| AC-C6 | Given any test or UAT run, then fixture titles, file names and tasks start with `Test-` and carry a run marker. All Trinnex rows, blobs and proposals with that marker are auto-removed at the end, and 0 remaining is reported. | safety | post-run SELECT |
| AC-C7 | Given access control, then every Trinnex read, write and delete is scoped to the owner's email (as artifacts are). A second user's session lists 0 of the owner's Trinnex items and cannot delete one by id. | security | 2-identity test |

---

## 5. Spelling table (Tier 1: the name parser and the question filters parse input)

**Ground rule.** These inputs have no external documentation. The source of truth for each verdict is the
OWNER-APPROVED prototype behaviour (cited per row) plus the owner's stated intent. Where the two prototype parsers
disagree, the row says so; the build must use ONE shared parser for titles AND file names.
- Meetings parser: `meetings.html:378-398` (`titleNames`, `TITLE_STOP`).
- Library parser: `library.html:325-365` (`nameHits`, `NAME_STOP`, `NAME_TRIGGERS`, `nameLike`).

People list for these rows: ["Von", "Michael R.", "Priya S.", "Dana K."] (`data.js` `people`). The owner is "Von".

### S-A. People names from meeting titles and file names

| # | Input | Documented by | Expected suggestion(s) | Wrong answer would be |
|---|---|---|---|---|
| S-A1 | `Meeting with Priya` | meetings.html:385-388 (known first name) | `Priya S.` | FALSE REFUSAL |
| S-A2 | `Von / Michael 1:1` | meetings.html:383,390-393 (owner excluded; "/" trigger) | `Michael R.` only, never `Von` | FALSE PASS if Von is offered |
| S-A3 | `1on1_Dana` (as a meeting title) | library.html:346-347 (1on1 trigger, `_` → space). The meetings regex has NO `1on1` trigger (:391), so the parsers DISAGREE | `Dana K.` | FALSE REFUSAL (meetings parser today) |
| S-A4 | `1on1_Dana.md` (as a file name) | library.html:345-347 | `Dana K.` | FALSE REFUSAL |
| S-A5 | `Sync w/ Jordan` | meetings.html:391 ("/" branch); library.html:347 | `Jordan` (new name, offered with "add") | FALSE REFUSAL |
| S-A6 | `Priya-budget-notes.docx` | library.html:347 (`-` → space), :355-358 (known first name) | `Priya S.` | FALSE REFUSAL |
| S-A7 | `Q1 planning.pptx` | library.html:327-331 ("planning" stop; no trigger) | none | FALSE PASS |
| S-A8 | `Marchesi review` | no trigger; `march` is a stop word but must be matched as a whole token, not a prefix (library.html:333) | none (no trigger, not a known person) | FALSE PASS if offered |
| S-A9 | `Sync with Marchesi` | library.html:359-362 (trigger + nameLike; a whole-token stop check lets "Marchesi" through) | `Marchesi` | FALSE REFUSAL if the month check is prefix-based |
| S-A10 | `Weekly sync` | meetings.html:378; library.html:328 | none | FALSE PASS |
| S-A11 | `Meeting with the team` | stop words "the", "team" | none | FALSE PASS |
| S-A12 | `Sync with Von` | owner excluded (meetings.html:383,394) | none | FALSE PASS |
| S-A13 | `Budget/Forecast review` | library NAME_STOP has `forecast` (:332). Meetings TITLE_STOP does NOT (:378), so the meetings parser offers "Forecast" | none | FALSE PASS (meetings parser today) |
| S-A14 | `Lunch with ACME` | library `nameLike` needs Capital+lowercase (:343). The meetings regex accepts all-caps (:391) | none (organisation, not a person) | FALSE PASS |
| S-A15 | `Sync with José` | library `nameLike` `[a-z'’]` rejects `é` (:343). The meetings regex `[A-Za-z'\-]` captures the truncated `Jos` (:391) | `José` | FALSE REFUSAL (library) / WRONG NAME `Jos` (meetings) |
| S-A16 | `meeting with priya` (lower case) | known-person match is case-insensitive (meetings.html:380) | `Priya S.` | FALSE REFUSAL |
| S-A17 | `Meeting with Priya and Dana` | two triggers | `Priya S.`, `Dana K.` (order kept, no duplicates) | FALSE REFUSAL of the second |
| S-A18 | `Call with May` | `may` is a month stop word (library.html:333) | none unless "May" is in the people list, in which case `May` | FALSE PASS / accepted limitation, see Open Questions |
| S-A19 | `Michael's 1:1` | `Michael` is a known first name with a possessive | `Michael R.` | FALSE REFUSAL |
| S-A20 | `Q3/Q4 planning` | `/` trigger, but `Q4` is not nameLike | none | FALSE PASS |
| S-A21 | `Sync with Michael` while the people list holds `Michael R.` AND `Michael T.` | ambiguous first name | both offered, neither auto-picked | FALSE PASS (wrong Michael picked) |
| S-A22 | `"Meeting with Priya" <script>` (markup in a title) | untrusted text | `Priya S.`; the markup is rendered as text | security: XSS |

### S-B. Fireflies speaker labels as they actually arrive

**Observed shapes in the repo**: `speaker_name?: string` (`fireflies.server.ts:75`), optional. The formatter maps
undefined/null/empty/whitespace to `"Speaker"` (`fireflies.server.ts:180`; `minutes.ts:128`); `source-item.ts:312`
keeps it via `str()`. Test fixtures carry only display names (`"Sam"`, `"Ana"`, `fireflies-minutes.test.ts:200-201`;
`"Synth A"`, `correspondence-ingest.test.ts:880`). **No fixture in the repo contains `"Speaker 1"`.** The
`"Speaker N"` shape comes from the prototype (`data.js`) and is NOT attested by real data here (see Gaps).
`start_time` arrives as a string (`"65.2"`) or a number.

| # | Input `speaker_name` | Documented by | Expected | Wrong answer would be |
|---|---|---|---|---|
| S-B1 | `"Speaker 1"` | prototype data.js; regex `^speaker\s*\d+$`i (meetings.html:462) | unmapped label, offered for mapping | FALSE PASS if auto-mapped |
| S-B2 | `"speaker 2"`, `"Speaker  3"`, `"SPEAKER 4"` | same regex is case-insensitive and allows any whitespace | unmapped label (same class as S-B1); label is kept verbatim | FALSE REFUSAL (treated as a name) |
| S-B3 | `"Speaker"` (no number) | fireflies.server.ts:180 fallback | ONE bucket "Unknown speaker". All such lines are mapped together; the UI warns it may be several people | FALSE PASS (merging is silent) |
| S-B4 | missing / `null` / `""` / `"   "` | fireflies.server.ts:180; minutes.ts:128 | same bucket as S-B3 | crash / FALSE PASS |
| S-B5 | `"Von Ellis"` | meetings.html:207-212 (full or first name) | pre-mapped to `Von`, still editable | FALSE REFUSAL |
| S-B6 | `"Sam"` (display name not in the people list) | fireflies-minutes.test.ts:200 | shown as "Sam", offered with "add Sam" and "this is someone else"; never auto-added | FALSE PASS if auto-added |
| S-B7 | `"Michael"` with two Michaels in the people list | ambiguity | not auto-mapped; both offered | FALSE PASS |
| S-B8 | `"Speaker 10"` vs `"Speaker 1"` | distinct labels | two separate rows (no prefix collision) | FALSE PASS (merged) |
| S-B9 | `"Priya S. (Guest)"` / an email-shaped `"priya@x.example"` | not attested; defensive | matched to `Priya S.` only on an exact normalised name or a known email, else unmapped | FALSE PASS (loose substring) |

### S-C. "Most recent meeting in a series" in questions

Source: the prototype "How Iris knows this" panel, `"last" = most recent date` and `series + most recent date`
(`ask.html:374,384`), plus the owner's example question (`data.js` qa[1]).

| # | Question phrasing | Expected filter | Wrong answer would be |
|---|---|---|---|
| S-C1 | `the last Engineering Leaders meeting` | series ILIKE 'Engineering Leaders', ONE meeting = max(meeting_at) | FALSE PASS (several meetings mixed) |
| S-C2 | `the latest Engineering Leaders` / `most recent Eng Leaders sync` | same filter. "Eng Leaders" resolves only if it matches exactly one series by prefix or alias; otherwise Iris asks | FALSE REFUSAL / wrong series |
| S-C3 | `last week's Engineering Leaders meeting` | series + meeting_at within the previous calendar week (owner TZ), NOT max(meeting_at) | FALSE PASS (wrong meeting) |
| S-C4 | `the last two Engineering Leaders meetings` | top 2 by meeting_at | FALSE PASS (only 1) |
| S-C5 | `the Engineering Leaders meeting before last` | 2nd most recent | FALSE PASS (most recent) |
| S-C6 | `last time we discussed the vendor` | NOT a series filter. A semantic search, ranked by date among the hits | FALSE PASS (treated as a series) |
| S-C7 | `the last meeting` (no series) | max(meeting_at) across all Trinnex meetings | FALSE REFUSAL |
| S-C8 | `the last Weekly sync` where untriaged meetings are only titled "Weekly sync" with no series | matches the edited title or the Fireflies title only if no series is set; an untriaged meeting is not in memory at all (AC-T16), so it is an honest miss | FALSE PASS (finds non-ingested data) |
| S-C9 | `last Engineering Leaders` when the most recent one is queued but not yet ingested | answers from the latest INGESTED one and says a newer one is still processing | FALSE PASS (silently stale) |
| S-C10 | `what did Michael say last` | speaker filter + max(meeting_at) among Michael's passages | wrong speaker / wrong meeting |
| S-C11 | `"last"` inside a quoted title, e.g. `the "Last Mile" review` | title match, NOT recency | FALSE PASS |

---

## 6. Goal → AC coverage

- Meetings carry real titles, series and people: AC-T1..T6, S-A
- The OneDrive file name matches the title: AC-T7..T9
- Each voice says who said it, "for the benefit of the rag storage": AC-T10, T11, L5, S-B
- Pick owners without retyping; Von first; adds persist: AC-T12..T15
- Load work documents: AC-L1..L14
- Ask Iris/Eli with sources: AC-M10..M14, M18, S-C
- Personal chats never leak work content (decision "A"): AC-M1..M3, M6, M7, M17
- Remove means gone: AC-L7, L8, M15
- Stored model output is traceable: AC-M8, M9
- Cost and secrets: AC-C1..C3; privacy of logs: AC-C4, C5; test hygiene: AC-C6; multi-user: AC-C7
- No AC without a goal. AC-T18 (regression of the chat triage path) traces to "never change existing behaviour without the impact table".

## 7. Gaps (things I could not verify cold)

- **`"Speaker N"` is not attested by any fixture or code path in the repo.** Before building S-B1/S-B2 parsing, pull
  one real `sentences[].speaker_name` set from `chat.correspondence_ledger` (source `transcript`, via
  `azure-pg-query.yml`). If real data has only display names and `null`, S-B1/S-B2 become dead code.
- `lib/db/shared-pool.server.ts` was not read. AC-M3 assumes it returns ONE pool keyed on `AZURE_PG_URL`.
- `ActionsView.tsx` was not read. AC-T13 assumes Actions > Meetings currently uses a typed-name box, as the prototype states (`index.html` change table).
- Whether `extractTriples` today returns a per-triple chunk linkage was not read past the signature (`triples.server.ts:47`). AC-M8 requires the linkage either way.

## 8. OPEN QUESTIONS (genuine owner decisions only)

1. **Remove from memory: also delete the stored file?** The brief says remove deletes passages, facts AND the stored
   file. The approved prototype says *"The original file is not touched"* (`library.html:810`). For an UPLOAD, the
   options are: (a) delete the blob too, so it is gone everywhere, or (b) keep the blob, so it can be re-added
   without uploading again. AC-L7 is written as (a). For a MEETING, the OneDrive file stays under both options.
2. **Honest miss in "Everything" mode.** The prototype shows a miss message in Everything mode too (`ask.html:297`).
   Today personal memory misses are deliberately silent (`tools.ts:63-72`). Should Everything-mode misses be (a)
   honest, which changes today's behaviour for Iris/Eli when the switch is on, or (b) silent like today? AC-M14 is
   written as Trinnex-mode-only.
3. **Supersede across sources** (AC-M9): when two documents disagree, should the newer fact (a) hide the older one,
   or (b) should both be kept and Iris shows the conflict with both sources? I recommend (b).
4. **What "Mine" stores as assignee**: NULL, as today's Mine, or "Von", so "what does Von owe" works the same way as
   for others?
5. **Upload size cap and the Searchable-time target** (AC-L12: 25 MB proposed; AC-L14: 120 s for 10 pages proposed).
6. **First-name-only people** (S-A18 "May", S-A21 two Michaels): is "suggest, never auto-pick" acceptable for
   ambiguous names?
7. **Default switch position in Iris/Eli's ORDINARY 1:1** (outside the Ask surface): Trinnex, Everything, or off
   (personal only, as today)? This decides whether existing 1:1 behaviour changes.
