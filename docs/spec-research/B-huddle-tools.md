# B — Huddle per-agent tool execution: ground-truth audit

<!--
WHAT:       Fact-check of a feature spec against the REAL Huddle codebase.
WHY:        The spec says Huddle's per-agent tool execution was "not yet inspected / not located".
            This file locates it precisely, with file:line + verbatim snippets.
EVIDENCE:   repo /home/user/huddle-extension-app @ origin/main 3148bcd
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
-->

**Repo:** `/home/user/huddle-extension-app` — branch `main`, commit `3148bcd`
**Method:** direct source reads. Every claim carries file:line + verbatim snippet.
**Status legend:** CONFIRMED / REFUTED / PARTLY-TRUE / NOT-FOUND

_(written incrementally — sections appear as they are confirmed)_

---

## 1. WHERE DOES A PER-AGENT TOOL CALL EXECUTE? — **LOCATED**

**Spec claim: "not yet inspected / not located" → REFUTED.** Both dispatch paths are located
precisely below. They are two branches of the *same* function.

### The one function that owns it: `runAgentTurn`

`src/features/huddle/lib/huddle.functions.ts:1885`
```ts
const runAgentTurn = async (
```
This is a closure declared *inside* `runHuddleTurn` (`huddle.functions.ts:602`). That nesting is
load-bearing and is the reason the dispatch was hard to find: **the tool implementations are not
top-level exports, they are closures over the turn's state** (`data.caller`, `winner`,
`claimAction`, `createdTaskTitles`, `turnActionLedger`, `recordToolUse`). Any new tool gets that
context for free — and cannot be moved to a separate module without passing it explicitly.

`winner` is the *responding agent* for this invocation. Per-agent behaviour keys off `winner`.

### The backend fork — one line

`huddle.functions.ts:2913`
```ts
      if (usedBackend === "openai" && openaiKey) {
```
`huddle.functions.ts:4264-4265`
```ts
      } else {
        // Lovable AI path (default backend). Wire the SAME native tools the
```
`usedBackend` is seeded per agent from `agentsCfg` (`huddle.functions.ts:1900`):
```ts
    const agentBackend = agentsCfg[nextId] ?? { backend: "lovable" as const };
```
with a key-availability failover at `:2898` (openai→lovable) and `:2907` (lovable→openai).

**Verdict: CONFIRMED — both paths exist, exactly as repo CLAUDE.md says.**

### PATH A — OpenAI (Responses API)

| Piece | file:line |
|---|---|
| Tool **catalog** assembled | `huddle.functions.ts:3225` `const mergedTools = [` |
| Tool **executor** | `huddle.functions.ts:3263` `const combinedOnToolCall = async (c: {` |
| Handed to the model | `huddle.functions.ts:4224-4226` |
| The hop loop that actually invokes it | `src/features/huddle/lib/openai-responses.server.ts:349` |

`huddle.functions.ts:4224`
```ts
          tools: mergedTools.length > 0 ? mergedTools : undefined,
          onToolCall: (c: { name: string; arguments: Record<string, unknown> }) =>
            runToolSafely(c.name, () => combinedOnToolCall(c)),
```
`combinedOnToolCall` is a **flat if/else-if chain on `c.name`** (`:3266` onward):
```ts
          if (c.name === "create_huddle_task") {
            return JSON.stringify(await createSuggestedTaskFromTool(c.arguments));
          }
          ...
          if (c.name === "delegate_to_specialist") {
            return await dispatchDelegate(c.arguments);
          }
```
Execution reaches it from `openai-responses.server.ts:349`:
```ts
        output = await input.onToolCall({ name: tc.name, arguments: args });
```
inside a bounded loop — `maxHops = input.maxToolHops ?? 2` (`:245`), set to `5` at
`huddle.functions.ts:4228` (`maxToolHops: 5`).

### PATH B — Lovable (Vercel AI SDK `generateText`)

| Piece | file:line |
|---|---|
| Path entered | `huddle.functions.ts:4265` |
| Tool **map** (catalog AND executor in one object) | `huddle.functions.ts:4319` `const lovableTools: ToolSet = {};` |
| Example registration | `huddle.functions.ts:4322` `lovableTools.create_huddle_task = tool({` |

The shapes differ and this is the single most important structural fact for anyone adding a tool:

- **OpenAI path = TWO places.** A JSON schema goes into `mergedTools` (`:3225`), and a matching
  `if (c.name === ...)` arm goes into `combinedOnToolCall` (`:3263`). Miss the second and the model
  calls a tool that silently returns nothing.
- **Lovable path = ONE place.** `tool({ description, inputSchema, execute })` carries the schema
  and the implementation together (`:4319`+).

So **a new tool must be added TWICE**, once per path, or it works only on whichever backend that
agent happens to be on. Verified by the existing tools doing exactly that — e.g. `groom_backlog`
appears at `:3223` (+ `:3775` dispatch) and again at `:4908`; `prioritize` at `:3739` and `:4830`.

### >>> HOW TO GIVE A TOOL TO **ONE AGENT ONLY** — the pattern already exists

**This is the spec's key open question, and the codebase already answers it.** `groom_backlog` is
the working precedent for an exclusive, single-agent tool.

**OpenAI path**, `huddle.functions.ts:2993-2996` computes the gate:
```ts
        const ownsGrooming =
          agentOwnsCapability(winner, "backlog-grooming") ||
          winner.id === "terry-locke" ||
          winner.special === "standup-host";
```
then `huddle.functions.ts:3222-3223` conditionally includes the schema:
```ts
        // The scrum master alone gets the backlog-grooming tool (Jira-style triage/assign).
        const groomTools = ownsGrooming ? [(await import("./tasks/groom")).GROOM_BACKLOG_TOOL] : [];
```
spread into the catalog at `:3240` (`...groomTools,`).

**Lovable path**, `huddle.functions.ts:4901-4907` — the mirrored gate:
```ts
        // groom_backlog — gated on the data-driven grooming capability (agents.ts), with the
        // legacy id/special check kept as a non-destructive fallback (mirrors the OpenAI path).
        if (
          agentOwnsCapability(winner, "backlog-grooming") ||
          winner.id === "terry-locke" ||
          winner.special === "standup-host"
        ) {
```

**Recipe for a Cole-only tool (e.g. a Boost tool), 4 edits, no new subsystem:**
1. `src/features/huddle/data/agents.ts` — add a `capabilities` entry to `cole-blake`, e.g.
   `{ id: "boost-packet", label: "…", exclusive: true }`. (Data, not code — see §7.)
2. `huddle.functions.ts` ~`:2993` — `const ownsBoost = agentOwnsCapability(winner, "boost-packet");`
3. `huddle.functions.ts` ~`:3223` + `:3240` — `const boostTools = ownsBoost ? [BOOST_TOOL] : [];`
   and spread it into `mergedTools`; add an `if (c.name === "boost_…")` arm in
   `combinedOnToolCall` (~`:3266`).
4. `huddle.functions.ts` ~`:4901` — mirror with `if (ownsBoost) { lovableTools.boost_… = tool({…}) }`.

Gating on `winner.id === "cole-blake"` alone would also work and is used as the legacy fallback,
but the capability route is the one the codebase has standardised on (§7).

**Third dispatch site (do not miss it):** `runWorkerTurn` has its *own* `onToolCall` at
`huddle.functions.ts:6239`, wired at `:6332`. Delegated "worker" runs go through that, not through
`combinedOnToolCall`. A tool added only to `runAgentTurn` is absent from worker runs.
