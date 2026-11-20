// WHAT:          Prints the Trinnex database bootstrap SQL to stdout, for bootstrap-trinnex-db.yml.
// WHY:           AC-M2: the Trinnex DB runs byte-identical BOOTSTRAP_SQL (azure-pg.server.ts), rendered from the
//                code -- never a hand copy in a workflow that can drift.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/trinnex-memory.test.ts (M2 checks the prefix is BOOTSTRAP_SQL exactly).
import { TRINNEX_BOOTSTRAP_SQL } from "../src/features/huddle/lib/trinnex/bootstrap-sql";

process.stdout.write(TRINNEX_BOOTSTRAP_SQL);
