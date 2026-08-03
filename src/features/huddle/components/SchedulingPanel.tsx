import { useCallback, useEffect, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import {
  getMySchedulingConfigFn,
  setMySchedulingConfigFn,
} from "../lib/identity/scheduling-config.functions";
import type { JobCadence, JobTypeKey } from "../lib/identity/scheduling-config.server";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Recurring-job cadence Settings panel (Settings → Account → Scheduling). Every scheduled job type
// (grooming, auto-work, standup, review digest, review recheck) is editable here as hours + days —
// no code change needed to move a cadence, so a "grooming fires too often" complaint doesn't need
// another one-off patch next time. Mirrors AgentWorkflowPanel.tsx's fetch/persist pattern.

const JOB_LABELS: Record<JobTypeKey, { label: string; hint: string }> = {
  groom: {
    label: "Backlog grooming",
    hint: "Terry triages/assigns the backlog on this cadence (only re-grooms if it actually changed).",
  },
  autowork: {
    label: "Auto-work research",
    hint: "Agents self-start assigned research/artifact work after grooming has triaged the backlog.",
  },
  standup: {
    label: "Standup digest",
    hint: "Summarizes the prior day's autonomous work and blockers.",
  },
  reviewDigest: {
    label: "Review digest",
    hint: "Iris's nudge on what's waiting in Ready for review.",
  },
  reviewRecheck: {
    label: "48h review recheck",
    hint: "Per-task check-ins on items sitting in review — this sets how often the check RUNS, not the 48h-per-task interval itself.",
  },
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const JOB_TYPE_KEYS: JobTypeKey[] = ["groom", "autowork", "standup", "reviewDigest", "reviewRecheck"];

function parseHours(text: string): number[] {
  return [...new Set(text.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23))].sort(
    (a, b) => a - b,
  );
}

export function SchedulingPanel() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const [defaults, setDefaults] = useState<Record<JobTypeKey, JobCadence> | null>(null);
  const [overrides, setOverrides] = useState<Partial<Record<JobTypeKey, JobCadence>>>({});
  const [hoursText, setHoursText] = useState<Record<JobTypeKey, string>>({} as Record<JobTypeKey, string>);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState<JobTypeKey | null>(null);

  useEffect(() => {
    if (!caller) return;
    void (async () => {
      try {
        const res = await getMySchedulingConfigFn({ data: { caller } });
        setDefaults(res.defaults);
        const ov = res.config?.overrides ?? {};
        setOverrides(ov);
        const texts: Record<JobTypeKey, string> = {} as Record<JobTypeKey, string>;
        for (const key of JOB_TYPE_KEYS) {
          const effective = ov[key] ?? res.defaults[key];
          texts[key] = effective.hours.join(",");
        }
        setHoursText(texts);
      } catch {
        /* keep whatever's already in state */
      }
      setReady(true);
    })();
  }, [caller]);

  const effectiveCadence = useCallback(
    (key: JobTypeKey): JobCadence | undefined => overrides[key] ?? defaults?.[key],
    [overrides, defaults],
  );

  const persist = useCallback(
    async (key: JobTypeKey, next: JobCadence) => {
      if (!caller) return;
      setSaving(key);
      const nextOverrides = { ...overrides, [key]: next };
      try {
        const res = await setMySchedulingConfigFn({ data: { caller, overrides: nextOverrides } });
        if (res.error) toast.error(res.error);
        else if (res.config) setOverrides(res.config.overrides);
      } catch {
        toast.error("Couldn't save that schedule.");
      } finally {
        setSaving(null);
      }
    },
    [caller, overrides],
  );

  const toggleDay = useCallback(
    (key: JobTypeKey, dayIndex: number) => {
      const current = effectiveCadence(key);
      if (!current) return;
      const days = new Set(current.daysOfWeek ?? []);
      days.has(dayIndex) ? days.delete(dayIndex) : days.add(dayIndex);
      void persist(key, { ...current, daysOfWeek: days.size ? [...days].sort() : undefined });
    },
    [effectiveCadence, persist],
  );

  const commitHours = useCallback(
    (key: JobTypeKey) => {
      const current = effectiveCadence(key);
      if (!current) return;
      const hours = parseHours(hoursText[key] ?? "");
      if (!hours.length) {
        toast.error("Enter at least one hour (0-23).");
        return;
      }
      void persist(key, { ...current, hours });
    },
    [effectiveCadence, hoursText, persist],
  );

  const resetToDefault = useCallback(
    (key: JobTypeKey) => {
      if (!defaults) return;
      const next = { ...overrides };
      delete next[key];
      setOverrides(next);
      setHoursText((t) => ({ ...t, [key]: defaults[key].hours.join(",") }));
      void (async () => {
        if (!caller) return;
        try {
          const res = await setMySchedulingConfigFn({ data: { caller, overrides: next } });
          if (res.config) setOverrides(res.config.overrides);
        } catch {
          toast.error("Couldn't reset that schedule.");
        }
      })();
    },
    [defaults, overrides, caller],
  );

  if (!defaults) return null;

  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-1 text-sm font-semibold">Scheduling</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        When each recurring job checks in — hours (local time, comma-separated, e.g. "8" or
        "9,13,17") and which days of the week. Leave every day unchecked to run every day. These are
        checks, not guaranteed actions — most jobs are a no-op when there's nothing new to do.
      </p>
      <div className="space-y-4">
        {JOB_TYPE_KEYS.map((key) => {
          const cadence = effectiveCadence(key)!;
          const isOverridden = overrides[key] !== undefined;
          const days = new Set(cadence.daysOfWeek ?? []);
          return (
            <div key={key} className="rounded-md border border-hairline p-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">{JOB_LABELS[key].label}</Label>
                {isOverridden && (
                  <button
                    type="button"
                    onClick={() => resetToDefault(key)}
                    className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                    title="Reset to the shipped default"
                  >
                    reset to default
                  </button>
                )}
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{JOB_LABELS[key].hint}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {DAY_LABELS.map((label, i) => (
                  <button
                    key={label}
                    type="button"
                    disabled={!ready || saving === key}
                    onClick={() => toggleDay(key, i)}
                    className={cn(
                      "rounded px-2 py-1 text-[11px] font-medium border",
                      days.has(i)
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-hairline text-muted-foreground hover:bg-muted",
                    )}
                    title={days.size ? undefined : "Unset = every day"}
                  >
                    {label}
                  </button>
                ))}
                {!days.size && <span className="ml-1 text-[11px] text-muted-foreground">(every day)</span>}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  value={hoursText[key] ?? cadence.hours.join(",")}
                  onChange={(e) => setHoursText((t) => ({ ...t, [key]: e.target.value }))}
                  onBlur={() => commitHours(key)}
                  disabled={!ready || saving === key}
                  className="h-7 max-w-[160px] text-xs"
                  placeholder="e.g. 8 or 9,13,17"
                />
                <span className="text-[11px] text-muted-foreground">local hour(s), 0-23</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
