# VERIFY — triples dedup (independent verification)

Verifier agent, no shared context with the implementing session.
Started 2026-08-26. Repo `/home/user/huddle-extension-app`.

Baseline: `git fetch origin` run at session start.
- local HEAD = `1cbb976` "fix(memory): make the triples dedup actually fire, and visible when it doesn't"
- `origin/main` = `1cbb976` — identical, working tree clean.

Status legend: CONFIRMED / REFUTED / PARTIAL / UNVERIFIABLE.

| # | Claim | Verdict |
|---|---|---|
| C1 | dedup indexes exist, unique+partial, exact expression list | _pending_ |
| C2 | 465 total / 400 live, zero live dup groups | _pending_ |
| C3 | merge preserved max-confidence / newest / author union | _pending_ |
| C4 | writeTriples collapse behaviour (incl. case, incl. post-supersede) | _pending_ |
| C5 | supersede UPDATE carries `AND lower(object) <> lower($4)` | _pending_ |
| C6 | lookup_facts excludes superseded; no-op in legacy modes | _pending_ |
| C7 | bootstrap/diagnose/panel report the dedup indexes | _pending_ |
| C8 | created_at bumped on triples conflict; ORDER BY justification | _pending_ |
| C9 | tsc --noEmit passes | _pending_ |
| C10 | adversarial sweep | _pending_ |

---

(appended incrementally below)
