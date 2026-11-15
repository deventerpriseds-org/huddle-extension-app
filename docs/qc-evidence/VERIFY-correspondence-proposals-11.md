# VERIFY-correspondence-proposals-11

WHAT:       Independent verifier loop 11 for `claude_task-proposals` @ `90af5f3a` vs `origin/main`.
WHY:        Loop 10 (`claude_verify-correspondence-proposals-10`) refuted 1d-new (a cut comment removed main's stopping `>`),
            1e (per-token stack walks ~2000x main) and claim 4 (Lovable build_checklist offered `proposals` with flags off).
            90af5f3a claims fixes for all three plus a NEW owner-approved tag-span rewrite. This loop re-derives each.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-10.md stays as the loop-10 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts `scripts/verify11-*` on this branch; loop 5-10 probes copied unchanged from the loop-10 branch.

Verifier started 2026-11-15 22:38 UTC. Budget 90 min active. All fixtures synthetic. No live systems touched.

## Results (appended per claim as each lands)

- Claim 0 (suites): CONFIRMED

## Claim 0: every suite at 90af5f3a -- CONFIRMED
Ran EVERY `scripts/*.test.ts` (107 files) with `bun <file>`, PG 16 on PATH. **97 exit 0.** The 10 non-zero files are the
same 10 as loop 10, each re-checked against `origin/main` @ `e546e4c2` (`git archive`):

| file | branch | origin/main |
|---|---|---|
| autowork-lane-starvation / memory-context / raw-create-dedup / timeout-no-rerun | rc 1 "outside the test runner"; `bun test` rc 0 | `bun test` rc 0 |
| fireflies-minutes, focus, memory-mode, model-policy, start-on-approval | rc 1 | rc 1, failure lines identical (diffed, timings stripped) |
| confirm-reask-db | rc 2 `REFUSING: LOCAL_PG_ADMIN_URL ...` | rc 2, same refusal |

Named suites, observed: html-visible-loop5 46/0, checklist-tool 8/0, forwarded 22/0, onedrive-feed-truth 11/0, inbound-email
72/0, needs-you 77/0, redteam-correspondence 77/0, task-proposals 199/0, correspondence-ingest 149/0, proposals-preview 15/0,
feed-staleness 98/0, meeting-triage 69/0, attention all passed (16), onedrive-feed all passed (61). SQL: task-proposals-sql
45/0, correspondence-ledger-sql 50/0, feed-staleness-sql 23/0, meeting-triage-sql 34/0, fireflies-queue-sql all passed.
`npx tsc --noEmit` exit 0, 0 lines. `npm run build` exit 0; `parse5.mjs` in `.output/server/_libs`, 0 files in `.output/public`
mention parse5. The main reference copy `scripts/verify5-main/` was re-diffed against `origin/main` @ e546e4c2: `htmlToText`
and `inbound-email.ts` identical, so every main column below is current main.

- Claim 1 (email text = main except approved changes): REFUTED -- the text is right; the TIME is not. Under Node (the
  production runtime) the new tag-span loop costs (elements x body length): a 217 KB table report takes 2.9 s, 332 KB of
  plain paragraphs 5.0 s, a ~950 KB Outlook body 10-12.5 s, on EVERY call (907dade7: 0.06-0.18 s). One-line fix measured.

## Claim 1: email text -- REFUTED (performance on Node); every TEXT check holds

### 1-PERF (new, this loop). REFUTED: the tag-span loop is quadratic on Node
`html-visible.ts` lines 297 and 306 build `` `${PREFIX}${html}` `` inside the loop, once per located element, then
`.slice()` it. On V8 that is a fresh cons-string per element, and `slice` flattens it: one full copy of the body per element.
`node --experimental-strip-types scripts/verify11-node.mts` (Node 22.23, production runtime; raw `...-11-node.txt`):

| body (synthetic, real-looking) | 90af5f3a first / warm | 907dade7 first / warm | hoisted fix first / warm |
|---|---|---|---|
| 6 KB short note | 9 / 3 ms | 8 / 2 ms | 7 / 2 ms |
| 217 KB table report (6000 rows, unclosed cells) | **2874 / 2888 ms** | 114 / 62 ms | 126 / 82 ms |
| 332 KB, 20k plain `<p>` | **4912 / 5053 ms** | 95 / 43 ms | 117 / 48 ms |
| 947 KB Outlook/Word body (verify10-realistic's) | **10416 / 12504 ms** | 175 / 112 ms | 175 / 104 ms |
| 216 KB report as a flat `JSON.parse` string (how the feed delivers it) | **2522 ms** | 113 ms | -- |

Under bun the warm path is hidden by JSC's rope-substring optimisation (`verify11-perf.ts`, 1.0-1.8x base), but the COLD
first call shows it too: 947 KB body 2.7-3.1 s vs 0.14-0.17 s (`verify11-cold.ts`, 3 fresh processes each). This is why
`verify10-realistic.ts` (one cold call per body) printed 2636 ms at 90af5f3a against 157 ms in loop 10, and why the
implementer's bun suites did not see it. Reach: every HTML email body on Iris's live work-email screen, flags off; a feed
of a few large bodies approaches the ~45 s hosting ceiling.

**Minimal fix (applied temporarily, measured, restored; `docs/qc-evidence/VERIFY-correspondence-proposals-11-hoist-fix.patch`):**
build the string ONCE before the loop (`const SRC = `${PREFIX}${html}`;`) and slice `SRC`. Node times return to the base
(table above); `verify11-probes` output summary identical, onedrive-feed-truth 11/0, html-visible-loop5 46/0. Suggested
guard: a test that times a 200 KB `<td>` body under `node --experimental-strip-types` (bun cannot see it warm).

### 1d-new (`<!---->` for a cut span holding `>`) -- CONFIRMED fixed
`scripts/verify11-shapes.mjs` section B: 18 of my own raw-`<` + comment / hidden / tag shapes (two comments, mso
conditional, `--!>` end, `<!-->`, hidden text holding `>`, comment inside hidden, unclosed comment to EOF, comment before
the reply marker, comment inside blockquote, `<b <!-- c -->`), Chromium-recorded (`verify11-chromium-record.mjs` ->
`verify11-chromium-truth.json`), compared by `bun scripts/verify11-probes.ts` (raw `...-11-probes.txt`): **0 rows drop a
word main and Chromium show, 0 ask flips.** Loop 10's own 20 rows: `verify10-quote-probes` drops 0, flips 0 (was 2 / 1).

### 1e (depth limit `min(2000, 5e7/tokens)`, template inherits depth) -- CONFIRMED bounded
`bun scripts/verify11-limit.ts` (raw `...-11-limit.txt`): 10 stack-walk families (svg/span/math + `</x>`, div + `</li>` /
`</h1>` / `<dt>`, ul + `<li>`, b + `</i>`, table, select) sized just under the limit at 25k-400k tokens (98 KB-1.95 MB):
none aborts, every ask kept, hidden text cut. Slowest, re-timed alone: div+`<dt>` 1.5 MB 894 ms, ul+`<li>` 762 ms, math
498 ms, svg 453 ms (loop 10: 3349 ms at 810 KB). Template nesting x5000 / x100000 and `<template><div>` x1000-3000 + 20k
`</x>` now ABORT in 4-13 ms (loop 10: 2.1 s); x1000/x1990 parse in 14-26 ms (the ask inside unclosed templates is inert
content: Chromium hides it too). `verify10-scale` 20 rows all abort in 2-41 ms; `verify10-guard` 31 rows <= 24 ms;
`verify10-realistic` bodies all parse (hidden cut). Loop-9 shapes (`verify10-loop9-recheck`): all = main's text, <= 349 ms.
These timings are bun's: on Node the 1-PERF defect above adds (elements x length) to every one of them.

### Tag-span rewrite (owner-approved, FULL derivation) -- text CONFIRMED against the ACs
Spelling table: all 66 rows (S-01..S-58, N-01..N-08) run on the branch and Chromium (table rows `S-*`/`N-*` in the probes
file). **Every row meets its REQUIRED column** (whitespace only; S-40..S-45 cut the quote as required -- the Chromium
recording only strips `<blockquote>`, so its column still shows the old text). S-33 `d` and S-37 `raw` kept as REQUIRED;
S-27 / S-38 / S-58 / N-01 / N-08 = base as REQUIRED. Section C: 31 of my own shapes (reconstruction with hidden + `>`,
adoption agency with a `>`-bearing end tag, foster parenting, select/option, `</br title=">">`, `<image>`, svg
`foreignObject`, a rewrite next to a hidden cut, tag name `x<y`, duplicate attributes, nested `<a>`, implied `li`/`tr`,
450-deep, noscript, iframe, CRLF inside a tag).
Totals over 113 rows: word drops vs main+Chromium **2** (S-43: the approved Q1-A reply cut; C-noscript: `ns`, see below),
ask flips vs main 2, **flips against Chromium 0**, rows equal to Chromium 67 (main 23).

| AC | result | evidence |
|---|---|---|
| AC-1, AC-2 | PASS | S-01..S-26 all = Chromium; html-visible-loop5 "AC-1 the 8 fragment rows" PASS |
| AC-3, AC-4, AC-5 | PASS | `verify8-chromium-rows` 398 rows: regression drops 0/0/0/0; only Chromium-disagreeing flip `fontzero-attribution` (font-size:0, = base) |
| AC-6 | PASS with notes | 7 of 113 rows change newline count vs main; each is approved behaviour: S-16 (newline INSIDE a tag, = Chromium), S-43 (Q1-A cut), N-07 / B-preheader-lt (cut comment / hidden text took its line), C-recon-hidden (hidden, = Chromium), C-data-id-gt / C-id-unsafe-gt (below) |
| AC-7, AC-8 | PASS | S-40..S-45, S-50, S-51 |
| AC-9..AC-11, AC-15..AC-19 | PASS | rows S-23, S-25..S-38, S-54..S-58, C-*; no throw on any row |
| AC-12 + implementer's mutation note | CONFIRMED redundant | with BOTH `!seenStarts.has(...)` and `if (a < pos) continue` removed, `verify11-probes` output is byte-identical (113 rows incl. reconstruction shapes S-30, C-recon-*, C-mixed-hidden-gt-dups) and the 398-row summary identical; restored |
| AC-20 | PASS on bun, **FAIL on Node** | see 1-PERF |

Notes for the owner (no refute; each is main's behaviour or inside an approved choice):
- **Q1-A is applied only to tags that hold a `>`.** S-46 / S-47 (`data-id="divRplyFwdMsg"`, `title="id=appendonsend"`, no `>`)
  are NOT rewritten, so main's look-alike match still cuts what follows (= main). The same look-alike WITH a `>` attribute
  (C-data-id-gt) is rewritten and keeps the old text. Likewise `id="divRplyFwdMsg x"` (C-id-unsafe-gt): main cuts, the
  branch keeps the old quoted text (SAFE_ID drops the id). No test covers S-46/S-47.
- C-noscript: `ns` inside `<noscript>` dropped by branch AND 907dade7 (parse5 parses with scripting on); the Chromium
  column shows it only because the recorder runs with JavaScript disabled. Not new this loop.

### Radius
`teams-log.ts:103` also calls this `htmlToText` (flag-gated ingest path). `inbox-read.ts:254` has its own `htmlToText`,
unchanged. `forwarded.ts:44,49` reads the reply-marker id from the RAW body, then converts a slice with this `htmlToText`.

- Claim 2 (bell, code): CONFIRMED in code; UI NOT browser-verified (branch not deployed) -> MERGE-PENDING-UAT for this claim
- Claim 3 (preview-only code + public-log hygiene): CONFIRMED
- Claim 4 (merge readiness, flags off): REFUTED -- the checklist schemas are fixed (both = main), but the 1-PERF defect
  is live with every flag off (it is in `htmlToText`, Iris's work-email screen). Merge itself: one ledger conflict only.

## Claim 2: bell -- CONFIRMED in code, UI-UNVERIFIED
No attention / bell file changed between 907dade7 and 90af5f3a (`git diff --stat 907dade7 90af5f3a -- src` = html-visible.ts,
huddle.functions.ts, tools.ts). `attention.ts:35` `SETTINGS_KINDS = ATTENTION_KINDS.filter((k) => k !== "chat")`;
`AttentionBell.tsx:157` renders the "What counts" list from `SETTINGS_KINDS`; attention suite all passed (A0 pins
`["email","meeting","appointment"]`). The branch is not deployed, so the GHA browser runner (which drives the deployed SWA)
cannot reach it. **NOT YET UAT-VERIFIED**: after landing, open the bell -> "What counts" -> expect exactly Emails, Meetings,
Appointments & reminders.

## Claim 3: preview-only code + public-log hygiene -- CONFIRMED
- `correspondence/forwarded` is still imported by nothing under `src/` (grep empty).
- New since loop 10: `scripts/action-scan-steps.ts` (categories, "answered by your reply", hidden-by-settings section) and
  `scripts/reply-scan-preview.ts` (`PREVIEW_AS_OF` version-history read). Their `console.*` lines (`action-scan-steps.ts`
  113/185/250/262, `reply-scan-preview.ts` 29/49/75/171/207/216) print counts, HTTP statuses, the model name, category
  NAMES with counts, the feed file's base name, the chosen version's time and the OneDrive output path. The category
  names cannot carry email text: the schema enum is enforced (`callOpenAIRouter` sends `strict: true`,
  `openai-responses.server.ts:37`) and a missing value falls back to `"other"`. Subjects, names, reasons and quotes appear
  only in the HTML report written to OneDrive / mailed to the owner, never in the log. No SharePoint webUrl is printed.

## Claim 4: merge readiness with every flag OFF -- REFUTED (1-PERF only)
| check | result | evidence |
|---|---|---|
| OpenAI-path `build_checklist` schema, flags off | = main byte-for-byte | `verify10-checklist-schema.ts` (MAIN_TREE = origin/main e546e4c2): 2362 = 2362; on adds `proposals` |
| Lovable-path schema, flags off (loop-10 refute) | **fixed**: = main | `bun scripts/verify11-checklist-schema.ts` 4/4: keys `title, task_ids`, `ZodString, ZodArray`, unknownKeys `strip`, a model-sent `proposals` stripped exactly as on main; on adds exactly `proposals` |
| Lovable gate expression | same as the OpenAI path | `huddle.functions.ts:3890` and `:6285` both `proposalsConfig() !== null`, `.catch(() => false)`; `proposalsConfig()` returns null unless `correspondence.proposals === true` |
| Rest of the `origin/main...90af5f3a` src diff, flags off | unchanged since loop 10 except the three files above | loop 10's sweep stands for the other files; html-visible.ts is claim 1 |
| `htmlToText` cost, flags off | **REFUTED** | 1-PERF: on Node every HTML email costs one body copy per element (217 KB: 2.9 s; 947 KB: 10-12.5 s) |
| merge onto current `origin/main` (e546e4c2, 16 commits ahead of the merge base) | one conflict: `.claude/memory.md` (ledger). No src / scripts / workflow conflict; main's 16 commits touch only `.claude/*` and 4 workflows | `git merge-tree --write-tree origin/main 90af5f3a` |

## Verdict
PASS: claims 0, 3; claim 2 in code | FAIL: claim 1 (1-PERF), claim 4 (same defect) | UI-UNVERIFIED: 1 (claim 2 bell)
**Verdict: FIX FIRST.** Minimal fix: in `visibleHtml`, build `${PREFIX}${html}` once before the tag-span loop and slice that
(`docs/qc-evidence/VERIFY-correspondence-proposals-11-hoist-fix.patch`, measured: Node times back to the base, outputs
unchanged). Add a Node-run timing guard (bun cannot see the defect warm). Resolve the `.claude/memory.md` conflict when
merging. After the fix lands, the bell claim still needs a browser run (MERGE-PENDING-UAT for claim 2).
Everything else in this loop's scope held: 1d-new fixed, 1e bounded, the tag-span rewrite meets all 66 spelling-table rows
and 0 ask flips against Chromium over 113 + 398 rows, both checklist schemas = main with flags off.

### Addendum to 1e / 1-PERF: hostile shapes under Node WITH the hoist fix applied (temporarily; src restored)
`node --experimental-strip-types scripts/verify11-node-hostile.mts`: svg+`</x>` 781 KB 898 ms; math+`</x>` 391 KB 1356 ms;
div+`<dt>` 99 KB 531 ms / 1.5 MB 1181 ms; ul+`<li>` 1.5 MB 1122 ms (bun: 453-894 ms). Linear and bounded, hostile sender
only. (These rows hold no hidden text, so `visibleHtml` returns the input unchanged by design; the script's `aborted`
column is therefore not a budget signal for them.) Without the fix, Node adds one body copy per element on top of each.
