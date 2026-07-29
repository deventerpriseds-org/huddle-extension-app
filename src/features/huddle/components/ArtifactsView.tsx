import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FolderOpen, FileText, FileSpreadsheet, Presentation, FileImage, File as FileIcon,
  Check, Undo2, Download, ExternalLink, Loader2, RefreshCw, Plus, Cloud, Trash2,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { AgentAvatar } from "./AgentAvatar";
import { AGENT_BY_ID, type AgentId } from "../data/agents";
import {
  listArtifactsFn, getArtifactFn, reviewArtifactFn, createArtifactFn, mirrorArtifactFn, deleteArtifactFn,
} from "../lib/artifacts/artifacts.functions";
import type { ArtifactRow } from "../lib/artifacts/artifacts.server";
import { useHuddleStore } from "../store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const LANES = ["Ventures", "Career", "Education", "Personal"];
const STATUS_FILTERS: { k: "" | ArtifactRow["status"]; label: string }[] = [
  { k: "", label: "All" },
  { k: "review", label: "Needs review" },
  { k: "approved", label: "Approved" },
  { k: "changes", label: "Changes" },
  { k: "draft", label: "Draft" },
];

const STATUS_META: Record<ArtifactRow["status"], { label: string; cls: string }> = {
  review: { label: "Needs review", cls: "text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-950/60" },
  approved: { label: "Approved", cls: "text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-950/60" },
  changes: { label: "Changes requested", cls: "text-rose-700 bg-rose-100 dark:text-rose-300 dark:bg-rose-950/60" },
  draft: { label: "Draft", cls: "text-muted-foreground bg-muted" },
};

