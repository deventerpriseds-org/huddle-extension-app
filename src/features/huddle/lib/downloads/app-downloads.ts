// WHAT:       The apps on Huddle's Settings "Download" tab and how bridge-builder's getLatestApk answer becomes
//             the rows the tab shows. Same rules as journey-voice supabase/functions/_shared/app-downloads.ts
//             (separate repos, so the small shaper is mirrored rather than shared).
// WHY:        Owner request 2026-11-10: latest Huddle and TaskOS APK links in each app's Settings. Stored links
//             expire after 30 days and the blob store is private, so a fresh link is fetched each time.
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   deventerprisesds/bridge-builder#2.

export const DOWNLOAD_APPS = [
  { key: "huddle", name: "Huddle", appId: "8596e6c2-05d5-45c2-9d32-18e03be31471" },
  { key: "taskos", name: "TaskOS", appId: "54beaa01-7564-417f-a6cc-bd9190c14dcb" },
] as const;

export const DEFAULT_BRIDGE_BUILDER_API_URL = "https://bridge-builder-api.azurewebsites.net";

export interface DownloadRow {
  key: string;
  name: string;
  found: boolean;
  version: string | null;
  builtAt: string | null;
  sizeBytes: number | null;
  downloadUrl: string | null;
}

/** Only a signed https Azure blob link is ever handed to the page. */
export function isBlobLink(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    const p = new URL(u);
    return p.protocol === "https:" && p.hostname.endsWith(".blob.core.windows.net") && p.search.includes("sig=");
  } catch {
    return false;
  }
}

/** One row per DOWNLOAD_APPS entry, in that order, whatever bridge-builder returned. */
export function shapeDownloads(apps: unknown): DownloadRow[] {
  const list: any[] = Array.isArray(apps) ? apps : [];
  return DOWNLOAD_APPS.map((a) => {
    const hit = list.find((x) => x && typeof x.appId === "string" && x.appId.toLowerCase() === a.appId);
    const url = hit?.found && isBlobLink(hit.downloadUrl) ? (hit.downloadUrl as string) : null;
    return {
      key: a.key,
      name: a.name,
      found: !!url,
      version: url && typeof hit.version === "string" ? hit.version : null,
      builtAt: url && typeof hit.builtAt === "string" ? hit.builtAt : null,
      sizeBytes: url && Number.isFinite(hit.sizeBytes) ? hit.sizeBytes : null,
      downloadUrl: url,
    };
  });
}

/** -1 / 0 / 1, numeric per dotted part ("1.0.9" < "1.0.10"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
