// WHAT:       Settings "Download" tab: newest Huddle and TaskOS phone builds with Download buttons, plus the
//             version installed on this phone when opened inside the Huddle app.
// WHY / EVIDENCE: see ../lib/downloads/app-downloads.ts. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { getAppDownloadsFn } from "../lib/downloads/app-downloads.functions";
import { compareVersions, type DownloadRow } from "../lib/downloads/app-downloads";

/** This web app is the Huddle phone app when it runs inside the Android bridge. */
const THIS_APP_KEY = "huddle";

function installedVersion(): string | null {
  try {
    const raw = (window as any).AndroidBridge?.getCapabilities?.();
    const v = raw ? JSON.parse(raw)?.version : null;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

const REASONS: Record<string, string> = {
  sign_in_required: "Sign in to see download links.",
  not_configured: "The download service is not set up yet.",
  bridge_unreachable: "The build server did not answer. Try again in a minute.",
};

export function AppDownloadsPanel() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const [rows, setRows] = useState<DownloadRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const installed = typeof window !== "undefined" ? installedVersion() : null;

  const load = useCallback(async () => {
    if (!caller) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getAppDownloadsFn({ data: { caller } });
      if (res.ok) setRows(res.apps);
      else { setRows(null); setError(REASONS[res.reason] ?? "Could not load the latest builds."); }
    } catch {
      setRows(null);
      setError("Could not load the latest builds.");
    }
    setLoading(false);
  }, [caller]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Download</h3>
          <p className="text-xs text-muted-foreground">Latest Android builds. Each link is fresh for 30 days.</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void load()} disabled={loading || !caller} aria-label="Refresh">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!rows && !error && <p className="text-sm text-muted-foreground">{caller ? "Loading…" : "Sign in to see download links."}</p>}
      {rows?.map((r) => {
        const mine = r.key === THIS_APP_KEY && installed;
        const behind = mine && r.version ? compareVersions(installed!, r.version) < 0 : false;
        return (
          <div key={r.key} className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                {r.name}
                {r.version && <span className="rounded bg-muted px-1.5 py-0.5 text-xs">v{r.version}</span>}
                {behind && <span className="rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">Update available</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                {r.found
                  ? [r.builtAt && `Built ${new Date(r.builtAt).toLocaleDateString()}`,
                     r.sizeBytes && `${(r.sizeBytes / 1048576).toFixed(1)} MB`,
                     mine && `Installed here: v${installed}`].filter(Boolean).join(" · ")
                  : "No build found."}
              </p>
            </div>
            {r.downloadUrl && (
              <Button asChild size="sm">
                <a href={r.downloadUrl} rel="noopener noreferrer"><Download className="mr-1 h-4 w-4" />Download</a>
              </Button>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        On the phone, the download opens in your browser. Open the file when it finishes and allow installs from this source if Android asks.
      </p>
    </div>
  );
}
