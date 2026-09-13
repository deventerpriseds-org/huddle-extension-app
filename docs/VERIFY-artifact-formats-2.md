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

---

## C5 — SECURITY: artifact markup renders only inside a sandboxed, opaque-origin iframe

**CONFIRMED.** I could not break it. Ten escape attempts in real Chromium, all contained.

### Static read of the render path

`grep -rn "dangerouslySetInnerHTML|innerHTML|document.write|insertAdjacentHTML|new Function|eval("`
over `components/ArtifactsView.tsx` and `lib/artifacts/preview.ts` returns **no call sites** — only
three comment mentions (`ArtifactsView.tsx:469`, `preview.ts:9`, `preview.ts:159`) and ONE real
`insertAdjacentHTML` at `preview.ts:175`, which is a **static literal string inside the frame's own
`<script>`** (`'<pre>Diagram engine unavailable…</pre>'`) — no artifact content reaches it. Not a vector.

The only render site is `ArtifactsView.tsx:505-511`:

```
<iframe key={…} title={sel.name}
  sandbox={sandboxFor(kind)}          // preview.ts:125-127 -> "" for svg, "allow-scripts" otherwise
  srcDoc={buildSrcDoc(kind, text)}    // preview.ts:162
  referrerPolicy="no-referrer" … />
```

`SANDBOX_SCRIPTS = "allow-scripts"` (preview.ts:34) and `SANDBOX_NONE = ""` (L36) are module
constants; `sandboxFor` is a total function over `PreviewKind` returning one of exactly those two.
Neither string contains `allow-same-origin`. `rendersInIframe` (L120-122) restricts the frame to
`html | mermaid | svg`; everything else goes to a React `<pre>{text}</pre>` (L515), which React escapes.

**The srcdoc-escaping question the brief raises does not arise, and here is why:** `srcDoc` is passed as
a **React DOM prop**, so React sets it as a DOM attribute/property. The value is never concatenated
into an HTML source string, so there is no attribute delimiter for a `"` in the content to close, and
no element for a `</iframe>` in the content to terminate. A string-built `<iframe srcdoc="...">` would
be vulnerable; this is not that.

### Live attack results — Chromium `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`

`/tmp/probe/c5.ts` calls the REAL `detectPreviewKind`/`sandboxFor`/`buildSrcDoc`, then builds the
iframe the same way React does (`setAttribute("sandbox", …)`, `f.srcdoc = …`) in a parent page titled
`APP-TITLE-CLEAN`. Escape = parent title changed, or a stray `<script>`/extra `<iframe>` in the parent.

| # | attack payload | kind | sandbox | parent title after | escaped? | iframes in parent | scripts in parent |
|---|---|---|---|---|---|---|---|
| A1 | `</iframe><script>window.top.document.title='PWNED-A1'</script>` | html | `allow-scripts` | `APP-TITLE-CLEAN` | **NO** | 1 | 0 |
| A2 | `" onload="window.top.document.title='PWNED-A2'" x="` | html | `allow-scripts` | `APP-TITLE-CLEAN` | **NO** | 1 | 0 |
| A3 | `<script>window.parent.document.title='PWNED-A3'</script>` | html | `allow-scripts` | `APP-TITLE-CLEAN` | **NO** | 1 | 0 |
| A4 | `localStorage.setItem('k','v')` | html | `allow-scripts` | `APP-TITLE-CLEAN` | **NO** | 1 | 0 |
| A5 | `document.cookie='a=b'` | html | `allow-scripts` | `APP-TITLE-CLEAN` | **NO** | 1 | 0 |
| A6 | SVG carrying `<script>` **and** `<image onerror=…>` | **svg** | **`""`** | `APP-TITLE-CLEAN` | **NO** | 1 | 0 |
| A7 | mermaid source containing `</pre><script>…</script><pre>` | mermaid | `allow-scripts` | `APP-TITLE-CLEAN` | **NO** | 1 | 0 |
| A8 | HTML entities `&lt;script&gt;` **and** numeric `&#60;script&#62;` | html | `allow-scripts` | `APP-TITLE-CLEAN` | **NO** | 1 | 0 |
| A9 | markdown whose prose AND ```` ```mermaid ```` block both carry `</pre><script>` | mermaid | `allow-scripts` | `APP-TITLE-CLEAN` | **NO** | 1 | 0 |
| A10 | `window.top.location='https://evil.example/'` | html | `allow-scripts` | `APP-TITLE-CLEAN` | **NO** (parent url stayed `about:blank`) | 1 | 0 |

**10/10 contained. `iframeCount` stayed 1 in every case — `</iframe>` in the body did not close the
element, confirming the React-prop reasoning empirically.**

Two results are worth reading closely because they are the evidence the containment is real rather
than the scripts merely failing to run:

- **A7 / A9 frame body text** came back as
  `"Diagram engine unavailable (offline or blocked).\ngraph TD;\nA-->B;\n</pre><script>window.top.document.title='PWNED-A7'</sc…"`.
  Two facts at once: (a) `escapeHtml` (preview.ts:129-136, applied at L171-172) turned the injected
  `</pre><script>` into **visible text inside the `<pre>`**, so it never became markup; and (b) the
  "Diagram engine unavailable" line is `preview.ts:175`'s own catch handler firing — which **proves
  script DID execute inside the frame**. So the sandbox is not silently script-dead; scripts run
  (as D3/mermaid need) and still cannot reach the parent. (The CDN being unreachable is this
  container's egress, not a defect.)
- **A8** rendered `<script>window.top.document.title='PWNED-A8'</script>` as literal visible text.
  Entities in a `srcdoc` body are decoded **once** by the frame's HTML parser into a text node, not
  re-parsed into a tag. No double-decode path exists.
- **A6** is the SVG case: `sandboxFor("svg")` returned `""`, so neither the embedded `<script>` nor
  the `onerror` handler could fire. Matches the claim's "SVG: no scripts at all".

**No input escaped.** Nothing to report as a break.

---

## C7 — no regression for plain markdown

**CONFIRMED.** Same probe harness as C2 (`/tmp/probe/c789.ts`), input
`"# Title\n\ntext with **bold** and a | table |\n"` (44 bytes), `name: "notes"`.

| case | returned name | returned mime | bytes | warnings | body byte-for-byte identical to input |
|---|---|---|---|---|---|
| `format: "md"` | `notes.md` | `text/markdown; charset=utf-8` | 44 | `[]` | **yes** |
| **format absent entirely** | `notes.md` | `text/markdown; charset=utf-8` | 44 | `[]` | **yes** |

Both paths also wrote `notes.md` / `text/markdown; charset=utf-8` into the SQL INSERT, and the stored
body printed back as exactly `# Title\n\ntext with **bold** and a | table |\n` — the markdown is
**passed through untouched**, not re-serialised through the block parser. The default in
`createArtifactFromAgent` L182 (`typeof a.format === "string" ? … : "md"`) is what makes the
absent-format case identical.

