// WHAT:       Reads the names of the transcript files in the owner's OneDrive "Fireflies Transcripts" folder, so
//             Meetings can show "Weekly planning sync" instead of Fireflies' date-only title "Nov 10, 09:37 AM".
// WHY:        Owner, 2026-11-20 (OneDrive screenshot): "Why aren't the titles from the files on the server kept instead
//             of using the date as a title?" All 29 Meetings rows carry date-only Fireflies titles; probe run
//             44734811029 found the folder at /automation/Fireflies Transcripts in the SAME drive Huddle already
//             writes to, with 28 of 28 files named "<Mon D>- <hh-mm AM>-<descriptive name>.md".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-trinnex-named-titles.md; .github/workflows/fireflies-folder-probe.yml.
//
// FAIL-SOFT: any failure (no Graph credentials, 403, folder moved) returns an empty list, and Meetings falls back to
// the Fireflies title exactly as before. Logs carry a status code only, never a file name (names hold people).
// COST: Graph calls only; no new resource, $0 idle. Reuses the existing app-only Graph credentials (no new secret).

import { emailFromOptions, getAppToken, graphEmailConfigured } from "../email/graph-email.server";

const GRAPH = "https://graph.microsoft.com/v1.0";
/** The folder found by the probe. FIREFLIES_NAMED_FOLDER overrides it if the owner moves the folder. */
export const DEFAULT_NAMED_FOLDER = "/automation/Fireflies Transcripts";
const TTL_MS = 5 * 60 * 1000;

export interface NamedFile {
  name: string;
  createdAt: string | null;
}

let cache: { at: number; key: string; files: NamedFile[] } | null = null;

function env(name: string): string {
  return (typeof process !== "undefined" ? process.env?.[name] : undefined)?.trim() ?? "";
}

function mailbox(): string {
  return env("FIREFLIES_ONEDRIVE_MAILBOX") || emailFromOptions()[0] || "";
}

function folderPath(): string {
  const f = env("FIREFLIES_NAMED_FOLDER") || DEFAULT_NAMED_FOLDER;
  return f.replace(/^\/+|\/+$/g, "");
}

/** The file names in the named-transcripts folder (cached 5 minutes). Never throws. */
export async function listNamedTranscriptFiles(fetchImpl: typeof fetch = fetch): Promise<NamedFile[]> {
  const box = mailbox();
  const folder = folderPath();
  const key = `${box}|${folder}`;
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.files;
  if (!box || !folder || !graphEmailConfigured()) return [];
  try {
    const token = await getAppToken();
    const files: NamedFile[] = [];
    const encoded = folder.split("/").map(encodeURIComponent).join("/");
    let url: string | null =
      `${GRAPH}/users/${encodeURIComponent(box)}/drive/root:/${encoded}:/children?$top=200&$select=name,createdDateTime,file`;
    for (let page = 0; url && page < 10; page++) {
      const res: Response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        console.warn(`[trinnex] named-files list failed status=${res.status}`);
        return [];
      }
      const body = (await res.json()) as { value?: Array<{ name?: string; createdDateTime?: string; file?: unknown }>; "@odata.nextLink"?: string };
      for (const v of body.value ?? []) if (v.file && typeof v.name === "string") files.push({ name: v.name, createdAt: v.createdDateTime ?? null });
      url = body["@odata.nextLink"] ?? null;
    }
    cache = { at: Date.now(), key, files };
    return files;
  } catch (e) {
    console.warn(`[trinnex] named-files list failed kind=${e instanceof Error ? e.name : "unknown"}`);
    return [];
  }
}

/** Test seam: forget the cached listing. */
export function resetNamedFilesCache(): void {
  cache = null;
}
