# huddle web-search (Azure Function)

Tavily search proxy for the huddle app, ported from journey-voice's Supabase
edge function `supabase/functions/web-search/index.ts`. It replaces OpenAI's
`web_search_preview` as the huddle web-search backend.

- **Runtime:** Azure Functions v4 programming model, Node.js 20 LTS, TypeScript.
- **Trigger:** HTTP `POST /api/web-search`, **anonymous** auth level (the only
  secret, the Tavily key, lives server-side).
- **Upstream:** `POST https://api.tavily.com/search` with `Authorization: Bearer $TAVILY_API_KEY`.

## Request contract (huddle → function)

```jsonc
POST /api/web-search
Content-Type: application/json

{
  "query": "string, required, verbatim from user",
  "topic": "general | news | finance",   // default "general"
  "search_depth": "basic | advanced",     // default "advanced"
  "max_results": 5,                        // int 1-20, default 5
  "include_answer": true,                  // default true
  "include_raw_content": false,            // default false
  "days": 7,                               // optional, only meaningful for topic=news
  "start_date": "YYYY-MM-DD",              // optional
  "end_date": "YYYY-MM-DD",                // optional
  "include_domains": ["example.com"],      // optional
  "exclude_domains": ["spam.com"]          // optional
}
```

Validated with zod (`src/lib/validate.ts`). Invalid shape → **400** `{ error, issues }`.
Invalid JSON → **400** `{ error: "invalid_json" }`.

### Same-day range guard

If `start_date` and `end_date` are both present and **equal**, only `start_date`
is forwarded to Tavily (`end_date` is dropped), because Tavily rejects a
same-day range. See `src/lib/tavily.ts`.

## Response contract (function → huddle)

On success the function returns **Tavily's JSON verbatim, unwrapped**, with HTTP 200:

```json
{
  "query": "...",
  "answer": "...",
  "results": [
    { "title": "...", "url": "...", "content": "...", "score": 0.87, "published_date": "..." }
  ],
  "response_time": 1.23
}
```

On upstream non-2xx → **502** `{ error, upstreamStatus, upstreamBody }` (`upstreamBody` truncated to 2KB).
Upstream timeout (25s) → **502** `{ error: "tavily_timeout", ... }`.
Missing `TAVILY_API_KEY` → **500** `{ error: "missing_TAVILY_API_KEY" }`.

## CORS

The function emits CORS headers on every response and returns **204** for
`OPTIONS` preflight. Allowed origin is `*` (no cookies are sent). Configure the
Function App CORS blade as belt-and-suspenders (see deploy below).

## Divergences from journey-voice (intentional)

The task header asked to mirror journey "byte-for-byte", but journey's actual
behavior differs from the huddle contract specified in the task body. Where they
conflict, this port follows the **explicit huddle contract**. The differences:

| Aspect | journey-voice edge function | this Azure port |
| --- | --- | --- |
| Response | wrapped envelope `{ success, answer, sources, results, query, paramsUsed }` | Tavily JSON **verbatim, unwrapped** |
| Error handling | returns HTTP 200 with a graceful message | upstream errors → **502** with error envelope |
| `include_answer` | hardcoded `'advanced'` | boolean, default `true` (from request) |
| Date param | `time_range` (day/week/month/year) | `days` (news) + `start_date`/`end_date` |
| Same-day guard | **none** | drops `end_date` when it equals `start_date` |
| `max_results` default | 10 | 5 |
| Validation | manual (`query` presence only) | zod schema |

## Local development

```bash
cp local.settings.json.example local.settings.json   # then set TAVILY_API_KEY
npm ci
npm start        # runs: clean, tsc build, func start
```

`local.settings.json` is gitignored — never commit the real key.

## Deploy

> Requires an authenticated Azure CLI (`az login` or a service principal) with
> access to the target subscription. `func` (Azure Functions Core Tools) OR
> `az functionapp deployment source config-zip` can publish the build.

```bash
RG=rg-huddle-web-search
LOC=eastus2
APP=huddle-web-search-<short-random>     # globally unique
STG=huddlewebsearch<short-random>        # lowercase, <=24 chars

az group create -n $RG -l $LOC
az storage account create -n $STG -g $RG -l $LOC --sku Standard_LRS
az functionapp create -g $RG -n $APP \
  --storage-account $STG \
  --consumption-plan-location $LOC \
  --runtime node --runtime-version 20 \
  --functions-version 4 --os-type Linux

az functionapp config appsettings set -g $RG -n $APP --settings \
  TAVILY_API_KEY="<paste-value>"

for O in \
  https://huddle-extension-app.lovable.app \
  https://id-preview--a6760242-2abf-43de-b87f-bf2cff586ea4.lovable.app \
  http://localhost:8080 http://localhost:5173; do
  az functionapp cors add -g $RG -n $APP --allowed-origins "$O"
done

npm ci && npm run build
func azure functionapp publish $APP --typescript
# or, without func:
#   npm ci && npm run build && zip -r ../pkg.zip . -x 'node_modules/@types/*' 'src/*.ts'
#   az functionapp deployment source config-zip -g $RG -n $APP --src ../pkg.zip
```

## Verify

```bash
URL=https://$APP.azurewebsites.net/api/web-search

# 1. Preflight -> HTTP 204 with CORS headers
curl -i -X OPTIONS $URL -H "Origin: https://huddle-extension-app.lovable.app" \
  -H "Access-Control-Request-Method: POST"

# 2. Basic query -> JSON with answer, results[], response_time
curl -s -X POST $URL -H "Content-Type: application/json" \
  -d '{"query":"latest news on Azure Functions v4","topic":"news","max_results":3}' | jq .

# 3. Same-day range guardrail -> JSON success (no Tavily 400)
curl -s -X POST $URL -H "Content-Type: application/json" \
  -d '{"query":"nvidia earnings","topic":"news","start_date":"2025-08-27","end_date":"2025-08-27"}' | jq .
```
