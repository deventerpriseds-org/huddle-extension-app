// One-way mirror of an artifact's bytes to the owner's OneDrive, via the EXISTING app-only Microsoft
// Graph client (client-credentials — reuses AZURE_CLIENT_ID/SECRET/TENANT_ID; no new secret). Upload is
// path-keyed (`Huddle Artifacts/{lane}/{name}`) so re-mirroring overwrites the same item — never a
// duplicate. Needs the Graph app to hold Files.ReadWrite.All application permission (admin-consented);
// without it Graph returns 403, which we surface as an actionable, NON-fatal error (never a crash).
import { getAppToken, graphEmailConfigured } from "../email/graph-email.server";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024; // Graph simple PUT /content ceiling; above this use a session
const SESSION_CHUNK = 5 * 1024 * 1024; // 5 MiB — a multiple of 320 KiB, as Graph requires for non-final chunks
const MAX_UPLOAD = 250 * 1024 * 1024; // sanity cap: the whole artifact is buffered in memory to mirror it

export interface OneDriveMirrorResult {
  ok: boolean;
  webUrl?: string;
  error?: string;
  needsConsent?: boolean; // true when the failure is a missing Files.ReadWrite.All grant (403)
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

const CONSENT_ERROR =
  "OneDrive access not granted yet — the Graph app needs the Files.ReadWrite.All application permission with admin consent.";

// Node's undici fetch accepts a Buffer/Uint8Array body at runtime; TS's DOM BodyInit union (post-5.7
// ArrayBufferLike generic) doesn't model it, so cast at the boundary. No copy.
const asBody = (b: Buffer | Uint8Array): BodyInit => b as unknown as BodyInit;

/** Upload bytes to `Huddle Artifacts/{lane}/{name}` in `mailbox`'s OneDrive; return the item's webUrl. */
export async function uploadArtifactToOneDrive(opts: {
  mailbox: string;
  lane: string;
  name: string;
  bytes: Buffer;
  mime: string;
}): Promise<OneDriveMirrorResult> {
  if (!graphEmailConfigured()) {
    return { ok: false, error: "Microsoft Graph app is not configured on the server." };
  }
  if (opts.bytes.length > MAX_UPLOAD) {
    return { ok: false, error: `Artifact is too large to mirror (>${MAX_UPLOAD / 1024 / 1024}MB).` };
  }
  let token: string;
  try {
    token = await getAppToken();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Graph token error" };
  }
  const drivePath = `Huddle Artifacts/${opts.lane}/${opts.name}`;
  const rootPrefix = `${GRAPH}/users/${encodeURIComponent(opts.mailbox)}/drive/root:/${encodePath(drivePath)}:`;
  // Small artifacts: one simple PUT. Large ones: a resumable upload session (chunked). Both are
  // path-keyed with replace semantics, so re-mirroring overwrites the same item — never a duplicate.
  return opts.bytes.length <= SIMPLE_UPLOAD_MAX
    ? simpleUpload(rootPrefix, token, opts.bytes, opts.mime)
    : sessionUpload(rootPrefix, token, opts.bytes);
}

async function simpleUpload(rootPrefix: string, token: string, bytes: Buffer, mime: string): Promise<OneDriveMirrorResult> {
  let res: Response;
  try {
    res = await fetch(`${rootPrefix}/content`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": mime || "application/octet-stream" },
      body: asBody(bytes),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "OneDrive request failed" };
  }
  if (res.status === 403) return { ok: false, needsConsent: true, error: CONSENT_ERROR };
  if (!res.ok) return { ok: false, error: `OneDrive upload failed (${res.status}): ${(await res.text()).slice(0, 160)}` };
  const item = (await res.json()) as { webUrl?: string };
  return { ok: true, webUrl: item.webUrl };
}

// Resumable upload for artifacts above the simple-PUT ceiling: create a session, then PUT sequential
// 5 MiB chunks with a Content-Range header. Intermediate chunks return 202; the final chunk returns the
// DriveItem (200/201) with the webUrl. The session's uploadUrl is pre-authenticated — no bearer header.
async function sessionUpload(rootPrefix: string, token: string, bytes: Buffer): Promise<OneDriveMirrorResult> {
  let create: Response;
  try {
    create = await fetch(`${rootPrefix}/createUploadSession`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "OneDrive session request failed" };
  }
  if (create.status === 403) return { ok: false, needsConsent: true, error: CONSENT_ERROR };
  if (!create.ok) return { ok: false, error: `OneDrive session create failed (${create.status}): ${(await create.text()).slice(0, 160)}` };
  const { uploadUrl } = (await create.json()) as { uploadUrl?: string };
  if (!uploadUrl) return { ok: false, error: "OneDrive session did not return an uploadUrl." };

  const total = bytes.length;
  for (let start = 0; start < total; start += SESSION_CHUNK) {
    const end = Math.min(start + SESSION_CHUNK, total); // exclusive
    const chunk = bytes.subarray(start, end);
    let res: Response;
    try {
      res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${end - 1}/${total}`,
        },
        body: asBody(chunk),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "OneDrive chunk upload failed" };
    }
    if (res.status === 200 || res.status === 201) {
      const item = (await res.json()) as { webUrl?: string };
      return { ok: true, webUrl: item.webUrl };
    }
    if (res.status !== 202) {
      // Best-effort cancel so a failed large upload doesn't leave a dangling session.
      try { await fetch(uploadUrl, { method: "DELETE" }); } catch { /* ignore */ }
      return { ok: false, error: `OneDrive chunk failed (${res.status}): ${(await res.text()).slice(0, 160)}` };
    }
  }
  return { ok: false, error: "OneDrive upload completed without returning an item." };
}
