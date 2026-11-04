<!--
WHAT:          Implementation log for the Huddle half of journey's new JOB task category
               (JOB = work for the owner's employer, Trinnex; CAREER = getting the next role).
WHY:           journey is adding JOB; its rows already sync into tasks.journey_tasks (category is free
               TEXT), but Huddle's colour seed, display order, labels, standup owner map and tool
               descriptions only knew the old categories. Unseeded, JOB hashes to hue 189, 40 degrees
               from CAREER's 149 (journey-voice docs/qc-evidence/AC-job-category.md, F-23 / AC-F2).
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      journey-voice docs/qc-evidence/AC-job-category.md section F (AC-F1..F8); this file's
               Proof section; branch claude/jolly-archimedes-is9jyz.
-->

# IMPL: JOB category, Huddle side

Owner rulings this implements: JOB label "Job", placed directly before Career; Cole (`cole-blake`)
owns JOB items in standups. Additive only: existing categories must look and behave as today.

Baseline before any edit (origin/main 32f50e4): widget-colors 25/0, category-tree 46/0,
category-tree-independent 25/0, widget-topic-tree 20/0, category-push 35/0, week-order 9/0,
router-winners 39/0; `npx tsc --noEmit` 0 errors.

## Progress (one line per file)
