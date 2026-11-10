// WHAT:       Settings -> Account -> Meeting minutes: choose how Fireflies meeting minutes are written
//             (Fireflies summary | Luna from transcript), who receives them, whether a reprocessed meeting
//             emails again, and see the last few meetings' email + OneDrive results.
// WHY:        Owner handoff 2026-11-10 (Fireflies Webhook to Huddle Meeting Minutes): a clear, persistent
//             two-option control, configurable recipients, and a visible failure state.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   lib/fireflies/minutes.functions.ts; .claude/actions.md ACT:fireflies-minutes.
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { getMinutesSettingsFn, setMinutesSettingsFn } from "../lib/fireflies/minutes.functions";

type Source = "fireflies" | "luna";
type Meeting = {
  id: string;
  title: string | null;
  at: string | null;
  source: string | null;
  kind: string | null;
  email: string | null;
  emailError: string | null;
  emailsSent: number;
  onedrive: string | null;
  onedrivePath: string | null;
  onedriveError: string | null;
};

const KIND_LABEL: Record<string, string> = {
  custom: "Fireflies custom summary",
  standard: "Fireflies standard summary",
  luna: "Luna from transcript",
};

export function MeetingMinutesPanel() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const [ready, setReady] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [source, setSource] = useState<Source>("fireflies");
  const [recipients, setRecipients] = useState("");
  const [savedRecipients, setSavedRecipients] = useState("");
  const [updateEmails, setUpdateEmails] = useState(false);
  const [configured, setConfigured] = useState<{ webhookSecret: boolean; apiKey: boolean } | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);

  const load = useCallback(async () => {
    if (!caller) return;
    try {
      const r = await getMinutesSettingsFn({ data: { caller } });
      if (!r.ok) {
        setDenied(r.error ?? "Unavailable.");
      } else {
        setSource(r.source as Source);
        const list = (r.recipients as string[]).join(", ");
        setRecipients(list);
        setSavedRecipients(list);
        setUpdateEmails(!!r.updateEmails);
        setConfigured(r.configured);
        setMeetings(r.meetings as Meeting[]);
      }
    } catch {
      setDenied("Couldn't load meeting-minutes settings.");
    }
    setReady(true);
  }, [caller]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: { source: Source; recipients: string; updateEmails: boolean }) => {
      if (!caller) return false;
      const list = next.recipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
      try {
        const r = await setMinutesSettingsFn({
          data: { caller, source: next.source, recipients: list, updateEmails: next.updateEmails },
        });
        if (!r.ok) {
          toast.error(r.error ?? "Couldn't save");
          return false;
        }
        return true;
      } catch {
        toast.error("Couldn't save");
        return false;
      }
    },
    [caller],
  );

  if (!caller || denied) return null;

  return (
    <div className="rounded-lg border p-4" data-testid="meeting-minutes-panel">
      <h3 className="mb-1 text-sm font-semibold">Meeting minutes</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        When Fireflies finishes transcribing a meeting, Huddle emails the minutes and saves the transcript to
        OneDrive under Automation/transcripts.
      </p>
      {configured && (!configured.webhookSecret || !configured.apiKey) && (
        <p className="mb-3 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          Not connected yet: the Fireflies {!configured.apiKey ? "API key" : ""}
          {!configured.apiKey && !configured.webhookSecret ? " and " : ""}
          {!configured.webhookSecret ? "webhook signing secret" : ""} {(!configured.apiKey && !configured.webhookSecret) ? "are" : "is"} missing
          from the server settings, so no minutes will be sent.
        </p>
      )}

      <Label className="text-sm">Write the minutes from</Label>
      <RadioGroup
        className="mt-2 space-y-1"
        value={source}
        disabled={!ready}
        onValueChange={async (v) => {
          const prev = source;
          setSource(v as Source);
          if (!(await save({ source: v as Source, recipients: savedRecipients, updateEmails }))) setSource(prev);
        }}
        data-testid="minutes-source"
      >
        <label className="flex items-start gap-2 text-sm">
          <RadioGroupItem value="fireflies" className="mt-0.5" />
          <span>
            Fireflies summary <span className="text-xs text-muted-foreground">(default)</span>
            <span className="block text-xs text-muted-foreground">
              Formats the summary Fireflies wrote, using your custom summary when Fireflies provides it.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <RadioGroupItem value="luna" className="mt-0.5" />
          <span>
            Luna from transcript
            <span className="block text-xs text-muted-foreground">
              Luna reads the full transcript and writes Agenda, Summary, Questions, Decisions and Action Items.
            </span>
          </span>
        </label>
      </RadioGroup>

      <div className="mt-4">
        <Label className="text-sm" htmlFor="minutes-recipients">Send to</Label>
        <Textarea
          id="minutes-recipients"
          className="mt-1 min-h-[56px] text-xs"
          value={recipients}
          disabled={!ready}
          onChange={(e) => setRecipients(e.target.value)}
          placeholder="name@example.com, other@example.com"
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">Separate addresses with commas.</p>
          <Button
            size="sm"
            variant="outline"
            disabled={!ready || recipients === savedRecipients}
            onClick={async () => {
              if (await save({ source, recipients, updateEmails })) {
                toast.success("Recipients saved");
                void load();
              }
            }}
          >
            Save recipients
          </Button>
        </div>
      </div>

      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label className="text-sm">Email again when Fireflies updates a meeting</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Off: an updated transcript only replaces the OneDrive file. On: you also get an "Updated meeting minutes" email.
          </p>
        </div>
        <Switch
          checked={updateEmails}
          disabled={!ready}
          onCheckedChange={async (v) => {
            setUpdateEmails(v);
            if (!(await save({ source, recipients: savedRecipients, updateEmails: v }))) setUpdateEmails(!v);
          }}
        />
      </div>

      {meetings.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-xs font-medium">Recent meetings</p>
          <ul className="divide-y text-xs" data-testid="minutes-meetings">
            {meetings.map((m) => (
              <li key={m.id} className="py-1.5">
                <p className="truncate font-medium">{m.title || "Untitled meeting"}</p>
                <p className="text-muted-foreground">
                  Email:{" "}
                  {m.email === "sent"
                    ? `sent${m.kind ? ` (${KIND_LABEL[m.kind] ?? m.kind})` : ""}`
                    : m.email === "failed"
                      ? `not sent — ${m.emailError ?? "error"}`
                      : (m.email ?? "pending")}
                  {" · "}OneDrive: {m.onedrive === "saved" ? "saved" : m.onedrive === "failed" ? `failed — ${m.onedriveError ?? "error"}` : "pending"}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
