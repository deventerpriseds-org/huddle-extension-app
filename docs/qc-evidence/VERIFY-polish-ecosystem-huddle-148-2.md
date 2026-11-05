# WHAT:       Independent verification, loop 2, of huddle-extension-app#148 + nexus-hub#176 (Polish ecosystem)
# WHY:        Loop 1 was killed twice before writing any verdict; this is the first recorded pass.
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   probe .vtmp/route-probe.ts (not committed: harness only); heads below

Heads read: Huddle `origin/claude/tender-bardeen-g2q5ey` @ 2c05160; Nexus `claude_polish-ecosystem` @ 92053c8.
Method: read the diffs; drove the REAL `POST` handler of `src/routes/api/public/polish.ts` under bun
with env set (`JOURNEY_PROXY_TOKEN`, `CROSS_APP_TURN_SUBJECT`) and `fetch` stubbed.

## C10 suites -- CONFIRMED
- Huddle `bun scripts/polish-core.test.ts` -> "all passed". `npx tsc --noEmit` -> RC=0, no output.
- Nexus `cd api && npm ci --ignore-scripts && npm run build` -> RC=0, `polish: 30 passed`, other suites green.

## C1 secret before body -- CONFIRMED
Probe (bodyRead counts calls to request.json()):
- no header -> 401 `unauthorized`, bodyRead=0; wrong secret -> 401, bodyRead=0.
- route line order: authenticateCaller (polish.ts:38) precedes request.json() (polish.ts:46); same
  `authenticateCaller` import from cross-app/turn-gate.ts as run-agent-turn.ts:71.
- Note: secret with a trailing space -> 200. Not a defect: the Fetch `Headers` object trims header
  values (HTTP whitespace), so this is the same for every route on the gate.

## C2 identity -- PARTLY REFUTED (refusal has a depth/size hole; acting subject is still server-only)
- top `caller`, nested `request.X.Entra-Email`, `settings.USER` -> all 400 `caller_identity_not_accepted`.
- **Depth 9:** `{"action":"profiles","a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":{"email":"a@b"}}}}}}}}}}` -> **200**.
- **Node cap:** `{"action":"profiles","pad":[5001 x {}],"z":{"email":"a@b"}}` -> **200**.
  Cause: turn-gate.ts `MAX_SCAN_DEPTH = 8` / `MAX_SCAN_NODES = 5_000`, the walker returns null (fail-open).
  Inherited from the shared gate, not new in #148.
- Structural half HOLDS: subject = `resolveActingSubject()` (env only); `loadPolishProfiles(subject.value.entra_email)`;
  no body field reaches it. zod `z.object` strips unknown keys; `settings` (z.unknown) only goes to
  `normalizeSettings`, which reads the 8 setting keys.
