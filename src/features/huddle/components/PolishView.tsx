// WHAT:       Polish — Huddle's text cleanup tool. Type rough on the left (Draft), get finished copy on
//             the right (Polished), steer it with quick actions or a typed direction (whole text or just
//             a selection), step through versions, see Changes against the draft, Copy and paste.
//             Writing profiles (Work email, LinkedIn post, ... plus your own) set tone, formality,
//             edit strength, length, format, audience and always/never rules.
// WHY:        The owner drafts content daily and wants a cleanup tool inside Huddle on web and phone.
//             First of Huddle's tool modules (Sidecar and Prompto to follow).
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   prototype claude.ai/artifact/7MJkFX17io8FHmVWwSZCAn (approved before merge);
//             design source claude.ai artifact 283e7883; prompt/splice rules in scripts/polish-core.test.ts
//
// Storage: your own profiles + last profile sync across devices through the workspace blob (store.ts).
// The draft and its versions are per device (localStorage), so a half-written draft is never lost to a
// reload, and nothing you type is uploaded until you polish it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  PenLine,
  SlidersHorizontal,
  Sparkles,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useHuddleStore } from "../store";
import {
  BUILTIN_PROFILES,
  ENGINE_LABEL,
  FORMAT_LABEL,
  LENGTH_LABEL,
  POLISH_TONES,
  QUICK_ACTIONS,
  STRENGTH_LABEL,
  normalizeSettings,
  settingsDiffer,
  settingsSummary,
  wordCount,
  wordDiff,
  type PolishProfile,
  type PolishRequest,
  type PolishSettings,
} from "../lib/polish/polish-core";
import { polishTextFn } from "../lib/polish/polish.functions";

type Version = { text: string; label: string; edited?: boolean };
type Sel = { start: number; end: number; text: string };

const LS = "huddle:polish:";
const lsGet = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(LS + k);
    return v == null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: unknown) => {
  try {
    localStorage.setItem(LS + k, JSON.stringify(v));
  } catch {
    /* private mode / quota: per-device convenience only */
  }
};

const LIVE_DEBOUNCE_MS = 1500;

