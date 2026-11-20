// WHAT:       The Meetings module (Modules launcher): your Fireflies meetings, and for one meeting the triage form --
//             title, series, participants (from the title, the invite and the voices), who each voice is, who owns each
//             action item, the optional title suffix and OneDrive rename, and Save with or without Trinnex memory.
// WHY:        Owner-approved prototype docs/trinnex/prototype/meetings.html; AC-trinnex-workspace.md section 1.
//             Built from the app's own parts: WidgetPage + CollapsibleSection (ActionsView's frame), the dropdown,
//             sonner toasts, tokens only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-trinnex-meetings.md.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CollapsibleSection, WidgetPage } from "./JourneyWidgets";
import { PeopleMenuItems, usePeople } from "./PeoplePicker";
import { getTrinnexMeetingFn, listTrinnexMeetingsFn, saveTrinnexMeetingFn } from "../lib/trinnex/meetings.functions";
import { MEETING_TITLE_MAX, SERIES_MAX, fullTitle, splitWarnings } from "../lib/trinnex/meeting-triage-core";
import type { MeetingDetail, MeetingListItem } from "../lib/trinnex/meetings.server";

type Pick = { kind: "person"; name: string } | { kind: "skip" };

const fieldCls = "h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const chipCls = "inline-flex min-h-[32px] items-center gap-1 rounded-full border border-hairline bg-surface px-2.5 text-xs text-foreground";
const btnCls = "inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50";

function niceDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Ask for a new name, persist it, return the stored spelling (AC-T14). */
async function promptNewName(add: (n: string) => Promise<string | null>): Promise<string | null> {
  const raw = typeof window !== "undefined" ? window.prompt("New name") : null;
  if (!raw || !raw.trim()) return null;
  const n = await add(raw);
  if (n) toast(`Added ${n} to your people list.`);
  return n;
}

function PersonDropdown({
  label,
  owner,
  people,
  add,
  onPick,
  extra,
  testId,
}: {
  label: string;
  owner: string | null;
  people: string[];
  add: (n: string) => Promise<string | null>;
  onPick: (name: string) => void;
  extra?: React.ReactNode;
  testId?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(btnCls, "h-8 border border-input bg-background px-2.5 text-xs")} data-testid={testId}>
          <span className="max-w-[160px] truncate">{label}</span>
          <ChevronDown size={12} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <PeopleMenuItems
          owner={owner}
          people={people}
          onPick={onPick}
          onAddNew={() => void promptNewName(add).then((n) => n && onPick(n))}
          testId={testId}
        />
        {extra}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MeetingsView() {
  const { owner, people, add, caller } = usePeople();
  const [list, setList] = useState<MeetingListItem[] | null>(null);
  const [series, setSeries] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!caller) return;
    const r = await listTrinnexMeetingsFn({ data: { caller } }).catch(() => null);
    if (!r || !r.ok) return setError(r && !r.ok ? r.error : "Couldn't load your meetings.");
    setError(null);
    setList(r.meetings);
    setSeries(r.series);
  }, [caller]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = list?.filter((m) => !m.triaged) ?? [];
  const done = list?.filter((m) => m.triaged) ?? [];
  const row = (m: MeetingListItem) => (
    <button
      key={m.meetingId}
      type="button"
      data-testid="meeting-row"
      onClick={() => setSelected(m.meetingId)}
      className={cn(
        "flex min-h-[44px] w-full flex-col items-start gap-0.5 border-b border-hairline px-3 py-2 text-left transition hover:bg-muted/50 sm:px-6",
        selected === m.meetingId && "bg-muted",
      )}
    >
      <span className="w-full truncate text-sm text-foreground">{m.title}</span>
      <span className="text-xs text-muted-foreground">
        {niceDate(m.meetingAt)}
        {m.series ? ` · ${m.series}` : ""}
        {m.trinnexState === "ingested" ? " · In Trinnex memory" : m.trinnexState === "queued" ? " · Queued" : ""}
      </span>
      {m.factsNotice && <span className="text-xs text-warning-foreground">{m.factsNotice}</span>}
    </button>
  );

  return (
    <WidgetPage title="Meetings" subtitle={list ? `${open.length} to triage` : null}>
      {error && <p className="px-3 py-3 text-sm text-destructive sm:px-6">{error}</p>}
      {!list && !error && <p className="px-3 py-3 text-sm text-muted-foreground sm:px-6">Loading…</p>}
      {list && (
        // Two columns only when THIS page is wide enough (a container query on the page, not the screen): with the
        // sidebar and context panel open, a 1000px screen left the detail one word wide (UAT 2026-11-20, run
        // 44705323308). Below 42rem of page width it behaves like the phone: list, then detail with a back button.
        <div className="@container flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col @2xl:flex-row">
          <div className={cn("min-w-0 @2xl:w-[320px] @2xl:shrink-0 @2xl:border-r @2xl:border-hairline", selected && "app-hidden @2xl:block")}>
            <CollapsibleSection id="meetings-open" label="Needs triage" count={open.length}>
              {open.length ? open.map(row) : <p className="px-3 py-2 text-xs text-muted-foreground sm:px-6">Nothing to triage.</p>}
            </CollapsibleSection>
            <CollapsibleSection id="meetings-done" label="Triaged" count={done.length} defaultOpen={false}>
              {done.map(row)}
            </CollapsibleSection>
          </div>
          <div className={cn("min-w-0 flex-1", !selected && "app-hidden @2xl:block")}>
            {selected ? (
              <MeetingTriage
                key={selected}
                meetingId={selected}
                seriesOptions={series}
                owner={owner}
                people={people}
                add={add}
                onBack={() => setSelected(null)}
                onSaved={() => void load()}
              />
            ) : (
              <p className="px-6 py-6 text-sm text-muted-foreground">Pick a meeting to triage it.</p>
            )}
          </div>
        </div>
        </div>
      )}
    </WidgetPage>
  );
}

