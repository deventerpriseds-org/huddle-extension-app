<!--
WHAT:          build log for the LIBRARY lane of the Trinnex workspace (upload, store, extract, ingest, remove).
WHY:           spec docs/qc-evidence/AC-trinnex-workspace.md section 2 (AC-L*), section 4 storage/cost rows,
               section 5 file-name rows, section 9 decisions, section 10 lane contract. Written as-you-go so a
               container reclaim loses at most one step.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      commits on origin/claude_trinnex-library; tests named per step below.
-->

# BUILD: Trinnex Library lane

Branch `claude_trinnex-library`, cut from `origin/claude_trinnex-workspace` at `dd88c0f2`.

## Steps (one line each: ACs, test that covers them)

- S0 branch cut; spec read in full (280 lines).
- S1 stubs: `lib/trinnex/memory.server.ts` = section 10 contract STUB (zeros, `trinnexConfigured()` false). `lib/trinnex/names.ts` = VERBATIM copy of the meetings lane's file at `origin/eds-wip/claude_trinnex-meetings` 86e781dc (export `suggestNames`/`speakerKey`/`matchSpeaker`), so the export matches and the merge is add/add-identical; take THEIRS on merge.
- S2 pure rules `lib/trinnex/library-core.ts`: AC-L1 types, L2 Type, L3 category, L5 cues/speakers, L9 splitter (7000-char cap < 8000 embed cap, exact-substring slices), L12 25 MB. Tests: `scripts/trinnex-library.test.ts` "L1 accepts...", "L2 type is automatic", "L3 category...", "L12 the cap is 25 MB", "L9 splitter...", "L5 transcript cues...", "L4 people come from the file name..." (S-A2, S-A4, S-A6, S-A7).
- S3 extraction `lib/trinnex/extract.server.ts` + `lib/trinnex/zip.server.ts`: AC-L1 magic bytes, L9 page/slide/sheet, L11 no text / protected. Fixtures `scripts/fixtures/trinnex/` built by `make-fixtures.py`. Tests "L9 pdf/docx/pptx/xlsx ...", "L1 server refuses a pdf whose bytes are a zip", "L11 empty, image-only and protected...", "L2 vtt yields cues". Result: `bun test scripts/trinnex-library.test.ts` 14 pass 0 fail.
- NEW LIBRARY `unpdf` 1.4.0 (published 2025-10-31; 0 dependencies; 1.83 MB unpacked, 2.1 MB on disk). Why: PDF text needs a real parser (font encodings, ToUnicode maps, compressed streams); pdf.js is the standard and unpdf ships its serverless build that runs in Node with no worker and no native code, so it runs in SWA's Node functions. Lazy `import("unpdf")` inside the worker only. NOT added: an unzip library (zip.server.ts on node:zlib, ~80 lines); jszip is only transitive and undeclared.
- Lockfiles NOT regenerated: `bun install` in this container fails on proxy 403 for unrelated tarballs (chalk, @oxc-project/types). The deploy's `bun install` resolves `unpdf` from package.json. Step for the owner/merger: run `bun install` once where the registry works and commit `bun.lock` + `package-lock.json`.
- S4 store + pipeline `lib/trinnex/library.server.ts` (schema `trinnex` in RAG_AI_Agents: WHY a new schema, not `artifacts`: artifacts.items are AGENT outputs the owner reviews/approves and mirrors to OneDrive; uploads are owner INPUTS to a separate memory, and listing them under artifacts would surface them in the Artifacts view and the mirror. Tables `trinnex.library_items` (all brief columns + content_hash, lease) and `trinnex.library_categories`). Shared pool via `getSharedPool()`, email-scoped (AC-C7). Blob: container `trinnex-library` on the same account ($0 idle). Pipeline AC-L6/L11/C5, removal AC-L7/L8 (Q1: memory + blob + row; row deleted LAST). Tests "L6 status follows...", "L6 waiting for Trinnex memory...", "C5 quota failure...", "L11 protected file fails at Read", "L5 transcript passages carry the mapped speaker", "L7 remove deletes memory, file and row", "L8 a failed blob delete...", "L8 a failed memory delete...", "L8 ingested rows with memory unavailable...". Result 23 pass 0 fail.
- S5 server fns `lib/trinnex/library.functions.ts` (list, upload base64 with 25 MB + type re-check + sha256 duplicate -> "replace?" AC-L10, process kick, retry, set speakers AC-L5, remove). Heartbeat: one call added to `lib/tasks/scheduler.server.ts` (SHARED FILE, +6 lines, same shape as Fireflies). `lib/artifacts/blob.server.ts` (SHARED FILE): optional `containerName` param on put/get/delete; existing callers unchanged.
- S6 UI `components/TrinnexLibraryView.tsx` (header anatomy from PolishView; tokens only; right Sheet max 440px; phone: single column, safe-area padding, stepper stacks). Placement: "Trinnex Library" entry in `HUDDLE_APPS` (AppsLauncher.tsx), so it appears in BOTH the desktop Rail popover and the phone Apps sheet; no new nav. SHARED-FILE edits (minimal): `store.ts` View union +1, `HuddleApp.tsx` VIEWS + FULL_WIDTH_VIEWS +1, `ViewSwitcher.tsx` VIEW_TITLE +1, `AppsLauncher.tsx` +1 entry. Covers AC-L1 (drop rejects with the prototype text), L3 (datalist + suggestion chip + "New category"), L4 (dashed suggestion chips, never auto-added), L5 (speaker rows, all labels stored, drawer remap -> re-ingest), L6 (stepper from server status; polls only while in flight), L7/L8 (in-page confirm, "Removal incomplete" + Retry remove), L10 (replace? prompt), L12 (refused before upload), L13 (search name/category/people + category pill counts). Fireflies row: read-only count. `tsc --noEmit`: 0 errors in touched files.
- UNVERIFIED UI: nobody has LOOKED at this view yet (no browser in this lane). Owner or UAT must open Apps -> Trinnex Library on a phone and on desktop.
- S7 VERIFY. `bun test scripts/trinnex-library.test.ts`: 23 pass 0 fail. Existing artifact tests after the blob.server.ts edit: `bun scripts/artifact-format-dispatch.test.ts` 48 passed 0 failed; `bun scripts/artifact-traversal-guard.test.ts` 15 passed 0 failed. `nice -n 10 npm run build`: rc=0 ("built" x3, nitro prebuilt OK). The first build failed on `parse5` missing from the SHARED node_modules (pre-existing, not this lane; `html-visible.ts`); parse5 7.3.0 + entities 6.0.1 were unpacked into THIS worktree only to get a real result. `tsc --noEmit`: 0 errors in touched files.
- S8 MUTATIONS (`mutate.sh`, anchors in files, bare test names; bun prints `(fail) describe > name`, so the test cmd is a wrapper that rewrites it to `FAIL name`, exit code kept with pipefail):
  - M1 `library.server.ts` `if (remaining.length) {` -> `if (false) {` : "L8 a failed blob delete keeps the row as removal incomplete" -> FIRED (control EQUIVALENT), exit 0.
  - M2 `extract.server.ts` %PDF- magic-byte check removed : "L1 server refuses a pdf whose bytes are a zip" -> FIRED (control EQUIVALENT), exit 0.
  - M3 `library.server.ts` ingest-failure cleanup `await deps.memory.remove(item.id)` -> `void 0` : "C5 quota failure is named and leaves no half-searchable rows" -> FIRED (control EQUIVALENT), exit 0.
  - M4 `library-core.ts` `PASSAGE_MAX_CHARS = 7000` -> 9000 : "L9 splitter keeps every passage under the cap and loses no text" -> FIRED (control EQUIVALENT), exit 0.

## Not covered / open
- AC-L6 counts reconcile with `count(*)` in the Trinnex DB, AC-L9 metadata.page/slide/sheet keys, AC-L14 120 s timing: depend on the MEMORY lane (contract passes only `page`, so slide/sheet travel as "slide 3" / "sheet X rows a-b" in `page`; the memory lane must map them).
- AC-C2 bare-GET 404/409 and AC-C7 two-identity test: need a live run (no live calls in this lane). Container is created PRIVATE (no access arg).
- AC-C6 UAT cleanup harness: not written.
- People list: interim = names already tagged in the Library; switch to the meetings lane shared people list when it lands (AC-L5 "same people list").
- Fireflies count uses `triaged_at` on chat.fireflies_meetings IF the meetings lane adds that column; otherwise counts every recorded meeting. Rename if their column differs.
- Upload is a base64 server-fn body (25 MB file = ~33 MB request). Not measured against the SWA request limit.
- UI not looked at on any screen.
