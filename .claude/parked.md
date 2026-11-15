# Parked work -- built but NOT live (owner rule 2026-11-15: remind every turn until he decides go or skip)
# Format: - [ ] PARKED: <slug> | <what> | state: <...> | since <date> | decide: go/skip
#         resolved only as: - [x] PARKED: ... | DECIDED: go <date>  or  DECIDED: skip <date>
- [x] PARKED: correspondence-branch | Email/Teams correspondence work (approved email-text fixes, proposals checklist, meeting triage, judge, staleness alerts) on branch claude_task-proposals | state: not merged (verifier loop 11 running) | since 2026-11-14 | DECIDED: go 2026-11-15 (owner: "Push everything there")
- [x] PARKED: correspondence-collection | Collect email + Teams files into Azure (ledger) since Monday, back-fill from OneDrive versions, Teams daily from 6pm | state: switched off (correspondence.ingest + no teams/sent keys), tables not in prod; back-fill dry run found 138 emails since Monday | since 2026-11-15 | DECIDED: go 2026-11-15 (owner: "Push everything there")
- [x] PARKED: report-links-checklist | Report email links into Iris's checklist + Wrong link + category settings | state: ACs written, not built | since 2026-11-15 | DECIDED: go 2026-11-15 (owner: option A)
- [ ] PARKED: verify-loop-work-slug-alias | eds-claude-skills #138 checker fix | state: not merged (three AC findings open) | since 2026-11-15 | decide: go/skip
- [x] PARKED: parked-work-reminder | eds-claude-skills #139: the per-turn reminder hook that prints this list | state: not merged (CI running) | since 2026-11-15 | DECIDED: go 2026-11-15 (owner: "Make a mechanized rule")
