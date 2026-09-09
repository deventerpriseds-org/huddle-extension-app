# BUILD — `search_scholar` (Elle Rowan finds published literature, with the library link)

<!--
WHAT:       Build log for the `search_scholar` agent tool in Huddle's Nexus tool module.
WHY:        The owner is a UM-Flint DBA student. A measured ~30% of scholarly results have no free
            full text, and his university library (EZproxy) is the only route to those. So a result
            without his library link is not a usable result — the link is the requirement, not a
            nicety.
SUPERSEDES: nothing.
SUPERSEDED-BY: nothing — current.
EVIDENCE:   this file; branch claude/scholar-search-tool.
-->

Branch: `claude/scholar-search-tool`, cut from `origin/main` @ `9d82c7c`.
**`main` auto-deploys on push in this repo — this branch is NOT merged. PR only.**

## Step 1 — read before writing (done)

Ground truth read this session, not recalled:

| Thing | Where | What it actually is |
|---|---|---|
| Tool shape to match | `nexus.server.ts:468-495` `GET_NEXUS_LIBRARY_TOOL` | `type:"function" as const`, `name`, `description`, `parameters{type:"object" as const, additionalProperties:false, properties, required:[] as string[]}`, `strict:false` |
| Registration point 1 | `nexus.server.ts:242-584` | the exported `const` |
| Registration point 2 | `nexus.server.ts:587-602` | array returned by `nexusReadTools()` |
| Registration point 3 | `nexus.server.ts:604-616` | `NEXUS_TOOL_NAMES` Set |
| Registration point 4 | `nexus.server.ts:623+` | `executeNexusTool` dispatcher |
| Non-d1 endpoint helper | `nexus.server.ts:176-186` `nexusGetPath` | the right helper — `/api/scholar-search` is not a `/api/d1/{table}` route |
| Owner injection | `nexus.server.ts:97-118` `nexusFetch` | `url.searchParams.set("owner", …)` AFTER caller params. The contract's `?owner=` is supplied here and is **unreachable from a tool argument** |
| Test to extend | `scripts/nexus-read-tools.test.ts` (`npm run test:nexus-tools`) | `t(name, got, want)`; prints `✔ ok` / `✘ not ok` — the words are load-bearing for `mutate.sh` attribution |
| Count assertion that must move | test PART 1 `"both set -> eleven tools"` = 11 | becomes 12 |

Both live surfaces already consume all four points generically
(`huddle.functions.ts:3247-3275` text, `realtime-tools.server.ts:173` voice), so a tool registered at
all four reaches text AND voice with no per-surface edit. No per-agent gating exists — every agent
sees the tool; Elle is the one whose lane it is, and the description is what steers her to it.

## Step 2 — implementation (commit `3ab1e66`)

All four registration points, in `src/features/huddle/lib/nexus/nexus.server.ts`:

| # | Point | What landed |
|---|---|---|
| 1 | exported const | `SEARCH_SCHOLAR_TOOL` — `type:"function" as const`, `additionalProperties:false`, `required:["query"]`, `strict:false`. Params: `query` (required), `limit`. **No identity parameter** — PART 3's existing all-tools sweep covers it. |
| 2 | `nexusReadTools()` | appended; array is now 12 |
| 3 | `NEXUS_TOOL_NAMES` | `"search_scholar"` added; set is now 12 |
| 4 | `executeNexusTool` | `if (name === "search_scholar")` branch, before the `unknown_nexus_tool_*` fallthrough |

Both live surfaces consume all four generically, so no per-surface edit was needed or made:
`huddle.functions.ts` spreads `nexusTools` into `mergedTools` and dispatches on
`NEXUS_TOOL_NAMES.has(c.name)`; `realtime-tools.server.ts` spreads `nexusReadTools()` into `raw` and
`...NEXUS_TOOL_NAMES` into its NATIVE set. Verified by the pre-existing PART 2 voice-drift guards,
which still pass.

### The contract, called exactly as specified

`nexusGetPath("/api/scholar-search", { q: query, limit })` → `nexusFetch` appends the caller's params
then **`searchParams.set("owner", …)` from server config**, so `?owner=` is supplied and is
unreachable from a tool argument, identical to every other tool in the file. Asserted live in the
test by parsing the real outbound URL: `pathname` `/api/scholar-search`, `q` `dynamic capabilities`,
`limit` `5`, `owner` `owner-uuid`.

Response mapped to snake_case for the model, **pass-through only**:
`libraryUrl`→`library_url`, `openAccessUrl`→`open_access_url`, `landingPageUrl`→`landing_page_url`,
`citedByCount`→`cited_by_count`; `doi` stays bare. Abstracts trimmed to 1200 chars with a per-paper
`abstract_truncated` flag (same reasoning as the semantic search's k-cap — ten full abstracts is a
context hazard, and a silent trim invites the model to summarise a fragment as the whole).

