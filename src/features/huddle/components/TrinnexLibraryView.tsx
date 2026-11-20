// WHAT:       "Trinnex Library", an app in the Apps launcher: add work files and transcripts, see each one move
//             Uploaded -> Read -> Split -> Facts -> Searchable from the SERVER's status, filter and search the
//             library, map transcript speakers, and remove an item from memory after an in-page confirmation.
// WHY:        the owner-approved prototype docs/trinnex/prototype/library.html, built as a real view.
//             AC-trinnex-workspace.md section 2 (AC-L1..L13). Anatomy copied from PolishView.tsx (ai-soft icon
//             tile + 17px title; right-side Sheet max 440px). Tokens only: no invented colours or radii.
// SUPERSEDES: the prototype page (never shipped).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-trinnex-library.md. NOT yet looked at on a phone: see BUILD "unverified UI".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, AudioLines, CheckCircle2, FileText, Library, Plus, RotateCcw, Search, Sparkles, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useHuddleStore } from "../store";
import {
  ACCEPTED_EXTS,
  FAIL_LABEL,
  type FailReason,
  factsFailureNotice,
  type LibraryKind,
  MAX_UPLOAD_BYTES,
  STEPS,
  extOf,
  guessKind,
  isInFlight,
  parseCues,
  parseTextTranscript,
  partitionFiles,
  speakerStats,
  stepIndex,
  suggestCategory,
  type SpeakerStat,
} from "../lib/trinnex/library-core";
import { matchSpeaker, speakerKey, suggestNames } from "../lib/trinnex/names";
import type { LibraryItem } from "../lib/trinnex/library.server";
import {
  type LibraryListing,
  listTrinnexLibraryFn,
  processTrinnexFileFn,
  removeTrinnexFileFn,
  retryTrinnexFileFn,
  setTrinnexSpeakersFn,
  uploadTrinnexFileFn,
} from "../lib/trinnex/library.functions";

const KIND_LABEL: Record<LibraryKind, string> = { document: "Document", transcript: "Meeting transcript" };

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
const today = () => new Date().toISOString().slice(0, 10);

function ownerFirstName(email: string | undefined): string {
  const local = String(email ?? "").split("@")[0].split(/[._-]/)[0];
  return local ? local[0].toUpperCase() + local.slice(1) : "";
}

async function toBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

interface Pending {
  pid: string;
  file: File;
  kind: LibraryKind;
  category: string;
  suggested: string;
  date: string;
  participants: string[];
  names: string[];
  speakers: SpeakerStat[];
  speakerMap: Record<string, string>;
  busy: boolean;
}

function statusChip(item: LibraryItem) {
  if (item.status === "searchable") {
    // AC-C5: passages are searchable, but say so when the facts could not be extracted (quota named).
    const notice = factsFailureNotice(item.failReason);
    return notice
      ? { cls: "bg-band-cream text-warning-foreground", text: `Searchable · ${notice}` }
      : { cls: "bg-ai-soft text-ai", text: "Searchable" };
  }
  if (item.status === "waiting_memory") return { cls: "bg-muted text-muted-foreground", text: "Waiting for Trinnex memory" };
  if (item.status === "failed")
    return { cls: "bg-destructive/10 text-destructive", text: `Failed: ${item.failedStep ?? "step"} (${FAIL_LABEL[item.failReason as FailReason] ?? item.failReason ?? "error"})` };
  if (item.status === "remove_incomplete") return { cls: "bg-destructive/10 text-destructive", text: "Removal incomplete" };
  if (item.status === "removing") return { cls: "bg-muted text-muted-foreground", text: "Removing" };
  return { cls: "bg-muted text-muted-foreground", text: `${STEPS[Math.max(0, stepIndex(item.status))]}…` };
}