export function PolishView() {
  const { user } = useAuth();
  const caller = useMemo(
    () =>
      user
        ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username }
        : undefined,
    [user],
  );

  // ---- profiles (synced) ----
  const custom = useHuddleStore((s) => s.polishProfiles);
  const profileId = useHuddleStore((s) => s.polishProfileId);
  const setCustom = useHuddleStore((s) => s.setPolishProfiles);
  const setProfileId = useHuddleStore((s) => s.setPolishProfileId);
  const allProfiles = useMemo(
    () => [...BUILTIN_PROFILES, ...custom.map((p) => ({ ...p, custom: true }))],
    [custom],
  );
  const baseProfile: PolishProfile =
    allProfiles.find((p) => p.id === profileId) ?? BUILTIN_PROFILES[0];
  const [settings, setSettings] = useState<PolishSettings>(() =>
    normalizeSettings(baseProfile, baseProfile),
  );
  // Re-seed working settings when the picked profile changes (or arrives from the synced blob).
  const seededFor = useRef<string>(baseProfile.id);
  useEffect(() => {
    if (seededFor.current !== baseProfile.id) {
      seededFor.current = baseProfile.id;
      setSettings(normalizeSettings(baseProfile, baseProfile));
    }
  }, [baseProfile]);
  const dirty = settingsDiffer(baseProfile, settings);

  // ---- draft + versions (per device) ----
  const [draft, setDraft] = useState<string>(() => lsGet("draft", ""));
  const [versions, setVersions] = useState<Version[]>(() => lsGet("versions", []));
  const [idx, setIdx] = useState<number>(() =>
    Math.max(0, lsGet<Version[]>("versions", []).length - 1),
  );
  const [polishedFrom, setPolishedFrom] = useState<string>(() => lsGet("from", ""));
  const [live, setLive] = useState<boolean>(() => lsGet("live", true));
  const [draftChangedSinceEdit, setDraftChangedSinceEdit] = useState(false);
  const [busy, setBusy] = useState<null | { label: string; token: number }>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [direction, setDirection] = useState("");
  const [sel, setSel] = useState<Sel | null>(null);
  const [tab, setTab] = useState<"draft" | "out">("draft");
  const [freshDot, setFreshDot] = useState(false);
  const [status, setStatus] = useState<{ msg: string; kind?: "ok" | "err" } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => lsSet("draft", draft), [draft]);
  useEffect(() => lsSet("versions", versions.slice(-20)), [versions]);
  useEffect(() => lsSet("from", polishedFrom), [polishedFrom]);
  useEffect(() => lsSet("live", live), [live]);

  const cur = versions[idx];
  const edited = !!cur?.edited;
  const outRef = useRef<HTMLTextAreaElement>(null);
  const directRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef(0);
  const prevIdxRef = useRef(0);

  // ---- running a Polish call ----
  const run = useCallback(
    async (req: PolishRequest, label: string, from: string) => {
      if (busy) return;
      if (!caller) {
        setStatus({ msg: "Sign in to use Polish.", kind: "err" });
        return;
      }
      const token = ++tokenRef.current;
      prevIdxRef.current = idx;
      setBusy({ label, token });
      setShowChanges(false);
      setStatus(null);
      if (req.mode === "polish" || req.mode === "merge") setTab("out");
      try {
        const res = await polishTextFn({
          data: { caller, profileName: baseProfile.name, settings, request: req },
        });
        if (tokenRef.current !== token) return; // stopped or superseded
        if (!res.ok) {
          setStatus({ msg: res.error, kind: "err" });
          return;
        }
        const next = [...versions.slice(0, idx + 1), { text: res.text, label }];
        setVersions(next);
        setIdx(next.length - 1);
        setPolishedFrom(from);
        setDraftChangedSinceEdit(false);
        setSel(null);
        if (req.mode === "revise" || req.mode === "span") setDirection("");
        setFreshDot(true);
        setStatus({ msg: `${label} with ${baseProfile.name}.`, kind: "ok" });
      } catch {
        if (tokenRef.current === token)
          setStatus({
            msg: "Couldn't reach Huddle. Your text is unchanged; try again.",
            kind: "err",
          });
      } finally {
        if (tokenRef.current === token) {
          setBusy(null);
        }
      }
    },
    [busy, caller, idx, versions, baseProfile.name, settings],
  );

  const stop = () => {
    tokenRef.current++;
    setBusy(null);
    setIdx(prevIdxRef.current);
    setStatus({ msg: "Stopped. The previous version is back." });
  };

  const polishDraft = useCallback(() => {
    if (!draft.trim()) return;
    if (edited && draftChangedSinceEdit) {
      setTab("out"); // the banner there asks how to merge
      return;
    }
    void run({ mode: "polish", draft }, "Polished", draft);
  }, [draft, edited, draftChangedSinceEdit, run]);

  const revise = (instruction: string) => {
    if (!cur || !instruction.trim()) return;
    const s = sel && outRef.current && outRef.current.value === cur.text ? sel : null;
    if (s)
      void run(
        { mode: "span", text: cur.text, start: s.start, end: s.end, instruction },
        instruction,
        polishedFrom,
      );
    else void run({ mode: "revise", text: cur.text, instruction }, instruction, polishedFrom);
  };

  // ---- Live: polish ~1.5s after typing stops, never over your own edits ----
  useEffect(() => {
    if (!live || busy || !draft.trim() || draft === polishedFrom) return;
    if (edited) return; // the banner offers Update/Replace instead of overwriting
    const t = setTimeout(
      () => void run({ mode: "polish", draft }, "Polished", draft),
      LIVE_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, live]);

  // ⌘K / Ctrl+K focuses the direction box while Polish is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        directRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const trackSel = () => {
    const o = outRef.current;
    if (!o) return;
    const a = o.selectionStart;
    const b = o.selectionEnd;
    setSel(b - a >= 2 ? { start: a, end: b, text: o.value.slice(a, b) } : null);
  };

  const onEditOut = (text: string) => {
    setSel(null);
    setDraftChangedSinceEdit(false);
    if (!versions.length) {
      setVersions([{ text, label: "Yours", edited: true }]);
      setIdx(0);
      return;
    }
    setVersions(versions.map((v, i) => (i === idx ? { ...v, text, edited: true } : v)));
  };

  const copy = async () => {
    const t = cur?.text ?? "";
    try {
      await navigator.clipboard.writeText(t);
      toast.success("Copied. Ready to paste.");
    } catch {
      setShowChanges(false);
      requestAnimationFrame(() => {
        outRef.current?.focus();
        outRef.current?.select();
      });
      toast("Selected. Use your keyboard's copy.");
    }
  };

  const pickProfile = (id: string) => {
    setProfileId(id);
    setMenuOpen(false);
  };

  const outValue = cur?.text ?? "";
  const diff = useMemo(
    () => (showChanges && cur ? wordDiff(polishedFrom || draft, cur.text) : []),
    [showChanges, cur, polishedFrom, draft],
  );
  const summary = settingsSummary(baseProfile.name, settings, dirty);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden bg-background px-3 pb-2 pt-2.5 md:gap-3 md:px-5 md:pb-3 md:pt-4">
      {/* Top bar: profile · settings summary · engine */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-1 hidden items-center gap-2 md:flex">
          <span className="flex size-8 items-center justify-center rounded-lg bg-ai-soft text-ai">
            <PenLine size={16} />
          </span>
          <h1 className="text-[17px] font-semibold tracking-tight">Polish</h1>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="inline-flex min-h-10 items-center gap-2 rounded-full border border-accent-foreground/20 bg-accent px-3.5 text-[13px] font-semibold text-accent-foreground md:min-h-9"
          >
            {baseProfile.name}
            <ChevronDown size={14} />
          </button>
          {menuOpen && (
            <>
              <button
                type="button"
                aria-label="Close menu"
                className="fixed inset-0 z-30 cursor-default"
                onClick={() => setMenuOpen(false)}
              />
              <div
                role="menu"
                className="absolute left-0 top-[calc(100%+6px)] z-40 min-w-56 rounded-lg border border-hairline bg-popover p-1 shadow-pop"
              >
                <MenuLabel>Profiles</MenuLabel>
                {BUILTIN_PROFILES.map((p) => (
                  <MenuItem
                    key={p.id}
                    checked={p.id === baseProfile.id}
                    onClick={() => pickProfile(p.id)}
                  >
                    {p.name}
                  </MenuItem>
                ))}
                {custom.length > 0 && <MenuLabel>Yours</MenuLabel>}
                {custom.map((p) => (
                  <MenuItem
                    key={p.id}
                    checked={p.id === baseProfile.id}
                    onClick={() => pickProfile(p.id)}
                  >
                    {p.name}
                  </MenuItem>
                ))}
                <div className="my-1 h-px bg-hairline" />
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false);
                    setSheetOpen(true);
                  }}
                >
                  <SlidersHorizontal size={14} /> Writing settings…
                </MenuItem>
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-hairline bg-surface py-1 pl-3.5 pr-1.5 text-left text-[13px] text-muted-foreground md:min-h-9 md:flex-[1_1_300px]"
        >
          <span className="min-w-0 flex-1 truncate">{summary}</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-accent-foreground">
            <SlidersHorizontal size={12} /> Settings
          </span>
        </button>
        <span className="hidden items-center gap-2 rounded-full border border-hairline bg-surface px-3 py-1.5 text-xs text-muted-foreground md:inline-flex">
          <span className="size-2 rounded-full bg-success" /> {ENGINE_LABEL[settings.engine]}
        </span>
      </div>

      {/* Phone: Draft / Polished tabs */}
      <div
        role="tablist"
        aria-label="Panes"
        className="flex gap-1 rounded-full border border-hairline bg-surface p-[3px] md:hidden"
      >
        {(["draft", "out"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              if (t === "out") setFreshDot(false);
            }}
            className={cn(
              "inline-flex min-h-[38px] flex-1 items-center justify-center gap-1.5 rounded-full text-sm font-semibold",
              tab === t ? "bg-muted text-foreground" : "text-muted-foreground",
            )}
          >
            {t === "draft" ? "Draft" : "Polished"}
            {t === "out" && freshDot && tab !== "out" && (
              <span className="size-[7px] rounded-full bg-ai" />
            )}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
        {/* DRAFT */}
        <section
          aria-label="Draft"
          className={cn(
            "min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-hairline bg-surface-2",
            tab === "draft" ? "flex" : "hidden md:flex",
          )}
        >
          <div className="flex min-h-12 items-center gap-2 border-b border-hairline py-1.5 pl-4 pr-2.5">
            <PaneTitle>Draft</PaneTitle>
            <span className="hidden text-xs text-muted-foreground md:inline">
              Type it the way you'd say it.
            </span>
            <span className="flex-1" />
            <ToolButton onClick={() => setDraft("")} disabled={!draft}>
              Clear
            </ToolButton>
          </div>
          <label htmlFor="polish-draft" className="sr-only">
            Draft
          </label>
          <textarea
            id="polish-draft"
            value={draft}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              if (edited) setDraftChangedSinceEdit(true);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                polishDraft();
              }
            }}
            placeholder="Rough notes, half sentences, typos. Polish turns it into finished copy."
            className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3.5 font-mono text-[14px] leading-[1.7] outline-none placeholder:text-muted-foreground/80 md:px-5 md:py-4"
          />
          <div className="flex items-center gap-2.5 border-t border-hairline py-2 pl-4 pr-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={live}
              onClick={() => setLive((l) => !l)}
              className="inline-flex min-h-8 items-center gap-2 text-[13px] font-medium"
              title="Polish automatically when you pause typing"
            >
              <span
                className={cn(
                  "relative h-[18px] w-8 rounded-full transition",
                  live ? "bg-ai" : "bg-input",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-3.5 rounded-full bg-surface transition-all",
                    live ? "left-4" : "left-0.5",
                  )}
                />
              </span>
              Live
            </button>
            <span className="text-xs tabular-nums text-muted-foreground">
              {wordCount(draft)} words
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={polishDraft}
              disabled={!!busy || !draft.trim()}
              className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-ai px-3.5 text-[13px] font-semibold text-ai-foreground transition hover:brightness-105 disabled:opacity-50"
            >
              <Sparkles size={14} /> Polish{" "}
              <span className="hidden text-[11px] font-medium opacity-80 md:inline">⌘↵</span>
            </button>
          </div>
        </section>

        {/* POLISHED */}
        <section
          aria-label="Polished"
          className={cn(
            "min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-soft",
            tab === "out" ? "flex" : "hidden md:flex",
          )}
        >
          <div className="flex min-h-12 flex-wrap items-center gap-1.5 border-b border-hairline py-1.5 pl-3 pr-2 md:gap-2 md:pl-4 md:pr-2.5">
            <PaneTitle>Polished</PaneTitle>
            {edited && !busy && (
              <span className="rounded-full bg-band-cream px-2 py-0.5 text-[11px] font-semibold text-warning-foreground">
                <span className="md:hidden">Edited</span>
                <span className="hidden md:inline">Edited by you</span>
              </span>
            )}
            {busy && (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ai">
                <span className="size-[11px] animate-spin rounded-full border-2 border-ai/30 border-t-ai motion-reduce:animate-none" />
                Writing…
              </span>
            )}
            <span className="flex-1" />
            <span className="inline-flex items-center overflow-hidden rounded-lg border border-hairline">
              <button
                type="button"
                aria-label="Previous version"
                disabled={!!busy || idx <= 0}
                onClick={() => setIdx((i) => i - 1)}
                className="flex min-h-[30px] items-center px-1.5 text-muted-foreground disabled:opacity-35 md:px-2"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="flex min-h-[30px] items-center border-x border-hairline px-2 text-[12.5px] md:px-2.5 font-semibold tabular-nums">
                v{versions.length ? idx + 1 : 0} / {versions.length}
              </span>
              <button
                type="button"
                aria-label="Next version"
                disabled={!!busy || idx >= versions.length - 1}
                onClick={() => setIdx((i) => i + 1)}
                className="flex min-h-[30px] items-center px-1.5 text-muted-foreground disabled:opacity-35 md:px-2"
              >
                <ChevronRight size={14} />
              </button>
            </span>
            <ToolButton
              pressed={showChanges}
              onClick={() => setShowChanges((s) => !s)}
              disabled={!cur || !!busy}
            >
              Changes
            </ToolButton>
            <ToolButton onClick={copy} disabled={!cur || !!busy}>
              <Copy size={14} /> Copy
            </ToolButton>
          </div>

          {edited && draftChangedSinceEdit && !busy && (
            <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-band-cream px-3.5 py-2.5 text-[13px] text-warning-foreground">
              <span className="flex-[1_1_200px]">
                You edited the polished text and the draft has changed since.
              </span>
              <button
                type="button"
                onClick={() =>
                  cur &&
                  void run(
                    { mode: "merge", draft, edited: cur.text },
                    "Updated, kept your edits",
                    draft,
                  )
                }
                className="rounded-md border border-warning-foreground bg-warning-foreground px-2.5 py-1 text-xs font-semibold text-band-cream"
              >
                Update, keep my edits
              </button>
              <button
                type="button"
                onClick={() => void run({ mode: "polish", draft }, "Polished", draft)}
                className="rounded-md border border-warning-foreground px-2.5 py-1 text-xs font-semibold"
              >
                Replace from draft
              </button>
            </div>
          )}

          {showChanges && !busy && cur ? (
            <div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3.5 font-serif text-[17px] leading-[1.6] md:px-[22px] md:py-[18px] md:text-[18px]">
              <div className="mb-2.5 flex gap-3.5 font-sans text-xs text-muted-foreground">
                <span>
                  <ins className="rounded-sm bg-band-cream px-0.5 text-warning-foreground no-underline">
                    added
                  </ins>{" "}
                  by Polish
                </span>
                <span>
                  <del className="text-destructive">removed</del> from your draft
                </span>
              </div>
              {diff.map((d, i) =>
                d.kind === "same" ? (
                  <span key={i}>{d.text}</span>
                ) : d.kind === "add" ? (
                  <ins
                    key={i}
                    className="rounded-sm bg-band-cream px-0.5 text-warning-foreground no-underline"
                  >
                    {d.text}
                  </ins>
                ) : (
                  <del key={i} className="text-destructive">
                    {d.text}
                  </del>
                ),
              )}
            </div>
          ) : (
            <>
              <label htmlFor="polish-out" className="sr-only">
                Polished text
              </label>
              <textarea
                id="polish-out"
                ref={outRef}
                value={outValue}
                readOnly={!!busy}
                onChange={(e) => onEditOut(e.target.value)}
                onSelect={trackSel}
                onKeyUp={trackSel}
                onMouseUp={trackSel}
                onTouchEnd={trackSel}
                placeholder="Your polished text lands here. Edit it freely; Polish stops overwriting once you do."
                className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3.5 font-serif text-[17px] leading-[1.6] outline-none placeholder:font-sans placeholder:text-sm placeholder:text-muted-foreground/80 md:px-[22px] md:py-[18px] md:text-[18px]"
              />
            </>
          )}

          <div className="flex flex-col gap-2 border-t border-hairline px-3 pb-3 pt-2.5">
            <div className="-mx-0.5 flex gap-1.5 overflow-x-auto px-0.5 [scrollbar-width:none] md:flex-wrap md:overflow-visible">
              {QUICK_ACTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={!cur || !!busy}
                  onClick={() => revise(q)}
                  className="min-h-[34px] flex-none rounded-full border border-hairline bg-surface-2 px-3 text-[12.5px] font-medium transition hover:border-ai/40 hover:bg-ai-soft disabled:opacity-50 md:min-h-[30px]"
                >
                  {q}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <label htmlFor="polish-direct" className="sr-only">
                Direction
              </label>
              <input
                id="polish-direct"
                ref={directRef}
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    revise(direction);
                  }
                }}
                autoComplete="off"
                placeholder="Direct it: “end with a question”, “cut the second paragraph”…"
                className={cn(
                  "min-h-11 min-w-0 flex-1 rounded-lg border px-3 text-[15px] outline-none md:min-h-10 md:text-sm",
                  sel ? "border-ai bg-surface" : "border-input bg-surface-2",
                )}
              />
              {busy ? (
                <button
                  type="button"
                  onClick={stop}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-input bg-surface px-3.5 text-[13px] font-semibold md:min-h-10"
                >
                  <Square size={13} /> Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => revise(direction)}
                  disabled={!cur || !direction.trim()}
                  className="min-h-11 rounded-lg bg-ai px-4 text-[13px] font-semibold text-ai-foreground disabled:opacity-50 md:min-h-10"
                >
                  Apply
                </button>
              )}
            </div>
            <div className={cn("text-xs", sel ? "font-semibold text-ai" : "text-muted-foreground")}>
              {sel ? (
                `Applies to your selection (${wordCount(sel.text)} words) · the rest stays as is`
              ) : (
                <>
                  Applies to the whole text<span className="hidden md:inline"> · ⌘K to focus</span>
                </>
              )}
            </div>
          </div>
        </section>
      </div>

      <div
        role="status"
        aria-live="polite"
        className={cn(
          "min-h-[18px] text-[12.5px]",
          status?.kind === "ok"
            ? "text-success"
            : status?.kind === "err"
              ? "text-destructive"
              : "text-muted-foreground",
        )}
      >
        {status?.msg ?? ""}
      </div>

      <WritingSettings
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        profiles={allProfiles}
        base={baseProfile}
        settings={settings}
        dirty={dirty}
        onChange={setSettings}
        onPick={pickProfile}
        onDiscard={() => setSettings(normalizeSettings(baseProfile, baseProfile))}
        onSave={() => {
          setCustom(custom.map((p) => (p.id === baseProfile.id ? { ...p, ...settings } : p)));
          toast.success(`Saved to ${baseProfile.name}`);
        }}
        onSaveNew={(name) => {
          const p: PolishProfile = {
            ...settings,
            id: `c-${Date.now().toString(36)}`,
            name,
            custom: true,
          };
          setCustom([...custom, p]);
          seededFor.current = p.id; // keep the working settings exactly as they are
          setProfileId(p.id);
          toast.success(`Saved as ${name}`);
        }}
        onDelete={() => {
          const n = baseProfile.name;
          setCustom(custom.filter((p) => p.id !== baseProfile.id));
          setProfileId("work-email");
          toast(`Deleted ${n}`);
        }}
      />
    </div>
  );
}