---

## C8 — `renderArtifact` never throws

**CONFIRMED.** 18 hostile inputs called directly against the real `renderArtifact`. **Zero threw,
zero hung** — the slowest was 124 ms.

| input | threw? | ms | result | warning |
|---|---|---|---|---|
| `document` as a string | no | 115 | `a.docx`, 8582 B | "Structured document was not an object — rendered its raw text instead." |
| `document` as a number (42) | no | 22 | `a.docx`, 8576 B | same |
| `document: null` | no | 20 | `a.docx`, 8530 B | "No content or document supplied — an empty document was produced." |
| `document` nested **2000 deep** | no | 110 | `a.docx`, 8826 B | "Section 0 had unknown type …" — **no stack overflow** |
| deck as a string | no | 86 | `a.pptx`, 44794 B | "Structured deck was not an object — rendered its raw text on one slide." |
| deck nested 2000 deep | no | 4 | `a.pptx`, 44132 B | "Structured deck had no slides." |
| **1 MB single-line** → docx | no | 124 | `a.docx`, 9655 B | `[]` |
| **1 MB single-line** → pptx | no | 70 | `a.pptx`, 1 045 392 B | `[]` |
| **1 MB single-line** → md | no | 1 | `a.md`, 1 000 000 B | `[]` |
| unterminated ```` ``` ```` code fence | no | 19 | `a.docx`, 8711 B | `[]` |
| malformed table (ragged rows, `\|\|\|`) | no | 22 | `a.docx`, 8780 B | `[]` |
| neither content nor document | no | 15 | `a.docx`, 8531 B | "No content or document supplied…" |
| `content` undefined, md | no | 0 | `a.md`, 0 B | "No content supplied — an empty file was produced." |
| `format: null` | no | 0 | `a.md` | `Unknown format "null" — rendered as markdown.` |
| `format: {a:1}` | no | 0 | `a.md` | `Unknown format "[object Object]" — rendered as markdown.` |
| `content` is an object | no | 0 | `a.md`, 7 B | `[]` |
| `name: ""` | no | 13 | **`artifact.docx`** (sane fallback) | `[]` |
| **circular** `document` (`o.self = o`) | no | 9 | `a.docx`, 8572 B | "Structured document had no sections." — **no infinite loop** |

**Largest input tried: a 1 000 000-character single-line string (1 MB), in all three of md, docx and
pptx.** The docx result is only 9655 bytes, which looks like truncation and is not: unzipping
`/tmp/probe/big.docx` gives `word/document.xml` of **1 002 706 uncompressed bytes**, and the full
`"x" * 1 000 000` run **is present** in it — ZIP deflate simply compresses a million identical
characters to almost nothing. Content preserved in full.

---

## C9 — ADVERSARIAL: can a misrepresenting or unopenable file be produced?

**REFUTED — one real mislabelling hole, plus one path-traversal risk in the OneDrive mirror. The
rest of the surface held.**

### What HELD (no defect)

| attempt | result | why it is fine |
|---|---|---|
| docx labelled `mime:"text/markdown"` | `report.docx`, **Office mime**, magic `50 4b 03 04` | the override was correctly IGNORED (`artifacts.server.ts:224-226`) |
| pptx labelled `mime:"text/plain"` | `deck.pptx`, **Office mime**, ZIP magic | same guard |
| name `"report.md"` + `format:"docx"` | `report.docx` | extension REPLACED, not appended — no `report.md.docx` |
| `format: " DOCX "` (padding + caps) | **`report.docx`**, Office mime, ZIP magic | whitespace+case tolerated |
| `format: "DOCX"` / `"MeRmAiD"` | `report.docx` / `diag.mmd` | case-insensitive |
| `format: "pdf"` (unknown) | `doc.md` + warning `Unknown format "pdf" — rendered as markdown.` | degrades honestly |
| **empty deck** (`format:"pptx", content:""`) | `deck.pptx`, 44 745 B + warning "No content or document supplied" | unzipped: `testzip()`=None, **1 real slide part** `ppt/slides/slide1.xml` (well-formed) and **1 `<p:sldId>`** in `presentation.xml`. It OPENS — an empty-looking deck, not a corrupt one |
| empty docx / empty mermaid | `doc.docx` (valid pkg) / `diag.mmd` 0 B + warning | warned, not silent |
| svg labelled `mime:"text/html"` | `pic.svg`, `image/svg+xml; charset=utf-8` | PASSTHROUGH branch ignores the override entirely |
| name `".docx"` (extension only) | `.docx`, valid Office package | ugly (a dotfile with no basename) but openable and correctly typed — cosmetic only |
| name `".."` | `...md` | harmless |
| name `"a\b\c"` | `a\b\c.md`, blob path `…-a-b-c-md` | backslashes slugged out of the blob path |

### DEFECT 1 — markdown can be stored under an Office mime (the mislabelling the guard misses)

**Failing input:** `{ format: "md", content: "# R", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }`

**Observed:** `name: "report.md"`, `mime:
"application/vnd.openxmlformats-officedocument.wordprocessingml.document"`, **3 bytes**, first bytes
`23 20 52` (`# R`) — **NOT** `50 4b 03 04`. Both the blob's content-type and the `artifacts.items.mime`
column carry the Word mime.