function Stepper({ item }: { item: LibraryItem }) {
  const at = stepIndex(item.status);
  return (
    <ol aria-label="Processing steps" className="grid grid-cols-1 gap-1.5 sm:grid-cols-5">
      {STEPS.map((s, i) => {
        const done = at > i || item.status === "searchable";
        const active = at === i && item.status !== "searchable";
        return (
          <li key={s} aria-current={active ? "step" : undefined} className={cn("flex flex-col gap-1 text-xs", done ? "text-foreground" : active ? "font-semibold text-ai" : "text-muted-foreground")}>
            <span className="h-1 overflow-hidden rounded-full bg-secondary">
              <span className={cn("block h-full bg-ai transition-all", done || active ? "w-full" : "w-0")} />
            </span>
            {s}
          </li>
        );
      })}
    </ol>
  );
}

export function TrinnexLibraryView() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const owner = ownerFirstName(user?.username);
  const setView = useHuddleStore((s) => s.setView);
  const [data, setData] = useState<LibraryListing>({ items: [], categories: [], people: [], firefliesWaiting: null, memoryReady: false });
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Pending[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!caller) return setLoading(false);
    try {
      setData(await listTrinnexLibraryFn({ data: { caller } }));
    } finally {
      setLoading(false);
    }
  }, [caller]);
  useEffect(() => void load(), [load]);

  // Poll ONLY while the server still has work on an item (status is the server's, not a client timer: AC-L6).
  const inFlight = data.items.some((i) => isInFlight(i.status));
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  const ctx = useMemo(() => ({ people: data.people, owner }), [data.people, owner]);

  async function addFiles(list: FileList | null) {
    const { accepted, rejected: bad } = partitionFiles(Array.from(list ?? []));
    const tooBig = accepted.filter((f) => f.size > MAX_UPLOAD_BYTES);
    setRejected([...bad, ...tooBig.map((f) => `${f.name} (over 25 MB)`)]);
    const fresh: Pending[] = [];
    for (const file of accepted.filter((f) => f.size <= MAX_UPLOAD_BYTES)) {
      const kind = guessKind(file.name);
      let speakers: SpeakerStat[] = [];
      const speakerMap: Record<string, string> = {};
      if (kind === "transcript") {
        const text = await file.text().catch(() => "");
        const e = extOf(file.name);
        const cues = e === "vtt" || e === "srt" ? parseCues(text) : parseTextTranscript(text);
        speakers = speakerStats(cues, speakerKey);
        for (const s of speakers) {
          const m = matchSpeaker(s.label, ctx);
          // Every label is kept (unmapped = "", stored raw) so it can be mapped later from the drawer (AC-L5).
          speakerMap[s.label] = m.kind === "person" ? m.person : ""; // pre-mapped, still editable (S-B5)
        }
      }
      const suggested = suggestCategory(file.name, data.categories);
      seq.current += 1;
      fresh.push({
        pid: `p${seq.current}`, file, kind, category: suggested, suggested, date: today(), participants: [],
        names: suggestNames(file.name, ctx).map((n) => n.name), speakers, speakerMap, busy: false,
      });
    }
    setPending((p) => [...p, ...fresh]);
  }

  const patch = (pid: string, p: Partial<Pending>) => setPending((all) => all.map((x) => (x.pid === pid ? { ...x, ...p } : x)));

  async function save(p: Pending, replace = false) {
    if (!caller) return;
    patch(p.pid, { busy: true });
    const res = await uploadTrinnexFileFn({
      data: {
        caller, name: p.file.name, kind: p.kind, category: p.category, participants: p.participants,
        speakerMap: p.speakerMap,
        docDate: p.date || null, base64: await toBase64(p.file), replace,
      },
    }).catch(() => ({ error: "storage_error" }) as { error: string });
    if ("duplicateOf" in res && res.duplicateOf) {
      patch(p.pid, { busy: false });
      if (window.confirm(`"${res.duplicateOf.name}" is already in your library. Replace it?`)) return save(p, true);
      return;
    }
    if (!("item" in res) || !res.item) {
      patch(p.pid, { busy: false });
      toast.error(`Not added: ${FAIL_LABEL[(res as { error?: string }).error as FailReason] ?? "could not save"}`);
      return;
    }
    setPending((all) => all.filter((x) => x.pid !== p.pid));
    await load();
    void processTrinnexFileFn({ data: { caller, id: res.item.id } }).finally(() => void load());
  }

  const items = data.items;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.category, (m.get(i.category) ?? 0) + 1);
    return m;
  }, [items]);
  const shown = items.filter((i) => {
    if (filter !== "All" && i.category !== filter) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [i.name, i.category, ...i.participants].some((s) => s.toLowerCase().includes(q));
  });
  const open = items.find((i) => i.id === openId) ?? null;

  async function remove(item: LibraryItem) {
    if (!caller) return;
    const r = await removeTrinnexFileFn({ data: { caller, id: item.id } });
    setConfirmRemove(false);
    if (r.removed) {
      toast.success("Removed from Trinnex memory");
      setOpenId(null);
    } else toast.error(`Removal incomplete: ${r.remaining.join(" and ") || "try again"} still there. Retry Remove.`);
    await load();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background px-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] pt-2.5 md:px-5 md:pt-4">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <header className="flex items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ai-soft text-ai">
            <Library size={16} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-[17px] font-semibold tracking-tight">Trinnex Library</h1>
            <p className="text-[13px] text-muted-foreground">
              Work files and transcripts Iris and Eli can search, with sources. Kept apart from your personal memory.
            </p>
          </div>
        </header>

        {!data.memoryReady && !loading && (
          <p role="status" className="rounded-lg bg-muted px-3 py-2 text-[13px] text-muted-foreground">
            Trinnex memory is not set up yet. Files are stored and read now, and become searchable once it is.
          </p>
        )}

        {data.firefliesWaiting !== null && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3">
            <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-foreground"><AudioLines size={16} aria-hidden /></span>
            <span className="min-w-0 flex-1 text-sm">
              <span className="font-semibold">Fireflies meetings</span>
              <span className="block text-xs text-muted-foreground">
                {data.firefliesWaiting} waiting for triage. Meetings join Trinnex after you triage them.
              </span>
            </span>
            <button type="button" onClick={() => setView("actions")} className="text-sm font-medium text-primary hover:underline">
              Open Meetings
            </button>
          </div>
        )}

        <section aria-label="Add material" className="flex flex-col gap-2">
          <div
            onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); void addFiles(e.dataTransfer.files); }}
            className={cn("flex flex-col items-center gap-2 rounded-xl border-[1.5px] border-dashed border-border bg-surface-2 px-4 py-6 text-center", over && "border-ai bg-ai-soft")}
          >
            <Upload size={22} className="text-muted-foreground" aria-hidden />
            <p className="text-sm">Drop files here, or</p>
            <button type="button" onClick={() => inputRef.current?.click()} className="min-h-10 rounded-full border border-border bg-card px-4 text-[13px] font-semibold hover:bg-muted md:min-h-9">
              Choose files
            </button>
            <p className="text-xs text-muted-foreground">{ACCEPTED_EXTS.map((e) => `.${e}`).join(" ")} · up to 25 MB each</p>
            <input ref={inputRef} type="file" multiple hidden accept={ACCEPTED_EXTS.map((e) => `.${e}`).join(",")} onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
          </div>
          {rejected.length > 0 && (
            <p role="alert" className="inline-flex items-center gap-1.5 text-[13px] text-destructive">
              <AlertTriangle size={14} aria-hidden /> Not added, unsupported type: {rejected.join(", ")}
            </p>
          )}
          {pending.map((p) => (
            <PendingForm key={p.pid} p={p} categories={data.categories} people={data.people} owner={owner}
              onPatch={(x) => patch(p.pid, x)} onDiscard={() => setPending((a) => a.filter((x) => x.pid !== p.pid))} onSave={() => void save(p)} />
          ))}
        </section>

        <section aria-label="Your library" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-0 flex-[1_1_220px]">
              <span className="sr-only">Search the library</span>
              <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search names, categories, people"
                className="h-10 w-full rounded-lg border border-input bg-card pl-8 pr-3 text-sm md:h-9" />
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
            {["All", ...data.categories.filter((c) => counts.has(c))].map((c) => (
              <button key={c} type="button" aria-pressed={filter === c} onClick={() => setFilter(c)}
                className={cn("min-h-8 rounded-full border px-3 text-[12.5px] font-medium", filter === c ? "border-ai/40 bg-ai-soft text-ai" : "border-hairline bg-surface-2 hover:bg-muted")}>
                {c} <span className="tabular-nums text-muted-foreground">{c === "All" ? items.length : counts.get(c)}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-col rounded-xl border border-border bg-card">
            {loading ? (
              <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : shown.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">{items.length ? "Nothing matches." : "Nothing here yet. Add a file above."}</p>
            ) : (
              shown.map((i) => {
                const chip = statusChip(i);
                return (
                  <button key={i.id} type="button" onClick={() => { setOpenId(i.id); setConfirmRemove(false); }}
                    className="grid w-full grid-cols-[32px_minmax(0,1fr)] items-center gap-2.5 border-t border-border px-2.5 py-2.5 text-left first:border-t-0 hover:bg-surface-2 sm:grid-cols-[32px_minmax(0,1fr)_auto]">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                      {i.kind === "transcript" ? <AudioLines size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{i.name}</span>
                      <span className="flex flex-wrap gap-x-2.5 text-xs text-muted-foreground">
                        <span>{i.category}</span><span>{KIND_LABEL[i.kind]}</span><span>{fmtSize(i.sizeBytes)}</span>
                        {i.status === "searchable" && <span className="tabular-nums">{i.chunks} passages, {i.facts} facts</span>}
                      </span>
                    </span>
                    <span className={cn("col-start-2 justify-self-start rounded-full px-2 py-0.5 text-xs font-medium sm:col-start-3", chip.cls)}>{chip.text}</span>
                  </button>
                );
              })
            )}
          </div>
        </section>
      </div>

      <Sheet open={!!open} onOpenChange={(o) => { if (!o) { setOpenId(null); setConfirmRemove(false); } }}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]">
          {open && (
            <>
              <div className="flex flex-col gap-1.5 border-b border-hairline px-5 py-4 pr-12">
                <SheetTitle className="truncate text-base">{open.name}</SheetTitle>
                <SheetDescription>{KIND_LABEL[open.kind]} · {open.category} · {fmtSize(open.sizeBytes)}</SheetDescription>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
                <Stepper item={open} />
                <p className={cn("w-fit rounded-full px-2 py-0.5 text-xs font-medium", statusChip(open).cls)}>{statusChip(open).text}</p>
                {open.status === "searchable" && <p className="text-sm tabular-nums">{open.chunks} passages, {open.facts} facts</p>}
                {open.participants.length > 0 && <p className="text-sm"><span className="text-muted-foreground">People: </span>{open.participants.join(", ")}</p>}
                {open.kind === "transcript" && (
                  <DrawerSpeakers item={open} people={data.people} onSave={async (map, participants) => {
                    if (!caller) return;
                    const r = await setTrinnexSpeakersFn({ data: { caller, id: open.id, speakerMap: map, participants } });
                    toast[r.ok ? "success" : "error"](r.ok ? "Speakers saved. Passages will be updated." : "Speakers not saved");
                    await load();
                  }} />
                )}
                {confirmRemove && (
                  <div role="alertdialog" aria-label="Confirm remove" className="flex flex-col gap-2 rounded-xl border border-destructive bg-destructive/5 p-3">
                    <p className="text-sm font-semibold">Remove "{open.name}" from Trinnex memory?</p>
                    <p className="text-[13px] text-muted-foreground">Its passages and facts are deleted, and the stored copy of the file is deleted too. Your own original file is not touched.</p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => void remove(open)} className="min-h-9 rounded-lg bg-destructive px-3 text-[13px] font-semibold text-primary-foreground">Remove</button>
                      <button type="button" onClick={() => setConfirmRemove(false)} className="min-h-9 rounded-lg border border-border px-3 text-[13px]">Keep it</button>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2 border-t border-hairline px-5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
                {(open.status === "failed" || open.status === "waiting_memory") && (
                  <button type="button" onClick={async () => { if (caller) { await retryTrinnexFileFn({ data: { caller, id: open.id } }); void processTrinnexFileFn({ data: { caller, id: open.id } }).finally(() => void load()); await load(); } }}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium hover:bg-muted">
                    <RotateCcw size={14} aria-hidden /> Retry
                  </button>
                )}
                <button type="button" onClick={() => setConfirmRemove(true)} disabled={open.status === "removing"}
                  className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-destructive/40 px-3 text-[13px] font-medium text-destructive hover:bg-destructive/5">
                  <Trash2 size={14} aria-hidden /> {open.status === "remove_incomplete" ? "Retry remove" : "Remove from memory"}
                </button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function PeopleInput({ value, onChange, people, suggestions }: { value: string[]; onChange: (v: string[]) => void; people: string[]; suggestions: string[] }) {
  const [draft, setDraft] = useState("");
  const addName = (n: string) => {
    const v = n.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!v || value.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    onChange([...value, v]);
  };
  const left = suggestions.filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()));
  const listId = useMemo(() => `people-${Math.random().toString(36).slice(2)}`, []);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-input bg-card px-1.5 py-1">
        {value.map((n) => (
          <span key={n} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
            {n}
            <button type="button" aria-label={`Remove ${n}`} onClick={() => onChange(value.filter((x) => x !== n))}><X size={12} /></button>
          </span>
        ))}
        <input list={listId} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a person"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addName(draft); setDraft(""); } }}
          className="h-7 min-w-[100px] flex-1 bg-transparent text-sm outline-none" />
        <datalist id={listId}>{people.map((p) => <option key={p} value={p} />)}</datalist>
      </div>
      {left.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="From the file name">
          <span className="text-xs text-muted-foreground">From the file name</span>
          {left.map((n) => (
            <button key={n} type="button" onClick={() => addName(n)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-ai px-2 py-0.5 text-xs font-medium text-ai">
              <Plus size={12} aria-hidden /> {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SpeakerRows({ speakers, map, people, onChange }: { speakers: SpeakerStat[]; map: Record<string, string>; people: string[]; onChange: (m: Record<string, string>) => void }) {
  const taken = Object.values(map).filter(Boolean);
  const dup = taken.length !== new Set(taken.map((t) => t.toLowerCase())).size;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-muted-foreground">Speakers</span>
      {speakers.length === 0 && <p className="text-xs text-muted-foreground">No speaker labels found in this file.</p>}
      {speakers.map((s) => (
        <div key={s.label} className="grid grid-cols-1 gap-1 rounded-lg bg-surface-2 p-2 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center">
          <span className="min-w-0 text-xs">
            <span className="font-semibold">{s.label}</span>
            <span className="text-muted-foreground"> · {s.lines} lines · {s.talkPct}%</span>
            <span className="block truncate text-muted-foreground">"{s.sample}"</span>
          </span>
          <input aria-label={`Who is ${s.label}`} list="trinnex-speaker-people" value={map[s.label] ?? ""} placeholder="Who is this?"
            onChange={(e) => onChange({ ...map, [s.label]: e.target.value.slice(0, 80) })}
            className="h-8 rounded-md border border-input bg-card px-2 text-sm" />
        </div>
      ))}
      <datalist id="trinnex-speaker-people">{people.map((p) => <option key={p} value={p} />)}</datalist>
      {dup && <p className="text-xs text-muted-foreground">Two labels mapped to one person. Fireflies sometimes splits one person; that is allowed.</p>}
    </div>
  );
}

function PendingForm({ p, categories, people, owner, onPatch, onDiscard, onSave }: {
  p: Pending; categories: string[]; people: string[]; owner: string;
  onPatch: (x: Partial<Pending>) => void; onDiscard: () => void; onSave: () => void;
}) {
  const isNew = !!p.category.trim() && !categories.some((c) => c.toLowerCase() === p.category.trim().toLowerCase());
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3">
      <div className="flex min-w-0 items-center gap-2">
        {p.kind === "transcript" ? <AudioLines size={16} className="text-muted-foreground" aria-hidden /> : <FileText size={16} className="text-muted-foreground" aria-hidden />}
        <span className="min-w-0 truncate text-sm font-semibold">{p.file.name}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{fmtSize(p.file.size)}</span>
        <button type="button" aria-label={`Discard ${p.file.name}`} onClick={onDiscard} className="ml-auto rounded-md p-1 hover:bg-muted"><X size={14} /></button>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">Type
          <select value={p.kind} onChange={(e) => onPatch({ kind: e.target.value as LibraryKind })} className="h-9 rounded-lg border border-input bg-card px-2 text-sm font-normal text-foreground">
            <option value="document">Document</option><option value="transcript">Meeting transcript</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">Category
          <input list={`cats-${p.pid}`} value={p.category} maxLength={60} onChange={(e) => onPatch({ category: e.target.value })} className="h-9 rounded-lg border border-input bg-card px-2 text-sm font-normal text-foreground" />
          <datalist id={`cats-${p.pid}`}>{categories.map((c) => <option key={c} value={c} />)}</datalist>
          <span className={cn("font-normal", isNew ? "text-ai" : "text-muted-foreground")}>{isNew ? "New category. It will be offered for future files." : "Pick one you already use, or type a new one."}</span>
          {p.suggested !== p.category && (
            <button type="button" onClick={() => onPatch({ category: p.suggested })} className="inline-flex w-fit items-center gap-1 rounded-full bg-ai-soft px-2 py-0.5 font-medium text-ai">
              <Sparkles size={12} aria-hidden /> Suggested: {p.suggested}
            </button>
          )}
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-muted-foreground">Date
          <input type="date" value={p.date} onChange={(e) => onPatch({ date: e.target.value })} className="h-9 rounded-lg border border-input bg-card px-2 text-sm font-normal text-foreground" />
        </label>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-muted-foreground">People</span>
        <PeopleInput value={p.participants} onChange={(v) => onPatch({ participants: v })} people={people.filter((x) => x !== owner)} suggestions={p.names} />
      </div>
      {p.kind === "transcript" && (
        <SpeakerRows speakers={p.speakers} map={p.speakerMap} people={[owner, ...people].filter(Boolean)} onChange={(m) => onPatch({ speakerMap: m })} />
      )}
      <div className="flex justify-end">
        <button type="button" disabled={p.busy} onClick={onSave} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-[13px] font-semibold text-primary-foreground disabled:opacity-60 md:min-h-9">
          <CheckCircle2 size={14} aria-hidden /> {p.busy ? "Adding…" : "Add to Trinnex"}
        </button>
      </div>
    </div>
  );
}

function DrawerSpeakers({ item, people, onSave }: { item: LibraryItem; people: string[]; onSave: (m: Record<string, string>, participants: string[]) => Promise<void> }) {
  const [map, setMap] = useState<Record<string, string>>(item.speakerMap);
  useEffect(() => setMap(item.speakerMap), [item.id, item.speakerMap]);
  const labels: SpeakerStat[] = Object.keys(item.speakerMap).map((label) => ({ label, lines: 0, talkPct: 0, sample: "", sampleAt: 0 }));
  if (!labels.length) return <p className="text-xs text-muted-foreground">Speakers were not mapped at upload. Re-add the file to map them.</p>;
  return (
    <div className="flex flex-col gap-2">
      <SpeakerRows speakers={labels} map={map} people={people} onChange={setMap} />
      <button type="button" onClick={() => void onSave(map, item.participants)}
        className="w-fit rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium hover:bg-muted">Save speakers</button>
    </div>
  );
}
