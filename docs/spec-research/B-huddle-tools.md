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

---

## 2. Cole Blake's real config — **CONFIRMED (all fields), with one addition**

`src/features/huddle/data/agents.ts:236-253`, verbatim:
```ts
  {
    id: "cole-blake",
    name: "Cole Blake",
    handle: "cole-blake",
    role: "Career coach",
    initials: "CB",
    colorVar: "--agent-indigo",
    domains: ["career", "reviews", "interviews", "growth"],
    themes: ["performance", "resume", "promotion", "1:1", "feedback"],
    tone: "coach",
    voiceId: "o2zd9K5QOO7ppTb04Lx0",
    avatarUrl: "/agents/cole-blake.jpg",
    systemPrompt: p(
      "Cole Blake, the career coach",
      "measured, developmental",
      "you handle career growth, reviews and interviews",
    ),
  },
```

| Spec field | Spec value | Real value | Verdict |
|---|---|---|---|
| `id` | cole-blake | `cole-blake` | **CONFIRMED** |
| `name` | Cole Blake | `Cole Blake` | **CONFIRMED** |
| `role` | (career coach) | `Career coach` | **CONFIRMED** (capital C) |
| `domains` | career, reviews, interviews, growth | identical, same order | **CONFIRMED** |
| `themes` | performance, resume, promotion, 1:1, feedback | identical, same order | **CONFIRMED** |
| `tone` | coach | `coach` | **CONFIRMED** |
| `voiceId` | o2zd9K5QOO7ppTb04Lx0 | `o2zd9K5QOO7ppTb04Lx0` | **CONFIRMED** char-for-char |
| `capabilities` | (not claimed) | **ABSENT — no `capabilities` key** | **NOT-FOUND** |
| `special` | (not claimed) | **ABSENT** | — |

**The important negative:** Cole has **no `capabilities` array**, so
`agentOwnsCapability(cole, …)` returns false for everything today. He owns nothing exclusive.
He also has `handle`, `initials`, `colorVar`, `avatarUrl` and `systemPrompt` — fields the spec
does not mention. `systemPrompt` is the compact `p()` fallback (`agents.ts:74`), **not** the
authoritative instruction source (see §4).

---

## 3. Agent roster — **CONFIRMED: exactly 15**

`AGENTS` array, `src/features/huddle/data/agents.ts:79-360`. Listed in **array order**
(the order the roster is built in), with `id:` line numbers:

| # | line | id | name | role | tone | special |
|---|---|---|---|---|---|---|
| 1 | 80 | `terry-locke` | Terry Locke | Scrum master | direct | — |
| 2 | 110 | `iris-chase` | Iris Chase | Team lead | warm | `coordinator` |
| 3 | 129 | `finn-reid` | Finn Reid | Finance Strategist | direct | — |
| 4 | 147 | `faith-hartley` | Faith Hartley | Family scheduler | warm | — |
| 5 | 165 | `elle-rowan` | Elle Rowan | EMBA planner | coach | — |
| 6 | 183 | `flex-grimes` | Flex Grimes | Fitness coach | coach | — |
| 7 | 201 | `ezra-miles` | Ezra Miles | Errands | direct | — |
| 8 | 219 | `sam-trent` | Sam Trent | Startup planner | direct | — |
| 9 | 237 | `cole-blake` | Cole Blake | Career coach | coach | — |
| 10 | 255 | `charleston-lewis` | Charleston Lewis | Personal chef | warm | — |
| 11 | 273 | `eli-vaughn` | Eli Vaughn | Executive assistant | formal | — |
| 12 | 291 | `liam-kingsley` | Liam Kingsley | Life strategy | coach | — |
| 13 | 308 | `cam-post` | Cam Post | Communications Agent | warm | — |
| 14 | 326 | `troy-lennox` | Troy Lennox | Travel | direct | — |
| 15 | 344 | `tess-sutton` | Tess Sutton | Product owner | wry | — |

