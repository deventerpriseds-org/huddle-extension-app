# VERIFY-subcategories-1 — Category -> Topic -> Task (huddle#71 65005a1, journey-voice#42 4dec778)

<!--
WHAT:       Independent verifier report for the sub-categories change (Category -> Topic -> Task).
WHY:        Owner asked for topics between category and task, matching his Android widget; the implementer
            only checked Career (8). This pass checks every category on real data and attacks the mechanism.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; commands and outputs quoted inline.
-->

Verifier: independent subagent, isolated worktree, branch `verify/subcategories-1` (based on 65005a1).
Written incrementally; each verdict appended when reached.

## Claim 6 — no regressions (tests, tsc, build) — PASS

Run in worktree at 65005a1 (node_modules symlinked from main checkout; package.json unchanged vs f4f2af5).

| suite | result |
|---|---|
| test:category-tree | 34 passed, 0 failed |
| test:category-tree-independent | 25 passed, 0 failed |
| test:widget-topics | 20 passed, 0 failed |
| test:widget-park | 10 passed, 0 failed |
| test:widget-live | 12 passed, 0 failed |
| test:widget-colors | 25 passed, 0 failed |
| test:widget-band-color | 21 passed, 0 failed |
| test:week-order | 9 passed, 0 failed |
| test:priority-lane | 9 passed, 0 failed |
| test:priority-check | 20 passed, 0 failed |
| test:schedule-brief | 21 passed, 0 failed |
| test:router | 20 passed, 0 failed |
| test:standup-ranking | 13 passed, 0 failed |
| test:blocked | 21/21 passed |
| test:assign-on-create | ALL PASS |
| `npx tsc --noEmit` | rc=0, no output |
| `npm run build` | rc=0 (nitro "You can preview this build") |

## Claim 1 — real data, every category vs the Android rule — FAIL as stated ("matches his phone for every category")

**Data pulled (2026-10-15 ~17:05Z):**
- journey (Supabase `wwxgajrtmslzklnyplah`, owner `a3378f93-…`): 169 topics (74 `archived_at` set, 3 `merged_into` set, 0 with parent, 112 at position 0, 20 distinct positions), 369 owner links (374 links in the whole table; 2 users own topics), 432 tasks (103 not DONE, 101 not DONE/BLOCKED).
- Huddle mirror (`azure-pg-query.yml` run 38774084536, job 116557091198): 366 rows, all `dev@enterpriseds.io`; 0 open journey tasks absent from the mirror.
- Payload built with exactly the field set of 4dec778's `getTaskTopics`, round-tripped through `JSON.stringify/parse` as the proxy does, fed to the REAL `buildPrioritiesTree` (65005a1) with bun. Android computed from `PrioritiesWidgetFactory.rebuildItems` + `SupabaseTaskClient.getTasksForTopics` (android-bridge-template): topic category = `category_affinity ?: window_affinity[0]`, normalised PERSONAL->LIFE / PROF_EDUCATION->EDUCATION; tasks via mappings, `topicByTask` last-wins; `status not in (DONE,BLOCKED)`; no completed_at or tag filter.
- Script: scratchpad `compare.ts`; full output reproduced in the table below.

| Category | Android | Huddle | topics A / H | Divergences (each explained) |
|---|---|---|---|---|
| Life & Personal | 18 | 14 | 53 / 53 | -4 parking-lot (Financial Mgmt x4; Application Development 1 is parked AND has completed_at); -1 `completed_at` set (Academic Communication "Email AI professor"); +1 STATUS DRIFT ("Accept my DBA financial aid": mirror UP_NEXT, journey DONE); +1 unlinked ("Test task #1" under category directly) |
| Career | 8 | 8 | 13 / 13 | total equal ONLY BY CANCELLATION: Career Development A=2 H=3 (+1 BLOCKED "Schedule Trinnex interview"); Fractional CTO Services A=1 H=blank (-1 parking-lot "Research CTOx Fractional CTO Launchpad") |
| Ventures | 66 | 55 | 68 / 68 | -11 parking-lot (10 topics go blank); -2 `completed_at` set (archived topics Application Development Projects, Business Partnerships); multi-topic task "Prepare an inspections records database" under Database Management in Huddle vs Inspection Records Management on Android (last-wins); +1 unlinked ("Test cross-app memory for Nexus webapp") |
| Education | 6 | 6 | 35 / 35 | equal ONLY BY CANCELLATION: Educational Resource Mgmt +1 BLOCKED ("Upload video for case- GROW"); MIT Assignments A=2 H=1 (-1 `completed_at` set, "Complete 2 MIT assignments", status UP_NEXT) |
| Family | 0 (header drawn, blank) | ABSENT | 0 / 0 | Huddle draws no Family row at all; the phone draws one |

