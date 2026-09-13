# VERIFY topic-tree-categories — loop 1

WHAT:       Independent adversarial verification of the topic-tree/category change deployed at huddle origin/main 1a9be2b.
WHY:        Claims made by the implementing session are unverified until observed. No shared context with that session.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   commands + file:line + live SQL recorded inline below.

Verifier start: 2026-09-13T15:48:32Z. Budget 25 min.
Baseline: huddle-extension-app local HEAD d3cbe63 (origin/main 1a9be2b + docs commit). journey-voice origin/main c7491b1, checked-out branch claude/journey-widgets-in-chat.

---

## C1 — journey web + Android bridge read `task_topic_index` DIRECTLY over PostgREST with USER credentials, not via `execute-tool`

**CONFIRMED.**

journey web (`/home/user/journey-voice/src/pages/Priorities.tsx:222`), inside `loadData`:
```
supabase.from('task_topic_index').select('*').eq('user_id', user.id),
```
That `supabase` is the browser client from `src/integrations/supabase/client.ts`, created with
`SUPABASE_PUBLISHABLE_KEY` (a JWT whose payload decodes to `"role":"anon"`) plus a localStorage-persisted
session (`STORAGE_KEY = sb-wwxgajrtmslzklnyplah-auth-token`) — i.e. the signed-in user's own credentials,
RLS-scoped. `supabase.from(...)` is PostgREST, not an edge function. No `execute-tool` appears on this path.

Other direct user-credential writes/reads on the same table in journey web, confirming the pattern is
table-level and not tool-mediated:
- `src/components/priorities/AddTopicGroupDialog.tsx:49` — `.upsert(`
- `src/components/priorities/TopicGroupPanel.tsx:53` — `.delete().eq('id', ...)`
- `src/pages/Priorities.tsx:531` — `.update({ position: i })`
- `src/pages/Priorities.tsx:592` — `.update({ category_affinity: dstCatKey })`

Android bridge (`/home/user/android-bridge-template/app/src/main/java/com/bridgetemplate/util/SupabaseTaskClient.kt:216-221`), `getPriorityGroups`:
```
val (supabaseUrl, anonKey, accessToken, userId) = credsWithUser(context) ?: return null
appendLog(context, "FETCH task_topic_index groups")
return getArray(
    "$supabaseUrl/rest/v1/task_topic_index?select=id,topic_name,position,category_affinity,parent_topic_id,window_affinity&user_id=eq.$userId&order=position.asc",
    anonKey, accessToken, context
)
```
`/rest/v1/` is PostgREST. Headers set at `SupabaseTaskClient.kt:44-45`:
`apikey: $anonKey` + `Authorization: Bearer $accessToken`, where `accessToken` is read at line 27 from
`EncryptedPrefs.get(context, "supabase_access_token")` — the signed-in user's session token, not a service
role key and not a shared secret. `grep -rn SERVICE_ROLE --include=*.kt` over the repo: no hits.
Note the Android select list explicitly includes `id`, `category_affinity` and `parent_topic_id` — the exact
columns a tree needs (relevant to C3).

---

## C2 — Huddle cannot use that route (shared-secret proxy credential only, no journey user session)

**CONFIRMED.**

Huddle's only journey egress is `journeyFetch` in
`/home/user/huddle-extension-app/src/features/huddle/lib/journey/proxy.functions.ts:35-46`:
```
const token = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();     // :31
const res = await fetch(url + path, { headers: { authorization: `Bearer ${token}`, "x-huddle-proxy": "1" }, ... })
```
`JOURNEY_PROXY_URL` is documented at `:17` as `https://<journey-project>.supabase.co/functions/v1/huddle-proxy`.
Only three paths are ever requested: `"/tools"` (`:65`), `"/tool"` (`:110`), `"/health"` (`:158`).
`invokeJourneyTool` (`:107`) takes `toolName: z.string().min(1)` (`:202`) — a NAMED tool, nothing else.

