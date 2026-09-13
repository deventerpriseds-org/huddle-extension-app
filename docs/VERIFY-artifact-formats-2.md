## VERIFY LOOP
work: artifact-formats
loop: 2
Wall-clock budget - AT THE BUDGET: 30 minutes from your start. Deliver what is proven, mark every unreached claim NOT REACHED, stop.
Incremental artifact - COMMIT AND PUSH PER CLAIM: docs/VERIFY-artifact-formats-2.md

## PRIOR STATE (loop 1)
Previously CONFIRMED - RE-CHECKED THIS LOOP: NONE. Loop 1 ran the identical brief and was stopped by its parent before its first push. It produced ZERO durable evidence -- no VERIFY-artifact-formats-1.md exists on origin/main or on disk. Its transcript reported C3 as holding; that verdict was never written down and is treated as UNPROVEN, not as prior art. Nothing is carried forward and nothing is checked at reduced depth.
Previously REFUTED / now fixed - FULL RE-DERIVATION: none.
Blast radius of the fix: not applicable -- no fix was made between loops. No code changed since c6299cc; HEAD is 79af620 (docs only). So DEPTH is spread evenly across all ten claims rather than concentrated.
CHALLENGE THE RADIUS: with no fix between loops there is no radius to narrow. This verifier claims NO reduced depth on any claim -- all ten are derived from scratch in this loop.

# VERIFY -- artifact-formats -- loop 2

<!--
WHAT:       Independent adversarial verification of the artifact multi-format work (md/docx/pptx/html/mermaid/svg).
WHY:        Every test so far was the implementing session's own. An agent had told the owner artifacts
            were "limited to .md"; three lanes built the fix in parallel and one session wired it together.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; commands and byte values inline per claim.
-->

Base: `origin/main` @ `79af620` (deployed SHA `c6299cc`). Repo `/home/user/huddle-extension-app`.
Verifier has NO shared context with the implementer. Every verdict below is from a command run here.

---

## C1 — tool schema advertises the six formats; `content` no longer required

**CONFIRMED.**

`src/features/huddle/lib/artifacts/artifact-tool.ts`:

- **L34-36** — `format: { type: "string", enum: ["md", "docx", "pptx", "html", "mermaid", "svg"] }`.
  Exactly the six claimed, in that order, no extras.
- **L75** — `required: ["name"]`. `content` is NOT in `required`; neither is `format`.
- **L60-66** — `document` exists as an optional object property (the alternative to `content` that
  makes dropping `content` from `required` coherent).
- **L13-17** — the description explicitly counters the "limited to .md" claim that started this:
  `"YOU ARE NOT LIMITED TO MARKDOWN: set \`format\` to 'docx' for a real Word document…"`.

**One real defect found while reading (minor, non-blocking, reported not waved away):**
`CreateArtifactToolArgs` (L79-85) declares `name/content/folder/task_id/mime` but **omits `format`
and `document`** — the two properties this change added to the schema. The interface is all
`unknown`-typed so it is a documentation/typing gap, not a runtime break; the dispatch sites are
verified separately in C4. Flagged so it is not mistaken for intentional.

---

## Cheap suite re-run (whole area, actual numbers)

| command | result |
|---|---|
| `bun scripts/artifact-render.test.ts` | **52 passed, 0 failed** |
| `bun scripts/artifact-preview.test.ts` | **28 passed, 0 failed** |
| `bun scripts/artifact-format-dispatch.test.ts` | **21 passed, 0 failed** |

These are the IMPLEMENTER'S suites and are recorded only as context. Every verdict below comes from a
probe this verifier wrote against the real code path, per the brief.

---

## C2 — all six formats produce the promised artifact end to end

**CONFIRMED.**

**What I exercised** (not the existing suite): `/tmp/probe/c2.ts`, run with
`bun /tmp/probe/c2.ts` from the repo root. It imports the REAL
`createArtifactFromAgent` from `src/features/huddle/lib/artifacts/artifacts.server.ts` and stubs only
the three I/O edges, via `mock.module` on the **resolved** specifiers:

- `Bun.resolveSync("pg", …)` → a `Pool` whose `query()` records the INSERT params
- `…/artifacts/blob.server` → `putArtifactBlob` records `(path, bytes, mime)`
- `…/identity/identity.server` → `resolveScopeByEmail` returns a fixed scope

So `render.server.ts` (the real `docx`/`pptxgenjs` renderers), the PASSTHROUGH branch, the mime
override rule, `withExtension`/`ensureExtension` and `createArtifact`'s INSERT all ran for real.
Every call used `name: "quarterly-review"` (NO extension) and a probe string `UNIQUEPROBE7`.

| format | returned name | returned mime | bytes | first 4 bytes | mime written to blob | name/mime/size in the SQL INSERT |
|---|---|---|---|---|---|---|
| md | `quarterly-review.md` | `text/markdown; charset=utf-8` | 82 | `23 20 51 75` | same | `quarterly-review.md` / `text/markdown; charset=utf-8` / 82 |
| docx | `quarterly-review.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | 8904 | **`50 4b 03 04`** | same | `quarterly-review.docx` / same / 8904 |
| pptx | `quarterly-review.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | 51076 | **`50 4b 03 04`** | same | `quarterly-review.pptx` / same / 51076 |
| html | `quarterly-review.html` | `text/html; charset=utf-8` | 62 | `3c 21 64 6f` (`<!do`) | same | `quarterly-review.html` / same / 62 |
| mermaid | `quarterly-review.mmd` | `text/vnd.mermaid; charset=utf-8` | 33 | `67 72 61 70` (`grap`) | same | `quarterly-review.mmd` / same / 33 |
| svg | `quarterly-review.svg` | `image/svg+xml; charset=utf-8` | 71 | `3c 73 76 67` (`<svg`) | same | `quarterly-review.svg` / same / 71 |

`warnings` was `[]` for all six. The mime handed to Blob Storage, the mime in the metadata row and the
mime returned to the caller are **the same string in every case** — no divergence between what is
stored and what the UI will be told. `size_bytes` in the INSERT equals the actual buffer length in
every row. The `UNIQUEPROBE7` marker survived into the bytes for md/pptx/html/mermaid/svg; for docx it
is absent from the *raw* bytes only because ZIP deflate compresses it — C3 unzips and finds it.

---

## C3 — the docx and pptx are genuinely openable Office packages

**CONFIRMED.** This is the claim the brief flagged as most likely to be superficially true; it is not.
The bytes from the C2 run were written to `/tmp/probe/out.docx` and `/tmp/probe/out.pptx` and opened
with Python's `zipfile` + `xml.dom.minidom`.

**`out.docx` — 22 entries, `zipfile.testzip()` returned `None` (every CRC valid)**

