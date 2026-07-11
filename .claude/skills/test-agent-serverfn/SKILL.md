---
name: test-agent-serverfn
description: >-
  Live-test Huddle agents (routing, group conversations, tool use, handoffs) by calling the
  deployed `sendHuddleMessage` server function directly and decoding its seroval response. Use when
  the user wants to confirm agents reply correctly, verify a group conversation goes several rounds
  with different agents jumping in, or check that a prompt/routing change works against the real
  deployment — without a browser.
---

# Test Huddle agents via the server function

Huddle's chat turn is the TanStack Start server function **`sendHuddleMessage`**
(`src/features/huddle/lib/huddle.functions.ts`). You can drive it end-to-end over HTTP against the
live SWA deployment, which exercises the *real* runtime: routing, snapshot instructions, house-style
layer, tools (`create_huddle_task`, `prioritize`, RAG, web search), and multi-agent interjection.

## Why this is fiddly (and why the harness exists)
- The request/response bodies are **seroval-encoded**, not plain JSON. You must encode the payload
  with `toJSONAsync` and decode the reply with `fromJSON`, both using TanStack's default seroval
  plugins. Hand-rolling a JSON body gets a 500; hand-parsing the reply misreads the node graph.
- The endpoint is `POST /_serverFn/{id}` and **requires the header `x-tsr-serverFn: true`**. Without
  it you get a 405 (routing rejects it as a non-server-fn request).
- `{id}` is a **content hash TanStack assigns to `sendHuddleMessage` at build time** — it *changes*
  whenever that server fn (or its dependency graph) changes. A stale id 404/405s. See "Refresh the
  id" below. (During this project it moved from `…09ef…` to `…89ef…` after a code change.)

## Run it
The ready-to-run harness is `scripts/harness.mjs` in this skill dir. Run it from the repo root
(it needs `seroval` and `@tanstack/start-client-core`, which are already project deps):

```bash
node .claude/skills/test-agent-serverfn/scripts/harness.mjs
```

It sends a probe turn to all members and prints each agent's reply. For a **multi-round group
conversation** (the high-value test — target 1 answers, then a different agent jumps in per round),
thread the returned `replies` back in as `history` and enable interjections:

```js
// history is an array of { role, agentId?, text }; append each turn's replies before the next send.
let history = [];
const t1 = await send("am I over budget on dining this month?", history, /*interject*/ true);
history = history.concat({ role: "user", text: "am I over budget on dining this month?" },
                         ...t1.val.replies.map(r => ({ role: "assistant", agentId: r.agentId, text: r.text })));
const t2 = await send("switching gears, what features should we build next?", history, true);
// …3–4 rounds; assert different agentIds lead per round and that a second agent interjects.
```

Set `interject: true` and `maxInterjectors` in the router block to test the "another agent should
jump in with input because it's their domain/memory" behavior. Set `journey.enabled` per-agent if
you're testing `create_huddle_task`'s journey dual-write, and call with a `prioritize`-triggering
prompt (e.g. "what should I prioritize in ventures?") to exercise that tool — but remember the
task-sync mirror is eventually-consistent (see `verify-task-sync`).

## Refresh the id when it 404/405s
The id is baked into the built client bundle. To get the current one:

```bash
# From a local build:
npm run build && grep -roE '"[a-f0-9]{64}"' .output/public/assets/*.js | sort -u
# or grab it from the deployed app's assets and match it to the sendHuddleMessage call site.
```

Update `FN` at the top of `harness.mjs`. If every call 405s regardless of id, re-check the
`x-tsr-serverFn: true` header first — that's the more common cause than a stale id.

## Interpreting results
- **HTTP 200 + decoded `replies`** → working; inspect `agentId`/`text` per reply.
- **HTTP 405** → almost always the missing header, occasionally a stale id.
- **HTTP 500 with a body** → the request *reached* the function; the body (once decoded) usually
  carries the real error. A malformed seroval body also lands here.
- **decodeErr** → the response wasn't valid seroval (often an HTML error page from SWA) — check
  `raw`.

Do not "fix" a failing test by loosening a flag or trap in the runtime — per the repo rules, a
firing trap is signal. Diagnose the root cause.