**Count = 15 — CONFIRMED.** The `AgentId` union (`agents.ts:9-25`) also has 15 members and the
same set. Note the union lists `tess-sutton` 3rd while the `AGENTS` array places her **last** —
a cosmetic ordering difference, not a missing agent. Only one agent carries `special`
(`iris-chase` = `coordinator`, `agents.ts:120`); no agent is `standup-host` or `queue-owner`
by `special` today, so the `winner.special === "standup-host"` fallback in the grooming gate is
currently dead weight and grooming resolves purely through Terry's capability.

---

## 4. Assistant snapshot for cole-blake — **CONFIRMED, and it is the LONGEST of all 15**

`src/features/huddle/data/openai-assistant-snapshots.json` (38,950 bytes) is a **top-level object
keyed by agent id**, with all 15 agents present. `cole-blake` is one of them.

Measured (`python3 json.load`):

| Field | Value |
|---|---|
| instructions | **1,718 chars / 212 words / 24 lines** |
| `tools` | `[]` (empty) |
| `model` | `o3` |
| other keys | `assistantId, name, model, modelNote, instructions, tools, toolResources, metadata, temperature, topP, responseFormat, fetchedAt` |

**Cole's snapshot is the largest in the file.** Ranked by instruction length:
`cole-blake 1718` > `liam-kingsley 1707` > `elle-rowan 1453` > `eli-vaughn 1431` >
`iris-chase 1332` > `flex-grimes 1177` > `charleston-lewis 949` > `faith-hartley 878` >
`tess-sutton 839` > `terry-locke 810` > `cam-post 773` > `finn-reid 741` > `sam-trent 515` >
`troy-lennox 182` > `ezra-miles 165`.

Opening verbatim:
> You are the user's Career Coach. Your job is to help them land an executive or VP-level role.
> Review resumes, draft cover letters, suggest target companies, and provide behavioral interview
> prep. Focus on executive strategy, accomplishments, and alignment to leadership expectations.
> Track applications and recruiter follow-ups. Work closely with the Life Strategist Agent to align
> goals and timelines.

### How the snapshot actually reaches the model

`huddle.functions.ts:2918`
```ts
        const snapshot = getAssistantSnapshot(winner.id);
```
`huddle.functions.ts:2985-2988`
```ts
        const overrideInstructions = agentBackend.instructionsOverride?.trim();
        const snapshotInstructions = snapshot?.instructions?.trim();
        const effectiveInstructions = overrideInstructions || snapshotInstructions;
        fromSnapshot = !overrideInstructions && !!snapshotInstructions;
```
`huddle.functions.ts:3024-3025`
```ts
        const stableInstructions =
          (effectiveInstructions || winner.systemPrompt) +
```
So the precedence is **`instructionsOverride` > snapshot > `agents.ts` `systemPrompt`**, and the
`p()` prompt in `agents.ts` is only a fallback that Cole never reaches (he has a snapshot).
This is the **OpenAI path only** — the Lovable path at `:4271` uses `appSystem`, not the snapshot:
```ts
        usedInstructions = appSystem + webInstructions;
```

### ⚠️ TENSION WITH THE SPEC — "thin passthrough" would BYPASS the richest prompt in the app

The spec proposes making Cole a **thin passthrough**. Flagging this explicitly:

1. **It discards the most content of any agent.** Cole's 1,718 chars is the single largest
   snapshot in the file. A passthrough that replaces `effectiveInstructions` deletes all of it.
2. **The mechanism to do it exists and is one field** — `agentBackend.instructionsOverride`
   (`huddle.functions.ts:132`, applied at `:2985`). Because `overrideInstructions ||
   snapshotInstructions` short-circuits, **setting the override does not merge with the snapshot,
   it REPLACES it.** There is no additive path through that expression.
