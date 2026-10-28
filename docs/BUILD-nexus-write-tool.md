<!--
WHAT:          Build log for FEATURE 2 -- a Nexus WRITE tool (`write_nexus_assignments`) Huddle agents
               call to add/update the owner's dated, graded Nexus assignments, with Elle (elle-rowan)
               and Iris (iris-chase) as the prime responders.
WHY:           Huddle's Nexus bridge was read-only (nexus.server.ts, "READ-ONLY BY CONSTRUCTION"), so
               "add my MGT-782 assignments" had no route; and the offline router sent "update the due
               date on my research paper" to Eli (0.32) and, in a 1:1 with Elle, laneOwnerFor handed
               it to Eli too. Owner: "the nexus tool should be among a pool of tools but elle and iris
               should be prime to use it immediately if i request it."
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      ACs: nexus-hub docs/cross-app-agent/AC-syllabus-deliverables-write-tool.md Part B +
               RESOLUTIONS (OQ-9 = W1, X-UAT-Token). Tests: scripts/nexus-write-tool.test.ts
               (npm run test:nexus-write). Commits on branch worktree-agent-a5321d2fac007d47a.
-->

# BUILD — Nexus write tool for Huddle agents (Feature 2)

Base: huddle-extension-app `origin/main` 4809e2e (fast-forwarded before any edit).
Nexus contract read from a fresh clone of nexus-hub `origin/main` a3683ab.

## Step 0 — facts read before writing anything

| Fact | Source | Consequence |
|---|---|---|
| `POST /api/d1/assignments` inserts one row per transaction; body `{rows:[...]}` or a bare row; returns `{rows:[row]}` | `api/src/functions/d1.ts:1199-1241` | one POST per item, read `rows[0].id` |
| `PATCH /api/d1/assignments?id=` updates owner-scoped row; 404 when not owned | `d1.ts:1243-1300` | update needs the assignment id |
| Writable columns: course_id, title, description, type, status, due_date, priority, points, … program_id, canvas_meta | `d1.ts:400-412` | tool sends only course_id/program_id (from the course row) + title/description/type/status/due_date/priority/points |
| UAT write auth: `x-uat-token` equal (timingSafeEqual) to Function App `UAT_BYPASS_TOKEN`; owner = `?owner=` | `api/src/lib/auth.ts:131-137` | Huddle sends `X-UAT-Token` and sets `?owner=` from `NEXUS_OWNER_ID` |
| **PATCH always writes a preimage** (op='update', complete prior row, same tx) | `d1.ts:1272-1294` | no reversibility gap on UPDATE |
| POST writes an op='insert' preimage **only when `x-agent-tool` is sent** | `d1.ts:1136-1143`, `preimage.ts:175` | tool always sends `X-Agent-Tool` + `X-Agent-Ref` |
| Huddle server runtime had **no** `UAT_BYPASS_TOKEN` app setting — only the client build gets `VITE_UAT_BYPASS_TOKEN` | `.github/workflows/deploy-swa.yml:201` vs `:413-437` | add `UAT_BYPASS_TOKEN="${{ secrets.UAT_BYPASS_TOKEN }}"` (same org secret Nexus's `api-deploy.yml:125` syncs; no new secret) |
| Nexus `normTitle` = lowercase, non-alphanumerics → space, trim | `api/src/shared/canvasIngest.ts:128` | spelled identically in Huddle (cannot import across repos — see gaps) |
| Nexus `normCode` drops every separator | `api/src/shared/courseLink.ts:46` | same |

## Progress