**Root cause** — `artifacts.server.ts:224-226`:

```
const rawMime = typeof a.mime === "string" && a.mime.trim() ? a.mime.trim() : null;
const isPassthrough = rendered.mime.startsWith("text/") || rendered.mime === "application/json";
const mime = rawMime && isPassthrough ? rawMime : rendered.mime;
```

The gate tests the **rendered** mime, not the **override**. Its own comment says the point is that
*"a docx labelled text/markdown downloads as an unopenable file"* — and it does block that direction
(proven above). The **reverse is wide open**: because `rendered.mime` for `md` starts with `text/`,
`isPassthrough` is true and ANY override wins, including a binary Office one. The result is 3 bytes of
markdown that the browser and OneDrive will both announce as a Word document; Word will refuse it.
That is precisely "a file that misrepresents itself". Consequences reach C6 too — `TEXT_PREVIEW_MIME`
rejects the Office mime, so this artifact also silently loses its in-app preview.

**Fix direction:** validate the override against an allow-list of text-ish mimes (or require it to
start with `text/` / `application/json` itself), instead of inferring permission from the rendered mime.

### DEFECT 2 — `..` survives the artifact NAME into the OneDrive mirror path

**Failing input:** `{ format: "md", content: "# R" }` with `name: "../../etc/passwd"`.

**Observed:** blob path is `p-e-com/f/art-<uuid>-etc-passwd-md` — `slug()` (`artifacts.server.ts:100`)
strips the separators, so **Azure Blob is safe**. But the stored `artifacts.items.name` is
**`../../etc/passwd.md`**, verbatim, and that column is what the OneDrive mirror interpolates:
`onedrive.server.ts:52` builds `…/drive/root:/${encodePath(drivePath)}:` where `encodePath` (L21) is
`p.split("/").map(encodeURIComponent).join("/")` — and `encodeURIComponent` does **not** encode `.`,
so the `..` segments pass through intact and the `/` separators are preserved by the split/join. A
mirrored artifact named `../../etc/passwd.md` therefore targets
`Huddle Artifacts/<lane>/../../etc/passwd.md`, escaping the `Huddle Artifacts` folder to the drive
root. Scope is the owner's OWN OneDrive (the mailbox is resolved server-side, not from the name), so
this is a write-outside-the-intended-folder bug rather than a cross-user one — but the name is
**model-authored**, so an agent can put a file anywhere in the user's drive.

**Fix direction:** sanitise `name` at `createArtifactFromAgent` (strip `/`, `\` and `..` segments,
keeping `withExtension`'s behaviour) rather than only in `slug()`, which protects the blob path alone.
