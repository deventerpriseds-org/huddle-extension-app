<!--
WHAT:       Implementation log for offering OpenAI built-in tools (code_interpreter, image_generation)
            to Huddle agents and landing their file output in the artifact store.
WHY:        The owner reported the agent refusing to produce images or Word/PowerPoint, saying it is
            limited to .md. Ground truth: mergedTools (huddle.functions.ts) contains only custom
            type:"function" tools, and snapshotResponsesTools (openai-assistants.server.ts) explicitly
            drops code_interpreter. So the model is handed a strictly smaller toolset than ChatGPT's.
SUPERSEDES: nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   greps recorded in this file.
-->

# LANE A — offer OpenAI built-in tools (code_interpreter, image_generation)

Branch: `claude/iris-huddle-interaction-baj51c`
Started: 2026-09-13

## Log

- Created this file as the first action (write-as-you-go discipline).
- `git rev-parse --abbrev-ref HEAD` -> `claude/iris-huddle-interaction-baj51c`
- `git log --oneline -5` head = `79bfce3 Merge remote-tracking branch 'origin/main' into claude/iris-huddle-interaction-baj51c`
- Working tree clean at start (`git status --porcelain` empty).

## Ground truth: the problem, re-read this session

| Claim | File + line read | What it says |
|---|---|---|
| `mergedTools` is all custom functions | `src/features/huddle/lib/huddle.functions.ts:3497-3531` | Every entry is a `type:"function"` tool or a spread of function arrays (`groomTools`, `emailTools`, `snapshotTools`, `ragTools`, `journeyTools`, `webSearchTools`, `nexusTools`). No OpenAI-executed built-in. Confirmed. |
| snapshot drops `code_interpreter` | `src/features/huddle/lib/openai-assistants.server.ts:28-33, 43-63` | Doc comment: "Drops `code_interpreter` and anything unrecognized." The loop only handles `file_search` and `function`. Confirmed. |
| the store is already binary-capable | `src/features/huddle/lib/artifacts/artifacts.server.ts:105-150` | `CreateArtifactInput.bytes: Buffer \| Uint8Array`, arbitrary `mime`, `putArtifactBlob(blobPath, data, input.mime)`. Confirmed — extend, do not rebuild. |
| `create_artifact` is markdown-only | `src/features/huddle/lib/artifacts/artifact-tool.ts:6-31` | `content` described as "The FULL document in markdown", `mime` "defaults to text/markdown". Confirmed. |
| the wrong comment on `tools?` | `src/features/huddle/lib/openai-responses.server.ts:90` | `/** OpenAI Responses tools (function/file_search). Not code_interpreter. */` Confirmed — must be updated. |

Also read end-to-end: `openai-responses.server.ts` (364 lines). Output items are iterated in exactly
two places — `extractText` (line 140), `extractReasoning` (147) and `extractToolCalls` (207). All
three FILTER, so an unknown item type is silently ignored rather than crashing. The important
consequence: a hop whose output contains only built-in items and a message returns at line 331-333
(`toolCalls.length === 0`), which is correct — built-in tools are executed by OpenAI **inside the
same response**, they never round-trip through `onToolCall`.

## Ground truth: the OpenAI built-in tool wire shapes

The sandbox egress **blocks `platform.openai.com`** (WebFetch -> `EGRESS_BLOCKED`), so the docs were
not the available primary source. Instead I pulled the OpenAI SDK's own type declarations, which are
generated from the API spec:

```
npm pack openai   ->  openai-7.15.0.tgz   (into the scratchpad; NOT installed into this repo)
```

Every field name below was read out of that tarball this session — none typed from memory:

| Thing | Where read | Shape |
|---|---|---|
| code_interpreter tool (request) | `resources/responses/responses.d.ts:8304-8319` | `{ type: 'code_interpreter', container: string \| {type:'auto', file_ids?, memory_limit?} }` — **`container` is REQUIRED**, not optional. |
| image_generation tool (request) | `responses.d.ts:8353-8430` | `{ type: 'image_generation', model?, size?, quality?, output_format?: 'png'\|'webp'\|'jpeg', background?, moderation?, partial_images? }` — every field but `type` optional. |
| `image_generation_call` (output item) | `responses.d.ts:3689-3731` | `{ id, type:'image_generation_call', status, result: string \| null /* base64 */, output_format?, revised_prompt?, size? }` |
| `code_interpreter_call` (output item) | `responses.d.ts:1553-1607` | `{ id, type:'code_interpreter_call', code, container_id, status, outputs: Array<{type:'logs',logs} \| {type:'image',url}> \| null }` |
| where produced FILES surface | `responses.d.ts:5353-5368` + `5418-5443` | On the `output_text` content part's `annotations` array, as `{ type:'container_file_citation', container_id, file_id, filename, start_index, end_index }`. |
| download endpoint | `resources/containers/files/content.js:14` | `GET /containers/{container_id}/files/{file_id}/content` |
| container file object | `resources/containers/files/files.d.ts` | `{ id, bytes, container_id, created_at, object:'container.file', path, source }`; list is `GET /containers/{container_id}/files` (`files.js:41`). |

