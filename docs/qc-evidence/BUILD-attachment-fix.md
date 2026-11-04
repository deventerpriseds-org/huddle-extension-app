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
