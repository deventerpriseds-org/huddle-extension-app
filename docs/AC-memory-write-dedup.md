# AC — write-time dedup for `public.rag_chunks` (`writeChunk`)

**Status: IN PROGRESS (adversarial AC pass, cold read). No source files edited.**

Author: independent AC subagent. Change is NOT implemented; this doc is written before any code.

Hard constraint noted up front: this session CANNOT reach Azure PG (egress is HTTPS-only, TCP 5432
blocked, no PG creds in env). No `psql` was attempted. Every claim below is sourced from code on
disk or from `.claude/memory.md`; anything requiring a live DB read is marked
**UNVERIFIABLE-FROM-SESSION** with the exact `azure-pg-query.yml` SQL that would settle it.

## 1. Feasibility table
_(populating…)_