So the file a code_interpreter run writes is reachable as
`container_file_citation.container_id` + `.file_id` + `.filename` -> one authenticated GET.

MIME strings were also grounded rather than typed: `npm pack mime-db` (1.54.0) in the scratchpad, then
its `db.json` queried for the extensions the map covers. `application/vnd.openxmlformats-officedocument
.spreadsheetml.sheet` cross-checks against the one already present in `ArtifactsView.tsx:104`.

## Part 1 — transport + engine (done, tsc clean)

| File | Change |
|---|---|
| `src/features/huddle/lib/openai-builtin-tools.ts` (**new**) | `CODE_INTERPRETER_TOOL`, `IMAGE_GENERATION_TOOL`, `BUILTIN_TOOL_TYPES`, `BUILTIN_TOOLS_SYSTEM_HINT`, `mimeForFilename`, `basenameOf`. Dependency-free constants, so the turn engine imports it statically exactly like `artifact-tool.ts`. |
| `openai-responses.server.ts` | New `builtInTools` + `onBuiltInFile` inputs; `extractBuiltInFiles()`; `fetchContainerFileBytes()`; built-ins merged into the wire `tools` array; **400 fallback** that retries the hop with function tools only; the wrong `Not code_interpreter.` comment replaced. |
| `identity/agent-workflow-config.server.ts` | Two new columns on the existing `identity.agent_workflow_config` (`builtin_tools_enabled` default **true**, `builtin_tools_agent_overrides`), config field + upsert, and `canOfferBuiltInTools()` beside `canOfferSendEmailTool()`. |
| `identity/agent-workflow-config.functions.ts` | Both new fields added to `ConfigInput` so the existing client-callable `setMyWorkflowConfigFn` can change them — no new config surface. |
| `huddle.functions.ts` | Gate resolved once above the instruction assembly; hint added under the same condition; the "dropped unsupported assistant tools" warning no longer names `code_interpreter` when we are offering our own; `onBuiltInFile` handler landing bytes via the **existing** `createArtifact`; `builtInTools` passed in `personaArgs`. |

**Why the gate defaults ON and fails OPEN, stated plainly because it is the opposite of the email
gate two functions above it.** `canOfferSendEmailTool` fails CLOSED because mail leaving the tenant is
irreversible. This is a COST gate: what it protects is a few cents of container/image spend, and what
a closed default costs is the reported bug itself — the agent saying it can only produce markdown,
with no error anywhere to explain why. So default ON, per-agent override wins, read failure resolves
to the default.

**Why the 400 fallback exists.** Built-in tools are model- and account-dependent. Without a fallback,
one model that cannot run `code_interpreter` turns every one of its turns into a hard failure. The
retry drops exactly the built-ins and re-sends; if the 400 was about anything else the retry is
rejected identically and the original throw happens, so it can only convert a hard failure into a
degraded success. No error-string matching — that would be a literal I have not read.

## Part 2 — the seven markdown-constraining sites

Scope expansion received mid-task from the coordinator, with
`docs/qc-evidence/ACT-artifact-rich-formats-consumer-map.md` (read in full). Ordering constraint
honoured: Part 1 landed first, so no prompt tells an agent to produce a `.docx` before the tool can.

**Superseded before it was committed — see the reconciliation below.** Only `artifact-tool.ts` (site 1)
had been edited when the halt came; that edit is DISCARDED (`git checkout --`) because `6e055f2` on
`origin/main` reworked the same description better. Sites 2-7 were never touched.

---

# RECONCILIATION with origin/main (2026-09-13)

Halt instruction received mid-implementation: another session shipped part of this lane by a different
mechanism. `git fetch origin` then read, at `origin/main`:

```
449bdfe test(artifacts): a non-package must FAIL the render suite, never crash it (found by mutation)
86eb4a6 fix(artifacts): SVG artifacts never reached the viewer -- the server withheld their bytes
82e56b8 feat(artifacts): server-side docx/pptx renderer (markdown + structured), one entry point
d803826 feat(artifacts): render mermaid, HTML/D3 and SVG artifacts in a sandboxed iframe
6e055f2 feat(artifacts): the create_artifact contract stops saying "markdown only"
```

