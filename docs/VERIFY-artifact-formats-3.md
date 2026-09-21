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
