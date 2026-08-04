import { useEffect, useState } from "react";
import { Download, Upload, RotateCcw, X, Database, Loader2, Settings2, ChevronRight } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AGENTS } from "../data/agents";
import {
  useBackendsStore,
  BackendsConfigSchema,
  defaultBackendsConfig,
} from "../lib/agent-backends";
import {
  ROUTER_MODELS,
  supportsPriority,
  type RouterBackend,
} from "../lib/model-catalog";
import { pingRagStore } from "../lib/rag.functions";
import { checkAssistantDrift } from "../lib/agent-inspect.functions";
import { useHuddleStore } from "../store";
import { useAgentPanelStore } from "../lib/agent-panel-store";
import { MemoryDbPanel } from "./MemoryDbPanel";
import { AccountSettingsPanel } from "./AccountSettingsPanel";
import { ExecutiveProfilePanel } from "./ExecutiveProfilePanel";
import { AgentWorkflowPanel } from "./AgentWorkflowPanel";
import { ArtifactMirroringPanel } from "./ArtifactMirroringPanel";
import { SchedulingPanel } from "./SchedulingPanel";

interface SettingsSheetProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function SettingsSheet({ open, onOpenChange }: SettingsSheetProps) {
  const config = useBackendsStore((s) => s.config);
  const setRouter = useBackendsStore((s) => s.setRouter);
  const setAgent = useBackendsStore((s) => s.setAgent);
  const replaceConfig = useBackendsStore((s) => s.replaceConfig);
  const resetToDefaults = useBackendsStore((s) => s.resetToDefaults);
  const showDemoData = useHuddleStore((s) => s.showDemoData);
  const setShowDemoData = useHuddleStore((s) => s.setShowDemoData);
  const openAgent = useAgentPanelStore((s) => s.openAgent);

  function openAgentDrawer(id: (typeof AGENTS)[number]["id"]) {
    onOpenChange(false);
    // small delay so the sheet close animation doesn't fight the new one
    setTimeout(() => openAgent(id), 60);
  }

  const [uploadError, setUploadError] = useState<string | null>(null);

  const routerModels = ROUTER_MODELS[config.router.backend];
  const modelGroups = Array.from(
    routerModels.reduce((map, m) => {
      const arr = map.get(m.group) ?? [];
      arr.push(m);
      map.set(m.group, arr);
      return map;
    }, new Map<string, typeof routerModels>()),
  );

  function onBackendChange(backend: RouterBackend) {
    // If current model isn't in the new backend's catalog, reset to that backend's default.
    const validIds = new Set(ROUTER_MODELS[backend].map((m) => m.id));
    const model = validIds.has(config.router.model)
      ? config.router.model
      : ROUTER_MODELS[backend][0].id;
    setRouter({ backend, model });
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    try {
      const text = await file.text();
      const parsed = BackendsConfigSchema.parse(JSON.parse(text));
      replaceConfig(parsed);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Invalid config");
    } finally {
      e.target.value = "";
    }
  }