function fileKind(name: string, mime: string) {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (["xlsx", "xls", "csv"].includes(ext) || mime.includes("sheet") || mime.includes("csv"))
    return { Icon: FileSpreadsheet, tag: ext.toUpperCase() || "XLSX", color: "#217346" };
  if (["pptx", "ppt"].includes(ext) || mime.includes("presentation"))
    return { Icon: Presentation, tag: ext.toUpperCase() || "PPTX", color: "#c43e1c" };
  if (["docx", "doc"].includes(ext) || mime.includes("word"))
    return { Icon: FileText, tag: ext.toUpperCase() || "DOCX", color: "#2b579a" };
  if (ext === "pdf" || mime.includes("pdf")) return { Icon: FileText, tag: "PDF", color: "#c4342e" };
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext) || mime.startsWith("image/"))
    return { Icon: FileImage, tag: ext.toUpperCase() || "IMG", color: "#7a44b3" };
  if (ext === "md" || mime === "text/markdown") return { Icon: FileText, tag: "MD", color: "#4b50d4" };
  return { Icon: FileIcon, tag: (ext || "FILE").toUpperCase(), color: "#64748b" };
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function ago(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

type FullArtifact = ArtifactRow & { url?: string | null };

// E2E-only fixtures — DOUBLE-GATED (Vite DEV build AND VITE_E2E_AUTH_BYPASS=1), so this whole block is
// dead-code-eliminated in the production bundle. It lets headless Playwright drive the real component
// (list → preview → review) without the dev/prod server-fn codec mismatch. The live data path
// (create/list/get/review server fns) is verified separately against the deployed prod app.
const E2E = import.meta.env.DEV && import.meta.env.VITE_E2E_AUTH_BYPASS === "1";
const E2E_ROWS: ArtifactRow[] = E2E
  ? [
      { id: "art-e1", user_email: "dev@enterpriseds.io", agent_id: "cam-post", task_id: "research-agentforce", folder: "Ventures", name: "agentforce-scan.md", mime: "text/markdown", size_bytes: 1840, blob_path: "p/art-e1", status: "review", version: 1, review_note: null, reviewed_by: null, reviewed_at: null, onedrive_url: null, gdrive_url: null, created_at: "2026-07-25T17:00:00Z", updated_at: "2026-07-25T18:00:00Z" },
      { id: "art-e2", user_email: "dev@enterpriseds.io", agent_id: "finn-reid", task_id: "market-model", folder: "Ventures", name: "market-model.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size_bytes: 4200, blob_path: "p/art-e2", status: "approved", version: 2, review_note: null, reviewed_by: "dev@enterpriseds.io", reviewed_at: "2026-07-25T17:30:00Z", onedrive_url: null, gdrive_url: null, created_at: "2026-07-25T16:00:00Z", updated_at: "2026-07-25T17:30:00Z" },
      { id: "art-e3", user_email: "dev@enterpriseds.io", agent_id: "sam-trent", task_id: "gtm", folder: "Ventures", name: "gtm-notes.md", mime: "text/markdown", size_bytes: 900, blob_path: "p/art-e3", status: "changes", version: 1, review_note: "tighten the CAC math", reviewed_by: "dev@enterpriseds.io", reviewed_at: "2026-07-25T17:10:00Z", onedrive_url: null, gdrive_url: null, created_at: "2026-07-25T15:00:00Z", updated_at: "2026-07-25T17:10:00Z" },
    ]
  : [];

export function ArtifactsView() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const [items, setItems] = useState<ArtifactRow[]>([]);
  const [folders, setFolders] = useState<{ folder: string; n: number }[]>([]);
  const [folder, setFolder] = useState<string>("");
  const [status, setStatus] = useState<"" | ArtifactRow["status"]>("");
  const [loading, setLoading] = useState(true);
  const [selId, setSelId] = useState<string | null>(null);
  const [sel, setSel] = useState<FullArtifact | null>(null);
  const [selText, setSelText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refetch = useCallback(async () => {
    if (E2E) {
      const rows = E2E_ROWS.filter((r) => (!folder || r.folder === folder) && (!status || r.status === status));
      setItems(rows);
      setFolders([{ folder: "Ventures", n: E2E_ROWS.length }]);
      setLoading(false);
      return;
    }
    if (!caller) { setLoading(false); return; }
    try {
      const res = await listArtifactsFn({
        data: { caller, folder: folder || undefined, status: status || undefined },
      });
      setItems(res.artifacts);
      setFolders(res.folders);
    } catch { /* keep prior */ }
    setLoading(false);
  }, [caller, folder, status]);

  useEffect(() => { void refetch(); }, [refetch]);

  const openArtifact = useCallback(async (id: string) => {
    if (E2E) {
      const a = E2E_ROWS.find((r) => r.id === id);
      if (a) { setSelId(id); setSel({ ...a, url: "data:text/markdown,x" }); setSelText(`# ${a.name}\n\nReal artifact preview body.`); }
      return;
    }
    if (!caller) return;
    setSelId(id);
    setSel(null);
    setSelText(null);
    try {
      const { artifact } = await getArtifactFn({ data: { caller, id } });
      setSel(artifact);
      // Fetch text content for markdown/plain/csv/json previews via the short-lived SAS.
      if (artifact?.url && /^(text\/|application\/json|application\/csv)/.test(artifact.mime)) {
        try {
          const r = await fetch(artifact.url);
          setSelText((await r.text()).slice(0, 20000));
        } catch { setSelText(null); }
      }
    } catch { /* ignore */ }
  }, [caller]);

  // A chat "Open <name>" chip sets activeArtifactId (+ view:"artifacts"); when this view receives it,
  // open that artifact by id (fresh SAS via getArtifactFn) then clear the intent so later manual
  // navigation isn't re-hijacked.
  const activeArtifactId = useHuddleStore((s) => s.activeArtifactId);
  const clearActiveArtifact = useHuddleStore((s) => s.openArtifactById);
  useEffect(() => {
    if (!activeArtifactId) return;
    void openArtifact(activeArtifactId);
    clearActiveArtifact(null);
  }, [activeArtifactId, openArtifact, clearActiveArtifact]);

  const review = useCallback(async (action: "approve" | "changes" | "reopen") => {
    if (!caller || !sel) return;
    let note: string | undefined;
    if (action === "changes") {
      note = window.prompt("What changes do you want?")?.trim() || "";
      if (!note) return;
    }
    if (E2E) {
      const next = action === "approve" ? "approved" : action === "changes" ? "changes" : "review";
      setSel((s) => (s ? { ...s, status: next, reviewed_by: "dev@enterpriseds.io" } : s));
      setItems((xs) => xs.map((x) => (x.id === sel.id ? { ...x, status: next } : x)));
      toast.success(action === "approve" ? "Approved" : action === "changes" ? "Changes requested" : "Re-opened");
      return;
    }
    setBusy(true);
    try {
      const res = await reviewArtifactFn({ data: { caller, id: sel.id, action, note } });
      if (res.ok && res.artifact) {
        setSel((s) => (s ? { ...s, ...res.artifact } : s));
        setItems((xs) => xs.map((x) => (x.id === res.artifact!.id ? { ...x, ...res.artifact! } : x)));
        toast.success(action === "approve" ? "Approved" : action === "changes" ? "Changes requested" : "Re-opened");
      } else {
        toast.error(res.error ?? "Couldn't update");
      }
    } finally { setBusy(false); }
  }, [caller, sel]);

  const mirror = useCallback(async () => {
    if (!caller || !sel) return;
    if (E2E) {
      setSel((s) => (s ? { ...s, onedrive_url: "https://onedrive.example/e2e" } : s));
      toast.success("Mirrored to OneDrive");
      return;
    }
    setBusy(true);
    try {
      const res = await mirrorArtifactFn({ data: { caller, id: sel.id, destination: "onedrive" } });
      if (res.ok) {
        setSel((s) => (s ? { ...s, onedrive_url: res.onedrive_url ?? s.onedrive_url } : s));
        toast.success("Mirrored to OneDrive");
      } else if (res.needsConsent) {
        toast.error("OneDrive access not granted yet — an admin needs to consent Files.ReadWrite.All.");
      } else {
        toast.error(res.error ?? "Couldn't mirror");
      }
    } finally { setBusy(false); }
  }, [caller, sel]);

  const remove = useCallback(async () => {
    if (!caller || !sel) return;
    if (!window.confirm(`Delete “${sel.name}”? This removes the file and its bytes — it can't be undone.`)) return;
    if (E2E) {
      setItems((xs) => xs.filter((x) => x.id !== sel.id));
      setSel(null);
      toast.success("Deleted");
      return;
    }
    setBusy(true);
    try {
      const res = await deleteArtifactFn({ data: { caller, id: sel.id } });
      if (res.ok) {
        setItems((xs) => xs.filter((x) => x.id !== sel.id));
        setSel(null);
        toast.success("Deleted");
      } else {
        toast.error(res.error ?? "Couldn't delete");
      }
    } finally { setBusy(false); }
  }, [caller, sel]);

  const newNote = useCallback(async () => {
    if (!caller) return;
    const name = window.prompt("Name the note (e.g. research-scan.md):", "note.md")?.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await createArtifactFn({
        data: {
          caller, folder: folder || "Personal", name,
          mime: "text/markdown", text: `# ${name.replace(/\.md$/, "")}\n\nWritten ${new Date().toLocaleString()}.\n`,
        },
      });
      if (res.ok) { toast.success("Artifact created"); await refetch(); if (res.id) void openArtifact(res.id); }
      else toast.error(res.error ?? "Couldn't create");
    } finally { setBusy(false); }
  }, [caller, folder, refetch, openArtifact]);

  const folderCount = (f: string) => folders.find((x) => x.folder === f)?.n ?? 0;

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* LEFT: folders + filters */}
      <aside className="hidden md:flex w-56 shrink-0 flex-col gap-5 border-r bg-muted/30 p-3 overflow-y-auto">
        <div>
          <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Folders</div>
          <button
            onClick={() => setFolder("")}
            className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              folder === "" ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted")}
          >
            <FolderOpen size={15} /> All folders
          </button>
          {LANES.map((f) => (
            <button
              key={f}
              onClick={() => setFolder(f)}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                folder === f ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted")}
            >
              <FolderOpen size={15} /> <span className="flex-1 text-left">{f}</span>
              <span className="text-xs tabular-nums opacity-70">{folderCount(f) || ""}</span>
            </button>
          ))}
        </div>
        <div>
          <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</div>
          <div className="flex flex-wrap gap-1.5 px-1">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s.k || "all"}
                onClick={() => setStatus(s.k)}
                className={cn("rounded-full border px-2.5 py-1 text-xs",
                  status === s.k ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:border-primary/50")}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-auto rounded-lg border border-dashed bg-background/60 p-3 text-[11px] leading-relaxed text-muted-foreground">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground"><Cloud size={13} /> Where things live</div>
          Stored in Azure; one click mirrors each artifact to your OneDrive &amp; Google&nbsp;Drive in a native format.
        </div>
      </aside>

      {/* CENTER: list */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <div className="text-sm text-muted-foreground">
            <span className="text-foreground font-medium">Artifacts</span>
            {folder && <> · {folder}</>}
            {status && <> · {STATUS_META[status as ArtifactRow["status"]].label}</>}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={newNote} disabled={busy}>
              <Plus size={14} /> New note
            </Button>
            <Button variant="ghost" size="icon" onClick={() => void refetch()} title="Refresh">
              <RefreshCw size={15} />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground"><Loader2 className="animate-spin" size={18} /></div>
          ) : items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
              <FolderOpen size={28} className="opacity-40" />
              <div className="text-sm">No artifacts here yet.</div>
              <div className="text-xs">Agents drop research, drafts, and reports here as they work — or add a note to try it.</div>
            </div>
          ) : (
            items.map((it) => {
              const k = fileKind(it.name, it.mime);
              const g = it.agent_id ? AGENT_BY_ID[it.agent_id as AgentId] : undefined;
              const sm = STATUS_META[it.status];
              return (
                <button
                  key={it.id}
                  onClick={() => void openArtifact(it.id)}
                  className={cn("flex w-full items-center gap-3 border-b px-4 py-3 text-left hover:bg-muted/50",
                    selId === it.id && "bg-primary/5 shadow-[inset_3px_0_0_var(--primary)]")}
                >
                  <div className="grid size-9 shrink-0 place-items-center rounded-md text-[9px] font-bold text-white" style={{ background: k.color }}>
                    {k.tag}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{it.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                      <span className="font-mono">{it.folder}</span>
                      {it.task_id && <>· <span className="truncate">from a task</span></>}
                    </div>
                  </div>
                  {g && (
                    <div className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                      <AgentAvatar agent={g} size="xs" clickable={false} /> <span className="hidden lg:inline">{g.name}</span>
                    </div>
                  )}
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", sm.cls)}>{sm.label}</span>
                  <div className="hidden shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
                    {ago(it.updated_at)}<div className="opacity-70">{fmtSize(it.size_bytes)}</div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </section>

      {/* RIGHT: preview + review */}
      <aside className="hidden w-80 shrink-0 flex-col border-l md:flex">
        {!sel ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Select an artifact to preview and review it.
          </div>
        ) : (
          <ArtifactPreview sel={sel} text={selText} busy={busy} onReview={review} onMirror={mirror} onDelete={remove} />
        )}
      </aside>
    </div>
  );
}

function ArtifactPreview({
  sel, text, busy, onReview, onMirror, onDelete,
}: { sel: FullArtifact; text: string | null; busy: boolean; onReview: (a: "approve" | "changes" | "reopen") => void; onMirror: () => void; onDelete: () => void }) {
  const k = fileKind(sel.name, sel.mime);
  const g = sel.agent_id ? AGENT_BY_ID[sel.agent_id as AgentId] : undefined;
  const sm = STATUS_META[sel.status];
  const isImg = sel.mime.startsWith("image/");
  const isPdf = sel.mime.includes("pdf");
  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-4">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-md text-[9px] font-bold text-white" style={{ background: k.color }}>{k.tag}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold leading-snug">{sel.name}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {g && <><AgentAvatar agent={g} size="xs" clickable={false} /> {g.name} ·</>}
              <span className={cn("rounded-full px-2 py-0.5 font-medium", sm.cls)}>{sm.label}</span>
            </div>
          </div>
          <button
            onClick={onDelete}
            disabled={busy}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            title="Delete this artifact"
            aria-label="Delete artifact"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isImg && sel.url ? (
          <img src={sel.url} alt={sel.name} className="max-h-72 w-full rounded-md border object-contain" />
        ) : isPdf && sel.url ? (
          <iframe src={sel.url} title={sel.name} className="h-72 w-full rounded-md border" />
        ) : text != null ? (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">{text}</pre>
        ) : (
          <div className="rounded-md border bg-muted/40 p-4 text-xs text-muted-foreground">
            {sel.url ? "Preview not available for this format — download or open it in a Drive." : "Storage not configured — no preview."}
          </div>
        )}

        <dl className="mt-4 grid grid-cols-[76px_1fr] gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Version</dt><dd>v{sel.version}</dd>
          <dt className="text-muted-foreground">Size</dt><dd className="tabular-nums">{fmtSize(sel.size_bytes)}</dd>
          <dt className="text-muted-foreground">Folder</dt><dd>{sel.folder}</dd>
          {sel.reviewed_by && (<><dt className="text-muted-foreground">Reviewed</dt><dd className="truncate">{sel.reviewed_by}</dd></>)}
        </dl>

        <div className="mt-4 rounded-lg border bg-muted/30 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Open natively</span>
            <button
              onClick={onMirror}
              disabled={busy}
              className="text-[11px] font-medium text-primary hover:underline disabled:opacity-50"
              title="Push this artifact to your OneDrive now"
            >
              {sel.onedrive_url ? "Re-mirror" : "Mirror now"}
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            <DriveLink label="Open in OneDrive" href={sel.onedrive_url} color="#126cbd" />
            <DriveLink label="Open in Google Drive" href={sel.gdrive_url} color="#1a8a49" soon="Phase 3" />
            <a
              href={sel.url ?? "#"} download={sel.name}
              className={cn("flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs", sel.url ? "hover:border-foreground/40" : "pointer-events-none opacity-50")}
            >
              <Download size={14} /> Download <span className="ml-auto font-mono text-[10px] text-muted-foreground">{k.tag}</span>
            </a>
          </div>
        </div>
      </div>

      <div className="flex gap-2 border-t p-3">
        {sel.status === "approved" ? (
          <>
            <Button className="flex-1" variant="outline" disabled><Check size={15} /> Approved</Button>
            <Button variant="outline" disabled={busy} onClick={() => onReview("reopen")}><Undo2 size={15} /> Re-open</Button>
          </>
        ) : (
          <>
            <Button className="flex-1" disabled={busy} onClick={() => onReview("approve")}><Check size={15} /> Approve</Button>
            <Button variant="outline" disabled={busy} onClick={() => onReview("changes")}>Request changes</Button>
          </>
        )}
      </div>
    </div>
  );
}

function DriveLink({ label, href, color, soon = "soon" }: { label: string; href: string | null; color: string; soon?: string }) {
  const enabled = !!href;
  return (
    <a
      href={href ?? "#"} target="_blank" rel="noreferrer"
      className={cn("flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs", enabled ? "hover:border-current" : "pointer-events-none opacity-50")}
      style={enabled ? { color } : undefined}
      title={enabled ? label : "Not yet mirrored (coming in a later phase)"}
    >
      <span className="grid size-4 place-items-center rounded text-[8px] font-bold text-white" style={{ background: color }}>▸</span>
      {label}
      {enabled ? <ExternalLink size={12} className="ml-auto" /> : <span className="ml-auto text-[10px] text-muted-foreground">{soon}</span>}
    </a>
  );
}
