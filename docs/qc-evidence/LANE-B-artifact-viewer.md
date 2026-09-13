<!--
WHAT:       Implementation log for rendering rich artifact formats -- mermaid diagrams, D3/HTML,
            and binary documents -- in the Huddle artifact viewer.
WHY:        The owner reported the agent claiming it can only produce .md, when mermaid and D3 were
            early requirements for the artifact library. Ground truth: mermaid and D3 are TEXT
            formats, so the generator was never the blocker -- the VIEWER previews text mimes as raw
            text (see TEXT_PREVIEW_MIME in artifacts.server.ts), so a diagram renders as source code.
SUPERSEDES: nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:   greps recorded in this file.
-->

# LANE B — artifact viewer: mermaid, D3/HTML, binary

Branch: `claude/iris-huddle-interaction-baj51c`
Started: 2026-09-13

## Log

### Step 0 — created this file before touching anything else.
