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

## Step 2 — implementation

_(appended below as it lands)_
