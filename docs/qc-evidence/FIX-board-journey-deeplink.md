# FIX-board-journey-deeplink

```
WHAT:          An "Open in journey" link on every Huddle board card that opens THAT task in journey (TaskOS).
WHY:           Owner, 2026-10-29: "I can't click to go to the task in journey" -> "Add the deep links".
               The board card had no path back to the canonical task in journey at all.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; scripts/board-journey-link.test.ts (`npm run test:journey-link`); PR on
               branch claude_board-journey-deeplink.
```

## 1. Findings (read from code, 2026-10-29)

| question | answer | source |
|---|---|---|
| journey's public host | `https://journey-voice.lovable.app` | journey-voice `public/bridge.config.json:4` (`baseUrl`); same value journey's own `supabase/functions/_shared/digest-content.ts:185` uses as `APP_BASE_URL_DEFAULT` |
| route that opens ONE task | `/tasks?task=<uuid>` | journey-voice `src/pages/TasksPage.tsx:51-70`: on load, reads `?task=`, finds the task in `useUnifiedTasks()` (live + historical), opens `TaskDetailModal`, then strips the param. `src/App.tsx:102` mounts `/tasks`. |
| also accepted | `/calendar?task=<uuid>` (alarm "Open task"), Dashboard | journey `src/utils/alarmDeepLink.ts` + `notification-delivery/index.ts:18`; `Calendar.tsx:146`; `Dashboard.tsx:77` |
| why `/tasks` not `/calendar` | the calendar view is for scheduled items; `/tasks` loads every task, so an unscheduled backlog card still resolves. `view=kanban` is set explicitly so TasksPage's "default view" effect (`TasksPage.tsx:35-41`) does not race the `task` param. | as above |
| does Huddle already know journey's app URL? | **No.** Zero hits for `journey-voice.lovable.app`, `JOURNEY_URL`, `JOURNEY_APP*` in huddle `src/`, workflows, `.env.example`. The only journey URL is server-side `JOURNEY_PROXY_URL` (a Supabase functions URL, not the app). | `grep -rn` over huddle repo |
| board row id == journey task uuid? | **Yes.** `tasks.journey_tasks.id TEXT PRIMARY KEY` is written from the webhook's `task.id` (`src/routes/api/public/tasks-sync.ts:48`), upserted `ON CONFLICT (id)`; `BoardTaskRow.id` is that column (`tasks.server.ts:1885`). | huddle source |
| Android Huddle web view | no JS external-link helper exists. `android-bridge-template` `BridgeWebViewClient.kt:87-123` sends any user-initiated main-frame navigation to a non-trusted host out via `Intent.ACTION_VIEW` (multiple windows unsupported, so `target="_blank"` becomes a main-frame load). A plain anchor is therefore the correct, already-handled mechanism; huddle's `ArtifactsView.tsx:574` uses the same plain-anchor shape. | android-bridge-template source |

## 2. Design

- One module, `src/features/huddle/lib/journey/journey-links.ts`: `JOURNEY_APP_URL_DEFAULT` (the real host above),
  `journeyAppBaseUrl()` (reads `VITE_JOURNEY_APP_URL` as an override; unset -> default; set to empty -> link
  OFF), `buildJourneyTaskUrl(base, taskId)` (returns `null` for a missing/non-http base or empty id).
- `BoardCard` renders `<a href target="_blank" rel="noopener noreferrer" draggable={false}>` with an
  `ExternalLink` icon + "Open in journey", stopping click/dragstart propagation like the other card controls.
  Absent when the builder returns `null`.
- No new secret (the URL is public). No journey change needed.

## 3. Log
</content>
</invoke>
<invoke name="Bash">
<parameter name="command">cd /tmp/claude-0/-home-user/f93a6466-3dfd-5e65-a8de-e415ffea7464/scratchpad/deeplink/huddle; ls src/features/huddle/lib/journey/; git add docs/qc-evidence/FIX-board-journey-deeplink.md && git commit -qm "docs: evidence file for board journey deep link (findings)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JSjgqm4C4dKpPB28gwWi2Y" && git push -q -u origin claude_board-journey-deeplink 2>&1 | tail -3; git log --oneline -1- 2026-10-29 `930401e` findings pushed. Implementation written; session then killed by a container restart
  before it was committed. The scratch clone survived with the work intact.
- 2026-11-04 `7ecf0e9` implementation committed + pushed: `journey-links.ts`, `BoardCard` link,
  `scripts/board-journey-link.test.ts`, `npm run test:journey-link`.
- 2026-11-04 `c0c8d75` merged `origin/main` (`18778f6`, #130) into the branch — clean merge, no conflicts.
- On the merged tree: `npm run test:journey-link` 23/23 PASS; `npm run test:board-delete` ALL PASS (same
  file); `npx tsc --noEmit -p .` exit 0, 0 errors (after `npm ci`).

## 4. Mutations (`mutate.sh`, anchors from files, test cmd `bun scripts/board-journey-link.test.ts`)

| # | defect reinstated | file | named test | outcome |
|---|---|---|---|---|
| M1 | builder accepts an empty / non-http base (`if (!id) return null;`) | journey-links.ts | `no link when the base is empty (not configured)` | **FIRED** |
| M2 | card ignores the configured base (hardcoded host) | BoardView.tsx | `card href is built from the configured base + THIS task's id` | **FIRED** |
| M3 | link's `onClick` stopPropagation removed | BoardView.tsx | `click does not reach the card` | **FIRED** |
| M4 | link rendered unconditionally (`{true && (`) | BoardView.tsx | `the link renders only when there is an href` | **FIRED** |
| M5 | empty override falls back to default instead of switching off | journey-links.ts | `override set to empty -> links OFF` | **FIRED** |

All five restored to HEAD and the named test passes again on the restored tree. A first pass passed the
pattern as `FAIL  <name>`; mutate.sh matches the bare NAME, so it reported "nothing proven" for all five
(not INERT) — re-run with bare names, results above.

## 5. Not verified

- Not seen in a real browser or in the Android Huddle app. The Android behaviour (link handed to the OS
  via `ACTION_VIEW`) is read from `android-bridge-template` source, not observed. Status: implemented,
  mechanism verified locally, NOT confirmed live.
