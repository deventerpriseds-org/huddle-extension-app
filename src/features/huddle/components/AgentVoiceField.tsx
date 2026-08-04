import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { AGENT_BY_ID, type AgentId } from "../data/agents";
import { synthesizeSpeech } from "../lib/voice/tts.functions";
import { getVoiceOverridesFn, setVoiceOverrideFn } from "../lib/voice/voice-config.functions";

// Editable + testable per-agent ElevenLabs voice id. Self-contained so it can live in BOTH the
// SettingsSheet agent card and the full AgentSettingsDrawer without duplicating the load/test/save logic.
// The saved value persists server-side (identity.agent_voice) and applies to every voice path.
export function AgentVoiceField({ agentId }: { agentId: AgentId }) {
  const agent = AGENT_BY_ID[agentId];
  const fallback = agent?.voiceId ?? "";
  const [value, setValue] = useState(fallback);
  const [busy, setBusy] = useState<null | "test" | "save" | "reset">(null);

  useEffect(() => {
    let alive = true;
    getVoiceOverridesFn()
      .then((r) => { if (alive) setValue((r.ok && r.overrides[agentId]) || fallback); })
      .catch(() => { if (alive) setValue(fallback); });
    return () => { alive = false; };
  }, [agentId, fallback]);

  async function test() {
    setBusy("test");
    try {
      const r = await synthesizeSpeech({
        data: { agentId, text: `Hi, this is ${agent?.name ?? "your assistant"}. How do I sound?`, voiceId: value.trim() || undefined },
      });
      if (r.ok && r.audioBase64) await new Audio(`data:audio/mpeg;base64,${r.audioBase64}`).play().catch(() => {});
      else toast.error(r.ok ? "No audio returned" : r.error);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    try {
      const r = await setVoiceOverrideFn({ data: { agentId, voiceId: value.trim() } });
      if (r.ok) toast.success("Voice saved — applies to every voice path.");
      else toast.error(r.error);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    try {
      const r = await setVoiceOverrideFn({ data: { agentId, voiceId: "" } });
      if (r.ok) { setValue(fallback); toast.success("Reset to the default voice."); }
      else toast.error(r.error);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <div className="font-medium">Voice ID (ElevenLabs)</div>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={fallback}
        spellCheck={false}
        className="w-full rounded-md border border-hairline bg-background px-2 py-1.5 font-mono text-[12px]"
      />
      <div className="text-[11px] text-muted-foreground">
        Default: <code>{fallback}</code>. <b>Test</b> previews the value above without saving; <b>Save</b>{" "}
        applies it to every voice path (1:1, ceremony, group) across devices.
      </div>
      <div className="flex flex-wrap gap-2 pt-0.5">
        <Button size="sm" variant="secondary" disabled={busy !== null || !value.trim()} onClick={test}>
          {busy === "test" ? <Loader2 size={13} className="animate-spin" /> : null}
          <span className="ml-1.5">Test voice</span>
        </Button>
        <Button size="sm" disabled={busy !== null} onClick={save}>
          {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : null}
          <span className="ml-1.5">Save</span>
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={reset}>
          {busy === "reset" ? <Loader2 size={13} className="animate-spin" /> : null}
          <span className="ml-1.5">Reset to default</span>
        </Button>
      </div>
    </div>
  );
}
