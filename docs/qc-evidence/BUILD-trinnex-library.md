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
