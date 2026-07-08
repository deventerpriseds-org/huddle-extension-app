# Make the LLM router primary and stop the silent fallback

## Root cause recap

The Cole misroute happened because the LLM router silently threw and the keyword scorer answered. Two reasons it threw:

1. The provider isn't built with `{ structuredOutputs: true }`, so `Output.object` degrades to `json_object` mode on OpenAI. Schema isn't enforced, `output` can come back malformed, `generateText` throws, we swallow it.
2. Even when it didn't throw, we treated it as coequal with the keyword path instead of the source of truth.

## Fix

### 1. LLM router = always primary for group huddles

In `src/features/huddle/lib/huddle.functions.ts`:
- Drop the `useLLMRouter` gate. If `model` exists and `scope === "group"` and there's no explicit `@mention` and no `targetAgentId`, always call `routeMessageLLM`. (1:1 and explicit mentions still short-circuit — those are deterministic by design.)
- Remove the branch that runs the keyword `routeMessage` as an alternate primary path.

### 2. Keyword scorer = pure fallback, loudly logged

In `src/features/huddle/lib/routing.ts` `routeMessageLLM`:
- Keep the `try/catch`, but in `catch` do `console.error("[huddle-router] LLM router failed, using keyword fallback:", err)` and set `decision.reason` to `LLM fallback: <error message>` so the routing panel shows it happened.
- Same treatment if the LLM returns a `primary` that isn't in `memberIds` — log and fall back rather than silently coercing.

### 3. Fix the structured-output drift

Per `ai-sdk-lovable-gateway` guidance: `Output.object` on OpenAI models only enforces the schema when the provider is constructed with `{ structuredOutputs: true }`. Fix in `src/lib/ai-gateway.server.ts` (or wherever `createLovableAiGatewayProvider` builds the OpenAI-compatible provider) — pass `structuredOutputs: true` so `json_schema` mode is used.

Also harden the router schema to match the strict-schema rules from that same knowledge entry: no `.min()`/`.max()`, no length bounds, no long enums, no deep nesting. The current schema (`primary: z.enum(memberIds)`, `supporting: z.array(z.enum(memberIds))`, `reason: z.string()`) is fine on shape but `memberIds` is dynamic per-huddle — that's already allowed, just confirm no bounds are added.

Wrap the call with the documented `NoObjectGeneratedError.isInstance(error)` guard so malformed output surfaces as a router failure (→ logged fallback) rather than a runtime crash.

### 4. Remove the `@charleston-lewis` hardcode

In `src/features/huddle/lib/huddle.functions.ts`, the base agent system prompt appended per-reply currently contains:

```
@mention the right specialist by their handle (e.g. @charleston-lewis) — the mention IS the handoff …
```

Replace with a handle-agnostic instruction, e.g.:

```
If a question is outside your lane, keep it to one short line and @mention the right specialist by their handle — the mention IS the handoff, do not narrate it or say "I'll pass this to".
```

No example handle. This alone kills the "Cole hands off to Charleston for a budget question" chain.

## Out of scope

- Adding `handles`/`notFor` fields to agents (revisit only if the LLM-primary router still misroutes after the structured-output fix).
- Chained-`@mention` cap.
- 1:1 cross-agent handoff.
- Any UI change.

## Files touched

- `src/lib/ai-gateway.server.ts` — pass `structuredOutputs: true` to the OpenAI-compatible provider.
- `src/features/huddle/lib/routing.ts` — loud fallback logging + `NoObjectGeneratedError` guard + membership sanity check.
- `src/features/huddle/lib/huddle.functions.ts` — LLM router unconditional for group, remove `@charleston-lewis` example from base prompt.

## Verification

1. In the group huddle, send "I need to review the budget" → primary is Finn, not Cole. Console shows no `LLM router failed` warning.
2. Temporarily break the model id to force a throw → console shows the loud warning, keyword scorer answers, routing panel `reason` shows `LLM fallback: …`.
3. Send an out-of-lane question in the group → the answering agent hands off with a real specialist handle, never a literal `@charleston-lewis` unless Charleston is genuinely the right pick.