Branch position: `git rev-list --left-right --count origin/main...HEAD` = **11 behind, 8 ahead**
(diverged — a merge, never `reset --hard`).

## (a) Does the server-side renderer make `code_interpreter` unnecessary for .docx/.pptx?

**Yes. For .docx and .pptx their design is better than mine, and I am withdrawing that half of my
work.** Not a close call:

| | server-side `renderArtifact()` (origin/main) | `code_interpreter` (my lane) |
|---|---|---|
| determinism | same markdown -> same document, always | depends on the model writing correct python-docx that run |
| cost | none beyond the request already being made | a billed container session per turn |
| latency | in-process | container spin-up + execution + a second authenticated GET for the file |
| testability | **52/52 offline** (`npm run test:artifact-render`), asserting on real `word/document.xml` and `ppt/slides/slideN.xml` | untestable without calling OpenAI |
| reach | a plain server function — works on the Lovable backend, worker sub-turns and the voice surface alike | OpenAI Responses only, and only on models that accept the tool (which is why my transport needed a 400 fallback at all) |
| failure mode | `render.server.ts` header says it NEVER throws; degrades to a valid document carrying the raw text | a model that writes bad python produces nothing |

The one thing `code_interpreter` still does that the renderer cannot is **compute**: a chart from a
real dataset, an `.xlsx` with live formulas, statistics over an uploaded file. That is a real gap but a
narrower one, and it is **not what the owner reported**. Withdrawing it is the correct outcome.

## (b) `image_generation` — still the gap, and still needed

Confirmed by `git grep -n "image_generation" origin/main -- src/`: **zero hits.** Nothing on
`origin/main` generates a raster image.

`6e055f2` added `format: 'svg'` (hand-authored vector) and `format: 'mermaid'` (diagrams), which cover
*drawings*. Neither covers "make me a logo / a picture of X / a mockup" — a photographic or painted
raster image. That is the half of "refusing to produce images" their work does not close.

It is also **architecturally independent** of the renderer: `image_generation` returns base64 in the
`image_generation_call` output item and lands via `onBuiltInFile` -> the existing `createArtifact`.
It never touches `renderArtifact`, `format`, or the create_artifact dispatch, so there is no
duplicate-mechanism problem. This is the minimal, non-overlapping diff I still hold.

## (c) Which of the seven sites did `6e055f2` actually fix? — checked one by one against origin/main

`git show 6e055f2 --stat` touched **three files: `artifact-tool.ts`, `package.json`,
`package-lock.json`.** So arithmetically it can only have fixed site 1. Verified each anyway, by
reading `git show origin/main:<file>`, not the local tree:

| # | Site | State on origin/main | Verdict |
|---|---|---|---|
| 1 | `artifacts/artifact-tool.ts` | rewritten; adds `format` enum (md/docx/pptx/html/mermaid/svg) + optional `document`; `required` is now `["name"]` only | **FIXED** (better than my version — discarded mine) |
| 2 | `voice/realtime-tools.server.ts:289,297,299` | still a HAND-RESTATED duplicate schema: *"Save a document (markdown/plain text)"*, `content` *"(markdown/plain text)"*, `mime` *"Default text/markdown"*. Still not importing the shared object; `LIST_ARTIFACTS_TOOL` beside it is still the only one pushed by reference | **UNFIXED** |
| 3 | `voice/realtime-tools.server.ts:102-104` | unchanged — *"do NOT just say you'll 'generate an MD file'"* | **UNFIXED** (though see the caveat below) |
| 4 | `agents/workers.ts:43` | unchanged — *"You MUST call create_artifact exactly once to save your full, detailed write-up as a **markdown** …"* | **UNFIXED** |
| 5 | `tasks/autowork.server.ts:64` | unchanged — *"You MUST call create_artifact to SAVE your full findings as a document — detailed **markdown** with …"* | **UNFIXED — and this is the autonomous WIP path** |
| 6 | `huddle.functions.ts:301-304` | unchanged house-style *"When you produce a document via create_artifact, give it the FULL structure…"*. Re-read in full: this constrains **structure**, never **format** — the word "markdown" does not appear in it | **NOT A DEFECT** — descriptive, leave it |
| 7 | `huddle.functions.ts:4873` (Lovable dispatch) | unchanged; still `mime: String(a.mime ?? "text/markdown")` and no `format` handling | **UNFIXED** |

### Two LIVE defects `6e055f2` introduced that nobody owns yet — higher priority than anything left in my lane

