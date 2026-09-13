<!--
WHAT:       Reconciliation of LANE B (artifact viewer: mermaid / D3-HTML / binary) against the
            equivalent feature that another session shipped to origin/main while this lane was
            building it. Records what main already does, what this lane built differently, and a
            per-difference verdict: port / discard / real gap.
WHY:        Two sessions implemented the same capability in parallel. This repo's CLAUDE.md forbids
            standing up a second parallel system ("Extend, don't duplicate"), so the parallel
            implementation was WITHDRAWN (local commit unwound, never pushed) and this file became
            the deliverable. It also carries the ground-truth reads that are still useful: the
            original diagnosis, and four measured defects in main's shipped version.
SUPERSEDES: the LANE B parallel implementation (local commit 0fe3372, unwound -- see "Withdrawal").
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   greps and command output recorded inline; a probe of origin/main's own preview.ts run
            under bun, output pasted verbatim in the "Measured defects" table.
-->

# LANE B — artifact viewer: RECONCILIATION against origin/main

Branch: `claude/iris-huddle-interaction-baj51c`
Date: 2026-09-13

> **STATUS: parallel implementation WITHDRAWN. Nothing was pushed.** The capability is already
> shipped on `origin/main`. Their version is the one to keep; on the single most important design
> question — where model-authored markup is executed — **theirs is safer than mine, not merely
> equivalent.** What survives from this lane is four measured defects in the shipped version and one
> structural recommendation, listed under "Real gaps" below.

---

## 1. What happened

I was briefed to build mermaid / D3-HTML / binary rendering in the artifact viewer. While I was
building it, session `01G19zjirdGhqjHkAuBJ8FGW` shipped the same feature to `origin/main`:

```
$ git fetch origin && git log --oneline -12 origin/main
449bdfe test(artifacts): a non-package must FAIL the render suite, never crash it (found by mutation)
86eb4a6 fix(artifacts): SVG artifacts never reached the viewer -- the server withheld their bytes
82e56b8 feat(artifacts): server-side docx/pptx renderer (markdown + structured), one entry point
654f78e docs(ledger): artifact preview renders mermaid/D3/HTML in a sandboxed frame
d803826 feat(artifacts): render mermaid, HTML/D3 and SVG artifacts in a sandboxed iframe
6e055f2 feat(artifacts): the create_artifact contract stops saying "markdown only"
```

Their module is `src/features/huddle/lib/artifacts/preview.ts`; mine was
`src/features/huddle/lib/artifacts/artifact-preview.ts`. **We independently created the same test
file name**, `scripts/artifact-preview.test.ts`, and the same npm script `test:artifact-preview` —
which is how the collision surfaced.

### Withdrawal — what I did about it

The work had already been committed **locally** (`0fe3372`) before the stop arrived. It was never
pushed. I unwound it with `git reset --soft` to its parent `77c1f9c` and then restored *only my own
five modified files* and deleted *only my own three new files*, because LANE A has uncommitted work
in this same tree (`huddle.functions.ts`, `openai-responses.server.ts`,
`agent-workflow-config.*`, `openai-builtin-tools.ts`) and a `reset --hard` would have destroyed it.
Post-unwind `git status` shows LANE A's files and nothing of mine. The npm dependency I added is
gone from `package.json`; `node_modules` still contains it locally, which is inert and disappears on
the next clean install.

---

## 2. The diagnosis — where both lanes agreed

Recorded because it is the durable finding, and both lanes reached it independently, which is
reasonable evidence it is right.

| Question | Command | Result |
|---|---|---|
| Was a mermaid renderer already a dependency? | `grep -rn "mermaid" package.json src/` | No hits anywhere. |
| A markdown renderer or sanitiser? | `grep -nE "markdown\|marked\|remark\|rehype\|dompurify" package.json` | None. |
| Is there a CSP that would block an iframe or a CDN script? | `find . -maxdepth 3 -name staticwebapp.config.json` | **No such file.** No CSP in the repo. |

**The generator was never the blocker.** Mermaid and D3 are TEXT. `TEXT_PREVIEW_MIME` in
`artifacts.server.ts` matched `^text/`, so a `text/html` or `text/vnd.mermaid` artifact ALREADY came
back from `getArtifact` with its source in `row.text` — and the viewer's preview branch had exactly
three arms (`<img>`, PDF `<iframe>`, `<pre>{text}</pre>`), so it printed that source as code. The
last ten lines of the render branch were the whole bug. main's `d803826` fixes exactly this.

---

## 3. Capability-by-capability reconciliation

**(a) port a small diff · (b) equivalent or worse — discard mine · (c) real gap mine closes**

