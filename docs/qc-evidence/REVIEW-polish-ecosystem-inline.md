# REVIEW — Polish ecosystem PRs (huddle #148 + nexus-hub #176), inline desk-check

<!-- WHAT:       Inline review of the two cross-app Polish PRs before merge.
     WHY:        Three independent verifier runs (work polish-ecosystem-huddle-148, loop 1 x2, loop 2)
                 were each killed by a container restart before pushing any verdict; the owner asked for
                 it working today, so the review was done inline instead. NOT an independent verification.
     SUPERSEDES: nothing.  SUPERSEDED-BY: nothing — current.
     EVIDENCE:   file:line below, read 2026-11-05 at huddle 2c05160 / nexus 92053c8. -->

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| H1 | Huddle route authenticates before reading the body | CONFIRMED (+ mutation FIRED) | src/routes/api/public/polish.ts — `authenticateCaller(request.headers)` precedes `request.json()`; scripts/polish-core.test.ts §10 |
| H2 | Subject server-held; asserted identity refused | CONFIRMED | same file — `findCallerAssertedIdentity(payload)` then `resolveActingSubject()`; body schema has no identity field |
| H3 | Route can only list profiles / run one model call | CONFIRMED | polish.server.ts `runPolish` (one fetch to OpenAI), `loadPolishProfiles` (one SELECT) |
| H5 | Huddle→Nexus Drive call: sign-in required; URL/owner server-held | CONFIRMED | polish.functions.ts `polishGoogleDriveFn` — `callerEmail` gate; `nexusBase()`/`nexusOwner()` from env only |
| N1 | Nexus /run verified owner only; body rebuilt; secret only to HUDDLE_AGENT_URL origin | CONFIRMED | nexus api/src/functions/polish.ts `signedInOwner` (verified && !ANON); shared/polish.ts `buildPolishBody` (no spread), `polishUrlFrom` (origin) |
| N2 | Nexus /gdrive verified owner; size capped pre-decode; "Polish" folder; needsReconnect | CONFIRMED | functions/polish.ts `polishGdrive`; shared/polish.ts `checkDocxBase64` |
| W1 | Wire agreement both directions | CONFIRMED, one benign mismatch | profileId cap Nexus 100 vs Huddle 80 (real ids are short; a >80 id would get a 400, not a wrong action) |
| T  | Suites | Huddle polish-core 35/35, tsc 0; Nexus api build `polish: 30 passed`, web build rc 0 (re-run after restart) |
