import { useState } from "react";
import { Download, Upload, RotateCcw, X, Database, Loader2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
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
import { useHuddleStore } from "../store";

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
            <TabsTrigger value="router">Router</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="platforms">Platforms</TabsTrigger>
            <TabsTrigger value="batch">Batch</TabsTrigger>
          </TabsList>

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
          </TabsContent>

          {/* ---- Agents ---- */}
          <TabsContent value="agents" className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
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
                <input type="file" accept="application/json" onChange={onUpload} className="hidden" />
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
              <div className="text-sm font-semibold">Demo data</div>
              <p className="text-xs text-muted-foreground">
                Remove the seeded example messages, tasks, memory, and routing decisions from this workspace. This affects only your browser; it does not touch server data.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  clearDemoData();
                  setDemoCleared(true);
                }}
              >
                <RotateCcw size={14} className="mr-1" /> Clear demo data
              </Button>
              {demoCleared && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">Demo data cleared.</p>
              )}
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