| # | Capability | `origin/main` | My withdrawn version | Verdict |
|---|---|---|---|---|
| 1 | **Mermaid render** | Pinned CDN `mermaid@11.4.1` loaded **inside** the sandboxed iframe; `startOnLoad:true`, `securityLevel:'strict'`; blocks emitted as `<pre class="mermaid">` with the source HTML-escaped | npm `mermaid@12.0.0`, rendered **in the app document**, SVG injected with `dangerouslySetInnerHTML` | **(b) DISCARD — theirs is safer.** Their own test asserts `dangerouslySetInnerHTML` appears in no line of executable code in either file. Mine violates that. Model-authored markup should not enter the app's document at all, and their opaque-origin frame is the stronger boundary. |
| 2 | **The mermaid npm dependency** | **None.** The library is a pinned CDN URL used only inside the frame | `"mermaid": "12.0.0"` added to `package.json` | **(b) DISCARD, and it is a real cost avoided.** Measured on my build: `_libs/mermaid+[...].mjs` **2.94 MB** in the server output, plus client assets going **52 → 154**. That is dead weight against main's design, which needs no package. The trade main accepted instead: a diagram will not draw with no internet — handled, see #8. |
| 3 | **HTML / D3 sandbox** | `<iframe srcDoc sandbox="allow-scripts" referrerPolicy="no-referrer">`, no `allow-same-origin`; `SANDBOX_SCRIPTS`/`SANDBOX_NONE` are exported constants asserted by tests | Identical decision, same three attributes | **(b) DISCARD — equivalent.** Two lanes reached the same posture independently. Theirs additionally injects a pinned `d3@7.9.0` CDN so a visualisation assuming a global `d3` still draws; mine did not. Theirs is ahead. |
| 4 | **SVG** | Its own `svg` kind rendered in a frame with `sandbox=""` — scripts off entirely. Correctly treats SVG as *text wearing an image mime* | Routed to the `image` arm (`<img src={sas}>`) | **(b) DISCARD — theirs is better.** `86eb4a6` is a follow-up fix that widened the mime gate for `image/svg+xml` specifically because the bytes never arrived. Mine never even asked for them. |
| 5 | **Binary .docx/.pptx/.xlsx** | Viewer unchanged: the "Preview not available…" card + the Download row. Separately, `82e56b8` adds `render.server.ts` so agents can **produce** real OOXML | A `BinaryArtifactCard` with the file kind and two wired `target="_blank"` controls | **(b) mostly DISCARD.** Cosmetic against their card; not worth a diff on shipped code. The one part that is NOT cosmetic is the download defect — see #6. |
| 6 | **The Download control** | `<a href={sas} download={sel.name}>` — **no `target`** (`ArtifactsView.tsx:544` on main) | `target="_blank" rel="noreferrer"`, label changed to match what the click does | **(c) REAL GAP — port this.** See "Real gaps" #1. |
| 7 | **`TEXT_PREVIEW_MIME` ↔ viewer sync** | Still a local `const` in `artifacts.server.ts` under the comment asking a human to keep it in step; widened by hand in `86eb4a6` | One exported constant in a pure module imported by BOTH sides, with a mutation-proved structural guard against re-declaring it | **(c) REAL GAP, but propose — do not refactor shipped code unilaterally.** See "Real gaps" #4. |
| 8 | **Offline / failure behaviour** | CDN unreachable → the frame prints *"Diagram engine unavailable (offline or blocked)"* | Bundled, so works offline; a syntax error shows the source plus the parser message | **(b) DISCARD.** Different trades, both handled. Not worth reopening. |

---

## 4. Real gaps in the shipped version — MEASURED, not inferred

I extracted `origin/main:src/features/huddle/lib/artifacts/preview.ts` to a scratch file and ran its
own exported functions under `bun`. Output pasted verbatim:

```
1) unterminated blocks: ["graph TD\n  A --> B\n\nTRAILING PROSE THAT NEVER GOT A CLOSING FENCE"]
1) unterminated prose  : "intro prose"
2) blocks: ["graph TD\nA-->B","sequenceDiagram\nA->>B: hi"]
2) prose : "PROSE-A\n\n\n\nPROSE-B\n\n\n\nPROSE-C"
3) tilde hasFence: false kind: markdown
4) js fence kind: markdown
5) docx kind: none
6) svg kind (text present): svg
7) plain md kind: markdown
```

**Gap 1 — the cross-origin `download` attribute is ignored (correctness, smallest fix, highest value).**
`ArtifactsView.tsx:544` on main is `<a href={sel.url ?? "#"} download={sel.name}>Download</a>`. The
SAS url is on `*.blob.core.windows.net`, i.e. **cross-origin** — and per the HTML spec browsers
ignore `download` for a cross-origin href. So the control navigates the SPA away from the app
instead of downloading. Minimal diff: add `target="_blank" rel="noreferrer"`, and say "Open the
file" rather than "Download" so the label matches the behaviour. Independent of the whole render
architecture. *(Read off the spec plus the confirmed host — not observed in a browser.)*

