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
- The request/response bodies are **seroval-encoded**, not plain JSON. Encode the payload with
  `toJSONAsync` using seroval plugins; hand-rolling a JSON body gets a 500.
- **Getting the plugins standalone:** `getDefaultSerovalPlugins()` from `@tanstack/start-client-core`
  requires the Start **server** runtime (AsyncLocalStorage) and throws when run as a plain Node
  script. It just returns `[...customSerializationAdapters.map(makeSerovalPlugin), ...defaultSerovalPlugins]`,
  and Huddle registers **no** custom serialization adapters — so import `defaultSerovalPlugins`
  straight from `@tanstack/router-core` and use that. (If the app ever adds custom adapters, mirror
  them.)
- **Decoding the reply:** the stock `fromJSON` needs the server's exact plugin set and throws on
  constant nodes we don't register. The harness instead **walks the node graph itself**
  (0=number, 1=string, 2=constant, 7=reference, 9=array, 10/11=object) and unwraps the
  `{ result, error, context }` transport envelope. Robust and dependency-light.
- **History shape:** threaded `history` items must match the server's `HuddleMessage` zod schema —
  `{ id, huddleId, author: {kind:"user"} | {kind:"agent", agentId}, text, ts }`. A bare
  `{role, text}` fails validation (`history[0].id Required`).
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

The harness runs a **multi-round group conversation** out of the box (the high-value test — a
different specialist should lead each round, and a second agent should interject when it's their
domain). It threads each round's `replies` back as properly-shaped `HuddleMessage` history and turns
on interjections. Edit the `TURNS` array to match what you're verifying. A known-good run:

| round | prompt | expected lead |
|---|---|---|
| 1 | "am I over budget on dining this month?" | Finn (finance) |
| 2 | "what features should we build next?" | Tess (product owner) |
| 3 | "how would we pitch that to seed investors?" | Sam (startup planner) |
| 4 | "let's run a quick retro on the sprint" | Terry (scrum master) |

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
