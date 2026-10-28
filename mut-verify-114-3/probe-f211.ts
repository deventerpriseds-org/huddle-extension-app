// WHAT: verifier probe (VERIFY-nexus-write-tool-3): AC-F2-11's own fixture and the owner's meeting example through the
//       canonical classifier. WHY: C1 re-derivation. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE: docs/VERIFY-nexus-write-tool-3.md. Run: bun mut-verify-114-3/probe-f211.ts
import { classifyNonDeliverable } from "../src/features/huddle/lib/nexus/nexus-write.server";
for (const t of [
  "Residency 4 – present ideas and insights from the readings",
  "Residency 4 - present ideas and insights from the readings",
  "Research Proposal",
  "Case Brief 7",
  "Discussion Post",
  "Reading: Chapter 4",
]) console.log(JSON.stringify(t), "->", classifyNonDeliverable(t));