3. **Repo `CLAUDE.md` declares agent prompts ADDITIVE-ONLY** — *"Do not replace, thin, shorten, or
   delete existing agent/assistant prompt content without explicit user approval for that specific
   subtraction"*, and names the snapshot JSON as one of the three protected homes. A thin
   passthrough for Cole is precisely a **subtractive prompt edit** and therefore needs explicit
   owner sign-off before it is built — not after.
4. **The additive alternative that respects the rule:** leave the snapshot alone and add the Boost
   capability as a *tool* (§1/§7). Tools are appended to `mergedTools` and their hints are appended
   to `stableInstructions` (see `groomHint` at `:3040`) — the existing extension points are
   additive by construction. Layering a tool on top of Cole's snapshot achieves passthrough
   behaviour without deleting anything.

**Verdict on the spec's premise: PARTLY-TRUE.** Cole *can* be made a passthrough (the field
exists), but doing it via `instructionsOverride` is a subtraction the repo's own hard rule forbids
without sign-off, and the tool route reaches the same outcome additively.

---

## 5. Inbound webhook precedent + outbound pattern — **CONFIRMED, and stronger than the spec claims**

### 5a. Inbound: `src/routes/api/public/tasks-sync.ts` (73 lines) — CONFIRMED

Auth is exactly as the spec says. `tasks-sync.ts:25-31`, verbatim:
```ts
        const secret = process.env.JOURNEY_PROXY_TOKEN;
        if (!secret) return json({ ok: false, error: "not_configured" }, 503);
        if (request.headers.get("x-webhook-secret") !== secret) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
```
- **Header:** `x-webhook-secret`, compared to `process.env.JOURNEY_PROXY_TOKEN`. **CONFIRMED.**
- Missing secret → `503 not_configured`; mismatch → `401 unauthorized`. Fails closed.
- Guards: `MAX_BODY_BYTES = 64_000` (`:13`) → `413`; bad JSON → `400`; missing id → `400`.
- **No Entra/MSAL** — the file's own comment says *"Server-to-server, gated by the existing shared
  secret JOURNEY_PROXY_TOKEN (same secret already bridging the two apps — no new org credential)
  — no Entra."*
- Route id `/api/public/tasks-sync` via TanStack `createFileRoute` (`:21`).

### 5b. Outbound: `invokeJourneyTool` — CONFIRMED, exists and is used in the hot path

`src/features/huddle/lib/journey/proxy.functions.ts:85`
```ts
export async function invokeJourneyTool(
  req: JourneyToolInvocationRequest,
): Promise<JourneyToolInvocationResponse> {
  const res = await journeyFetch("/tool", {
    method: "POST",
    body: JSON.stringify(req),
  });
```
Transport, `proxy.functions.ts:119-131`:
```ts
async function journeyFetch(path: string, init?: RequestInit): Promise<Response> {
  const { url, token, configured } = journeyEnv();
  if (!configured) {
    throw new Error("JOURNEY_PROXY_URL / JOURNEY_PROXY_TOKEN not configured");
  }
  const res = await fetch(url + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-huddle-proxy": "1",
```
Env, `proxy.functions.ts:113-117`: `JOURNEY_PROXY_URL` + `JOURNEY_PROXY_TOKEN`, read **at call
time, never at module scope**. Documented remote surface (`:20-23`):
`GET /health`, `GET /tools`, `POST /tool`.

**Note the auth asymmetry — this matters for anyone copying the pattern:**

| direction | header carrying the secret |
|---|---|
| inbound (journey → Huddle) | `x-webhook-secret: <token>` |
| outbound (Huddle → journey) | `authorization: Bearer <token>` + `x-huddle-proxy: 1` |

**Same secret, different header.** A new integration must pick one and be consistent; they are not
interchangeable in the existing code.

### 5c. "Reusable in reverse" — **CONFIRMED, and there is a better precedent still**

