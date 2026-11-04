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
