# VERIFY — artifact-formats — loop 3

<!--
WHAT:       Independent verification loop 3 of the multi-format artifact work (docx/pptx/md/html/
            mermaid/svg), re-deriving the two claims loop 2 REFUTED (C4, C9) at full depth.
WHY:        Loop 2 (docs/VERIFY-artifact-formats-2.md) returned 8 CONFIRMED / 2 REFUTED against
            deployed c6299cc. Commit b043afb claims to close all four findings. New code is where
            new defects live, so the fix itself is the subject of this loop.
SUPERSEDES: docs/VERIFY-artifact-formats-2.md (its C4/C9 verdicts describe pre-b043afb code)
SUPERSEDED-BY: nothing — current
EVIDENCE:   this file; commit b043afb; suites artifact-render / artifact-preview /
            artifact-format-dispatch
-->

## VERIFY LOOP
work: artifact-formats
loop: 3
Wall-clock budget - AT THE BUDGET: 30 minutes from start. Deliver what is proven, mark every unreached claim NOT REACHED, stop.
Incremental artifact - COMMIT AND PUSH PER CLAIM: docs/VERIFY-artifact-formats-3.md

## PRIOR STATE (loop 2)
Previously CONFIRMED - RE-CHECKED THIS LOOP: C1, C2, C3, C5, C6, C7, C8, C10 — re-confirmed at reduced depth by re-running the three suites, unzipping ONE docx and ONE pptx to confirm [Content_Types].xml, and reading the sandbox attribute string in the artifact render path rather than re-running the ten browser escape attempts.
Previously REFUTED / now fixed - FULL RE-DERIVATION: C4 (two of four dispatch sites declared their own schema with no `format` — Lovable's zod stripped it, Voice's additionalProperties:false made it unreachable) and C9 (markdown bytes could claim an Office mime; `../../etc/passwd` escaped the Huddle Artifacts folder via onedrive.server.ts:21's encodeURIComponent, which does not encode ".").
Blast radius of the fix: b043afb, 4 files, +144/-20 — src/features/huddle/lib/artifacts/artifacts.server.ts (safeArtifactName, withExtension, two-sided mime guard, format trim/lowercase, choke-point sanitisation) feeds C2/C3/C9a/C9b/C9c; src/features/huddle/lib/huddle.functions.ts (Lovable zod schema, the !name||!content guards) feeds C4; src/features/huddle/lib/voice/realtime-tools.server.ts (voice JSON schema) feeds C4; scripts/artifact-format-dispatch.test.ts (21→32 assertions) feeds every dispatch claim.
Cheap suite re-run covering EVERYTHING: bun scripts/artifact-render.test.ts && bun scripts/artifact-preview.test.ts && bun scripts/artifact-format-dispatch.test.ts — record the ACTUAL pass/fail numbers you observe here, not the expected ones.
CHALLENGE THE RADIUS. If you believe a claim I listed as reduced-depth is actually inside the blast radius, say so and test it at full depth — in particular whether choke-point sanitisation changes what C2/C3 produce, whether the format trim/lowercase alters C7's markdown default, and whether withExtension collides with render.server's own ensureExtension. Do not take the radius on trust.

### Suite numbers ACTUALLY OBSERVED this loop

Run from `/home/user/huddle-extension-app` with `bun`:

| suite | expected | **actual observed** | exit |
|---|---|---|---|
| `bun scripts/artifact-render.test.ts` | 52 pass | **52 passed, 0 failed** | 0 |
| `bun scripts/artifact-preview.test.ts` | 28 pass | **28 passed, 0 failed** | 0 |
| `bun scripts/artifact-format-dispatch.test.ts` | 32 pass | **32 passed, 0 failed** | 0 |

All three match. **These suites were written by the implementing agent and are recorded as context,
not as my evidence** — every verdict below rests on a derivation I ran myself against the source.

Base: `b043afb` confirmed an ancestor of `HEAD` (`git merge-base --is-ancestor b043afb HEAD` → exit 0).

---

## R1 — C4 re-derivation: can `format` actually reach all four dispatch sites?

### The four sites (enumerated, not assumed)

`grep -rn "createArtifactFromAgent" src/ | grep -v artifacts.server.ts`:

| # | path | call site | schema the model sees |
|---|---|---|---|
| 1 | OpenAI text | `huddle.functions.ts:3612` | `CREATE_ARTIFACT_TOOL` (`huddle.functions.ts:3500`) |
| 2 | Lovable text | `huddle.functions.ts:4882` | hand-written zod, `huddle.functions.ts:4837-4845` |
| 3 | Voice realtime | `realtime-tools.server.ts:601` | hand-written JSON schema, `realtime-tools.server.ts:290-315` |
| 4 | **Worker / auto-work** | `huddle.functions.ts:7036` | `CREATE_ARTIFACT_TOOL` (`huddle.functions.ts:7094`: `tools: [TAVILY_WEB_SEARCH_TOOL, CREATE_ARTIFACT_TOOL]`) |

### Site 1 + 4 — shared schema

`src/features/huddle/lib/artifacts/artifact-tool.ts:6` — read in full. `format` is present with the
six-value enum and `required` is `["name"]` only:

```
format: { type: "string", enum: ["md","docx","pptx","html","mermaid","svg"], … }
document: { type: "object", description: "…Supply the structure instead of `content`…" }
required: ["name"],
```

`format` **is reachable** on both. **CONFIRMED for the schema half.**

### Site 2 — Lovable zod, EXECUTED not read

The `z.object({…})` at `huddle.functions.ts:4837-4845` was copied **verbatim** into a scratch file and
`.parse()` was run on an object carrying every field. Actual stdout:

```
emitted keys : ["name","content","format","document","mime","bogus"]
parsed  keys : ["name","content","format","document","mime"]
parsed.format  = "pptx"
parsed.document= {"slides":[{"title":"S1"}]}
document-only parsed keys : ["name","format","document"]
document-only .content     = undefined
```

`format` and `document` now **survive `.parse()`** (the unknown key `bogus` is still stripped, which is
correct). This is the exact refutation loop 2 raised, and it is closed. **CONFIRMED.**

### Site 3 — Voice JSON schema

`realtime-tools.server.ts:302-311`, read directly:

```
additionalProperties: false,
properties: { name, content,
  format: { type: "string", enum: ["md","docx","pptx","html","mermaid","svg"], … },
  folder, mime },
required: ["name", "content"],
```

`format` is present with all six enum values under `additionalProperties:false`, so the model **can**
emit it. **CONFIRMED for the schema half.**

### The GUARD half — REFUTED at two of four sites

The brief asked me to also confirm the `!name || !content` guards accept a structured `document` with
no `content`. Only **two of the four** guards were relaxed by `b043afb`:

| # | site | guard, as it stands on `HEAD` | structured `document`, no `content` |
|---|---|---|---|
| 1 | OpenAI | `huddle.functions.ts:3578` — `if (!name \|\| (!content && !a.document))` | **ACCEPTED** |
| 2 | Lovable | `huddle.functions.ts:4851` — `if (!name \|\| (!content && !a.document))` | **ACCEPTED** |
| 3 | Voice | `realtime-tools.server.ts:592` — `if (!artName \|\| !content)` | **REJECTED** |
| 4 | **Worker** | `huddle.functions.ts:7029` — `if (!name \|\| !content)` | **REJECTED** |

Guard executed verbatim on the parsed Lovable object:

```
guard(name="deck", content=undefined, document={"slides":[{"title":"S1"}]}) -> ACCEPTED
guard(name="x",    content=undefined, document=undefined)                   -> REJECTED
guard(name="",     content=undefined, document={})                          -> REJECTED
```

**Site 4 (worker) is a real, live defect of the same class loop 2 refuted.** It advertises
`CREATE_ARTIFACT_TOOL`, whose `required` is `["name"]` and whose `document` description explicitly says
*"Supply the structure instead of `content`"* — and then its handler at `huddle.functions.ts:7029`
returns `{ok:false, error:"name and content are required"}`. A worker agent that follows its own tool
description into a precise slide layout is rejected outright. The schema promises, the guard refuses —
verbatim the shape of the original C4 finding, left standing at the one site loop 2 did not name.

Concrete failing input at site 4:
`{ name: "q3-review", format: "pptx", document: { slides: [{ title: "Q3" }] } }` →
`{"ok":false,"error":"name and content are required"}`.

**Site 3 (voice) is internally consistent, not a defect:** its own schema has no `document` property
and `required:["name","content"]`, so the guard matches what the model can emit. It is worth recording
that `realtime-tools.server.ts:607` passes `document: args.document` into the dispatch, which
`additionalProperties:false` makes permanently `undefined` — dead code, and a real capability gap
(voice cannot produce a structured-layout deck), but not a lie to the model.

### R1 VERDICT

**REFUTED (partial).** `format` is present and reachable on **all four** schemas — the specific loop-2
refutation is closed and I could not break it. But the companion `!name || !content` relaxation was
applied to only two of four handlers, and at the **worker** site the advertised schema and the handler
now contradict each other, so a structured `document` call from a worker agent fails.
Required fix: `huddle.functions.ts:7029` → `if (!name || (!content && !a.document))`.

---

## R2 — C9a re-derivation: does `safeArtifactName` actually neutralise traversal, at the choke point?

### The choke point — call ORDER read, not assumed

`artifacts.server.ts:216` computes `const safeName = safeArtifactName(input.name)` **before** either
branch, and both branches consume it:

* passthrough (mermaid/svg): `:236` `const outName = withExtension(safeName, passthrough.ext)` →
  `createArtifact({ name: outName })`
* rendered (md/html/docx/pptx): `:259` `renderArtifact({ …, name: safeName })` → `rendered.name` →
  `:283` `createArtifact({ name: rendered.name })`

`createArtifact` (`:123`) writes that one value to **both** consumers: the blob path
(`:129 slug(input.name)`) and the DB row (`:140 input.name`). The OneDrive mirror reads the DB row
(`:530 name: row.name`). So the sanitised value does reach all three. **Choke point CONFIRMED.**

**Radius challenge answered — `withExtension` vs `render.server`'s `ensureExtension` do NOT collide.**
They are on mutually exclusive branches (`withExtension` only for mermaid/svg, `ensureExtension` only
inside `renderArtifact`), both run strictly *after* `safeArtifactName`, and neither can reintroduce a
separator — `ensureExtension` (`render.server.ts:132-141`) only trims and appends/replaces a suffix.

### `safeArtifactName` executed on the real export — 36 inputs

Imported the actual symbol from `artifacts.server.ts` (not a copy). Every traversal input collapses to
a bare filename; **no output contains `/` or `\`, and none is `..`**:

```
"../../etc/passwd"                    -> "passwd"
"..\\..\\windows\\system32\\cfg.ini"  -> "cfg.ini"
"Huddle/../../../secret.docx"         -> "secret.docx"
".docx"                               -> "artifact.docx"
".."                                  -> "artifact"
"."                                   -> "artifact"
""                                    -> "artifact"
"   "                                 -> "artifact"
"....//....//etc/passwd"              -> "passwd"
"%2e%2e/%2e%2e/etc/passwd"            -> "passwd"
"..%2f..%2fetc"                       -> "artifact..%2f..%2fetc"   (no real separator; see note)
"a/../b.md"                           -> "b.md"
"/etc/passwd"                         -> "passwd"
"C:\\Users\\x\\a.docx"                -> "a.docx"
"\u0000evil.md"                       -> "evil.md"
"n\u001fame.md"                       -> "name.md"
"report<v2>.docx" -> "reportv2.docx"   'quote".md' -> "quote.md"
"pipe|x.md" -> "pipex.md"   "q?.md" -> "q.md"   "star*.md" -> "star.md"
null -> "artifact"   undefined -> "artifact"   12345 -> "12345"
```

The URL-encoded attempt `"..%2f..%2fetc"` keeps its literal `%2f`, which is correct: it is not a path
separator at this layer, and `encodePath` (`onedrive.server.ts:20`) then encodes the `%` to `%25`, so
it cannot decode back into a separator downstream.

**Legitimate names are NOT damaged** — dots, digits, spaces and unicode all survive byte-for-byte:

```
"Q3 review v1.2 final.docx"  -> "Q3 review v1.2 final.docx"
"ünïcödé-räpport.md"         -> "ünïcödé-räpport.md"
"2026-09-21_budget.xlsx"     -> "2026-09-21_budget.xlsx"
"my.file.with.dots.pptx"     -> "my.file.with.dots.pptx"
"日本語メモ.md"               -> "日本語メモ.md"
"a b  c.md"                  -> "a b  c.md"
```

Unicode separator homoglyphs (`U+2044 ⁄`, `U+FF0F ／`, `U+2215 ∕`) are passed through as ordinary
characters. That is safe here — `encodePath` percent-encodes them, and Graph/Windows do not treat them
as separators.

### THE NAME HALF IS FIXED. THE OTHER HALF OF THE SAME PATH IS NOT.

`onedrive.server.ts:51` builds the upload path from **two** model-controlled segments:

```ts
const drivePath = `Huddle Artifacts/${opts.lane}/${opts.name}`;
```

`opts.lane` is `row.folder` (`artifacts.server.ts:530`). `folder` is written to the DB **raw** —
`artifacts.server.ts:140` inserts `input.folder` with no sanitiser — and it is model output at every
one of the four dispatch sites (`String(a.folder ?? "Research")`, e.g.
`huddle.functions.ts:7039`, `realtime-tools.server.ts:604`). Only the **blob** path slugs it
(`:129 slug(input.folder)`); the mirror does not.

Executed with `encodePath` and the `drivePath` template copied verbatim from `onedrive.server.ts`:

```
contained  lane="Research"            name="../../etc/passwd"
           drivePath = Huddle Artifacts/Research/passwd
ESCAPES    lane="../../../Documents"  name="report.docx"
           drivePath = Huddle Artifacts/../../../Documents/report.docx
           URL = …/drive/root:/Huddle%20Artifacts/../../../Documents/report.docx:/content
ESCAPES    lane=".."                  name="a.md"
           drivePath = Huddle Artifacts/../a.md
ESCAPES    lane="Research/../../.."   name="a.md"
           drivePath = Huddle Artifacts/Research/../../../a.md
```

`encodeURIComponent` does not encode `.`, so the `..` segments survive into the Graph URL — **the
identical mechanism, on the identical path, that loop 2 refuted.** The fix closed the `{name}` half and
left the `{lane}` half open, and `lane` is just as model-driven as `name` was.

### R2 VERDICT

**REFUTED.** `safeArtifactName` itself is sound — it neutralised all 20 traversal inputs I threw at it,
is correctly applied once at the choke point so blob/DB/mirror all receive it, and damages no
legitimate name. But C9a as a whole ("`..` can no longer escape the Huddle Artifacts folder") is **not**
closed: `folder` reaches `Huddle Artifacts/{lane}/{name}` unsanitised and reproduces the escape.

Concrete failing input:
`create_artifact({ name: "report.docx", folder: "../../../Documents", content: "#x" })` →
mirror PUTs to `…/drive/root:/Huddle%20Artifacts/../../../Documents/report.docx:/content`.

Required fix: sanitise `folder` on the same choke point (or in `uploadArtifactToOneDrive`, which is the
one single place both segments meet) — e.g. apply `safeArtifactName` to each `lane` segment, or slug it
as the blob path already does.

---

## R3 — C9b re-derivation: can an artifact misrepresent itself in EITHER direction?

### The exact guard expression tested

Copied verbatim from `artifacts.server.ts:274-278`:

```ts
const isPackageMime = (m: string) =>
  /officedocument|application\/zip|application\/pdf|^application\/octet-stream/i.test(m);
const mime =
  rawMime && !isPackageMime(rendered.mime) && !isPackageMime(rawMime) ? rawMime : rendered.mime;
```

### All four quadrants, with real `renderArtifact` bytes

`renderArtifact` was called for real (no DB, no blob) and the guard applied to its actual output.
"LIES" = ZIP bytes stored under a non-package mime, or text bytes stored under a package mime.

| quadrant | first 4 bytes | rendered mime | override offered | **stored mime** | verdict |
|---|---|---|---|---|---|
| package bytes / package mime | `50 4b 03 04` (ZIP) | …wordprocessingml.document | …presentationml.presentation | …**wordprocessingml.document** | honest — override refused |
| package bytes / text mime | `50 4b 03 04` (ZIP) | …wordprocessingml.document | `text/markdown` | …**wordprocessingml.document** | honest — override refused |
| **text bytes / package mime** | `23 20 52 65` (`# Re`) | `text/markdown; charset=utf-8` | …wordprocessingml.document | **`text/markdown; charset=utf-8`** | honest — **the refuted direction, now closed** |
| text bytes / text mime | `23 20 52 65` | `text/markdown; charset=utf-8` | `text/csv` | **`text/csv`** | honest — escape hatch survives |
| text bytes / no override | `23 20 52 65` | `text/markdown; charset=utf-8` | `null` | `text/markdown; charset=utf-8` | honest |

`50 4b 03 04` is the ZIP local-file-header magic; `23 20 52 65` is `# Re`. The loop-2 failing input
`{format:"md", mime:"…wordprocessingml.document"}` now stores `text/markdown; charset=utf-8`, so
"report.docx" can no longer download as three bytes of markdown that Word refuses.

Note quadrant 1 is stricter than strictly necessary and that is the right call: a docx offered a pptx
mime keeps its docx mime rather than being relabelled as a different package type.

**R3 VERDICT: CONFIRMED.** I could not construct an input that stores bytes under a mime that
misrepresents them, in either direction.

---

## R4 — C9c: `format` with stray casing/whitespace

Normalisation expression from `artifacts.server.ts:214`, run verbatim:

```
" DOCX "   -> "docx"     renderer
"PPTX"     -> "pptx"     renderer
"MerMaid"  -> "mermaid"  passthrough (.mmd)
"  md"     -> "md"       renderer
"HTML"     -> "html"     renderer
"SVG"      -> "svg"      passthrough (.svg)
"\tdocx\n" -> "docx"     renderer
"Docx "    -> "docx"     renderer
undefined  -> "md"       renderer  (the default)
5          -> "md"       renderer  (non-string falls back)
"pdf"      -> "pdf"      UNKNOWN -> degrades to markdown (correct: not an offered format)
```

All three named cases (`" DOCX "`, `"PPTX"`, `"MerMaid"`) resolve to their real format instead of
degrading. Tabs and newlines are covered too, since `.trim()` is not space-only.

**Radius challenge answered — the trim/lowercase does NOT alter C7's markdown default.** `undefined`
and any non-string still yield `"md"`, and `renderArtifact({format:"md"})` produces
`name="n.md"`, `mime="text/markdown; charset=utf-8"`, bytes `"# T\n\nx"` — the content byte-for-byte,
unchanged. The only behaviour change is that strings which previously fell through to markdown by
*accident* now resolve, which is the fix.

**R4 VERDICT: CONFIRMED.**