Assessed concretely: yes, and the reuse is cheaper than the spec assumes, because **journey's tool
catalog is fetched DYNAMICALLY at runtime and converted into Huddle tools with no per-tool Huddle
code.** `huddle.functions.ts:836-844`:
```ts
      const { fetchJourneyToolDefinitions, toResponsesTool } =
        await import("./journey/proxy.functions");
      //  - web_search: Huddle uses its own Tavily.
      //  - send_email: Huddle sends via Microsoft Graph (email/graph-email.server).
      const HIDDEN_FROM_HUDDLE = new Set(["web_search", "send_email"]);
      const defs = (await fetchJourneyToolDefinitions()).filter(
        (d) => !HIDDEN_FROM_HUDDLE.has(d.name),
      );
      journeyToolsCache = { defs, tools: defs.map(toResponsesTool) };
```
and — **the decisive detail** — that catalog is already **gated per agent**,
`huddle.functions.ts:3079-3082`:
```ts
        if (agentBackend.journey?.enabled) {
          const cached = await ensureJourneyTools();
          if (cached) {
            journeyTools = cached.tools;
```
`agentBackend` is per-agent config (`:1900`), so `journey.enabled` is already a **per-agent remote
tool-catalog switch**. Huddle therefore has *two* working precedents for a Boost integration:

| approach | Huddle code per new tool | per-agent gating | how Cole-only is expressed |
|---|---|---|---|
| **A. native tool** (like `groom_backlog`) | schema + executor, ×2 backends | `agentOwnsCapability` | capability on `cole-blake` |
| **B. remote catalog** (like journey) | **none** — fetched from `/tools` | `agentBackend.journey.enabled` | a `boost.enabled` flag set only for Cole |

**Assessment: the spec's "reusable in reverse" is CONFIRMED and understated.** A Boost proxy that
serves `GET /tools` + `POST /tool` and accepts a bearer token could be wired by cloning
`proxy.functions.ts` and adding one gated block beside `:3079` — Boost tools would then appear for
Cole alone with **no per-tool Huddle code at all**. The one caveat: the Lovable path builds its own
`lovableTools` map and would need the mirrored block (see §1), and the outbound direction needs
`BOOST_PROXY_URL`/token env vars synced the way `JOURNEY_PROXY_*` already are.

---

## 6. Owner / identity resolution — **CONFIRMED `resolveTaskEmail`; tenant found, and it is NOT Boost's**

### 6a. The turn's email

`huddle.functions.ts:1170-1176` — memoized once per turn, shared by every responding agent:
```ts
  const resolveCallerEmail = async (): Promise<string | null> => {
    if (resolvedCallerEmail !== undefined) return resolvedCallerEmail;
    const { resolveTaskEmail } = await import("./journey/identity");
    resolvedCallerEmail =
      (await resolveTaskEmail(data.caller ?? {})) ?? data.caller?.entra_email ?? null;
    return resolvedCallerEmail;
  };
```
`src/features/huddle/lib/journey/identity.ts:128-138`:
```ts
export async function resolveTaskEmail(caller: Caller): Promise<string | undefined> {
  const { email } = await resolveJourneyIdentity(caller);
  const login = caller?.entra_email?.trim();
  let resolved = email ?? undefined;
  if (!resolved && login) {
    const { resolveCanonicalEmailByLogin } = await import("../identity/identity.server");
    resolved = (await resolveCanonicalEmailByLogin(login)) ?? undefined;
  }
  resolved = resolved ?? login;
  return resolved ? resolved.trim().toLowerCase() : undefined;
}
```
**Resolution order:** journey `whoami` (canonical) → local `profile_emails` map → raw Entra login.
Always lowercased/trimmed. `resolveJourneyIdentity` (`identity.ts:16`) caches per login in-memory
plus a **durable last-known-good** (`getCachedJourneyIdentity`, `:54`) — added because a transient
whoami blip made it fall back to the raw login and scope the same user under a second email
(comment dates it 2026-08-05).