  function onDownload() {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "agents.config.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function loadTemplate() {
    setUploadError(null);
    try {
      const res = await fetch("/agents.config.template.json");
      const json = await res.json();
      const parsed = BackendsConfigSchema.parse(json);
      replaceConfig(parsed);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to load template");
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 flex flex-col">
        <SheetHeader className="px-5 py-4 border-b border-hairline">
          <div className="flex items-center justify-between">
            <SheetTitle>Settings</SheetTitle>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted"
              aria-label="Close settings"
            >
              <X size={16} />
            </button>
          </div>
        </SheetHeader>

        <Tabs defaultValue="router" className="flex-1 min-h-0 flex flex-col">
          <TabsList className="mx-5 mt-4">
            <TabsTrigger value="account">Account</TabsTrigger>
            <TabsTrigger value="scheduling">Scheduling</TabsTrigger>
            <TabsTrigger value="router">Router</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="platforms">Platforms</TabsTrigger>
            <TabsTrigger value="batch">Batch</TabsTrigger>
          </TabsList>

          {/* ---- Account ---- */}
          <TabsContent value="account" className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <AccountSettingsPanel />
            <ExecutiveProfilePanel />
            <AgentWorkflowPanel />
            <ArtifactMirroringPanel />
          </TabsContent>

          {/* ---- Scheduling ---- */}
          <TabsContent value="scheduling" className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <SchedulingPanel />
          </TabsContent>

          {/* ---- Router ---- */}
          <TabsContent value="router" className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div className="space-y-2">
              <Label>Backend</Label>
              <Select value={config.router.backend} onValueChange={(v) => onBackendChange(v as RouterBackend)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI (direct)</SelectItem>
                  <SelectItem value="lovable">Lovable AI Gateway</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Which service the multi-agent router calls to pick who replies.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Model</Label>
              <Select value={config.router.model} onValueChange={(v) => setRouter({ model: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {modelGroups.map(([group, models]) => (
                    <SelectGroup key={group}>
                      <SelectLabel>{group}</SelectLabel>
                      {models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {supportsPriority(config.router.backend, config.router.model) && (
              <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
                <div>
                  <Label className="text-sm">Fast mode</Label>
                  <p className="text-xs text-muted-foreground">Request the priority serving tier (higher cost, lower latency).</p>
                </div>
                <Switch
                  checked={config.router.fastMode}
                  onCheckedChange={(v) => setRouter({ fastMode: v })}
                />
              </div>
            )}

            <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
              <div className="pr-3">
                <Label className="text-sm">Solo when covered</Label>
                <p className="text-xs text-muted-foreground">
                  Drop supporting agents when the primary already covers the
                  message. Prevents adjacent-lane pile-ons (e.g. life-strategy
                  chiming in on a workout question).
                </p>
              </div>
              <Switch
                checked={config.router.soloOnCoverage}
                onCheckedChange={(v) => setRouter({ soloOnCoverage: v })}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
              <div className="pr-3">
                <Label className="text-sm">Strict router prompt</Label>
                <p className="text-xs text-muted-foreground">
                  Tighten the LLM router's instructions to prefer a single
                  primary agent, with an explicit one-shot example. Only add
                  supporting agents when the message names a second specialty.
                </p>
              </div>
              <Switch
                checked={config.router.strictPrompt}
                onCheckedChange={(v) => setRouter({ strictPrompt: v })}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
              <div className="pr-3">
                <Label className="text-sm">Substantive interjections</Label>
                <p className="text-xs text-muted-foreground">
                  Let another agent add SPECIFIC value even when the primary
                  already covered the request — a calendar conflict, prep notes
                  for a named contact, a risk. Not topical adjacency; each
                  interjector stays silent unless it has something concrete. Off
                  keeps pure solo.
                </p>
              </div>
              <Switch
                checked={config.router.interjections ?? false}
                onCheckedChange={(v) => setRouter({ interjections: v })}
              />
            </div>

            {config.router.interjections && (
              <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
                <div className="pr-3">
                  <Label className="text-sm">Max interjectors per turn</Label>
                  <p className="text-xs text-muted-foreground">
                    How many agents may chime in with substantive value on a
                    single message.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="flex size-7 items-center justify-center rounded-md border border-hairline text-sm disabled:opacity-40"
                    disabled={(config.router.maxInterjectors ?? 2) <= 0}
                    onClick={() =>
                      setRouter({
                        maxInterjectors: Math.max(0, (config.router.maxInterjectors ?? 2) - 1),
                      })
                    }
                  >
                    −
                  </button>
                  <span className="w-5 text-center text-sm tabular-nums">
                    {config.router.maxInterjectors ?? 2}
                  </span>
                  <button
                    type="button"
                    className="flex size-7 items-center justify-center rounded-md border border-hairline text-sm disabled:opacity-40"
                    disabled={(config.router.maxInterjectors ?? 2) >= 4}
                    onClick={() =>
                      setRouter({
                        maxInterjectors: Math.min(4, (config.router.maxInterjectors ?? 2) + 1),
                      })
                    }
                  >
                    +
                  </button>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ---- Agents ---- */}
          <TabsContent value="agents" className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            <PlatformDriftPanel />
            {AGENTS.map((a) => {
              const cfg = config.agents[a.id];
              if (!cfg) return null;
              const hasId = !!cfg.assistantId?.trim();
              const status =
                cfg.backend === "lovable"
                  ? "Lovable AI"
                  : hasId
                  ? `OpenAI · ${cfg.model ?? "gpt-4o"}`
                  : `OpenAI · ${cfg.model ?? "gpt-4o"} (no snapshot)`;

              return (
                <div key={a.id} className="rounded-lg border border-hairline p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{a.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{a.role} · @{a.handle}</div>
                    </div>
                    <div className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded ${
                      cfg.backend === "lovable"
                        ? "bg-muted text-muted-foreground"
                        : hasId
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    }`}>{status}</div>
                  </div>

                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full justify-between font-medium shadow-sm ring-1 ring-hairline hover:bg-primary hover:text-primary-foreground"
                    onClick={() => openAgentDrawer(a.id)}
                  >
                    <span className="flex items-center">
                      <Settings2 size={14} className="mr-1.5" />
                      Full agent settings — prompt, memory, voice, tools
                    </span>
                    <ChevronRight size={15} />
                  </Button>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Backend</Label>
                      <Select
                        value={cfg.backend}
                        onValueChange={(v) => setAgent(a.id, { backend: v as "lovable" | "openai" })}
                      >
                        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="lovable">Lovable AI</SelectItem>
                          <SelectItem value="openai">OpenAI Responses</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {cfg.backend === "openai" && (
                      <div>
                        <Label className="text-xs">Assistant ID</Label>
                        <Input
                          className="h-8"
                          placeholder="asst_..."
                          value={cfg.assistantId ?? ""}
                          onChange={(e) => setAgent(a.id, { assistantId: e.target.value })}
                        />
                      </div>
                    )}
                  </div>

                  {cfg.backend === "openai" && (
                    <div>
                      <Label className="text-xs">Model</Label>
                      <Input
                        className="h-8"
                        placeholder="gpt-4o"
                        value={cfg.model ?? ""}
                        onChange={(e) =>
                          setAgent(a.id, { model: e.target.value.trim() || undefined })
                        }
                      />
                      <p className="text-xs text-muted-foreground pt-1">
                        Blank falls back to the assistant snapshot's model, then gpt-4o.
                      </p>
                    </div>
                  )}

                  <AgentContextEditor agentId={a.id} />
                </div>
              );
            })}
          </TabsContent>

          {/* ---- Platforms ---- */}
          {/* ---- Memory ---- */}
          <TabsContent value="memory" className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <MemoryTab />
          </TabsContent>

          {/* ---- Platforms ---- */}
          <TabsContent value="platforms" className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            <div className="rounded-lg border border-hairline p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold">Lovable AI Gateway</div>
                  <div className="text-xs text-muted-foreground">Managed by Lovable — always available.</div>
                </div>
                <span className="text-[10px] uppercase tracking-wide bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-1 rounded">Active</span>
              </div>
            </div>
            <div className="rounded-lg border border-hairline p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold">OpenAI</div>
                  <div className="text-xs text-muted-foreground">Direct calls to the Responses API using stored assistants.</div>
                </div>
                <span className="text-[10px] uppercase tracking-wide bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-1 rounded">Configured</span>
              </div>
              <p className="text-xs text-muted-foreground">
                To rotate the key, open the workspace secrets panel and update <code>OPENAI_API_KEY</code>.
              </p>
            </div>
          </TabsContent>

          {/* ---- Batch ---- */}
          <TabsContent value="batch" className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Upload a JSON file matching <code>agents.config.template.json</code> to update every agent (and the router) at once.
            </p>
            <div className="flex flex-wrap gap-2">
              <label className="inline-flex items-center gap-2 rounded-md border border-hairline px-3 py-2 text-sm hover:bg-muted cursor-pointer">
                <Upload size={14} /> Upload config
                <input type="file" accept="application/json" onChange={onUpload} className="app-hidden" />
              </label>
              <Button variant="outline" size="sm" onClick={onDownload}>
                <Download size={14} className="mr-1" /> Download current
              </Button>
              <Button variant="outline" size="sm" onClick={loadTemplate}>
                Load prefilled template
              </Button>
              <Button variant="ghost" size="sm" onClick={() => resetToDefaults()}>
                <RotateCcw size={14} className="mr-1" /> Reset to defaults
              </Button>
            </div>
            {uploadError && (
              <p className="text-xs text-destructive">{uploadError}</p>
            )}
            <div className="rounded-lg border border-hairline p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="pr-3">
                  <div className="text-sm font-semibold">Show demo data</div>
                  <p className="text-xs text-muted-foreground">
                    Toggle the seeded example messages, tasks, memory, and routing
                    decisions on or off. Nothing is deleted — the records are simply
                    filtered from every view while this is off.
                  </p>
                </div>
                <Switch
                  checked={showDemoData}
                  onCheckedChange={(v) => setShowDemoData(v)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-semibold">Memory DB &amp; vector stores (all agents)</div>
              <p className="text-xs text-muted-foreground">
                Cross-agent database diagnostics and batch provisioning of OpenAI vector stores.
              </p>
              <MemoryDbPanel />
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Show current config</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px]">
                {JSON.stringify(config, null, 2)}
              </pre>
            </details>
          </TabsContent>
        </Tabs>

        <p className="border-t border-hairline px-5 py-3 text-[11px] text-muted-foreground">
          Router: <b>{config.router.backend}</b> · {config.router.model}
          {config.router.fastMode ? " · fast" : ""}
        </p>
      </SheetContent>
    </Sheet>
  );
}

export function useSettingsSheet() {
  const [open, setOpen] = useState(false);
  return { open, setOpen };
}

// ---------------- Platform drift check ----------------

type DriftRow = Awaited<ReturnType<typeof checkAssistantDrift>>["rows"][number];

function PlatformDriftPanel() {
  const setAgent = useBackendsStore((s) => s.setAgent);
  const config = useBackendsStore((s) => s.config);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<DriftRow[] | null>(null);

  async function runCheck() {
    setLoading(true);
    setError(null);
    try {
      const res = await checkAssistantDrift();
      if (!res.ok) {
        setError(res.error);
        setRows(null);
      } else {
        setRows(res.rows);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Check failed");
    } finally {
      setLoading(false);
    }
  }

  function applyRow(r: DriftRow, applied: boolean) {
    if (applied) {
      setAgent(r.agentId, { instructionsOverride: undefined });
      return;
    }
    if (!r.liveInstructions) return;
    setAgent(r.agentId, {
      instructionsOverride: r.liveInstructions,
      ...(r.liveModel ? { model: r.liveModel } : {}),
    });
  }

  const drifted = (rows ?? []).filter(
    (r) => r.status === "changed" || r.status === "no-local",
  );

  return (
    <div className="rounded-lg border border-hairline p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Platform sync</div>
          <div className="text-xs text-muted-foreground">
            Check whether any OpenAI assistant has changed on the platform since the bundled snapshot.
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={runCheck} disabled={loading}>
          {loading ? (
            <Loader2 size={14} className="mr-1.5 animate-spin" />
          ) : (
            <RotateCcw size={14} className="mr-1.5" />
          )}
          Check for updates
        </Button>
      </div>

      {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}

      {rows && (
        <div className="space-y-1.5">
          {drifted.length === 0 ? (
            <div className="text-xs text-emerald-700 dark:text-emerald-300">
              Up to date — every platform assistant matches the bundled snapshot.
            </div>
          ) : (
            <>
              <div className="text-xs text-amber-700 dark:text-amber-300">
                {drifted.length} assistant{drifted.length === 1 ? "" : "s"} drifted from the snapshot.
                Apply pulls the live platform instructions into this browser now; re-run the
                sync-assistants workflow to update the repo snapshot for everyone.
              </div>
              {drifted.map((r) => {
                const applied = !!config.agents[r.agentId]?.instructionsOverride;
                return (
                  <div
                    key={r.agentId}
                    className="flex items-center justify-between gap-2 rounded border border-hairline px-2 py-1.5"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">{r.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {r.status === "no-local"
                          ? "not in local snapshot"
                          : `changed: ${r.changedFields.join(", ")}`}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={applied ? "secondary" : "outline"}
                      className="h-7 shrink-0"
                      disabled={!r.liveInstructions}
                      onClick={() => applyRow(r, applied)}
                    >
                      {applied ? "Applied ✓ (clear)" : "Apply to app"}
                    </Button>
                  </div>
                );
              })}
            </>
          )}
          {rows.some((r) => r.status === "error") && (
            <div className="text-[11px] text-muted-foreground">
              {rows.filter((r) => r.status === "error").length} assistant(s) could not be checked.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- Memory tab ----------------

type PingResult =
  | { ok: true; version: string; extensions: string[] }
  | { ok: false; error: string };

function MemoryTab() {
  const config = useBackendsStore((s) => s.config);
  const setAgent = useBackendsStore((s) => s.setAgent);
  const [pinging, setPinging] = useState(false);
  const [ping, setPing] = useState<PingResult | null>(null);

  async function onTest() {
    setPinging(true);
    setPing(null);
    try {
      const res = (await pingRagStore({ data: { store: "azure" } })) as PingResult;
      setPing(res);
    } catch (err) {
      setPing({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setPinging(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-hairline p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold flex items-center gap-2">
              <Database size={14} /> Azure Postgres + pgvector
            </div>
            <div className="text-xs text-muted-foreground">
              Uses <code>AZURE_PG_URL</code> secret. Chunks and triples stored on your instance.
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={onTest} disabled={pinging}>
            {pinging ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
            Test connection
          </Button>
        </div>
        {ping && ping.ok && (
          <div className="text-xs rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 p-2">
            <div className="font-medium">Connected</div>
            <div className="opacity-80 truncate">{ping.version}</div>
            <div className="opacity-80">Extensions: {ping.extensions.join(", ") || "(none)"}</div>
          </div>
        )}
        {ping && !ping.ok && (
          <div className="text-xs rounded bg-destructive/10 text-destructive p-2 whitespace-pre-wrap break-all">
            {ping.error}
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Per-agent retrieval tools. The model decides when to call{" "}
        <b>search_memory</b> (semantic chunks) vs <b>lookup_facts</b> (structured triples).
        Turn a tool off to hide it from that agent.
      </p>

      <div className="space-y-3">
        {AGENTS.map((a) => {
          const cfg = config.agents[a.id];
          if (!cfg) return null;
          const rag = cfg.rag ?? {
            store: "azure" as const,
            chunks: true,
            triples: true,
            fileSearch: false,
            sharing: "shared" as const,
          };
          const setRag = (patch: Partial<typeof rag>) =>
            setAgent(a.id, { rag: { ...rag, ...patch } });
          return (
            <div key={a.id} className="rounded-lg border border-hairline p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{a.name}</div>
                  <div className="text-xs text-muted-foreground truncate">@{a.handle}</div>
                </div>
                <Select
                  value={rag.store}
                  onValueChange={(v) => setRag({ store: v as "azure" | "lovable" | "none" })}
                >
                  <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="azure">Azure pgvector</SelectItem>
                    <SelectItem value="lovable" disabled>
                      Lovable Cloud (soon)
                    </SelectItem>
                    <SelectItem value="none">Off</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {rag.store !== "none" && (
                <div className="flex items-center justify-between gap-3 pt-1">
                  <div>
                    <Label className="text-sm">Shared memory</Label>
                    <p className="text-xs text-muted-foreground">
                      On = this agent reads and writes shared memory. Off = private to this agent.
                    </p>
                  </div>
                  <Switch
                    checked={(rag.sharing ?? "shared") === "shared"}
                    onCheckedChange={(v) => setRag({ sharing: v ? "shared" : "private" })}
                  />
                </div>
              )}

              {rag.store !== "none" && (
                <div className="grid grid-cols-3 gap-2 pt-1">
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={rag.chunks}
                      onCheckedChange={(v) => setRag({ chunks: v })}
                    />
                    Chunks
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={rag.triples}
                      onCheckedChange={(v) => setRag({ triples: v })}
                    />
                    Facts
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={rag.fileSearch}
                      onCheckedChange={(v) => setRag({ fileSearch: v })}
                    />
                    File search
                  </label>
                </div>
              )}

              {rag.store !== "none" && rag.fileSearch && (
                <Input
                  className="h-8"
                  placeholder="vs_... (OpenAI vector store id)"
                  value={rag.openaiVectorStoreId ?? ""}
                  onChange={(e) => setRag({ openaiVectorStoreId: e.target.value })}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- Per-agent context entry ----------------

import { Plus, Trash2 } from "lucide-react";
import type { AgentId } from "../data/agents";

function AgentContextEditor({ agentId }: { agentId: AgentId }) {
  const memory = useHuddleStore((s) => s.memory);
  const addMemoryItem = useHuddleStore((s) => s.addMemoryItem);
  const removeMemoryItem = useHuddleStore((s) => s.removeMemoryItem);
  const [draft, setDraft] = useState("");

  const entries = memory.filter((m) => m.agentId === agentId && !m.demo);

  function commit() {
    const label = draft.trim();
    if (!label) return;
    addMemoryItem({ agentId, kind: "fact", label, editable: true });
    setDraft("");
  }

  return (
    <div className="pt-2 border-t border-hairline space-y-2">
      <Label className="text-xs">Context entries</Label>
      <p className="text-[11px] text-muted-foreground">
        Add facts, preferences, or knowledge this agent should always remember.
      </p>
      {entries.length > 0 && (
        <ul className="space-y-1">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between gap-2 rounded bg-muted/60 px-2 py-1 text-xs"
            >
              <span className="truncate">{e.label}</span>
              <button
                type="button"
                onClick={() => removeMemoryItem(e.id)}
                className="inline-flex size-6 items-center justify-center rounded hover:bg-muted"
                aria-label="Remove entry"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          className="h-8"
          placeholder="e.g. I prefer concise, bulleted answers"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
        <Button size="sm" variant="outline" onClick={commit} disabled={!draft.trim()}>
          <Plus size={14} className="mr-1" /> Add
        </Button>
      </div>
    </div>
  );
}