Both come from the contract being flipped ahead of the mechanism, which is precisely the ordering
hazard the consumer map warned about. Read from `git show origin/main:src/features/huddle/lib/huddle.functions.ts`:

1. **`renderArtifact` has ZERO callers.** `git grep -n "renderArtifact" origin/main -- src/` matches
   only its own definition (`render.server.ts:904`) and its own header comment. The renderer is built,
   tested 52/52, and wired to nothing.
2. **The dispatch contradicts the schema it is supposed to serve.** At `huddle.functions.ts:3576-3579`
   it is still:
   ```
   const content = String(a.content ?? "");
   if (!name || !content)
     return JSON.stringify({ ok: false, error: "name and content are required" });
   ```
   while the new schema made `content` optional (`required: ["name"]`) so a structured `document`
   could stand alone. **A `document`-only call is rejected outright.** And `format` is read by nothing
   in any of the four dispatches (`3614` text, `4873` Lovable, `7028` worker, `realtime-tools.server.ts:590`
   voice) — each still stores `mime: a.mime ?? "text/markdown"`.

   **Net effect today: an agent asked for a Word document sets `format:"docx"`, the dispatch ignores
   it, and the store gets raw markdown named `.docx` under `text/markdown`.** That is worse for the
   owner than the original bug: before, the agent said "I can only do .md" and was *honest*; now it
   will say "here is your Word document" and hand over a mis-named text blob — the fabricated-document
   failure the house-style rule at `huddle.functions.ts:305-310` exists to prevent, and ACT-huddle-40
   recurring. Wiring `renderArtifact()` into the four dispatches is the single highest-value remaining
   task in this whole area.

## What I am left holding, and what I discarded

**Discarded outright** (origin/main does it better — said plainly, not defended):
- `code_interpreter` as the .docx/.pptx mechanism.
- My `artifact-tool.ts` description edit (site 1) — reverted with `git checkout --`.