function MeetingTriage({
  meetingId,
  seriesOptions,
  owner,
  people,
  add,
  onBack,
  onSaved,
}: {
  meetingId: string;
  seriesOptions: string[];
  owner: string | null;
  people: string[];
  add: (n: string) => Promise<string | null>;
  onBack: () => void;
  onSaved: () => void;
}) {
  const { caller } = usePeople();
  const [d, setD] = useState<MeetingDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [seriesV, setSeriesV] = useState("");
  const [participants, setParticipants] = useState<string[]>([]);
  const [withP, setWithP] = useState(false);
  const [rename, setRename] = useState(false);
  const [map, setMap] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!caller) return;
    let alive = true;
    getTrinnexMeetingFn({ data: { caller, meetingId } })
      .then((r) => {
        if (!alive) return;
        if (!r.ok) return setErr(r.error);
        setD(r);
        setTitle(r.meeting.baseTitle);
        setSeriesV(r.meeting.series ?? "");
        setParticipants(r.meeting.participants);
        setWithP(r.meeting.withParticipants);
        // A voice the parser is SURE of is pre-filled (still editable); every "Speaker N" starts unmapped.
        const m: Record<string, string> = { ...r.meeting.speakerMap };
        for (const s of r.speakers) if (!m[s.label] && s.match.kind === "person") m[s.label] = s.match.person;
        setMap(m);
      })
      .catch(() => alive && setErr("Couldn't open that meeting."));
    return () => {
      alive = false;
    };
  }, [caller, meetingId]);

  const addParticipant = (n: string) => setParticipants((p) => (p.includes(n) || n === owner ? p : [...p, n]));
  const setVoice = (label: string, who: string | null) => {
    setMap((m) => {
      const next = { ...m };
      if (who) next[label] = who;
      else delete next[label];
      return next;
    });
    if (who) addParticipant(who);
  };
  const warn = useMemo(() => splitWarnings(map), [map]);
  const shown = fullTitle(title.trim() || "Untitled", participants, withP);

  async function save(addToMemory: boolean) {
    if (!caller || !d) return;
    if (!title.trim()) return toast.error("A meeting needs a title.");
    setSaving(true);
    const r = await saveTrinnexMeetingFn({
      data: { caller, meetingId, title, series: seriesV || null, participants, withParticipants: withP, renameFile: rename, speakerMap: map, owners: picks, addToMemory },
    }).catch(() => null);
    setSaving(false);
    if (!r || !r.ok) return toast.error(r && !r.ok ? r.error : "Couldn't save. Try again.");
    const left = d.items.filter((i) => i.state === "untriaged" && !picks[i.id]).length;
    const head = addToMemory ? (r.memory === "ingested" ? "Saved and added to Trinnex memory." : "Saved.") : "Saved without adding to memory.";
    toast(head, { description: [...r.notes, left ? `${left} item${left === 1 ? "" : "s"} saved without an owner.` : ""].filter(Boolean).join(" ") || undefined });
    onSaved();
  }

  if (err) return <p className="px-6 py-6 text-sm text-destructive">{err}</p>;
  if (!d) return <p className="px-6 py-6 text-sm text-muted-foreground">Loading…</p>;
  const sugg = [...d.titleSuggestions.map((s) => s.name), ...d.inviteSuggestions].filter((n) => !participants.includes(n));

  return (
    <div className="flex flex-col gap-4 px-3 py-4 sm:px-6" data-testid="meeting-triage">
      <button type="button" onClick={onBack} className="inline-flex min-h-[44px] items-center gap-1 text-sm text-muted-foreground @2xl:app-hidden">
        <ChevronLeft size={14} aria-hidden /> Meetings
      </button>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="mt-title">Title</label>
        <input id="mt-title" className={fieldCls} value={title} maxLength={MEETING_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
        {d.meeting.firefliesTitle && d.meeting.firefliesTitle !== title && (
          <span className="text-xs text-muted-foreground">From Fireflies: {d.meeting.firefliesTitle}</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="mt-series">Series (optional)</label>
        <input id="mt-series" list="mt-series-list" className={fieldCls} value={seriesV} maxLength={SERIES_MAX} onChange={(e) => setSeriesV(e.target.value)} />
        <datalist id="mt-series-list">{seriesOptions.map((s) => <option key={s} value={s} />)}</datalist>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Participants</h2>
        <div className="flex flex-wrap gap-1.5">
          {participants.map((p) => (
            <span key={p} className={chipCls}>
              {p}
              <button type="button" aria-label={`Remove ${p}`} className="text-muted-foreground hover:text-foreground" onClick={() => setParticipants((x) => x.filter((y) => y !== p))}>
                <X size={12} />
              </button>
            </span>
          ))}
          <PersonDropdown label="Add" owner={null} people={people} add={add} onPick={addParticipant} />
        </div>
        {sugg.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Suggested:
            {sugg.map((n) => (
              <button key={n} type="button" className={cn(chipCls, "border-dashed")} onClick={() => void (people.includes(n) ? Promise.resolve(n) : add(n)).then((x) => x && addParticipant(x))}>
                <Plus size={11} aria-hidden /> {n}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Who is speaking</h2>
        {!d.speakers.length && <p className="text-xs text-muted-foreground">No transcript lines stored for this meeting.</p>}
        {d.speakers.map((s) => (
          <div key={s.label} className="flex flex-col gap-1 rounded-md border border-hairline bg-surface p-2.5 sm:flex-row sm:items-center sm:gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-foreground">
                {s.label} <span className="text-xs text-muted-foreground">· {s.lines} lines · {s.talkPct}%</span>
              </div>
              {s.sample && (
                <div className="truncate text-xs text-muted-foreground">
                  {s.sample.at ? `${s.sample.at} ` : ""}“{s.sample.text}”
                </div>
              )}
              {s.label === "Unknown speaker" && <div className="text-xs text-warning-foreground">These lines had no speaker; they may be several people.</div>}
            </div>
            <PersonDropdown
              label={map[s.label] ?? "Who is this?"}
              owner={owner}
              people={people}
              add={add}
              onPick={(n) => setVoice(s.label, n)}
              extra={
                map[s.label] ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setVoice(s.label, null)}>Not set</DropdownMenuItem>
                  </>
                ) : null
              }
            />
          </div>
        ))}
        {warn.length > 0 && <p className="text-xs text-muted-foreground">Fireflies sometimes splits one person into two voices: {warn.join(", ")} is on more than one.</p>}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Action items</h2>
        {!d.items.length && <p className="text-xs text-muted-foreground">No action items for this meeting.</p>}
        {d.items.map((i) => {
          const pk = picks[i.id];
          const label = pk ? (pk.kind === "skip" ? "Skip" : pk.name === owner ? `${owner} (me)` : pk.name) : i.state === "untriaged" ? "Pick owner" : i.state === "delegated" ? (i.assignee ?? "For someone") : i.state === "proposed" ? "Mine" : i.state;
          return (
            <div key={i.id} className="flex items-center gap-3 border-b border-hairline py-1.5 last:border-b-0">
              <span className="min-w-0 flex-1 text-sm text-foreground">{i.title}</span>
              {i.state === "untriaged" ? (
                <PersonDropdown
                  label={label}
                  owner={owner}
                  people={people}
                  add={add}
                  onPick={(n) => setPicks((p) => ({ ...p, [i.id]: { kind: "person", name: n } }))}
                  extra={
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setPicks((p) => ({ ...p, [i.id]: { kind: "skip" } }))}>Skip</DropdownMenuItem>
                    </>
                  }
                />
              ) : (
                <span className="text-xs text-muted-foreground">{label}</span>
              )}
            </div>
          );
        })}
      </section>

      <section className="flex flex-col gap-2 text-sm text-foreground">
        <label className="flex min-h-[44px] items-center gap-2">
          <input type="checkbox" checked={withP} onChange={(e) => setWithP(e.target.checked)} /> Add participants to the title
        </label>
        <label className="flex min-h-[44px] items-center gap-2">
          <input type="checkbox" checked={rename} onChange={(e) => setRename(e.target.checked)} /> Rename the OneDrive file to match
        </label>
        <p className="text-xs text-muted-foreground">Shows as: {shown}</p>
      </section>

      <div className="flex flex-wrap gap-2 pb-[env(safe-area-inset-bottom)]">
        <button type="button" disabled={saving} onClick={() => void save(true)} className={cn(btnCls, "bg-primary text-primary-foreground hover:bg-primary/90")} data-testid="meeting-save-memory">
          Save and add to Trinnex memory
        </button>
        <button type="button" disabled={saving} onClick={() => void save(false)} className={cn(btnCls, "border border-input bg-background text-foreground hover:bg-muted")}>
          Save without adding to memory
        </button>
      </div>
    </div>
  );
}