**So Huddle's per-turn owner key is an EMAIL, resolved through journey** — it is *not* the Entra
object id. A separate `entra_object_id` path exists (`identity.ts:59-65`) but its own comment says
it is *"added but not yet consumed; Phase 1 switches stores to key on this."* Anything integrating
today must key on the resolved email.

### 6b. MSAL / Entra tenant — **the exact value**

| var | value | source |
|---|---|---|
| `VITE_ENTRA_TENANT_ID` | **`b9791c7d-dd6c-4190-b1bb-dbbd1996bc2e`** | `.env:2` and `.env.example:9` |
| `VITE_ENTRA_CLIENT_ID` | `59465948-6e95-4124-984e-a43acade2fa9` | `.env:3`, `.env.example:10` |
| `VITE_ENTRA_TENANT_NAME` | `enterpriseds` | `.env.example:8` |
| `VITE_ENTRA_AUTHORITY` | **unset/commented** | `.env.example:11` |

Server-side verification reads the same pair, `src/lib/entra-verify.server.ts:21-23`:
```ts
  const tenantId = process.env.ENTRA_TENANT_ID || process.env.VITE_ENTRA_TENANT_ID;
  if (!tenantId) throw new EntraAuthError("ENTRA_TENANT_ID not configured on server");
  const authority = process.env.ENTRA_AUTHORITY || process.env.VITE_ENTRA_AUTHORITY;
```
`.env.example:2-6` documents the fork: authority **unset ⇒ Entra External ID (CIAM)**; set it to
`https://login.microsoftonline.com/<tenantId>/v2.0` for a workforce authority. Since it is unset,
Huddle runs the **CIAM / External ID** flavour today — `entra-verify.server.ts:2-3` confirms both
issuers are supported.

### 🚩 CROSS-APP FLAG — Huddle and Boost are on DIFFERENT tenants

- **Huddle tenant:** `b9791c7d-dd6c-4190-b1bb-dbbd1996bc2e` (CIAM/External ID, name `enterpriseds`)
- **Boost tenant** (per `boost-application-packet-platform/CLAUDE.md`): `ee633423-c321-413c-a191-ace8b07e4196`

These are **not the same GUID**. Any spec assuming a Huddle Entra token can be presented directly
to a Boost route, or that one MSAL session spans both, is wrong. This is a further argument for the
§5 shared-secret server-to-server pattern (`JOURNEY_PROXY_TOKEN`-style), which sidesteps tenant
identity entirely — exactly what `tasks-sync.ts` says it does (*"no Entra"*).

---

## 7. Capability ownership system — **CONFIRMED, and it IS the right extension point**

`src/features/huddle/lib/capabilities.ts` (265 lines) is the single source of ownership truth,
exactly as repo CLAUDE.md describes. Exports and lines:

| export | line | what it does |
|---|---|---|
| `agentOwnsCapability(agent, capId)` | 210 | the gate used by every tool site |
| `exclusiveCapabilities(members?)` | 215 | all exclusive owners, optionally scoped to a huddle |
| `ownerOfCapability(capId, members?)` | 228 | reverse lookup |
| `capabilityOwnerFor(text)` | 240 | **deterministic** owner resolution from `triggers` substrings |
| `ownershipMarker(agent)` | 251 | ` [owns: …]` roster suffix |
| `ownershipDirectory(members)` | 261 | `- <label> → @<handle>` prompt block |

`capabilities.ts:210-212`:
```ts
export function agentOwnsCapability(agent: Agent | undefined, capId: string): boolean {
  return !!agent?.capabilities?.some((c) => c.id === capId);
}
```

### Does cole-blake own any capability? — **NO. NOT-FOUND.**

`grep -n "capabilities:"` over `agents.ts` returns **exactly one hit: line 88**, inside
`terry-locke`, holding `backlog-grooming`. **No other agent — Cole included — has a `capabilities`
key.** So the system is real, wired, and currently exercised by a single capability on a single
agent. Cole owns nothing exclusive today.