**Still a genuine, non-overlapping gap:**
- `image_generation` + the `onBuiltInFile` -> `createArtifact` landing path (raster images).
- Sites 2, 3, 4, 5, 7 — all still say markdown on `origin/main`.
- The unwired renderer + the `content`-required dispatch contradiction (flagged; not mine to claim
  without direction, since it is the sibling renderer lane's other half).

**Not pushed, per the halt instruction.** No merge of `origin/main` into this branch either — that is
a decision for whoever sequences the lanes, since the merge is where my `openai-responses.server.ts`
and their `artifact-tool.ts` have to meet.

### What of Part 1 survives a withdrawal of code_interpreter

The transport work is not wasted if `image_generation` proceeds — `builtInTools`, `onBuiltInFile`,
`extractBuiltInFiles`, the 400 fallback and the config gate are all shared machinery, and only
`fetchContainerFileBytes` + `CODE_INTERPRETER_TOOL` are code-interpreter-specific (~40 lines, cleanly
removable). If the decision is "images only", dropping those two and the `container` half of
`extractBuiltInFiles` is a small subtraction, not a rewrite.

### One correction to the coordinator's brief, from ground truth

The brief asked me to make the voice surface push `CREATE_ARTIFACT_TOOL` **by reference** like
`LIST_ARTIFACTS_TOOL`. **A bare by-reference push would be wrong**, and this is measured, not a
preference: openai@7.15.0 `resources/realtime/realtime.d.ts:2690` declares

```ts
export type RealtimeToolsConfigUnion = RealtimeFunctionTool | RealtimeToolsConfigUnion.Mcp;
```

— the Realtime API accepts **function and MCP tools only**. No `code_interpreter`, no
`image_generation`. So the voice agent genuinely cannot produce a raster image, and handing it a
schema that tells it to would be ACT-huddle-40 again, from the opposite direction.

`format: 'docx'` is different and IS safe for voice, because the server-side renderer is a server

function rather than a model capability — once the dispatch is wired, voice gets real Word documents
for free. The right shape is therefore **one source of truth with a capability flag**, e.g.
`createArtifactTool({ images: boolean })` in `artifact-tool.ts`, rather than either a bare shared
reference or the current hand-restated duplicate. That keeps the surfaces from drifting without
telling one of them it can do something it cannot.

---

# Verification, verbatim

```
$ npx tsc --noEmit
TSC_EXIT=0                      # no output at all

$ npm run build
✓ built in 1.57s
[nitro] √ You can preview this build using npx vite preview
BUILD_EXIT=0
```

(Run against the reconciled tree — i.e. AFTER `artifact-tool.ts` was reverted, so this is what the
retained changes actually compile to.)

## Mutation proof

**None run, and none is owed.** `mutate.sh` proves a GUARD. This lane added no guard and no test —
its changes are a transport capability, a config column and a tool offering. The one thing that
behaves guard-like is the 400 fallback in `callOpenAIResponses`, and there is no test asserting it, so
mutating it would report `INERT` and that report would be honest but meaningless: the correct reading
is **UNPROVEN**, not "the guard protects nothing". Stated rather than skipped silently.

## What a sandbox CANNOT verify — stated explicitly

- **Nothing here has called OpenAI.** This session's egress blocks `platform.openai.com` outright
  (`WebFetch` -> `EGRESS_BLOCKED`), and no turn was run. So the following are **UNVERIFIED**, from
  reading generated type declarations rather than from an observed response:
  - that a Responses request carrying `{type:"image_generation", output_format:"png"}` is accepted by
    the models Huddle actually runs (`usedModel`);
  - that a real `image_generation_call` item arrives with `result` populated;
  - that `GET /containers/{id}/files/{id}/content` returns the bytes as expected;
  - that the 400 fallback ever fires, and that a rejection of built-ins really is a 400 rather than
    some other status.
- **The DB columns have not been applied anywhere.** `identity.agent_workflow_config` is bootstrapped
  lazily on first use against the live Azure PG, which a CCR session cannot reach (TCP 5432 is blocked
  by session egress — see CLAUDE.md). The two `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements are
  written and typecheck; they have **not been executed**.
- No agent has produced a real file through this code. Nothing here should be described as "working".

## Commit note — this lane's files landed under another lane's commit message

My staged files were swept into `710e3ff docs(qc-evidence): LANE B reconciliation -- the viewer
feature was already shipped` by a concurrent session committing on this same branch between my
`git add` and my `git commit`. Nothing was lost — verified by reading the commit, not the worktree:

```
$ git show --stat HEAD
 docs/qc-evidence/LANE-A-builtin-tools.md           | 264 +++++
 src/features/huddle/lib/huddle.functions.ts        | 113 ++++-
 src/features/huddle/lib/openai-builtin-tools.ts    | 133 +++++
 src/features/huddle/lib/openai-responses.server.ts | 214 ++++++-
 .../lib/identity/agent-workflow-config.server.ts   |  82 ++++-
 .../identity/agent-workflow-config.functions.ts    |   6 +
$ git show HEAD:src/features/huddle/lib/openai-responses.server.ts \
    | grep -c "builtInTools\|onBuiltInFile\|extractBuiltInFiles\|fetchContainerFileBytes"
13
```

History is NOT being rewritten to fix the attribution: another session is live on this branch and a
rebase there would be worse than a wrong commit subject. This note is the record instead. The branch
is **1 commit ahead of its own remote and NOT pushed**, per the halt instruction.

This is the `git add -A` sweep hazard my brief named ("this has swept the wrong files four times on
this branch") — worth noting that it bites even when the lane being swept staged narrowly and
correctly, because the sweeper is a different process.

### …and then the sweep was rewritten away, taking this lane's code with it

Minutes later `710e3ff` became **unreachable**: the same session reset and re-committed its own file
as `15806a4`, dropping my five source files from history.

```
$ git merge-base --is-ancestor 710e3ff HEAD ; echo $?
1                                     # NO -- 710e3ff is dangling
$ git show HEAD:src/features/huddle/lib/openai-builtin-tools.ts
fatal: path ... does not exist        # the code was gone from HEAD
$ git status --porcelain              # but the reset was --mixed, so the WORKTREE still had it
 M src/features/huddle/lib/huddle.functions.ts
 M src/features/huddle/lib/identity/agent-workflow-config.functions.ts
 M src/features/huddle/lib/identity/agent-workflow-config.server.ts
 M src/features/huddle/lib/openai-responses.server.ts
?? src/features/huddle/lib/openai-builtin-tools.ts
```

Re-committed as `f36f678`. Verified present in HEAD afterwards (`13` and `10` grep hits for the new
identifiers in `openai-responses.server.ts` and `huddle.functions.ts`).

**The lesson, and it generalises past this branch:** on a branch with two live sessions, "I committed
it" is not proof the work is safe — only `git show HEAD:<path>` is, checked AFTER the commit. Nothing
was lost here purely because their reset happened to be `--mixed`; a `--hard` would have destroyed
five files of work that had already been committed once. **The branch is still unpushed**, which means
this work currently exists in exactly one container. Pushing the feature branch (not `main` — nothing
deploys from a feature branch) is the only thing that makes it survivable, and it is being held back
only by the standing "do not push" instruction.



