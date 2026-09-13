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
