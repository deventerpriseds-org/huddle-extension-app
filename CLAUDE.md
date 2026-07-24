# Huddle — working rules

## Agent prompts are ADDITIVE-ONLY (hard rule)

The agents' instruction content is a canonical asset. Do **not** replace, thin, shorten,
or delete existing agent/assistant prompt content without **explicit user approval** for
that specific subtraction.

This applies to all three places agent instructions live:
- **Platform assistants** on OpenAI (edited via `scripts/push-assistant-instructions.ts`).
- **`src/features/huddle/data/openai-assistant-snapshots.json`** — the snapshot the runtime reads.
- **In-repo `p()` personas** in `src/features/huddle/data/agents.ts`.

Rules:
1. The original journey-voice prompts are the best/canonical source — preserve them. When a
   role changes, **layer** the change on top; never overwrite the rich prompt with a thin one.
2. Cross-agent concerns — **house-style/formatting, lane ownership, handoffs** — belong in the
   **shared runtime layer**, not baked into a specific agent's prompt. Change them in one place.
3. Any subtractive prompt edit (removing/replacing content, re-scoping by deletion) requires
   explicit user sign-off first. When in doubt, add — don't cut.
4. **Do not silence flags or error traps to make an issue disappear.** Fix the root cause
   (architecture/design/logic). A firing trap is signal, not noise.

### How agent instructions compose at runtime
Two content sources exist per agent: the **platform snapshot** (rich, canonical) and the
in-repo **`p()` persona** (compact fallback). The role split (who answers what) is enforced by
**routing** (`domains`/`themes`/`special` in `agents.ts`), NOT by prompt text — so restoring a
rich prompt does not change routing. The snapshot is the domain layer; shared house-style and
handoffs are a separate always-appended layer (`SHARED_COORDINATION` in `huddle.functions.ts`).

## Prompt source of truth (code-authoritative)
`src/features/huddle/data/openai-assistant-snapshots.json` is the **authoritative,
git-versioned source** of every agent's instructions. Edit it directly and commit — git
history IS the version record, so a degrading change is reverted with `git revert`/restore.
OpenAI is sunsetting BOTH the Assistants API and reusable Prompt objects (their guidance is to
keep prompts code-managed), and Huddle's runtime is already 100% Responses API reading this
snapshot — so the OpenAI platform `asst_…` objects are legacy and must NOT be treated as the
source of truth. Vector stores (file_search) are separate Files/vector-store API objects and
remain valid.

## FROZEN platform workflows (do not run)
These are disabled (each has a `Frozen — refuse to run` guard) because they would push to or
pull from the deprecated platform objects and could clobber the authoritative snapshot:
`sync-assistants.yml`, `snapshot-refresh.yml`, `provision-assistants.yml`, `revert-assistants.yml`.
To change an agent's instructions, edit the snapshot JSON directly.

## Assistant IDs
`src/features/huddle/data/assistant-ids.json` maps agent → legacy `asst_…` id. Kept for
reference/vector-store bindings; not the prompt source of truth.

## Prioritization & task-sync (how Huddle gets journey tasks)
Huddle scores/prioritizes tasks **supabase-independently** by mirroring journey's tasks into
Huddle's own Azure Postgres and running a ported scoring engine over the mirror. Read this before
touching anything task/priority related — several of these facts are non-obvious and were expensive
to re-derive.

**Pipeline (one-way fan-out, do not add a second writer):**
`create_huddle_task` (or any journey task write) → journey `public.tasks` (**canonical source of
truth**) → a `SECURITY DEFINER` DB trigger `notify_huddle_task_sync` → `pg_net` async HTTP →
journey edge fn `huddle-task-sync` (resolves owner email, adds the shared secret) →
Huddle webhook `POST /api/public/tasks-sync` → **`tasks.journey_tasks`** mirror in Azure PG →
`prioritize(category)` tool reads the mirror.

