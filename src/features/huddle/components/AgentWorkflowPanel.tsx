import { useCallback, useEffect, useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";
import { AGENTS } from "../data/agents";
import { getMyWorkflowConfigFn, setMyWorkflowConfigFn } from "../lib/identity/agent-workflow-config.functions";
import { toast } from "sonner";

interface Caps {
  approach: number;
  review: number;
  question: number;
}
const DEFAULT_CAPS: Caps = { approach: 3, review: 3, question: 2 };

// "Required vs discretionary" toggle for the WIP confirm-intent + review gate (Settings → Account).
// ON for an agent: it must confirm intent + a Definition of Done before DOING, and finished work is
// automatically graded by the review gate before it can reach Ready for review. OFF: today's more
// autonomous behavior — the agent uses its own judgment on whether to confirm/delegate/seek review.
export function AgentWorkflowPanel() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const [defaultRequired, setDefaultRequired] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [caps, setCaps] = useState<Caps>(DEFAULT_CAPS);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!caller) return;
    void (async () => {
      try {
        const res = await getMyWorkflowConfigFn({ data: { caller } });
        if (res.config) {
          setDefaultRequired(res.config.default_required);
          setOverrides(res.config.agent_overrides);
          setCaps({ ...DEFAULT_CAPS, ...res.config.default_caps });
        }
      } catch { /* keep defaults */ }
      setReady(true);
    })();
  }, [caller]);

  const persist = useCallback(
    async (next: { default_required?: boolean; agent_overrides?: Record<string, boolean>; default_caps?: Caps }) => {
      if (!caller) return;
      setSaving(true);
      try {
        const res = await setMyWorkflowConfigFn({ data: { caller, config: next } });
        if (res.error) toast.error(res.error);
        else if (res.config) {
          setDefaultRequired(res.config.default_required);
          setOverrides(res.config.agent_overrides);
          setCaps({ ...DEFAULT_CAPS, ...res.config.default_caps });
        }
      } catch {
        toast.error("Couldn't save that setting.");
      } finally {
        setSaving(false);
      }
    },
    [caller],
  );

  const toggleDefault = useCallback(
    (checked: boolean) => {
      setDefaultRequired(checked);
      void persist({ default_required: checked });
    },
    [persist],
  );

  const toggleAgent = useCallback(
    (agentId: string, checked: boolean) => {
      const next = { ...overrides, [agentId]: checked };
      setOverrides(next);
      void persist({ agent_overrides: next });
    },
    [overrides, persist],
  );

  const clearOverride = useCallback(
    (agentId: string) => {
      const next = { ...overrides };
      delete next[agentId];
      setOverrides(next);
      void persist({ agent_overrides: next });
    },
    [overrides, persist],
  );

  const updateCap = useCallback(
    (field: keyof Caps, value: number) => {
      if (!Number.isFinite(value) || value < 0) return;
      const next = { ...caps, [field]: Math.round(value) };
      setCaps(next);
      void persist({ default_caps: next });
    },
    [caps, persist],
  );

  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-1 text-sm font-semibold">Confirm-intent &amp; review gate</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        When required, an agent must confirm what it's aiming for and lock a Definition of Done before
        starting work, and finished work is automatically reviewed before it reaches Ready for review.
        When not required, the agent uses its own judgment on both. Toggle this per agent, or set a
        default for everyone — tune it as you see how the results land.
      </p>
      <div className="flex items-center justify-between rounded-md border border-hairline px-3 py-2">
        <Label className="text-sm">Require for all agents by default</Label>
        <Switch checked={defaultRequired} onCheckedChange={toggleDefault} disabled={!ready || saving} />
      </div>
      <div className="mt-3 space-y-1">
        {AGENTS.map((a) => {
          const override = overrides[a.id];
          const effective = override ?? defaultRequired;
          return (
            <div key={a.id} className="flex items-center justify-between px-1 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm">{a.name}</span>
                {override !== undefined && (
                  <button
                    type="button"
                    onClick={() => clearOverride(a.id)}
                    className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                    title="Clear override — follow the default again"
                  >
                    override
                  </button>
                )}
              </div>
              <Switch
                checked={effective}
                onCheckedChange={(checked) => toggleAgent(a.id, checked)}
                disabled={!ready || saving}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-4 border-t pt-4">
        <h4 className="mb-1 text-sm font-semibold">Auto-work loop limits</h4>
        <p className="mb-3 text-xs text-muted-foreground">
          Before starting, an agent's planned approach is graded automatically and revised until it's
          sound — same for the finished work against the review gate. Both loop on their own, invisible
          to you, up to these caps; only when a cap is hit does the agent stop and ask you directly
          instead of continuing to loop. The question cap limits how many times an agent can check in
          with you mid-task before it has to proceed on its own judgment or flag a real blocker.
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Approach revisions</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={caps.approach}
              disabled={!ready || saving}
              onChange={(e) => updateCap("approach", Number(e.target.value))}
            />
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Review revisions</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={caps.review}
              disabled={!ready || saving}
              onChange={(e) => updateCap("review", Number(e.target.value))}
            />
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Clarifying questions</Label>
            <Input
              type="number"
              min={0}
              max={10}
              value={caps.question}
              disabled={!ready || saving}
              onChange={(e) => updateCap("question", Number(e.target.value))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
