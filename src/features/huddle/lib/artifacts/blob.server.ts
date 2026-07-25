// Azure Blob layer for the artifact store. Reuses the org's proven pattern (BlobServiceClient from a
// connection string + a short-lived read SAS), but the container is PRIVATE — blob bytes are only ever
// reachable through a server-minted, read-only SAS that expires in ~15 minutes. Container: huddle-artifacts.
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} from "@azure/storage-blob";

const CONTAINER = "huddle-artifacts";
const SAS_TTL_MS = 15 * 60_000; // 15-minute read window

/** Distinct, actionable error when the store is misconfigured (AC-5) — never a generic null deref. */
class ArtifactStorageNotConfigured extends Error {
  constructor() {
    super("AZURE_STORAGE_CONNECTION_STRING is not set — the artifact store cannot reach Azure Blob Storage.");
    this.name = "ArtifactStorageNotConfigured";
  }
}

function conn(): string {
  const c = (process.env.AZURE_STORAGE_CONNECTION_STRING ?? "").trim();
  if (!c) throw new ArtifactStorageNotConfigured();
  return c;
}

let _svc: BlobServiceClient | null = null;
function service(): BlobServiceClient {
  if (!_svc) _svc = BlobServiceClient.fromConnectionString(conn());
  return _svc;
}

let _ensured = false;
async function container() {
  const client = service().getContainerClient(CONTAINER);
  if (!_ensured) {
    // No `access` argument => PRIVATE container (no anonymous blob/container read). Idempotent.
    await client.createIfNotExists();
    _ensured = true;
  }
  return client;
}

/** Upload bytes to `path` with the given content-type. Overwrites (id-keyed paths are unique per artifact). */
export async function putArtifactBlob(path: string, bytes: Buffer | Uint8Array, mime: string): Promise<void> {
  const c = await container();
  const blob = c.getBlockBlobClient(path);
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  await blob.upload(data, data.length, {
    blobHTTPHeaders: { blobContentType: mime || "application/octet-stream" },
  });
}

/** Byte length of a stored blob (diagnostics / verification). */
export async function artifactBlobSize(path: string): Promise<number | null> {
  try {
    const c = await container();
    const props = await c.getBlockBlobClient(path).getProperties();
    return props.contentLength ?? null;
  } catch {
    return null;
  }
}

/**
 * A read-ONLY SAS URL for `path`, expiring in ~15 min. This is the ONLY way blob bytes are exposed —
 * the container is private, so a URL without a valid, unexpired SAS is unreachable (403/404).
 */
export function artifactSasUrl(path: string): string {
  const c = conn();
  const accountName = c.match(/AccountName=([^;]+)/)?.[1] ?? "";
  const accountKey = c.match(/AccountKey=([^;]+)/)?.[1] ?? "";
  if (!accountName || !accountKey) throw new ArtifactStorageNotConfigured();
  const cred = new StorageSharedKeyCredential(accountName, accountKey);
  const startsOn = new Date(Date.now() - 60_000); // small skew tolerance
  const expiresOn = new Date(Date.now() + SAS_TTL_MS);
  const sas = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER,
      blobName: path,
      permissions: BlobSASPermissions.parse("r"), // read only — never w/d/c
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn,
    },
    cred,
  ).toString();
  return `https://${accountName}.blob.core.windows.net/${CONTAINER}/${encodeURI(path)}?${sas}`;
}