### Is it the right extension point for a Boost tool? — **YES, decisively**

Adding `capabilities: [{ id: "boost-…", exclusive: true, triggers: [...] }]` to `cole-blake` is
**one data edit in `agents.ts`** that automatically propagates to **six** consumers, with no
per-agent code anywhere:

| consumer | file:line | effect of adding the capability |
|---|---|---|
| OpenAI tool catalog | `huddle.functions.ts:2994`, `:3223` | tool offered to Cole only |
| Lovable tool map | `huddle.functions.ts:4904` | same, on the other backend |
| **Voice / Realtime toolset** | `voice/realtime-tools.server.ts:120` | tool available on a live voice call too |
| Roster shown to every agent | `roster.ts:15` (`ownershipMarker`) | teammates learn to hand off to Cole |
| LLM router | `routing.ts:592` (`ownershipMarker`) | routes the ask to Cole |
| Hand-off directive + 1:1 back-channel | `huddle.functions.ts:355`, `:2175-2183`, `:5629` | non-owners defer to Cole; 1:1 asks reach him deterministically |
| Meta-task guard | `huddle.functions.ts:2532`, `:2747` (`capabilityOwnerFor`) | blocks other agents filing a task restating Cole's job |

`voice/realtime-tools.server.ts:120` is the standout:
```ts
  if (agentOwnsCapability(agent, "backlog-grooming")) raw.push(GROOM_BACKLOG_TOOL);
```
— proof this is a **fourth tool site**, and that the capability route is the only one that covers
text *and* voice with a single edit.

### Capability vs. raw tool — the comparison

| | capability-gated tool | raw tool added to `mergedTools` |
|---|---|---|
| Cole-only | yes, by data | only by hardcoding `winner.id === "cole-blake"` |
| Router sends Cole the ask | **yes, automatic** | no — router unaware |
| Other agents hand off to Cole | **yes, automatic** | no — they may attempt it or file a meta-task |
| Works on a voice call | **yes** (`realtime-tools.server.ts:120`) | only if separately added |
| Deterministic 1:1 owner resolution | **yes** via `triggers` | no |
| Violates "no hardcoded per-agent lists" | no | yes |

**Recommendation (grounded in the code, not preference):** use the capability. `agents.ts:29-40`
states the design intent verbatim — *"no agent name is hardcoded anywhere in the runtime… Add a
capability here and it automatically flows into the roster surfaced to every agent, the router's
ownership rule, and the scope-aware hand-off behaviour — for EVERY agent, no per-case code."*
A raw tool would also collide with the org rule *"Systematic capability, never a patch."*

**One caveat to set expectations honestly:** the capability controls *who is offered the tool and
who the ask routes to*. It does **not** register the tool itself. The schema + executor still have
to be added at the sites in §1 (OpenAI ×2 places, Lovable ×1, worker, voice). The capability is the
gate, not the plumbing.

---

## SPEC ERRORS FOUND