UNEXPLAINED divergences: 0. Every gap is one of the causes below.

**Findings beyond the brief's known intended differences:**
- **F1 — `completed_at` rule (NOT a listed intended difference).** `isOpen` (widgets.server.ts:285-288) drops any row with `completed_at` set even when status is live. 6 mirror rows have `completed_at` set with a non-DONE status; 5 of them sit under topics on the phone. One is live work: "Complete 2 MIT assignments", UP_NEXT, completed_at 2026-09-13, so Huddle hides it and the phone shows it. The rule pre-dates 65005a1, but it now causes per-topic mismatches against the phone.
- **F2 — the Career 8 and Education 6 matches are coincidences.** Each total equals the phone's only because a +1 (BLOCKED kept) cancels a -1 (parked or completed_at). Per topic, Huddle shows "Career Development 3" where the phone shows 2, and a blank "Fractional CTO Services" where the phone shows 1. The commit's "reproduces his phone's Career 8 exactly, across the same 13 topics" is true for the category total and false for the topic rows.
- **F3 — mirror status drift.** "Accept my DBA financial aid" (ee2ad17a) is DONE in journey and UP_NEXT in the mirror, so Huddle shows a finished task under Life / Financial Management. This is a sync defect, not caused by this PR, but it shows on the new surface.
- **F4 — multi-topic placement.** 1 task. Huddle uses the smallest topic id (Database Management); the phone's last-wins pick depends on row order (Inspection Records Management in this dump's order). The commit declares this difference, but the brief's list of intended differences omits it.
- **F5 — topic ORDER differs from the phone.** 112/169 topics tie at position 0. Huddle breaks ties by name (`sortNodes`). Career renders as AI Workflow Management, Career Development, Career Development Tasks, … Presentation Development, … Career Tools Integration[p1]. The phone screenshot starts Presentation Development, Grooming Management, Fractional CTO Services, … (journey's untie-broken row order). Huddle's order is deterministic: a reversed payload produced an identical tree (`order.ts`; and `compare.ts`: "two builds JSON-identical = true"). It does not match the phone.
- **F6 — Family row absent.** The phone always draws the five configured categories. Huddle creates a category only when tasks or topics claim it. This is pre-existing and still not fixed.
- **F7 — archived topics render.** 74 archived topics are returned and rendered, mostly as blank rows. That matches the phone (Android does not filter `archived_at` either), so it is parity, but the tree carries 169 topic rows.
- Known intended differences, confirmed present: BLOCKED kept (2 rows), parking-lot excluded (16 rows), unlinked shown under own category (2 rows).

**Adversarial: category chip vs placement.** The tree row (`TopicTaskRow`, JourneyWidgets.tsx:769-794) renders NO category chip, so a tree row cannot contradict itself visually. 4 live rows are filed under a category other than their own `category`: "Debug the WIP autowork in Huddle" (CAREER, under LIFE/Application Development), "Fix the Nexus assignments section" (CAREER, under EDUCATION/MIT Assignments), "Set up payment plan for DBA balance" (VENTURES, under EDUCATION/DBA Course Management), "Accept my DBA financial aid" (EDUCATION, under LIFE/Financial Management). Two of them are STARRED (is_priority, rank 18 and 20). The This Week band (`PriorityRow` -> `<CategoryChip category={row.category}/>`, JourneyWidgets.tsx:647) shows them with a **CAREER chip** while the tree files them under Life and Education. The serialized payload the agent reads also carries `category: "CAREER"` on a row nested under `category:EDUCATION`. **Contradiction confirmed between the band chip and the tree placement, and inside the agent-facing JSON.** The contradiction does not appear on the tree row itself.

## Claim 2 — journey `get_task_topics` returns `{topics, mappings}` scoped to the caller — PASS on mechanism (code + docs + SQL equivalent + CI); runtime evidence follows in the LIVE section

- **Shape.** 4dec778 (read with `gh api …/commits/4dec778`) returns `{success:true, result:{topics, mappings}, message}`. huddle-proxy (`supabase/functions/huddle-proxy/index.ts:221-229`, journey main) forwards `result` as `output: JSON.stringify(payload)`. Huddle parses that string (`fetchTopicPayload`), and `findTopicArray`/`findTopicMappings` read `.topics`/`.mappings`. `mappings` is re-mapped to `{task_id, topic_id}` only, so the embedded join object is dropped.
- **Topic fields** (`id, topic_name, position, category_affinity, window_affinity, parent_topic_id`) are identical to the Android `getPriorityGroups` select (SupabaseTaskClient.kt:219). Neither filters `archived_at` or `merged_into`, so the two sides are at parity.
- **Embedded filter syntax.** The Supabase docs (search_docs: "Joins and Nesting -> Filtering using joined fields") give this exact pattern: `.select('id, name, orchestral_sections!inner(id, name)').eq('orchestral_sections.name', 'woodwinds')`, many-to-one from the child table with `!inner`. They also state that without `!inner` the parent rows are NOT filtered. The code uses `!inner`. That makes it valid PostgREST syntax, and it restricts the rows rather than only nulling the embed.
- **FK exists and is unambiguous.** From `pg_constraint`: `task_topic_mappings_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES task_topic_index(id) ON DELETE CASCADE`. It is the ONLY FK from mappings to task_topic_index, so the embed cannot be ambiguous (the PGRST201 case).
- **Leak check (SQL-equivalent).** The whole table holds 374 mappings, and task_topic_index holds 179 rows (169 owner + 10 other user, per `Rows Removed by Filter: 10`). The inner-join filter for the owner returns exactly 369 rows, so the other user's 5 links are excluded. EXPLAIN ANALYZE: Hash Join, 0.341 ms execution.
- **Service role.** execute-tool creates its client with `SUPABASE_SERVICE_KEY` (index.ts:2855), so RLS does NOT apply and the filter is the only scope. The filter is present on both reads. `userId` comes from huddle-proxy's `resolveUserId(caller.entra_email)`, the same path every other proxied tool uses.
- **No ordering on mappings.** This is harmless, because `findTopicMappings` is order-independent (min topic id).
- **CI.** PR #42's only check, `parse` (Parse Edge Functions, `.github/workflows/parse-edge-functions.yml`), ran on head `4dec7781…` with conclusion success. Log: "Parsed 51 edge function(s); 0 failed."
- **Unknown-tool phrase.** Before the deploy, execute-tool's default case returned `error: "Unknown tool: ${toolName}"` (index.ts:460-464), which contains "unknown tool", so it is classified `tool-absent`.

## Claim 3 — until journey deploys, Huddle renders exactly what it renders today — PARTIAL FAIL

Driven offline through the REAL `composePrioritiesWidget`, with `tasks.server` mocked to return the owner's 366 real mirror rows and the journey proxy mocked to return execute-tool's real unknown-tool error (bun `mock.module`, scratchpad `claim3.test.ts`, 8 pass):
- **Roots: byte-identical.** `JSON.stringify(composed.topics.roots) === JSON.stringify(mergeTopicTree([], buildCategoryTaskTree(rows)))` on the real rows. PASS.
- **Docked widget / Priorities view (`getPrioritiesWidget`).** Before the change it already returned `{ok:false, reason:"tool-absent"}` with the merged roots. After the change it returns `{"ok":false,"reason":"tool-absent","error":"Unknown tool: get_task_topics"}` with identical roots. The banner was already shown, so the render is IDENTICAL. PASS.
- **Agent-tool card (`dispatchPrioritiesWidget`, used by Iris's 6am/8pm priority check).** NOT identical. Before (main f4f2af5, tools.ts called `composePrioritiesWidget(userEmail, tz)` with no caller) it got `{"ok":true,"reason":"ok"}`: no banner. After, it passes `caller`, so it gets `{"ok":false,"reason":"tool-absent"}`. `JourneyWidgets.tsx:932` `{data.topics.reason !== "ok" && <TopicsEmpty/>}` therefore ADDS the "Sub-themes within each category aren't available yet …" banner to the in-chat card, and the card now waits for a journey round-trip it did not make before. This is arguably more honest, but it is a visible change, so "renders EXACTLY what it renders today" is false for this surface. It only applies to the window before journey#42 deploys (it has now been merged and deployed, per the coordinator).
- **Is the `tool-absent` classification still right after the move?** Yes. The phrase list in `fetchTopicPayload` (widgets.server.ts) matches the deleted `fetchTopicTree` one for one: unknown / unsupported / no such tool / tool not found / not implemented. A mocked `{ok:false, error:"Unknown tool: get_task_topics"}` produced `reason:"tool-absent"`, and a thrown "…not configured" produced `not-configured`.

## Claim 4 — fetchTopicPayload is bounded and never throws — PASS with one theoretical gap

- **Timeout.** With a never-resolving proxy and a 150 ms ceiling it resolved `{"ok":false,"reason":"error","error":"journey topic tree timed out after 150ms"}` in 151 ms.
- **Timer cleared.** Ran with no journey env and a 60 000 ms ceiling, as a standalone `bun` process (scratchpad `timer.sh`). It resolved `not-configured` in 52 ms and the process EXITED at wall 72 ms. A leaked ref'd 60 s timer would have held the process open for 60 s, so the `finally { clearTimeout }` is effective.
- **Rejection.** A proxy that throws `Error("socket hang up")` resolved `{ok:false, reason:"error"}`. `call` is an async IIFE whose body is entirely inside try/catch (the dynamic import included), so it cannot reject on an Error. `timeout` only ever resolves. So `Promise.race` cannot reject on any Error-shaped failure.
- **Theoretical gap.** A thrown non-Error whose `toString()` itself throws escapes: `String(err)` inside the catch re-throws, and `fetchTopicPayload` rejected with "evil". That is contrived: `invokeJourneyTool` only throws via `fetch`/`journeyFetch` Errors. Even then `dispatchPrioritiesWidget` (tools.ts:282-310) and `getPrioritiesWidget` both wrap the call in try/catch, so an agent turn would get `priorities_widget_failed`, not a hang.
- **Not aborted.** `journeyFetch` passes no AbortSignal (proxy.functions.ts:35-50), so after the 4 s ceiling the HTTP request keeps running in the background. The turn is not blocked, but the request is not cancelled either.
- **Is 4 s sound?** Supabase `function_edge_logs`, last 24 h: `huddle-proxy/tool` n=45, p50 526 ms, p95 2191 ms, **max 6972 ms**; `execute-tool` n=18, p50 271 ms, p95 2391 ms, max 6531 ms. The DB work for this tool is ~0.3 ms (EXPLAIN ANALYZE). So 4 s covers p95 with headroom, and cold-start tails (~7 s observed) will degrade to the category-only tree rather than stall. Payload size: 72 276 bytes of JSON (79 271 with the proxy envelope) for 169 topics + 369 links. The Huddle->journey network leg cannot be measured from this sandbox (the SWA host is egress-blocked here).

## Claim 5 — no surface builds its own payload; `fetchTopicTree` has no caller — PASS, with one guard gap

- `grep -rn fetchTopicTree` over all .ts/.tsx/.mjs/.js outside node_modules and .output finds ONLY two stale COMMENTS: widgets.server.ts:815 and :905. There is no call site. `composePrioritiesWidget` callers: tools.ts:294 and widgets.functions.ts:133. No file outside widgets.server.ts calls `buildPrioritiesTree`, `buildCategoryTaskTree` or `mergeTopicTree`.
- **Guard gap.** The allowlist guard (scripts/category-tree.test.ts:404-437) keys ONLY on `buildPrioritiesBand(`. A new surface that called `buildPrioritiesTree`/`buildCategoryTaskTree` directly (building its own TREE) or invoked `get_task_topics` itself would pass the guard. Today that is not happening (grep above).
- **Stale comments** that still describe the pre-deploy world: widgets.server.ts:106 ("`get_task_topics` is not deployed (not on `main`, not in any open PR…)"), :118, :814-816 ("REJECTED as unavailable"), :905 (`fetchTopicTree` returns `roots: []`), and JourneyWidgets.tsx:798. This is documentation drift, not behaviour.

## Mutation proofs (mutate.sh, anchors from files in scratchpad `mut/`)

| # | Mutation (file) | Test / label | Outcome |
|---|---|---|---|
| m1 | add a rogue `buildPrioritiesBand(` call in tools.ts | category-tree / "no surface builds its own priorities payload" | **FIRED** |
| m2 | drop `?? firstWindowAffinity(o)` in toTopicNode | "filed by its first window_affinity" | **FIRED** |
| m3 | multi-topic placement last-wins instead of min id | "the same one on every read" | **FIRED** |
| m4 | drop `!node.id.startsWith(CATEGORY_ROOT_PREFIX)` attach guard | category-tree + independent + widget-topics / "SUB-CATEGORIES" | **INERT / EQUIVALENT**. No real journey id starts with `category:` (uuids), so the guard is unreachable on real data and has no fixture. Unproven, not broken. |
| m5 | drop `|| isParked(r)` in buildPrioritiesTree | "SUB-CATEGORIES" | **FIRED** |
| m6 | drop `clearTimeout(timer)` in fetchTopicPayload | the suites / "SUB-CATEGORIES" | **INERT**. No suite test covers it. Re-run against my own probe (`mut/timer-test.sh`: a 60 s ceiling must exit < 5 s): **FIRED**. So the clear is real, but the repo has no test that guards it. |
| m7 | drop the per-topic `tasks.sort(byPriorityThenDue)` | "SUB-CATEGORIES" | **INERT**. No fixture puts 2+ differently ranked tasks under one topic in a non-sorted input order. The fixture is too weak; within-topic ordering is UNGUARDED. |
| m8 | remove "unknown tool" from the tool-absent phrase list | "SUB-CATEGORIES" | **INERT**. No test pins the tool-absent classification of execute-tool's real "Unknown tool: …" text. It is UNGUARDED. |

Every run reported `restored: … matches HEAD` and `tree clean`.

## LIVE (journey-voice#42 merged 678f80c + deployed, huddle#71 merged 21e907b + deployed, per coordinator 17:08Z)

**Runtime proof that `get_task_topics` executes, returns the owner's links, and only those:**
- Supabase `function_logs` 17:12:14.588Z: `[EXECUTE-TOOL] Executing: get_task_topics { args: {}, userId: "a3378f93-d655-4913-b2fa-ca5b1d8020f1", interface: "chat" }`, the only invocation since 17:07.
- Supabase `edge_logs` 17:12:14.720Z: `GET | 200 | /rest/v1/task_topic_mappings?select=task_id%2Ctopic_id%2Ctask_topic_index%21inner%28user_id%29&task_topic_index.user_id=eq.a3378f93-…`, role `service_role`, **`response.headers.content_range: "0-368/*"` = 369 rows**. The table holds 374 links, 5 of which belong to the other topic owner, so the embedded `!inner` filter EXECUTES (200, not a PGRST 400) and returns exactly the owner's 369. Other users' links are excluded at runtime.
- `function_edge_logs`: execute-tool 385 ms and huddle-proxy/tool 572 ms for that call, well inside the 4 s ceiling.
- The topics read is evidenced by the render: 53+13+68+35 = **169 topic rows**, exactly the owner's count. The other user's 10 topics would make it 179.

**verify-uat.yml run 38775191326 (390x844, ref verify/subcategories-1, checks file `.claude/skills/test-agent-serverfn/scripts/verify-subcategories-checks.mjs`, read-only: expand/collapse clicks only). Results from `uat-shots` commit adc42c3 `results.json`:**
- "Sub-themes … aren't available yet" banner: **absent**. "Couldn't load the topic breakdown": **absent**. "not configured": absent.
- getPrioritiesWidget server-fn response (id e47038b89436): HTTP 200, 115 116 bytes, no `tool-absent`, no `timed out`.
- **Career renders count 8 with 13 topic rows and 0 loose tasks**: AI Workflow Management 1 | Career Development **3** | Career Development Tasks | Career Review Management | Debugging and Troubleshooting | Design Resource Management 1 | **Fractional CTO Services (blank)** | Grooming Management | Presentation Development | Software Development Lifecycle 2 | Team Collaboration Tools | Vendor Communication | Career Tools Integration 1.
- Life & Personal **14** (53 topics, direct: "Test task #1"); Ventures **55** (68 topics, direct: "Test cross-app memory for Nexus webapp"); Education **6** (35 topics). **No Family row.**
- 0 console errors, 0 failed/4xx/5xx requests. 67 expanders clicked.
- **The live DOM matches my offline prediction from the real data topic for topic** (claim 1 table): every non-zero topic count is identical, including the BLOCKED +1, the parked/`completed_at` blanks, and the multi-topic task under Database Management.
- Android rule recomputed at 17:15:08Z (journey SQL): CAREER 13 topics / 8 tasks, EDUCATION 35 / 6, LIFE 53 / 18, VENTURES 68 / 66, unchanged since 17:05.

**So the live answer to the coordinator's question:** the deployed card shows **Career 8 across the same 13 topics** as the phone. The per-topic counts differ in two rows (Career Development 3 vs 2; Fractional CTO Services blank vs 1), and those cancel out. Life (14 vs 18) and Ventures (55 vs 66) differ from the phone. Every gap is explained by the three intended differences PLUS three that are NOT on the intended list: the `completed_at` rule (F1), one mirror status drift (F3) and multi-topic placement (F4). Topic order differs (F5) and Family is absent (F6).

Phone screenshots: `uat-shots` adc42c3 `01-priorities-view.png`, `02-tree-expanded.png`. The first category (Life & Personal) opens by default and shows 53 topic rows, most of them blank, before Career is reached. That is a UX observation, not a defect versus the AC.