**Gap 2 — an unterminated ```mermaid fence swallows the rest of the document (measured, line 1 above).**
`MERMAID_FENCE_G` ends `(?:\r?\n[ \t]*```|$)`, so with no closing fence the lazy body expands to the
end of the string. Measured: `TRAILING PROSE THAT NEVER GOT A CLOSING FENCE` ended up **inside the
diagram block** and was **removed from the prose** — mermaid then fails to parse it and the user
loses that text from the preview entirely. A truncated document is exactly when this happens.
Minimal diff: drop the `|$` alternative so an unclosed fence is not a block, plus one test case.
*(My splitter treated this as text and I mutation-proved it — mutation `let closed = false → true`
reinstated the swallow and the assertion FIRED.)*

**Gap 3 — document order is lost when prose and diagrams interleave (measured, line 2 above).**
`extractMermaidBlocks` + `stripMermaidBlocks` are two separate passes, so a
prose→diagram→prose→diagram→prose document renders as *both diagrams first*, then all prose
concatenated (`"PROSE-A\n\n\n\nPROSE-B\n\n\n\nPROSE-C"`). Not a bug; a readability regression for a
long brief. Fixing it means a single ordered split — a larger change to shipped code than the two
above, and I would not do it without the owner asking.

**Gap 4 — tilde fences are not detected (measured, line 3 above).** `~~~mermaid` scores
`hasFence: false` and renders as plain markdown. Minor: agents overwhelmingly emit backticks.

**Gap 5 (structural, a recommendation not a diff) — the mime gate and the renderer are still two
copies.** `artifacts.server.ts` decides whether a body is fetched at all; `preview.ts` decides how
to draw it; they must agree, and today the agreement is a comment. **This already failed once:**
`86eb4a6` exists precisely because the renderer grew an `svg` kind while the gate still withheld
`image/svg+xml` bytes — *"THE VIEWER CANNOT RENDER WHAT THE SERVER NEVER SENDS"*, in their own
commit message. Making `TEXT_PREVIEW_MIME` a single exported constant that both files import turns
that class of bug into an import error. The guard that makes it stick is a source assertion that the
server cannot re-declare its own copy; I mutation-proved that guard (re-introducing the local const
→ **FIRED**). Worth doing, but it is a refactor of shipped code and belongs to whoever owns that
file next, not to a withdrawn lane.

---

## 5. What I could NOT verify

**I have not seen a pixel of either implementation render.** A CCR sandbox cannot execute the SPA
and the deployed SWA is not in this session's egress allowlist. Everything above is source reading,
a production build, and pure functions executed under bun. Specifically not observed: that main's
CDN mermaid actually draws in the deployed app; that a D3 artifact loads its script inside the
sandbox in production (no CSP exists *in the repo* — that is not the same as no CSP in production);
or that the download control misbehaves in a real browser.

Live proof, when someone wants it: `verify-uat.yml` runs Playwright against the deployed SWA on a
GitHub runner. **Do not dispatch it against un-deployed code** — main's artifact work needs to be
deployed first, or the run screenshots the old viewer and "disproves" a shipped feature.

---

## 6. Evidence that the withdrawn work was real (so the reconciliation is not a rationalisation)

Before it was unwound, on the tree that contained it:

- `npx tsc --noEmit` → `TSC_EXIT=0`
- `npm run build` → `BUILD_EXIT=0`, `✓ built in 6.71s`
- `npm run test:artifact-preview` → `51 passed, 0 failed`
- `npm run test:router` (untouched suite, regression smoke) → `20 passed, 0 failed`
- four `mutate.sh` runs, all **FIRED**, each ending `restored: <file> matches HEAD`:
  duplicated mime constant; `sandbox="allow-scripts allow-same-origin"`; mime gate narrowed;
  unterminated fence swallowing the document. No `INERT`, no `NOT-APPLIED`.
- One honest note: the sandbox guard **fired on my own security comment** the first time it ran —
  correct code, wrong guard. Fixed by stripping comment lines before the check. main's test file
  independently contains the same `codeOnly()` precaution, with the same reasoning written above it.

None of that makes the parallel implementation worth keeping. Discarding it is the correct outcome.

---

## 7. Incident worth recording: `git add <path>` is not enough when lanes share a container

My first attempt to commit this file alone still swept **seven** files, including all of LANE A's
in-flight work, into a commit with my message. I did not use `git add -A` — I named exactly one
path. The cause is that LANE A is a sibling agent in the SAME container and therefore the SAME git
index: it staged its own files in the window between my `git add` and my `git commit`, and
`git commit` commits the whole index, not the paths you last added.

Nothing was lost (their content was committed, not destroyed) and it was split apart with
`git reset --soft` + `git restore --staged` on their paths only, which leaves their worktree
untouched. But the branch's standing "this has swept the wrong files four times" note has a sharper
form than "don't use `git add -A`":

> **With parallel lanes in one container, commit with `git commit --only <paths>` (`-o`).** It
> commits exactly those paths whatever else is in the shared index. `git add <path>` followed by a
> bare `git commit` is a race, and the other lane wins it silently.