function PaneTitle({ children }: { children: React.ReactNode }) {
  return (
    // Phone shows the Draft/Polished tabs instead, so the pane title only appears from md up.
    <h2 className="hidden text-[11.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground md:block">
      {children}
    </h2>
  );
}

function ToolButton({
  children,
  onClick,
  disabled,
  pressed,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[13px] md:px-2.5 font-medium transition disabled:opacity-45",
        pressed
          ? "bg-ai-soft text-ai"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  checked,
}: {
  children: React.ReactNode;
  onClick: () => void;
  checked?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-muted",
        checked && "font-semibold",
      )}
    >
      {children}
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Record<T, string>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-input">
      {(Object.keys(options) as T[]).map((k, i) => (
        <button
          key={k}
          type="button"
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          className={cn(
            "min-h-[34px] flex-1 px-1.5 text-[13px]",
            i > 0 && "border-l border-hairline",
            value === k
              ? "bg-primary font-semibold text-primary-foreground"
              : "text-muted-foreground",
          )}
        >
          {options[k]}
        </button>
      ))}
    </div>
  );
}

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  const cls = "text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";
  return htmlFor ? (
    <label htmlFor={htmlFor} className={cls}>
      {children}
    </label>
  ) : (
    <p className={cls}>{children}</p>
  );
}

