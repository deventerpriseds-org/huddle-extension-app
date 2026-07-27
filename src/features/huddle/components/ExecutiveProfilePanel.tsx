import { useCallback, useEffect, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { getMyContextFn, setMyContextFn } from "../lib/identity/user-context.functions";
import { toast } from "sonner";

type Ctx = {
  goals: string;
  ventures: string;
  positioning: string;
  audience: string;
  income_targets: string;
  notes: string;
};

const EMPTY: Ctx = { goals: "", ventures: "", positioning: "", audience: "", income_targets: "", notes: "" };

const FIELDS: { key: keyof Ctx; label: string; hint: string; ph: string }[] = [
  { key: "goals", label: "Standing goals", hint: "The outcomes every agent should push toward.", ph: "Grow my career; establish myself as a top thought-leader / national brand; increase income & revenue to free capital for other investments." },
  { key: "ventures", label: "Current ventures / initiatives", hint: "What you're actively building or running.", ph: "e.g. consulting practice, a SaaS idea, a book, a speaking track…" },
  { key: "positioning", label: "Positioning / brand", hint: "How you want to be known.", ph: "e.g. the go-to authority on X for Y audience…" },
  { key: "audience", label: "Target audience", hint: "Who you're trying to reach.", ph: "e.g. enterprise CTOs, early-stage founders, a specific industry…" },
  { key: "income_targets", label: "Income / revenue targets", hint: "The numbers that matter.", ph: "e.g. $X in new revenue by Q_, replace salary within N months…" },
  { key: "notes", label: "Other context", hint: "Anything else agents should weigh.", ph: "constraints, preferences, current priorities…" },
];

// Executive Profile editor (Settings → Account). Email-scoped; every agent frames its output around this.
export function ExecutiveProfilePanel() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const [ctx, setCtx] = useState<Ctx>(EMPTY);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!caller) return;
    void (async () => {
      try {
        const res = await getMyContextFn({ data: { caller } });
        if (res.context) {
          setCtx({
            goals: res.context.goals ?? "",
            ventures: res.context.ventures ?? "",
            positioning: res.context.positioning ?? "",
            audience: res.context.audience ?? "",
            income_targets: res.context.income_targets ?? "",
            notes: res.context.notes ?? "",
          });
        }
      } catch { /* keep empty */ }
      setReady(true);
    })();
  }, [caller]);

  const save = useCallback(async () => {
    if (!caller) return;
    setSaving(true);
    try {
      const res = await setMyContextFn({ data: { caller, context: ctx } });
      if (res.error) toast.error(res.error);
      else toast.success("Executive profile saved — agents will frame their work around it.");
    } catch {
      toast.error("Couldn't save your profile.");
    } finally {
      setSaving(false);
    }
  }, [caller, ctx]);

  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-1 text-sm font-semibold">Executive profile</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Tell your team who you are and what you're driving toward. Every agent frames its research,
        analysis, and recommendations around this — so results move your goals forward, not just answer.
      </p>
      <div className="space-y-3">
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1">
            <Label className="text-sm">{f.label}</Label>
            <p className="text-xs text-muted-foreground">{f.hint}</p>
            <textarea
              value={ctx[f.key]}
              onChange={(e) => setCtx((c) => ({ ...c, [f.key]: e.target.value }))}
              placeholder={f.ph}
              disabled={!ready}
              rows={f.key === "goals" || f.key === "notes" ? 3 : 2}
              className="w-full resize-y rounded-md border border-hairline bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" onClick={save} disabled={!ready || saving}>
          {saving ? "Saving…" : "Save profile"}
        </Button>
      </div>
    </div>
  );
}