**Facts that keep getting relearned:**
- **The mirror is a single-writer read-model.** Only the sync trigger writes `tasks.journey_tasks`.
  `create_huddle_task` does **not** write the mirror — it writes journey + renders a UI board card.
  The "Huddle board" is UI state (`suggestedTasks`/`journeyTaskUpdates` in the response), **not** a
  table. Before this mirror there was **no** Huddle task table at all.
- **No duplicates by construction.** The mirror upserts `ON CONFLICT (id) DO UPDATE` keyed on
  journey's task uuid. INSERT→UPDATE→re-fire all update the same row. If you ever add a
  read-your-writes warm-write from `create_huddle_task`, keep it id-keyed so it stays idempotent.
- **The sync is eventually-consistent (`pg_net` is async, ~1–3s lag).** A `prioritize` call
  immediately after a create can miss the just-created row. This is a freshness gap, **not** a bug —
  tests must **poll/retry**, not assume synchronous. A single failed read is usually just timing.
- **Secret discipline (standing rule): reuse `JOURNEY_PROXY_TOKEN`.** It already bridges
  Huddle↔journey and is synced to both Huddle appsettings and journey edge secrets. The webhook auth
  (`x-webhook-secret`) reuses it. **Never mint a new org secret** for this — it clutters org creds.
- **Azure PG access pattern:** model new stores on `src/features/huddle/lib/identity/identity.server.ts`
  — `getPool()`, `AZURE_PG_URL`, `ssl:{rejectUnauthorized:false}`, lazy `ensureBootstrapped()`.
- Ported scoring lives in `src/features/huddle/lib/tasks/scoring.ts`; the tool + dispatch in
  `src/features/huddle/lib/tasks/tools.ts`; mirror store in `.../tasks/tasks.server.ts`; webhook
  route in `src/routes/api/public/tasks-sync.ts`. The journey side (trigger migration + edge fn)
  lives in the **journey-voice** repo — see its CLAUDE.md for the supabase-side facts.

To exercise the pipeline end-to-end, use the **`verify-task-sync`** skill. To live-test agents
(group conversations, routing, tool use) via the server function, use the **`test-agent-serverfn`**
skill — both under `.claude/skills/`.

## Chat memory & context architecture (relearned the hard way — read before touching "memory")
How an agent gets context is TWO separate layers. Confusing them leads to wrong diagnoses.

- **Short-term = per-huddle transcript, isolated.** The zustand store holds ONE global message list,
  but every consumer (and the turn payload) filters by `huddleId`: `HuddleView.tsx` builds `history`
  from `messages.filter(m => m.huddleId === huddle.id)`, and `runHuddleTurn` only ever reads
  `data.history`. Group (`all-members`/`daily`) and 1:1 (`dm-<agentId>`) are **different huddles with
  different histories** — a message typed in the group is NOT in a 1:1's payload. Nothing seeds/copies
  messages across huddles. So history alone can never carry context group→1:1.
- **Cross-huddle bridge = shared RAG memory (Azure pgvector `rag_chunks`).** Every turn auto-writes the
  user message as a `scope='global'` chunk (`huddle.functions.ts`, fire-and-forget). Retrieval filters
  by **scope/agent only — no huddle filter** (`azure-pg.server.ts` `scopeClause`), so a global chunk is
  findable from any huddle. This is the ONLY thing that carries context across conversations.
- **Retrieval is now AUTOMATIC (was model-elected).** Historically memory was reachable only if the
  model chose to call the `search_memory` tool — so a pointed "what were the tasks?" recalled, but
  casual continuity ("two lines ago") often didn't. `runHuddleTurn` now **auto-retrieves** the top
  shared chunks (embed `data.text` once/turn, `searchChunks(mode:"shared", queryVec)`) and injects them
  into the system prompt. The `search_memory` tool remains for deeper lookups. If "it forgot", suspect
  the huddle boundary + whether auto-retrieval ran — NOT a broken store.
