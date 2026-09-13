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
