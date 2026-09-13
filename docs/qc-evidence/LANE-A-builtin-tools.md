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
