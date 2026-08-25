# Independent verification — notification fixes (Bug 1 + Bug 2)

**Verifier:** independent agent, no shared context with the implementing session.
**Date:** 2026-08-25
**Under test:** branch `claude/iris-huddle-interaction-baj51c`, commits `1f7a035` (Bug 1), `ca4d459` (Bug 2).
**Base confirmed:** `git log --oneline -6` shows `ca4d459` → `1f7a035` → `043b932` (the AC doc's stated base).
**Sandbox limits:** cannot reach Azure PG (`eds-postgresql`) or the deployed SWA from here. Anything
requiring the live DB, a real device push, or a real browser is marked **NOT LIVE-VERIFIED**.

Status: IN PROGRESS — appended incrementally as each item is checked.

---

## 0. Evidence log (running)

- `git log --oneline -6` → `ca4d459 fix(notifications): gate reply pushes on liveness at delivery...`,
  `1f7a035 fix(notifications): blocked-task messages now name the teammate who needs you (Bug 1)`.
- Working tree clean at start (`git status --porcelain` empty).