- **Memory-DB "vector not allow-listed" is usually a FALSE ALARM.** Azure's `azure.extensions`
  allow-list gate fires on `CREATE EXTENSION IF NOT EXISTS vector` even when vector is already installed
  and the store works — so the Settings "Run bootstrap"/"Verify round-trip" buttons can show red while
  live memory is fine. `BOOTSTRAP_SQL` guards this (swallows the error only if `pg_extension` shows
  vector present). "Saved memory for X (0)" is a per-agent MANUAL-save view; auto-written global chunks
  don't populate it and it is not evidence of an empty store.

## Away-notifications: piggyback journey, don't build a parallel push (standing rule)
journey already delivers push when the user is away via `send_push` (huddle-proxy → `execute-tool` →
`send-push-notification`), dual web-push **+ FCM/Android bridge** — the reliable path to the phone.
Reminders/alarms (`reminders.ts`) and durable-turn reply notifications (`executeClaimedTurn`) route
through it (`invokeJourneyTool({toolName:"send_push", channel:"messages"|"task-reminders"|"calendar_events"})`).
Huddle's own Web Push (`push/push.server.ts`, VAPID) is an OPTIONAL browser-only extra (no-op unless
Huddle VAPID keys are set) — journey's path is what covers the phone, so new away-comms should reuse
`send_push`, not add another sender.

## The canonical Azure DB is PINNED — do not let deploy discovery drift (relearned expensively)
Huddle's Azure Postgres is **`eds-postgresql` / database `RAG_AI_Agents`** (PG 17), in RG
`EnterpriseDS_ResourceGRP`. It holds everything: `public.rag_chunks`/`rag_triples` (memory),
`identity.*`, `tasks.*`, `chat.*`. **Never point the app at `ux-design-pg` (a different app's bare
server whose only DB is the default `postgres`).**

- **How it broke once:** `deploy-swa.yml` assembles `AZURE_PG_URL` from `az` discovery when the
  secret is empty (it is), and it used to take `servers[0]` with no pin + fall back to db `postgres`.
  When `ux-design-pg` was created it started winning discovery, so the app silently switched to
  `ux-design-pg/postgres`. Everything that **auto-bootstraps** (identity/tasks/turns/reminders)
  re-created itself there and looked fine; **memory does NOT auto-bootstrap** (explicit `runBootstrap`
  only), so `rag_chunks`/`rag_triples` never existed there → "relation does not exist" and
  "vector not allow-listed". Data ended up split-brain across the two servers.
- **The fix (in place):** `deploy-swa.yml` + `azure-pg-query.yml` default
  `PG_SERVER_OVERRIDE`→`eds-postgresql`, `PG_DB_OVERRIDE`→`RAG_AI_Agents`. Every deploy now pins there.
