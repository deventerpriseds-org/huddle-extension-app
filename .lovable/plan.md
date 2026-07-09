
# Get Azure Postgres working, transparently — no fallbacks, no tricks

You're right that it's a single connection string (`AZURE_PG_URL`), and it's already saved. The reason it hasn't worked isn't a missing secret — it's that the current code hides the actual failure behind a lazy bootstrap and static "everything's fine" chips. This plan removes the deception so we can see exactly what Azure is saying and fix that one thing.

## What changes

### 1. Delete the silent lazy bootstrap
`azure-pg.server.ts` today runs `CREATE TABLE IF NOT EXISTS` on the first call inside `ensureBootstrap()` and every store method swallows errors upstream. Replace with:
- Explicit `runBootstrap()` server fn the user triggers from Settings. Returns the raw SQL result or the raw error.
- Every store method (`writeChunk`, `searchChunks`, `lookupTriples`, `writeTriples`) throws `RagStoreUnavailableError` on failure. No `{ ok: false }` masquerading as success.

### 2. Real diagnostic server function
New `diagnoseAzurePg` returns, in one payload, the ground truth:
- Parsed host / port / database / user / sslmode from `AZURE_PG_URL` (password redacted).
- DNS resolution: does the host even resolve, and to what?
- Raw TCP probe on port 5432 with a 5-second timeout, using `node:net` — this tells "firewall blocks the port" apart from "TCP fine, Postgres rejected us."
- Real `pg.Client` handshake with 10-second timeout: returns the full Postgres error (`code`, `severity`, `message`, `routine`) on failure.
- On success: `SELECT version()`, `pg_extension` list, and presence + row counts for `rag_chunks` / `rag_triples`.

Whatever Azure says gets shown verbatim. Nothing inferred, nothing hidden.

### 3. Live "Memory DB" panel in Agent Settings
Replace the static `RAG STORE: azure / CHUNKS: true / TRIPLES: true` chips with a live panel:
- Grey/"unknown" on first mount — never green by default.
- Green only when the last `diagnoseAzurePg` returned ok. Otherwise red with the raw error line.
- Buttons: **Run diagnostic**, **Run bootstrap (create tables)**, **Refresh**.
- Expandable details: host, port, ssl mode, server version, extensions, table row counts, last-error timestamp.

### 4. Chat-turn transparency
If retrieval throws during a turn:
- Inline `memory unavailable` tag on the assistant message.
- Activity-log entry with the raw error.
- No silent empty-context fallback that pretends memory worked.

This matches your core-memory rule already: "Any runtime fallback must surface a visible alert."

### 5. What the diagnostic will likely show
Ordered by how often each is the culprit for Cloudflare Worker → Azure Flexible Server:
1. **Public access disabled** — Flexible Server defaults to private endpoint only. DNS resolves, TCP times out.
2. **Firewall rules missing a rule for public traffic** — Workers use rotating egress IPs; a fixed IP allowlist won't work. Options: enable "Allow public access from any Azure service" (limited), or accept `0.0.0.0/0` with strong auth, or front the DB with a fixed-IP proxy.
3. **TLS / sslmode conflict** — if `sslmode=verify-full` is baked into the URL it overrides driver options. We'll parse and strip conflicting query params, keep `{ ssl: { rejectUnauthorized: false } }` in code.
4. **Auth (`28P01`)** — password rotated or wrong user.
5. **Missing `vector` extension privilege** — bootstrap will surface this cleanly.

The diagnostic will point at exactly one of these, and we fix that one.

## Technical details

Files touched:
- `src/features/huddle/lib/rag/azure-pg.server.ts` — remove swallowing `ensureBootstrap`, export raw `runBootstrap()`, throw typed errors on failure.
- `src/features/huddle/lib/rag.functions.ts` — add `diagnoseAzurePg`, `runRagBootstrap`, `getRagTableStats` server functions.
- `src/features/huddle/components/AgentSettingsDrawer.tsx` — replace static RAG chips with the live Memory DB panel (TanStack Query, `refetchOnMount: "always"`).
- Chat turn renderer (`HuddleView.tsx` / message component) — surface `memory-unavailable` inline tag when retrieval throws.
- `openai-responses.server.ts` (retrieval call site) — let errors propagate to the turn instead of returning `[]`.

Implementation notes:
- Raw TCP probe uses `node:net`, DNS uses `node:dns/promises`. These work in the Workers runtime with `nodejs_compat` (already enabled).
- Use a fresh `pg.Client` (not the pool) inside the diagnostic so a broken pool state can't hide the error.
- No new secrets requested. `AZURE_PG_URL` is enough. If the diagnostic proves the string itself is bad (auth or sslmode), I'll ask you to reissue it from the portal at that point — with proof of what's wrong, not before.

## What happens after this ships

1. You open Agent Settings → Memory DB → **Run diagnostic**.
2. You paste the raw output back here (or screenshot it — the panel shows everything).
3. It names exactly one failure: DNS / TCP / TLS / auth / bootstrap. We fix that one thing and the store is live.

From that point on, the panel is the source of truth. If it's not green, memory isn't working — no more inferring from static config.