function WritingSettings(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  profiles: PolishProfile[];
  base: PolishProfile;
  settings: PolishSettings;
  dirty: boolean;
  onChange: (s: PolishSettings) => void;
  onPick: (id: string) => void;
  onDiscard: () => void;
  onSave: () => void;
  onSaveNew: (name: string) => void;
  onDelete: () => void;
}) {
  const { settings: s, onChange, base } = props;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const set = <K extends keyof PolishSettings>(k: K, v: PolishSettings[K]) =>
    onChange({ ...s, [k]: v });
  const STRENGTH_OPTS = {
    light: STRENGTH_LABEL.light[0],
    balanced: STRENGTH_LABEL.balanced[0],
    full: STRENGTH_LABEL.full[0],
  };
  const saveNew = () => {
    if (!name.trim()) return;
    props.onSaveNew(name.trim());
    setNaming(false);
    setName("");
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[440px]">
        <div className="border-b border-hairline px-5 py-4 pr-12">
          <SheetTitle className="text-base">Writing settings</SheetTitle>
          <SheetDescription className="sr-only">
            Tone, formality, edit strength, length, format, audience and rules for Polish.
          </SheetDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-6 pt-4">
          <div className="flex flex-col gap-2">
            <FieldLabel>Profile</FieldLabel>
            <div className="grid grid-cols-2 gap-1.5">
              {props.profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={p.id === base.id}
                  onClick={() => props.onPick(p.id)}
                  className={cn(
                    "flex min-h-[38px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-left text-[13px] font-semibold",
                    p.id === base.id ? "border-ai bg-ai-soft" : "border-hairline bg-surface-2",
                  )}
                >
                  <span className="truncate">{p.name}</span>
                  {p.custom && (
                    <span className="text-[11.5px] font-normal text-muted-foreground">· yours</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabel>Tone · pick up to 2</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              {POLISH_TONES.map((t) => {
                const on = s.tones.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set("tones", on ? s.tones.filter((x) => x !== t) : [...s.tones, t].slice(-2))
                    }
                    className={cn(
                      "min-h-8 rounded-full border px-3 text-[13px]",
                      on ? "border-ai bg-ai font-semibold text-ai-foreground" : "border-input",
                    )}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabel htmlFor="polish-formality">Formality · {s.formality}</FieldLabel>
            <input
              id="polish-formality"
              type="range"
              min={1}
              max={5}
              step={1}
              value={s.formality}
              onChange={(e) => set("formality", Number(e.target.value))}
              className="w-full accent-[var(--primary)]"
            />
            <div className="flex justify-between text-[11.5px] text-muted-foreground">
              <span>1 Casual</span>
              <span>3 Neutral</span>
              <span>5 Formal</span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabel>Edit strength</FieldLabel>
            <Segmented
              value={s.strength}
              options={STRENGTH_OPTS}
              onChange={(v) => set("strength", v)}
            />
            <p className="text-xs text-muted-foreground">{STRENGTH_LABEL[s.strength][1]}</p>
          </div>

          <div className="grid grid-cols-2 gap-3.5">
            <div className="flex flex-col gap-2">
              <FieldLabel>Length</FieldLabel>
              <Segmented
                value={s.length}
                options={LENGTH_LABEL}
                onChange={(v) => set("length", v)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <FieldLabel>Format</FieldLabel>
              <Segmented
                value={s.format}
                options={FORMAT_LABEL}
                onChange={(v) => set("format", v)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabel htmlFor="polish-audience">Audience</FieldLabel>
            <input
              id="polish-audience"
              value={s.audience}
              onChange={(e) => set("audience", e.target.value)}
              placeholder="e.g. colleagues and stakeholders"
              className="rounded-lg border border-input bg-surface-2 px-3 py-2 text-sm outline-none focus:border-ring"
            />
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabel htmlFor="polish-rules">Always / never rules</FieldLabel>
            <textarea
              id="polish-rules"
              value={s.rules}
              onChange={(e) => set("rules", e.target.value)}
              rows={3}
              placeholder="One rule per line, e.g. Never use “leverage”"
              className="min-h-20 resize-y rounded-lg border border-input bg-surface-2 px-3 py-2 text-sm leading-relaxed outline-none focus:border-ring"
            />
          </div>

          <div className="flex flex-col gap-2">
            <FieldLabel>Engine</FieldLabel>
            <Segmented value={s.engine} options={ENGINE_LABEL} onChange={(v) => set("engine", v)} />
            <p className="text-xs text-muted-foreground">
              Fast answers in a few seconds. Best thinks longer for important pieces.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 border-t border-hairline px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
          {props.dirty && (
            <p className="text-xs font-semibold text-warning-foreground">
              Unsaved changes to {base.name}. They apply now; save to keep them next time.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {props.dirty && base.custom && (
              <button
                type="button"
                onClick={props.onSave}
                className="min-h-9 rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground"
              >
                Save to {base.name}
              </button>
            )}
            {props.dirty && (
              <button
                type="button"
                onClick={props.onDiscard}
                className="min-h-9 rounded-lg border border-input bg-surface px-3 text-[13px] font-medium"
              >
                Discard changes
              </button>
            )}
            <button
              type="button"
              onClick={() => setNaming(true)}
              className="min-h-9 rounded-lg border border-input bg-surface px-3 text-[13px] font-medium"
            >
              Save as new profile
            </button>
            {base.custom && (
              <button
                type="button"
                onClick={props.onDelete}
                className="min-h-9 rounded-lg border border-input bg-surface px-3 text-[13px] font-medium text-destructive"
              >
                Delete {base.name}
              </button>
            )}
          </div>
          {naming && (
            <div className="flex gap-2">
              <label htmlFor="polish-newname" className="sr-only">
                New profile name
              </label>
              <input
                id="polish-newname"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveNew();
                  }
                }}
                placeholder="Name it, e.g. Board update"
                className="min-w-0 flex-1 rounded-lg border border-input bg-surface-2 px-3 py-2 text-sm outline-none focus:border-ring"
              />
              <button
                type="button"
                onClick={saveNew}
                disabled={!name.trim()}
                className="rounded-lg bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground disabled:opacity-50"
              >
                Save
              </button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
