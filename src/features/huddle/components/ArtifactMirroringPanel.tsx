import { useCallback, useEffect, useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { getMirrorConfigFn, setMirrorConfigFn } from "../lib/artifacts/artifacts.functions";
import { toast } from "sonner";

type Cfg = { mirror_on_approve: boolean; onedrive_enabled: boolean; gdrive_enabled: boolean };

// Settings panel for one-way artifact mirroring (Azure → cloud drives). Defaults all-on; every change
// saves the WHOLE config so toggles are durable and independent. OneDrive is live; Google Drive is Phase 3.
export function ArtifactMirroringPanel() {
  const { user } = useAuth();
  const caller = useMemo(
    () => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined),
    [user],
  );
  const [cfg, setCfg] = useState<Cfg>({ mirror_on_approve: true, onedrive_enabled: true, gdrive_enabled: true });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!caller) return;
    void (async () => {
      try {
        const res = await getMirrorConfigFn({ data: { caller } });
        setCfg(res.config);
      } catch { /* keep defaults */ }
      setReady(true);
    })();
  }, [caller]);

  const save = useCallback(async (next: Cfg) => {
    setCfg(next);
    if (!caller) return;
    try {
      const res = await setMirrorConfigFn({ data: { caller, ...next } });
      if (!res.ok) toast.error(res.error ?? "Couldn't save");
    } catch { toast.error("Couldn't save"); }
  }, [caller]);

  const Row = ({ label, hint, checked, onChange, disabledNote }: {
    label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabledNote?: string;
  }) => (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <Label className="text-sm">{label}{disabledNote && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{disabledNote}</span>}</Label>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={!ready} />
    </div>
  );

  return (
    <div className="rounded-lg border p-4">
      <h3 className="mb-1 text-sm font-semibold">Artifact mirroring</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Agent artifacts live in Azure. Mirror approved ones to your cloud drives so they open natively.
      </p>
      <div className="divide-y">
        <Row
          label="Mirror on approve"
          hint="When you approve an artifact, push it to your enabled drives automatically."
          checked={cfg.mirror_on_approve}
          onChange={(v) => save({ ...cfg, mirror_on_approve: v })}
        />
        <Row
          label="OneDrive"
          hint="Upload to your OneDrive under “Huddle Artifacts”. Needs admin consent (Files.ReadWrite.All)."
          checked={cfg.onedrive_enabled}
          onChange={(v) => save({ ...cfg, onedrive_enabled: v })}
        />
        <Row
          label="Google Drive"
          hint="Upload to your Google Drive. Push arrives in Phase 3; the preference is saved now."
          checked={cfg.gdrive_enabled}
          onChange={(v) => save({ ...cfg, gdrive_enabled: v })}
          disabledNote="Phase 3"
        />
      </div>
    </div>
  );
}
