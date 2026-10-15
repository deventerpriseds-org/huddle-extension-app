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

