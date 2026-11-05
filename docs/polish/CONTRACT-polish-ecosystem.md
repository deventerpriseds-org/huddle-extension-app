# CONTRACT — Polish across the app ecosystem (Huddle ⇄ Nexus)

<!-- WHAT:       The wire contract between Huddle and Nexus for the Polish text-cleanup tool.
     WHY:        Owner, 2026-11-05: "we will need to make this same module integratable with the nexus
                 app as well. these should all work as an ecosystem of connectable apps" — and chose
                 Option A: Huddle hosts the ONE Polish engine; Nexus gets its own Polish screen that
                 calls it; Google Drive saves go through Nexus's existing Google connection.
     SUPERSEDES: nothing.  SUPERSEDED-BY: nothing — current.
     EVIDENCE:   Huddle PR deventerpriseds-org/huddle-extension-app#146 (Polish, merged 08457bc);
                 existing bridges reused — Nexus→Huddle: nexus-hub api/src/lib/huddleAgent.ts →
                 huddle /api/public/run-agent-turn (cross-app/turn-gate.ts); Huddle→Nexus:
                 huddle lib/nexus/nexus-write.server.ts `nexusWriteFetch` (X-UAT-Token + ?owner=). -->

## Shape

```
Nexus browser ──(Nexus session)──▶ Nexus API  POST /api/polish/run ──(x-webhook-secret)──▶ Huddle POST /api/public/polish
Huddle browser ─(Huddle sign-in)─▶ Huddle server fn polishGoogleDriveFn ──(X-UAT-Token, ?owner=)──▶ Nexus POST /api/polish/gdrive
```

No new secret. No new identity scheme. Both directions reuse the credential that direction ALREADY uses.

## 1. Huddle `POST /api/public/polish` (Huddle hosts the engine)

- **Auth (who is calling):** `x-webhook-secret` must equal `JOURNEY_PROXY_TOKEN` — `authenticateCaller()` from
  `src/features/huddle/lib/cross-app/turn-gate.ts`, unchanged.
- **Subject (on whose behalf):** `resolveActingSubject()` — the server-held `CROSS_APP_TURN_SUBJECT`. The body has
  NO identity input; a body carrying `caller`/`entra_email`/`user`… is refused (`findCallerAssertedIdentity`).
- **Body cap:** 64,000 bytes (`MAX_BODY_BYTES`), 413 `payload_too_large` above it.
- **Body** — one of:
  ```jsonc
  { "action": "profiles" }
  { "action": "polish", "profileId": "work-email", "settings": { /* optional PolishSettings override */ },
    "request": { "mode": "polish", "draft": "..." }
             | { "mode": "revise", "text": "...", "instruction": "..." }
             | { "mode": "span", "text": "...", "start": 0, "end": 10, "instruction": "..." }
             | { "mode": "merge", "draft": "...", "edited": "..." } }
  ```
- **Responses** (always JSON, `Cache-Control: no-store`):
  ```jsonc
  // profiles
  { "ok": true, "profiles": PolishProfile[], "lastProfileId": "work-email",
    "tones": [...], "quickActions": [...] }          // built-ins + the subject's own synced profiles
  // polish
  { "ok": true, "text": "finished full text", "model": "gpt-5.6-luna" }
  // failure
  { "ok": false, "error": "human-readable sentence" }   // 4xx/5xx status as appropriate
  ```
- `PolishProfile` / `PolishSettings` are exactly the types in Huddle `src/features/huddle/lib/polish/polish-core.ts`:
  `{ id, name, custom?, tones: string[] (≤2), formality: 1..5, strength: "light"|"balanced"|"full",
  length: "shorter"|"keep"|"longer", format: "auto"|"bullets"|"sections", audience, rules, engine: "fast"|"best" }`.
- Settings are coerced server-side (`normalizeSettings`); unknown values fall back to the profile's.
- **Profiles are READ-ONLY from Nexus in v1.** They are saved in Huddle (synced across Huddle web + phone).
  Nexus may change settings for one polish (sent as `settings`) but cannot save a profile.
  *Why:* Huddle's client writes its whole workspace blob on a debounce, so a server-side write from Nexus
  would be silently overwritten by any open Huddle tab.

## 2. Nexus `POST /api/polish/run` (Nexus's own API, called by the Nexus Polish page)

- Signed-in Nexus owner only (`resolveOwner`; 401 otherwise).
- Forwards the body above to Huddle, server-to-server, with `x-webhook-secret: JOURNEY_PROXY_TOKEN`.
- Huddle URL: same origin as the existing `HUDDLE_AGENT_URL` (api-deploy.yml line ~99), path `/api/public/polish`.
  No new app setting.
- 45s timeout. Passes Huddle's JSON back unchanged; maps transport failures to `{ ok:false, error }`.

## 3. Nexus `POST /api/polish/gdrive` (Nexus owns the Google connection)

- Auth: `resolveOwner` — Huddle calls with `X-UAT-Token` + `?owner=<NEXUS_OWNER_ID>`, exactly like
  `nexusWriteFetch`; a signed-in Nexus user may also call it directly from the Nexus page.
- Body: `{ "fileName": "Billing go-live moved.docx", "docxBase64": "..." }` (≤ 10 MB decoded).
- Uploads to the owner's Drive in a folder **"Polish"** (created once and remembered by id; drive.file scope
  — Nexus can only touch files it made), via `getGoogleAccessToken(owner)` from `api/src/lib/google.ts`.
  Converts nothing: the file is stored as .docx (Drive opens it in Docs on click).
- Responses:
  ```jsonc
  { "ok": true, "webViewLink": "https://drive.google.com/...", "fileId": "..." }
  { "ok": false, "needsReconnect": true, "error": "Reconnect Google in Nexus Settings to allow Drive." }
  { "ok": false, "error": "..." }
  ```

## 4. What each app shows

| | Huddle Polish | Nexus Polish |
|---|---|---|
| Engine | local server fn `polishTextFn` | `/api/polish/run` → Huddle |
| Profiles | read + save (synced) | read (from Huddle) |
| Copy / Copy formatted | yes | yes |
| Email draft (chosen mailbox) | yes (Graph) | v2 (via Huddle) |
| Word → OneDrive | yes (artifact mirror) | Download .docx (Nexus docxBuilder) |
| Google Drive | **via Nexus `/api/polish/gdrive`** | direct (`/api/polish/gdrive`) |

## 5. Failure behaviour

Every cross-app call is best-effort: an unreachable peer shows a sentence saying which app could not be
reached, never a crash, and never loses the user's text.
