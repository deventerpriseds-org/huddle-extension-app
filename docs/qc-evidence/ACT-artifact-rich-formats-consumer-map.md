# Consumer map — every place that constrains agent output to markdown

<!--
WHAT:       The full producer/consumer trace for the ".md only" defect, so the fix lands at every
            site instead of only the tool schema that surfaced it.
WHY:        The repo's own "Fix all consumers, not just the one you found" rule. The schema in
            artifact-tool.ts is the site everyone finds first, but SEVEN sites constrain output, and
            three of them are PROMPTS that would keep forcing markdown even after the schema accepts
            bytes. realtime-tools.server.ts:308 already names this exact hazard in its own comment:
            reusing the shared schema is "what keeps the two surfaces from drifting the way they
            already have" -- and create_artifact is the one that did not reuse it.
SUPERSEDES: nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   `grep -rn "create_artifact\|CREATE_ARTIFACT_TOOL" src/ --include=*.ts --include=*.tsx`
            run 2026-09-13 at branch claude/iris-huddle-interaction-baj51c (merged with origin/main
            at 79bfce3). Line numbers are from that tree.
-->

## The core system everything funnels through

`createArtifact()` — `src/features/huddle/lib/artifacts/artifacts.server.ts:123-150`. It already
takes `input.bytes` (Buffer) plus an arbitrary `input.mime` and uploads via `putArtifactBlob`.
**Every fix below must funnel here. Do not add a second storage path.**

`artifacts.server.ts:386-388` is worth reading before touching anything: it records that the text
and voice paths each carry their OWN copy of the create_artifact dispatch, and that voice tools are
"silently absent when spoken, create_artifact among them until it was retro-fitted."

## The seven sites

| # | Site | What constrains output | Kind |
|---|---|---|---|
| 1 | `artifacts/artifact-tool.ts:24` | `content: {type:"string", …"The FULL document in markdown"}`; `mime` "defaults to text/markdown"; no bytes/file param | **schema** |
| 2 | `voice/realtime-tools.server.ts:287-302` | a hand-restated duplicate schema — `content` "(markdown/plain text)", `mime` "Default text/markdown" | **schema (duplicate)** |
| 3 | `voice/realtime-tools.server.ts:102-104` | voice system prose telling the agent to produce a document via create_artifact | prompt |
| 4 | `agents/workers.ts:43` | "You MUST call create_artifact exactly once to save your full, detailed write-up as a **markdown** …" | prompt |
| 5 | `tasks/autowork.server.ts:64` | "You MUST call create_artifact to SAVE your full findings as a document — detailed **markdown** …" | prompt |
| 6 | `huddle.functions.ts:302` | house-style block describing create_artifact output structure | prompt |
| 7 | `huddle.functions.ts:4825-4827` | the **Lovable** dispatch path registers `create_artifact` separately, reusing `CREATE_ARTIFACT_TOOL.description` | dispatch |

## Why the prompts matter as much as the schema

**#5 is the autonomous path.** `autowork.server.ts` is what produces artifacts on the WIP cadence
without the user in the loop. If its prompt still says "detailed markdown" after the schema accepts
binary, background work keeps emitting `.md` and the defect looks unfixed to the owner even though
the tool changed. Same for #4, the delegated-worker path.

**#2 is a drift bug already in progress.** The voice surface restates the schema rather than
importing it, so a Lane A change to `artifact-tool.ts` reaches the text agent and NOT the voice
agent. `LIST_ARTIFACTS_TOOL` immediately below it is pushed by reference and is the pattern to
follow — the comment at `:305-308` says so explicitly.

## Ordering constraint (the reason this is one coordinated change, not seven)

The prompts must NOT be flipped before the tool can actually produce binary. An agent told to
produce a `.docx` by a tool that only accepts a markdown string will either fail the call or narrate
a file it never saved — which is `ACT-huddle-40` recurring, the exact bug
`realtime-tools.server.ts:281-284` was written to fix ("it would SAY 'let me generate that MD file'
and produce nothing").

**So: schema + built-in tools land first, prompts in the same commit or immediately after.**

## Verification this map implies

- A search for `markdown` in the create_artifact instruction path returns no *constraining* use
  after the change (descriptive uses — "markdown is fine for a memo" — are correct and should stay).
- The voice and text surfaces resolve the SAME schema object, provable by reference rather than by
  reading both.
- An artifact saved through the voice path and one saved through the text path produce rows with the
  same `mime` handling.