| # | Spec claim | Reality | Verdict |
|---|---|---|---|
| 1 | Huddle's per-agent tool execution "not yet inspected / not located" | Fully located — `runAgentTurn` (`huddle.functions.ts:1885`); OpenAI catalog `:3225` + executor `:3263`; Lovable `:4319`; worker `:6239`; voice `realtime-tools.server.ts:113` | **REFUTED** |
| 2 | (implied) two dispatch paths | **FOUR** tool-registration sites, not two — the worker path (`:6239`) and the Realtime voice toolset are both missed by "OpenAI + Lovable" | **PARTLY-TRUE / incomplete** |
| 3 | (implied) no per-agent gating precedent | `groom_backlog` is a complete working precedent for an exclusive single-agent tool (`:2994`, `:3223`, `:4904`, `realtime-tools.server.ts:120`) | **REFUTED** |
| 4 | Cole = domains/themes/tone/voiceId as listed | Every field matches char-for-char | **CONFIRMED** |
| 5 | Roster of 15 | Exactly 15 in `AGENTS` and in the `AgentId` union | **CONFIRMED** |
| 6 | Make Cole a "thin passthrough" | Cole has the **longest** snapshot of all 15 (1,718 chars). `instructionsOverride` **replaces** rather than merges (`:2987` short-circuit), so this is a subtractive prompt edit — which repo CLAUDE.md forbids without explicit owner sign-off | **CONFLICT — needs sign-off** |
| 7 | tasks-sync webhook auth pattern "reusable in reverse" | True, and understated — journey's tool catalog is fetched dynamically and already gated per agent (`:3079`), so a Boost proxy needs ~zero per-tool Huddle code | **CONFIRMED (understated)** |
| 8 | (unstated) shared identity between apps | Huddle tenant `b9791c7d-…` ≠ Boost tenant `ee633423-…`. Different tenants; no shared MSAL session | **NEW RISK — not in spec** |
| 9 | (unstated) Cole owns a capability | Cole has **no** `capabilities` key; `terry-locke` is the only agent with one (`agents.ts:88`) | **NOT-FOUND** |

---

## THE ANSWER TO THE OPEN QUESTION

**Per-agent tool execution lives in ONE closure — `runAgentTurn`, declared inside `runHuddleTurn` at
`src/features/huddle/lib/huddle.functions.ts:1885`.** The responding agent is the local `winner`,
and every per-agent decision keys off it. The reason it reads as "not located" is that the tool
implementations are **not top-level exports** — they are closures over turn state, so they do not
appear in any module's export list.

It forks by backend at **`huddle.functions.ts:2913`** (`if (usedBackend === "openai" && openaiKey)`)
into:

- **OpenAI path — TWO places, and both are required.** Schemas in `mergedTools`
  (`:3225`), executor in `combinedOnToolCall` (`:3263`), handed over at `:4224-4226`, and actually
  invoked by the hop loop at `openai-responses.server.ts:349` (`maxToolHops: 5`).
- **Lovable path — ONE place.** `lovableTools` (`:4319`), where `tool({description, inputSchema,
  execute})` carries schema and implementation together.

**Two more sites the "two paths" framing misses:** `runWorkerTurn`'s own `onToolCall`
(`:6239`, wired `:6332`) for delegated worker runs, and `buildRealtimeToolset`
(`voice/realtime-tools.server.ts:113`) for live voice calls. **A tool is fully wired only when all
four are covered.**

**To give a tool to Cole Blake alone, copy `groom_backlog` exactly:**

1. `agents.ts` — add `capabilities: [{ id: "boost-packet", label: "…", exclusive: true, triggers: [...] }]`
   to the `cole-blake` entry (`agents.ts:237`). *(data only)*
2. `huddle.functions.ts:~2993` — `const ownsBoost = agentOwnsCapability(winner, "boost-packet");`
3. `huddle.functions.ts:~3223` + `:3240` — `const boostTools = ownsBoost ? [BOOST_TOOL] : [];`,
   spread into `mergedTools`; add the matching `if (c.name === "boost_…")` arm at `~:3266`.
4. `huddle.functions.ts:~4901` — mirror the gate, register `lovableTools.boost_… = tool({…})`.
5. *(if voice matters)* `voice/realtime-tools.server.ts:~120` — one more `agentOwnsCapability` line.

That is the whole mechanism. **No new subsystem is needed** — and per "Extend, don't duplicate",
none should be built. If Boost exposes a `GET /tools` + `POST /tool` proxy, the even cheaper route
is to clone `journey/proxy.functions.ts` and add one `agentBackend.boost?.enabled` block beside
`huddle.functions.ts:3079`, which offers a whole remote catalog to Cole alone with no per-tool
Huddle code at all.
