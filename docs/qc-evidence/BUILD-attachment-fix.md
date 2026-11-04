# BUILD-attachment-fix

# WHAT:       running record of the "attachment button stopped working" root-cause + fix
# WHY:        owner reported 2026-11-04: "the attachment button has also stopped working" in Huddle chat
# SUPERSEDES: nothing
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   this file; branch claude_attachment-fix

## Step 0 -- branch
- `git checkout -B claude_attachment-fix origin/main` at 32f50e4.
- Attachment UI candidates (grep Paperclip|type="file"|accept=|attachment): HuddleView.tsx (20 hits),
  AgentSettingsDrawer.tsx (2), SettingsSheet.tsx (1).

## Step 1 -- trace button -> server (observation)
- Button: HuddleView.tsx:1949 `<button onClick={() => fileInputRef.current?.click()}>` (Paperclip),
  hidden input :1939 `type=file multiple accept=... className="hidden" onChange=onPickFiles`.
- onPickFiles :1547 -> fileToBase64 -> `uploadChatAttachmentFn` (lib/artifacts/attachments.functions.ts)
  -> createArtifact (folder Uploads). Turn carries `attachments:[{id,name,mime}]`; zod Input
  huddle.functions.ts:302 accepts it; `resolveAttachmentContent` :1337 resolves ids.
- Attachment code introduced 8683485 (2026-10-06). lib/artifacts/ untouched since.
- HuddleView diffs since 10-15 (#120,#115,#111,#109,#104,#98,#91,#90,#87): NO line touching the
  file input / Paperclip / onPickFiles / uploading.
- ee8f7b6 (#126) touched entra-auth + deploy-swa appsettings only (adds UAT_BYPASS_TOKEN app setting).

## Step 2 -- reproduce in dev (observation)
- `VITE_E2E_AUTH_BYPASS=1 vite dev` on origin/main 32f50e4, Playwright headless Chromium.
- Paperclip button: present, enabled, elementFromPoint at its centre = its own svg (NOT covered).
- Click -> `filechooser` event fires (multiple=true). setFiles(Test-attach.txt) -> onPickFiles runs ->
  uploadChatAttachmentFn reaches the server -> toast "AZURE_PG_URL not configured" (expected: sandbox
  has no DB). So in a DEV build the client chain button -> input -> upload -> error-toast is intact.
- Interpretation: the break is NOT a dead click handler / overlay in the dev build. Remaining suspects:
  production build/runtime differences, server side in prod, or the surface the owner uses.

## Step 3 -- ground truth: when did uploads last WORK? (observation, primary source = prod DB)
- azure-pg-query.yml run 41762762471 (job 126354030921), eds-postgresql/RAG_AI_Agents:
  - newest `artifacts.items WHERE folder='Uploads'`: **2026-10-30 12:42 UTC**, iris-chase, image/jpeg,
    516931 B, "Screenshot_20261030_084003_Huddle chat..." (an Android screenshot).
  - matching `chat.pending_turns` row with `payload ? 'attachments'`: 2026-10-30 12:42, dm-iris-chase,
    status done, n=1.
  - Uploads/day before that: 09-19, 09-15, 09-14 (3), 09-13 (2), 09-12 (3), 09-02, 08-28, 08-26 (3) ...
    All recent uploads are phone screenshots ("Screenshot_YYYYMMDD_..._<app>.jpg").
- deploy-swa.yml runs: the newest is **#476, run 40885633183, 9983343, 2026-10-29 13:50Z, success**. Nothing
  has deployed since (the only later main commit is 32f50e4 #128, CLAUDE.md only, so paths-ignore keeps
  it from triggering a deploy).
- **Inference (high confidence, from those two facts):** the build serving prod today is the SAME build
  that accepted an upload at 10-30 12:42Z. So the break is NOT a code regression in this repo's deployed
  code. None of the listed suspect commits (#126 #125 #120 #115 #113 #114 #116 #124) can be the cause,
  because all of them were live during the last success.

## Step 4 -- re-check the 2026-11-04 deploys (observation)
- origin/main now 4a4fbff (#132) after c0e8c40 (#131). `git diff --stat 9983343 origin/main -- src` touches
  only graph-email.server.ts, inbox-read.ts, huddle.functions.ts, lane-handoff.ts, tasks/tools.ts,
  realtime-tools.server.ts. HuddleView.tsx and lib/artifacts/ are untouched. The huddle.functions.ts hunks
  matching attach|Input are two new tool `inputSchema`s (inbox read), NOT the turn Input / attachments field.
- Inference: the 11-04 deploys cannot have broken the paperclip -> upload chain either.

## Step 5 -- single-check module for the live run
- Added `.claude/skills/test-agent-serverfn/scripts/attachment-checks.mjs` (filters huddle-checks to
  `attachmentButton` only; throws if the filter does not find exactly one). Loads locally: `['attachmentButton']`.
- Next: dispatch verify-uat.yml on claude_attachment-fix with checks_file=that module, desktop 1000x680,
  then phone 390x844 (sequential -- both force-push the uat-shots branch).

## Step 6 -- Android bridge file-chooser path (observation, primary source = bridge source + history)
- Cloned `deventerprisesds/android-bridge-template` (main 19d2309, pushed 2026-10-29 13:11Z).
- The Huddle APK is config `configs/8596e6c2-.../bridge.config.json` (baseUrl = the live SWA). Last Huddle
  APK build: v1.0.13, 2325a7a, 2026-10-29 13:04Z (alarm-only change; touches bridge.config.json only).
- MainActivity.kt:112 `webView.webChromeClient = BridgeWebChromeClient(this)` -- the only chrome client.
- `webview/BridgeWebChromeClient.kt` overrides onConsoleMessage, onPermissionRequest,
  onGeolocationPermissionsShowPrompt. **It has NO `onShowFileChooser`.** File history: one commit,
  00babcb 2026-06-17 "Initial commit". `grep -rn onShowFileChooser` over the whole app: 0 hits.
- No bridge-side file-pick JS interface for chat either: `@JavascriptInterface` methods include
  isBridgeApp/getFcmToken/openAlarmFilePicker (alarm sound only); Huddle's src has no AndroidBridge
  file/upload call (only FCM token, HuddleView.tsx:1286-1292).
- Android platform fact (WebChromeClient docs): the default onShowFileChooser returns false, which
  cancels the `<input type=file>` request -- no picker, no error, nothing on screen.
- **Inference (high confidence):** inside the Huddle Android APK the paperclip tap has NEVER been able to
  open a picker -- this is by construction since 2026-06-17, not a regression. Every recorded upload
  (all Android screenshots, last 10-30 12:42Z) must therefore have come from a browser on the phone
  (Chrome), not the APK. If the owner's 11-04 attempt was from the Huddle APK (or the Journey Voice APK,
  same template), that alone explains "stopped working". NOT yet confirmed which surface the owner used.