| check | result |
|---|---|
| `[Content_Types].xml` | present, **2104 bytes, XML well-formed** |
| `word/document.xml` | present, **4223 bytes, XML well-formed** |
| `_rels/.rels` (package root relationship) | present |
| main part content-type declared in `[Content_Types].xml` | yes — `…wordprocessingml.document.main` |
| `PartName` overrides | `/word/document.xml`, `/word/styles.xml`, `/docProps/core.xml`, `/docProps/custom.xml`, `/docProps/app.xml`, `/word/numbering.xml`, `/word/footnotes.xml`, `/word/endnotes.xml` |
| input text present in `word/document.xml` | `UNIQUEPROBE7` **true**, `Quarterly Review` **true**, list items `one`/`two` **true** |
| structure is real, not one flat string | **8** `<w:t>` runs; `<w:tbl>` table element present (the input's markdown table became a real Word table) |

**`out.pptx` — 43 entries, `zipfile.testzip()` returned `None`**

| check | result |
|---|---|
| `[Content_Types].xml` | present, **2886 bytes, XML well-formed** |
| `ppt/presentation.xml` | present, **3294 bytes, XML well-formed** |
| `_rels/.rels` | present |
| main part content-type declared | yes — `…presentationml.presentation.main` |
| `PartName` overrides | `/ppt/presentation.xml`, `/ppt/notesMasters/notesMaster1.xml`, `/ppt/slideMasters/slideMaster1.xml`, `/ppt/slides/slide1.xml`, `/ppt/slideMasters/slideMaster2.xml`, `/ppt/slides/slide2.xml`, `/ppt/presProps.xml`, `/ppt/viewProps.xml` |
| slide parts | `ppt/slides/slide1.xml` (1878 B) and `slide2.xml` (1867 B), **both XML well-formed** |
| input text present in the slides | `UNIQUEPROBE7` **true**, `Slide One` **true**, `Slide Two` **true**, `second body` **true** |
| `presentation.xml` slide list | **2** `<p:sldId …>` entries — the deck really has the two slides the two `#` headings asked for, not one empty one |

Both packages therefore have valid ZIP central directories, the OPC content-type map, the root
relationship part, well-formed main parts, per-part content-type overrides, and the caller's own text
inside the parts. This is an Office package, not a ZIP wearing the right magic bytes.

---

## C6 — `TEXT_PREVIEW_MIME` admits SVG and nothing binary

**CONFIRMED.**

I did NOT retype the regex. `/tmp` probe extracted the literal from the source file with
`re.search(r"const TEXT_PREVIEW_MIME\s*=\s*\n?\s*(/.*?/);", src)` and ran that exact pattern.
Literal recovered from `artifacts.server.ts` L297-299:

```
/^(text\/|application\/json|application\/csv|image\/svg\+xml|application\/vnd\.mermaid|application\/xhtml\+xml)/
```

| mime | verdict |
|---|---|
| `image/svg+xml` | **ADMIT** ✓ (claimed) |
| `image/svg+xml; charset=utf-8` | **ADMIT** — the exact string C2 shows the SVG path storing, so the preview really fires |
| `image/png` | reject ✓ |
| `image/jpeg` | reject ✓ |
| `application/pdf` | reject ✓ |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | reject ✓ |
| `application/vnd.openxmlformats-officedocument.presentationml.presentation` | reject ✓ |
| `text/markdown; charset=utf-8` | ADMIT (expected) |
| `text/html; charset=utf-8` | ADMIT (expected) |
| `text/vnd.mermaid; charset=utf-8` | ADMIT (expected — this is the mime C2 measured for mermaid) |
| `application/json`, `application/csv` | ADMIT (expected) |
| `image/gif`, `image/svg`, `application/octet-stream` | reject |

Every mime the claim says must be admitted is admitted and every one it says must be excluded is
excluded. Note the regex is unanchored at the end, so it is a prefix match — `image/svg+xml;
charset=utf-8` matching is a feature here, not an accident, and no binary mime shares a prefix with an
admitted family.

---

## C4 — all four dispatch sites route through `createArtifactFromAgent`

**REFUTED — in substance. The literal wiring claim is true; the thing the claim exists to guarantee is
false at TWO of the four sites, and the brief's prediction that "voice is the likeliest miss" is
correct but incomplete — the Lovable path is worse.**

### The literal half: true

`grep -rn "createArtifactFromAgent" src/` returns exactly four call sites, and no others:

| # | site | file:line |
|---|---|---|
| 1 | OpenAI path | `src/features/huddle/lib/huddle.functions.ts:3610` |
| 2 | Lovable path | `src/features/huddle/lib/huddle.functions.ts:4870` |
| 3 | durable-turn worker | `src/features/huddle/lib/huddle.functions.ts:7024` |
| 4 | voice | `src/features/huddle/lib/voice/realtime-tools.server.ts:586` |

All four pass `args: { format: a.format, content, document: a.document, mime: a.mime }`.
`grep -rn "createArtifact(" src/` finds only two remaining direct callers and **neither is a tool
dispatch path**: `artifacts.functions.ts:207` (`saveArtifactFn`, a UI server-fn whose zod schema takes
an explicit `mime` from the client) and `attachments.functions.ts:64` (a USER file upload into folder
`"Uploads"`, bytes decoded from base64). Both correctly bypass the renderer — there is nothing to
render. **No tool dispatch path was left behind.**

### The substantive half: `format` cannot physically arrive at sites 2 and 4

Routing through the renderer is worthless if the tool SCHEMA the model is shown has no `format` field.
Two of the four sites declare their own schema instead of using `CREATE_ARTIFACT_TOOL`:

| # | site | schema it advertises | can `format` arrive? |
|---|---|---|---|
| 1 | OpenAI | `CREATE_ARTIFACT_TOOL` verbatim (`huddle.functions.ts:3500`) | **YES** |
| 3 | worker | `CREATE_ARTIFACT_TOOL` verbatim (`huddle.functions.ts:7082`) | **YES** |
| 2 | Lovable | **its own zod object**, `huddle.functions.ts:4829-4835` | **NO** |
| 4 | voice | **its own hand-written JSON schema**, `realtime-tools.server.ts:287-303` | **NO** |

**Site 2 — Lovable (`huddle.functions.ts:4827-4835`). This is the worse of the two, because it
advertises the feature and then discards it.**

```
lovableTools.create_artifact = tool({
  description: CREATE_ARTIFACT_TOOL.description,      // <- L4828: tells the model "set format to 'docx'"
  inputSchema: z.object({
    name: z.string(), content: z.string(),
    folder: z.string().optional(), task_id: z.string().optional(), mime: z.string().optional(),
  }),                                                  // <- L4829-4835: no `format`, no `document`
```

It borrows C1's description — the one reading *"YOU ARE NOT LIMITED TO MARKDOWN: set `format` to
'docx'…"* — while its `inputSchema` has no such property. A bare `z.object()` **strips** unknown keys.
Proven, not asserted (`/tmp/probe/zod.ts`, the schema copied verbatim from L4829-4835):

```
model emitted keys:        [ "name", "content", "format", "document" ]
keys surviving .parse():   [ "name", "content" ]
parsed.format === undefined
parsed.document === undefined
```

So on the Lovable path `a.format` at L4870 is **always `undefined`**, `createArtifactFromAgent`
defaults to `"md"`, and a user who asks for a Word document on this path gets `name.md` +
`text/markdown` — the exact bug that started this work, still live. L4841 also hard-requires `content`
(`if (!name || !content)`), so the `document`-only route C1 unblocked is unreachable here too.

**Site 4 — voice (`realtime-tools.server.ts:287-303).**

```
name: "create_artifact",
description: "Save a document (markdown/plain text) as a reviewable artifact …"   // L288-291
parameters: { type: "object", additionalProperties: false,
  properties: { name, content, folder, mime },                                     // L292-300: no format/document
  required: ["name", "content"] },
```

`additionalProperties: false` with no `format` property means the model cannot emit one even in
principle. `args.format` at L590 is therefore always `undefined`. The description compounds it by
telling the voice agent the artifact is *"markdown/plain text"*. This directly contradicts the comment
sitting three lines above the call, at L583-584:

> `// Formats go through the SAME renderer as the text path: "make me a deck" spoken out loud has`
> `// to produce the same .pptx it would typed, or voice quietly becomes a second-class caller.`

The renderer is reached; the format never is. Spoken "make me a deck" produces a `.md`. Line 578 also
hard-requires `content`, so voice cannot use `document` either.

### Concrete failing inputs

| path | user says | model can emit | stored result | expected |
|---|---|---|---|---|
| Lovable | "put that in a Word doc" | `{name:"review", content:"# R", format:"docx"}` | `review.md`, `text/markdown` (`format` stripped by zod) | `review.docx`, Office mime |
| voice | "make me a deck" | `{name:"deck", content:"# S1"}` — `format` impossible under `additionalProperties:false` | `deck.md`, `text/markdown` | `deck.pptx`, Office mime |

### Fix direction (not applied — verifier does not edit the code under test)

Add `format` and `document` to the Lovable `inputSchema` (`format: z.enum(["md","docx","pptx","html",
"mermaid","svg"]).optional()`, `document: z.unknown().optional()`) and to the voice tool's
`properties`, relax both `!content` guards to `!content && !document`, and replace the voice
description's "markdown/plain text" with the multi-format wording. Sites 1 and 3 need nothing.

**Note this also re-frames C1's minor finding:** `CreateArtifactToolArgs` omitting `format`/`document`
is not merely cosmetic — two of the four dispatch sites carry the same omission in a place where it
changes runtime behaviour.