The proxy's own surface (`/home/user/journey-voice/supabase/functions/huddle-proxy/index.ts`) is exactly
those three routes and no more:
- `:128-133` shared-token gate: `token !== PROXY_TOKEN → 401`. That is the ONLY credential Huddle presents.
- `:137` `GET …/health`, `:146` `GET …/tools`, `:151` `POST …/tool`.
- `:154-157` `POST /tool` requires `toolName`; `:197-206` delegates to `${SUPABASE_URL}/functions/v1/execute-tool`
  with `{ toolName, args, ... }`.
There is no table/PostgREST/SQL passthrough route. The user identity is resolved SERVER-SIDE inside the proxy
(`resolveUserId(supabase, caller)` with `SUPABASE_SERVICE_KEY`, `:158-159`) from the caller's email — Huddle
never holds a journey user session token.

Disconfirming check run: `grep -rn "wwxgajrtmslzklnyplah|SUPABASE_ANON|SUPABASE_SERVICE_ROLE|supabase.co/rest"`
over all of huddle `src/` returns exactly ONE hit, and it is a prose comment
(`src/features/huddle/lib/tasks/widgets.server.ts:525`), not a credential or a request. So there is no second
route into journey's database from Huddle.

---

## C3 — `get_task_topics` is NOT a duplicate of the `topic_groups` returned by `get_tasks`/`get_today_tasks`

**CONFIRMED — but the cited reason is one detail wrong; correction below.**

Read from journey `origin/main:supabase/functions/_shared/call-context-builder.ts` (not the working tree):

- `getTopicGroupsManual` is declared at line **204** and its last statement is line **272**:
  `return results.slice(0, 5);` — a hard top-5 cap. CONFIRMED as cited.
- The object it returns (lines 251-266) has exactly six fields:
  `topic_name, topic_summary, position, task_count, recency, priority_density`.
  No `id`, no `category_affinity`, no `parent_topic_id`. So the payload is structurally incapable of
  expressing a tree — no node identity and no parent edge to link on.
- `formatTopicGroups` (line 277) renders it as `"1. <name> (<n> tasks)"` — a flat numbered voice summary.

**CORRECTION to the claim's stated reason.** The claim says it "selects neither `id` nor
`category_affinity`". `id` IS selected from the table, at line 236:
```
.from('task_topic_index').select('id, topic_name, topic_summary, position')
```
— it is needed for the `topicTaskMap` join. What is true is that `id` is not *returned* to the caller, and
`category_affinity` / `parent_topic_id` are neither selected NOR returned. The conclusion (not a duplicate)
holds on stronger evidence than the claim gave; the wording of the reason is inaccurate about `id`.

---

## C4 — live journey data: `parent_topic_id` NULL on every row; 5 distinct `category_affinity`

**CONFIRMED**, with a caveat that matters for C6.

`mcp__Supabase__execute_sql`, project `wwxgajrtmslzklnyplah`, read-only:
```sql
SELECT count(*) total_rows, count(parent_topic_id) rows_with_parent,
       count(*) FILTER (WHERE parent_topic_id IS NULL) rows_parent_null,
       count(DISTINCT category_affinity) distinct_category_affinity,
       count(*) FILTER (WHERE category_affinity IS NULL) rows_category_null
FROM public.task_topic_index;
```
→ `{"total_rows":158,"rows_with_parent":0,"rows_parent_null":158,"distinct_category_affinity":5,"rows_category_null":0}`

So: 158 rows, **zero** have a parent, **five** distinct category values, **zero** null categories.

The five values are NOT the five display categories:
```sql
SELECT category_affinity, count(*) FROM public.task_topic_index GROUP BY 1 ORDER BY 2 DESC;
```
→ `LIFE 60, VENTURES 50, PROF_EDUCATION 24, CAREER 13, EDUCATION 11`

**Caveat (verifier's own observation, not in any claim):** `PERSONAL` and `FAMILY` have **zero** rows in live
data today. Under the C6 merge rules (`PROF_EDUCATION→EDUCATION`), today's live data collapses to **four**
occupied display rows — Life & Personal, Ventures, Education, Career — not five. FAMILY is a display category
with no live data behind it. Any claim of "5 categories on screen" is a claim about the CODE's category list,
not about what today's data produces.