- **Ops workflows** (org Azure SP creds; a runner opens a temp firewall rule for data-plane psql):
  `bootstrap-memory-db.yml` (allow-list pgvector + inspect all servers/DBs + confirm the app's DB),
  `migrate-huddle-db.yml` (idempotent consolidation onto `RAG_AI_Agents`), `azure-pg-query.yml`
  (ad-hoc read-only SQL, pinned). `scripts/setup-environment.sh` records these facts + helper commands.
- **Verify the live pointer:** the deploy's "Resolve database connection string" step must log
  `Assembled AZURE_PG_URL for eds-postgresql/RAG_AI_Agents`; or read the SWA app setting `AZURE_PG_URL`.

## Auto-retrieval calibration (two non-obvious gotchas that made memory look broken)
- **Score floor is model-specific.** `searchChunks` returns cosine similarity; `text-embedding-3-large`
  scores real topical matches ~0.4–0.5 (measured: "what is my dog's name?" vs a stored "my dog's name
  is Waffles" = 0.42), NOT the ~0.75+ older models give. The auto-retrieval floor is **0.3**
  (`MEMORY_MIN_SCORE` in `runHuddleTurn`); a higher floor silently drops every real hit.
- **Inject `memoryBlock` on BOTH instruction branches.** The OpenAI Responses path builds
  `baseInstructions` from the assistant snapshot when one exists (all real agents have one) and only
  falls back to `appSystem` when none does. `memoryBlock` must be concatenated into the snapshot branch
  too (`effectiveInstructions + scene + roster + taskToolInstructions + memoryBlock + HOUSE_STYLE`),
  or retrieval runs but never reaches the model. Verify recall with the `test-agent-serverfn` harness
  (RAG on; write a fact in a group huddle, recall it in a different 1:1 with empty history).

## Agent cooperation primitives (lightweight — NOT a workflow engine)
Three coordination helpers in `runHuddleTurn`; scoped to fix real duplicate/handoff/relevance gaps
without an Apollo-style state machine (deliberately not built — see git history / plan notes).
- **Decision rights = per-turn action ledger.** `turnActionLedger` + `claimAction(key)` (declared near
  `createdTaskTitles`): the first responding agent to perform a mutating action owns it; a second
  winner's identical call is a no-op. Guards `schedule_reminder`, `send_email`, `create_email_draft`
  in BOTH the OpenAI and Lovable dispatch paths (tasks already dedup via `createdTaskTitles`). Journey
  proxy tools are intentionally NOT ledgered (they mix reads + writes; ledgering a read would break it).
- **Mention-chain handoff.** When an agent @mentions a teammate, `handoffById.set(id,{fromName,ask})`
  is recorded at the re-queue site; the mentionee gets a `handoffDirective` ("you were handed this,
  address exactly it") in its scene. Ceremonies already carry their own directives; grooming is
  single-agent — this only fills the ad-hoc gap.
- **Role-scoped retrieval.** Auto-retrieval re-ranks the (relevance-floored) memory hits with a small
  lane boost — chunks whose text matches the responding agent's `domains`/`themes`, or that it
  co-authored (`author_agent_ids`), sort first — so each agent surfaces memory relevant to its lane.
  Pure reorder, no SQL change.

## Systematic capability, never a patch (standing principle — the user is firm on this)
Do NOT fix a symptom for one agent/case with a hardcoded string (e.g. "backlog grooming → @terry-locke"
baked into the shared layer). Build the GENERAL capability so it works for EVERY agent/lane/tool, driven
by data in `agents.ts` (roles, domains, ownership) — then PROVE it across the board (multiple ownership
mismatches, both group and 1:1), not just the one case that surfaced it. A one-off patch that only
handles the reported example is a regression against this principle; rework it into the systematic
mechanism. Same spirit as the router rule below (roster-driven, no hardcoded per-agent lists).

### Ownership-aware hand-off = data-driven capabilities (the systematic version)
"Who exclusively owns what" is **data** on the agent, never a hardcoded name. `Agent.capabilities:
AgentCapability[]` (agents.ts) declares each agent's EXCLUSIVE powers (`{id,label,exclusive}`); Terry
owns `backlog-grooming`. Everything reads it through **`lib/capabilities.ts`** (`agentOwnsCapability`,
`exclusiveCapabilities`, `ownerOfCapability`, `ownershipMarker`, `ownershipDirectory`) — the single
source of ownership truth. It flows to three consumers with ZERO per-agent code:
- **Roster** (`buildRoster`) appends each teammate's ` [owns: …]` marker, so every agent learns who to
  hand any exclusive job to. **Router** (`routing.ts`) surfaces the same marker on its roster line and
  its CAPABILITY OWNERSHIP rule keys off `[owns: …]` (not `role === "Scrum master"`).
- **Scope-aware hand-off** (`capabilityHandoffBlock(scope, members)` in huddle.functions.ts, appended
  to every agent's instructions): **group** = the owner just DOES it and reports what/why (no permission
  dance); a non-owner neither attempts it nor files a meta-task, it @mentions the owner. **1:1** = the
  owner isn't in the room, so the addressed agent DEFERS ("Terry's better suited, I'll let him know")
  and @mentions the owner. The grooming hint (`groom.ts`) is split the same way — `GROOM_HANDOFF_DO_HINT`
  (group) vs `GROOM_HANDOFF_CONFIRM_HINT` (1:1).
- **Exclusive-tool gating** (`groom_backlog`) is `agentOwnsCapability(winner,"backlog-grooming")` in
  both dispatch paths, with the legacy `id==="terry-locke" || special==="standup-host"` kept as a
  non-destructive fallback. Add a capability to any agent (or a new agent) → all of the above covers it.
- **Task discipline:** `taskToolInstructions` forbids creating a task that merely restates an action the
  agent was asked to PERFORM (the board is the USER's, not an agent scratchpad). Adding an agents' own
  personal backlog (off the user's board) is the follow-on; 1:1 cross-huddle "message from Terry" plumbing
  (reuse `send_push`) is the other follow-on.
- Domain/theme routing (finance→Finn, travel→Troy, dinner→Charleston, fitness→Flex) is the ROUTER's job
  and is already roster-driven; exclusive *capabilities* are the narrow powers layered on top. Prove with
  `.claude/skills/test-agent-serverfn/scripts/capability-ownership-test.mjs`.

## Routing is the auto-scaling brain — fix multi-agent behavior THERE, not with regex (relearned)
We ALREADY have a router (`src/features/huddle/lib/routing.ts`); do not bolt on hardcoded
agent lists or verb-regexes to steer who responds — they won't keep up as agents are added.
- **Two layers.** `routeMessage` = deterministic keyword/domain scoring (fallback). `routeMessageLLM`
  = the real brain: it's handed the roster **dynamically** (`present.map(...)`) and picks
  `primary + supporting + interjectors` semantically ("intent, not just keywords"). **Adding a new
  agent needs ZERO router code** — it shows up in the roster automatically. `parseMentions` is
  roster-driven too, so `@newagent` works the day you add them. So: extend/tune the LLM router (prompt,
  the trust rules below), never a per-agent hardcoded heuristic.
- **The responder set** = `routed.winners` + `interjectors`, assembled into `queue` at
  `huddle.functions.ts:590`. The mention-chain re-queue (`parseMentions`, huddle.functions.ts:~1984)
  is only a SECONDARY mid-reply path for agent-discovered handoffs.
- **THE BUG that makes "only one agent answers a multi-lane ask" (measured, not theorized).**
  `soloOnCoverage` (routing.ts:381-388) drops **every** supporting agent whenever the primary scores
  ≥0.15 on the topic — including collaborators the USER explicitly asked to pull in. Live proof
  (same message "Sam, sketch GTM; pull in Finn + Tess; Tess loop Cole", via `test-agent-serverfn`):
  - `soloOnCoverage=true` → responders **Sam → Iris** only; router reason even says "Finn can validate
    the financials and Tess can outline the MVP" then tags `[solo]` — i.e. the LLM routed them in and
    the guard cut them.
  - `soloOnCoverage=false` → responders **Sam → Finn → Tess → Iris**. The requested lanes all reply.
  `soloOnCoverage` exists to kill *adjacency* pile-ons (the "fitness Q also pulls in life-strategy"
  annoyance), but it's too blunt: it can't tell an adjacency add from an explicitly-requested one, so it
  suppresses genuine, user-asked multi-agent collaboration. **Fix direction:** make solo only drop
  adjacency (LLM-added, not user-named) supporting agents — e.g. trust the strict-prompt LLM `supporting`
  for explicitly multi-lane requests instead of overriding it with a keyword score. Keep it in the router.
- **Secondary (prose handoff).** Mid-reply, `parseMentions` fires only on a literal `@handle`/`@firstname`.
  When an agent delegates in prose ("I'll get Finn to…", "Tess should…") no re-queue happens. Prefer
  fixing this by prompt (get agents to emit `@handle`) or router intelligence — NOT a hardcoded verb list.

## Reading the live Huddle DB + run logs from a CCR session (the friction, solved)
You CANNOT query Azure PG directly from a CCR session, even though `az` (2.88) and `psql` are
installed: (1) session egress is **HTTPS-only through the agent proxy — TCP 5432 is blocked**
(tested: unreachable); (2) there are **no Azure/PG creds in the session env** (SP secrets are GitHub
org secrets, not here); (3) the PG firewall only admits Azure services + explicitly-added IPs, not the
session. So `az login`/`psql` from here is a dead end — and a "workflow opens the firewall → az/psql
from the session → workflow closes it" loop does NOT help, because the session's own egress blocks
5432 regardless of Azure's firewall. Don't retry it.

- **FASTEST way to read chat messages — the app's `getTurnUpdates` server fn over HTTPS (~1s, no
  workflow).** HTTPS works from the session, so POST the seroval-encoded `{huddleId, sinceMs}` to
  `/_serverFn/<getTurnUpdates id>` (see the `test-agent-serverfn` harness for encode/decode). It returns
  a huddle's recent turns (`status`, `replies`/`result.replies`). Enumerate huddleIds: group =
  `all-members`/`daily`, 1:1 = `dm-<agentId>`. Measured: matched a 90s workflow query in ~300ms–1.5s.
  Use this for "what did the user say / what did the agents reply." (Refresh the fn id from the build if
  it 404s — same content-hash mechanism as the harness.)
- For **arbitrary SQL** (memory `rag_chunks`, `tasks.*`, cross-table joins) the fast path isn't enough —
  use the workflow below.
- **Query the DB via the `azure-pg-query.yml` workflow** (`workflow_dispatch`, input `sql`). A GitHub
  runner logs in with the SP secrets, opens the firewall for its own IP, runs psql, closes it. Pinned
  to `eds-postgresql`/`RAG_AI_Agents`. Dispatch with `mcp__github__actions_run_trigger`.
- **Read the run's output with MCP `get_job_logs`** (`job_id` from `list_workflow_jobs`,
  `return_content:true`). Do NOT download the log zip (`GET /actions/runs/{id}/logs`) — it 302s to blob
  storage that the agent proxy blocks. Poll the run to completion with the tight GH-API bash loop (see
  "Waiting on deploys/CI").
- **Reading a user's chat history:** the real client uses the durable path, so conversations live in
  **`chat.pending_turns`**: `huddle_id` (`all-members`/`daily` = group, `dm-<agentId>` = 1:1),
  `payload->>'text'` = the user message, agent replies in the `replies` column (chunked turns) or
  `result->'replies'` (sync-completed). Every user message is also a `public.rag_chunks` row
  (`source = huddle:<id>`). Filter by recent `updated_at` — the DB is effectively single-user.

## Waiting on deploys/CI: poll for the terminal state, never blind-sleep (user preference)
The user dislikes fixed wait timers — they over-wait and are inefficient. Do NOT `sleep 300` then check.
Instead detect completion the INSTANT it happens with a tight poll that exits on the terminal state, so
the notification fires right away:
- **GitHub Actions is directly pollable from bash** — `GITHUB_TOKEN`/`GH_TOKEN` are in the env, so hit
  the REST API (no `gh` CLI needed): `curl -s -H "Authorization: Bearer $GH_TOKEN" .../actions/runs?per_page=1&branch=<b>` and read `status`/`conclusion`. Wrap it in a background `until`/`while` loop that
  `sleep 15-20` between checks and `break`s on `status=completed` — ONE notification, the moment it lands.
- The MCP `list_workflow_jobs` returns FRESH data; `get_workflow_run` can be cached/stale — prefer the
  direct API poll or `list_workflow_jobs`.
- SWA deploys are server-only here, so the client asset hash does NOT change — do not poll the hash to
  detect a server-code deploy; poll the workflow run state instead.
- Same idea for any external job (CI, remote queue): watch the actual state and exit on terminal, don't
  guess a duration. Reserve `send_later`/scheduled check-ins for genuinely long, detached waits.

## Verifying routing/agents: the loop discipline that matters (hard-won)
Full end-to-end turns are the REAL UAT and are the preferred way to verify — drive the actual flow.
The mistake to avoid is not "using full turns"; it's **blind responsive micro-iteration**: seeing a
result, making a tiny change, re-running the heavy test, repeat — without stopping to ask why.
- **THE RULE: when heavy calls return the SAME result 2–3× in a row, PAUSE and re-analyze.** Stop
  changing code. Form a hypothesis, add instrumentation, and find the ROOT CAUSE before the next edit.
  A run of identical outputs across incremental changes means your change isn't reaching the code path
  — that itself is the signal to investigate, not to tweak again.
- **Instrument to see the truth.** Surfacing `decision.reason` in the response is what finally revealed
  the real cause here: `LLM fallback: OpenAI Responses 429` — the OpenAI account hit
  `insufficient_quota`, so every LLM-router call fell back to keyword routing. The router CODE never
  ran; six rounds of prompt tweaks were chasing the quota fallback (handoff→mention-only,
  multi-lane→solo). Always print `decision.reason` when verifying routing — `LLM router (openai/…)` =
  real; `LLM fallback: …` = the router didn't run (429/quota/error), so the result says nothing about
  your change.
- **Keep a cheap offline inner loop AS WELL.** The winner-assembly is a pure function —
  `assembleWinners()` in `routing.ts` — unit-tested offline with mocked router outputs:
  `bun scripts/router-winners.test.ts` (`npm run test:router`), zero API spend, deterministic. Use it
  to prove the deterministic LOGIC fast, then confirm end-to-end with a few real turns. Offline test
  COMPLEMENTS full-turn UAT; it doesn't replace it. (Run TS offline with `bun`, not `tsx` — importing
  `routing.ts` pulls a transitive `.css` that tsx/node can't load; bun tolerates it.)
- **Fail fast on quota.** On `429`/`insufficient_quota`, STOP — do not retry (each retry burns more),
  and don't interpret any result until quota is restored.

## eds-claude-skills — shared dev-workflow playbooks (USE THESE going forward)
The org repo **`deventerpriseds-org/eds-claude-skills`** carries reusable Claude playbooks that apply
to ALL work in this environment. They are flat `.md` files under `.claude/skills/` (NOT `SKILL.md`
dirs), so they do NOT register as `/slash` Skill-tool entries — they're **reference playbooks to read
and follow**, surfaced to a session by the repo's `setup.sh` (which the CCR environment setup script
should run: it copies them into `/root/.claude/skills/` and appends an overview to the home CLAUDE.md).
Standing habit for future sessions:
- **`define-acceptance-criteria`** — before writing code for any feature/bug/task, extract verifiable
  ACs as a numbered checklist and get sign-off.
- **`verify-work`** — after implementing, map each AC to a concrete test, run it, and report **only
  observed evidence** (drive the real flow, e.g. the `test-agent-serverfn` harness); "should work" is
  banned. Matches this repo's rule that a firing trap is signal, not noise.
- **`setup-environment`** / **`setup-mcp`** — canonical CLI-install and `.mcp.json` recipes; reuse
  instead of re-deriving. All secrets are **org-level** in `deventerpriseds-org` (auto-inherited).
- **`create-github-repo`** — CCR's proxy blocks account-level GitHub API (`POST /orgs/{org}/repos`);
  create repos by triggering the repo's `create-repo.yml` workflow via `actions_run_trigger`, not the API.
To make these permanent across sessions, paste `eds-claude-skills/setup.sh` into the CCR environment
setup script (claude.ai/code → environment → edit → Setup script).

**Working style the user expects (bias to action — relearned):** don't turn every step into a
question. Apply the eds-skills' AC/verify discipline, but tune the ceremony down:
- **Confirm by searching, not by asking.** If a fact is discoverable (repo name, which app a service
  uses, a config value), look it up (`search_repositories`, grep, the `azure-pg-query` workflow) instead
  of asking. Only ask when the answer is a genuine judgment call the code/tools can't settle.
- **Just do the obviously-right, non-destructive step.** Cloning a repo for reference, reading code,
  running a read-only query, adding a tool the user already green-lit — fold it into the plan and do it;
  don't stop for permission on things that can't hurt anything.
- Reserve questions for destructive/irreversible/outward-facing actions or real forks in intent.

## Calendar reads — get_calendar_events via Microsoft Graph (Huddle-native)
Huddle reads the user's Outlook/M365 calendar directly through the **same Graph app** as email
(`email/graph-email.server.ts`, app-only client-credentials). `getGraphCalendarEvents()` calls
`GET /users/{mailbox}/calendarView` and backs the `get_calendar_events` agent tool (wired in both the
OpenAI and Lovable dispatch paths, gated on `graphEmailConfigured()`). Facts:
- Needs the Graph app to hold **`Calendars.Read`** application permission (admin-consented). A 403 from
  calendarView means that consent is missing — that's the thing to grant, not a code bug.
- **Outlook/M365 only.** A Google-only calendar won't appear here — journey holds Google tokens; a
  multi-provider read would go through the `mail-and-appointments` middleware
  (`deventerpriseds-org/mail-and-appointments`, the "mail-watcher" — M365 + Google email/calendar).
- Tasks vs events are different data: `prioritize` (mirror tasks) answers backlog/priorities;
  `get_calendar_events` (Graph) answers "what's on my calendar." Route accordingly.
- Related app for Graph patterns: `deventerpriseds-org/boost-application-packet-platform` ("boost").

## Backlog / known optimizations (surfaced, not yet done)
Ordered roughly by leverage. Revisit once the core turn is reliably fast.
1. **Prompt-payload efficiency via provider prompt caching (high leverage).** Each agent turn sends a
   large prompt (snapshot instructions + house-style + tool schemas + roster + memory + scene), and a
   multi-agent turn sends one PER agent — expensive (input tokens) and slow (bigger prompt = higher,
   higher-variance latency). Do NOT thin the snapshots (they're canonical/additive-only). Instead order
   the prompt as `[stable prefix: snapshot + house-style + tool schemas + roster]` + `[volatile suffix:
   scene + memory + user msg]` and lean on OpenAI automatic prompt caching (prefix-keyed, >1024 tok) so
   repeated/multi-agent sends bill the cached prefix cheaply and return faster — no loss of agent
   quality or flexibility. This both cuts cost and reduces the per-agent tail latency that causes #2.
2. **Per-agent model-call timeout (reliability).** Group-turn wall-time is now `primary + max(wave
   agent)` after the fan-out parallelization; OpenAI per-call latency is high-variance, so one stalled
   agent (~38s) can still drag a wave to the ~45s hosting ceiling and 500. Wrap each agent's
   `callOpenAIResponses`/`generateText` in an AbortController (~30s) → a graceful per-agent fallback,
   bounding worst-case under the ceiling. (Measured post-parallelization: successful 3-agent turns
   ~19–24s, but ~2/4 still 500 at ~46s from tail latency.)
3. **Incremental per-agent reply streaming (NEXT — plan written).** Group-turn wall-time can exceed
   the ~45s hosting ceiling; today parallel fan-out + a 36s turn deadline (`runBounded`) keep it
   crash-free but **defer/DROP** agents under slow-LLM windows (a turn can even return empty). The fix
   is a **resumable, incrementally-persisted turn**: run agents in sub-45s chunks, persist each reply
   the instant it completes (append to `chat.pending_turns.replies`), and continue the turn across
   runner executions (self-kick `/api/public/run-turn`) — so ALL agents reply, streaming in via the
   existing poll, and no agent is ever dropped. Ready-to-execute plan (schema, chunked driver,
   cross-chunk ledger persistence, client incremental render, verification) in
   **`docs/plan-incremental-turn-streaming.md`**. Supersedes the defer/drop path.
4. **Scoring upgrades (deferred from the read-tool work).** Effort term (WSJF "short job first"),
   continuous deadline-urgency curve (EDF/MDD vs the current step function), fix the `after_work`
   window drift (17–22 in scheduling-defaults vs 17–19 in execute-tool `find_open_slots`) and the
   whole-hour truncation, and a capacity guard that flags overcommitment instead of scheduling into
   nonexistent time.