### Requirement 4 — the library link reaches the model, and is never constructed

Two things, not one:

1. **It survives.** `library_url: p.libraryUrl ?? null` — copied, never derived. `proxyPrefix` and
   the DOI are both in scope at the mapping site, so `proxyPrefix + doi` is one plausible line away,
   and that line would manufacture links precisely for the papers whose DOI is missing: links that
   look right, resolve to nothing, and get blamed on the library. Mutation **M4** reinstates exactly
   that defect and the guard fires.
2. **The model is told to show it.** In the description (`ALWAYS PRESENT THE LIBRARY LINK … Never
   omit \`library_url\`, never invent, edit or reconstruct one`) **and** repeated in the per-result
   `note`, which opens `PRESENT THE LIBRARY LINK WITH EVERY PAPER` and counts how many of the
   returned papers have no free full text. A field the model never reads is not delivered.

Also handled, on the same reasoning the semantic search already uses — an outage must never be
reported as a fact about the literature: an upstream non-2xx returns `ok:false, http_<n>`; a 200
carrying a non-object body returns `bad_response_shape`; an empty result set says *"found no papers
for that phrasing — not that no research exists"*.

## Step 3 — guards (`npm run test:nexus-tools`, PART 10)

Extended the existing suite rather than adding a file. **190 passed, 0 failed** (was 179 + the two
count assertions moved 11→12).

The four registration points are asserted **behaviourally** — the real exported value, the real
returned array, the real Set, a real dispatch — not by grepping the source. That was deliberate: a
raw-file match is satisfied by a commented-out line, and a regex window can reach into the
neighbouring entry; both have produced an INERT guard in this estate before. The one place a text
match is unavoidable (the description and note wording) is bounded to the exact string under test,
read off the imported value and the returned object rather than off the file.

## Step 4 — mutation proof (`/usr/local/bin/mutate.sh`, anchors from FILES)

**9 mutations, 9 FIRED, 0 INERT, 0 NOT-APPLIED.** Every run ended
`restored: … matches HEAD`.

| # | Defect reinstated | Test that had to fail | Outcome |
|---|---|---|---|
| M1 | drop `SEARCH_SCHOLAR_TOOL` from `nexusReadTools()` | `2/4 nexusReadTools() offers it to the model` | **FIRED** |
| M2 | drop `"search_scholar"` from `NEXUS_TOOL_NAMES` | `3/4 NEXUS_TOOL_NAMES routes it to the executor` | **FIRED** |
| M3 | rename the dispatcher branch so it never matches | `4/4 the executor dispatches it` | **FIRED** |
| M4 | **fabricate the link:** `?? proxyPrefix + "https://doi.org/" + doi` | `a null library_url stays NULL` | **FIRED** |
| M5 | rename the tool to `scholar_search` | `1/4 the exported const is the tool` | **FIRED** |
| M6 | **edit the link in transit** (`https`→`http`) | `library_url reaches the model UNMODIFIED` | **FIRED** |
| M7 | note stops ordering the link to be shown | `the result note repeats it where the model cannot skim past it` | **FIRED** |
| M8 | boundary sentence removed from the description | `the description draws the boundary against the owner's OWN material` | **FIRED** |
| M9 | wrong-shaped 200 returned as `{ok:true, count:0}` | `a 200 with the wrong body shape is refused` | **FIRED** |

M4 and M6 are the pair that matter — they are the two ways the owner's requirement dies quietly
(a link invented where there was none, and a link altered on the way out). Both are caught.

## Step 5 — typecheck, build, and the neighbouring suites

- `npx tsc --noEmit` — clean, no output.
- `npm run build` — `✓ built`, nitro output generated.
- `test:nexus-tools` 190/0 · `test:voice-tools` 36/0 · `test:router` 20/0 · `test:cross-app` 83/0 ·
  `test:turn-identity` ALL PASS · `test:email-gate` 73/0.

## Step 6 — what is NOT proven here

Stated plainly rather than left implied:

- **No live call was made.** `/api/scholar-search` is being built simultaneously in `nexus-hub` by
  another agent and this session did not touch that repo. Every result above is against a mocked
  `fetch` returning the agreed contract shape. The contract was consumed exactly as written and not
  altered.
- **Elle actually choosing this tool over `search_nexus_knowledge`** is model behaviour and is not
  testable from here — the description is the mechanism, and it is asserted for content, not effect.
- Live end-to-end confirmation (a real DBA query, a real link the owner clicks) is a post-deploy
  check and belongs to the owner.

## Step 7 — PR

**Not merged.** `main` auto-deploys on push in this repo, so merging is deploying.

_(PR number appended below.)_
