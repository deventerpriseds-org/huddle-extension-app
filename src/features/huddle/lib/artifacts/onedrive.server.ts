// One-way mirror of an artifact's bytes to the owner's OneDrive, via the EXISTING app-only Microsoft
// Graph client (client-credentials — reuses AZURE_CLIENT_ID/SECRET/TENANT_ID; no new secret). Upload is
// path-keyed (`Huddle Artifacts/{lane}/{name}`) so re-mirroring overwrites the same item — never a
// duplicate. Needs the Graph app to hold Files.ReadWrite.All application permission (admin-consented);
// without it Graph returns 403, which we surface as an actionable, NON-fatal error (never a crash).
import { getAppToken, graphEmailConfigured } from "../email/graph-email.server";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024; // Graph simple PUT /content limit

export interface OneDriveMirrorResult {
  ok: boolean;
  webUrl?: string;
  error?: string;
  needsConsent?: boolean; // true when the failure is a missing Files.ReadWrite.All grant (403)
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

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
  if (opts.bytes.length > SIMPLE_UPLOAD_MAX) {
    return { ok: false, error: `Artifact is too large for OneDrive simple upload (>${SIMPLE_UPLOAD_MAX / 1024 / 1024}MB).` };
  }
  let token: string;
  try {
    token = await getAppToken();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Graph token error" };
  }
  const drivePath = `Huddle Artifacts/${opts.lane}/${opts.name}`;
  const url = `${GRAPH}/users/${encodeURIComponent(opts.mailbox)}/drive/root:/${encodePath(drivePath)}:/content`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": opts.mime || "application/octet-stream" },
      // Node's undici fetch accepts a Buffer body at runtime; TS's DOM BodyInit union (post-5.7
      // ArrayBufferLike generic) doesn't model it, so cast. No copy.
      body: opts.bytes as unknown as BodyInit,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "OneDrive request failed" };
  }
  if (res.status === 403) {
    return {
      ok: false,
      needsConsent: true,
      error:
        "OneDrive access not granted yet — the Graph app needs the Files.ReadWrite.All application permission with admin consent.",
    };
  }
  if (!res.ok) {
    return { ok: false, error: `OneDrive upload failed (${res.status}): ${(await res.text()).slice(0, 160)}` };
  }
  const item = (await res.json()) as { webUrl?: string };
  return { ok: true, webUrl: item.webUrl };
}
