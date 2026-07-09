import { useEffect, useState } from "react";
import { X, RefreshCw, Loader2, AlertTriangle, CheckCircle2, PlusCircle } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AGENT_BY_ID, type AgentId } from "../data/agents";
import { useAgentPanelStore } from "../lib/agent-panel-store";
import { useBackendsStore, ASSISTANT_IDS } from "../lib/agent-backends";
import { getAgentDebug, refetchAgentSnapshot } from "../lib/agent-inspect.functions";
import { saveMemoryItem } from "../lib/rag.functions";
import { AgentAvatar } from "./AgentAvatar";
import { MemoryDbPanel } from "./MemoryDbPanel";
import { toast } from "sonner";


export function AgentSettingsDrawer() {
  const openId = useAgentPanelStore((s) => s.openAgentId);
  const closeAgent = useAgentPanelStore((s) => s.closeAgent);
  const turns = useAgentPanelStore((s) => s.turns);
  const fallbacks = useAgentPanelStore((s) => s.fallbacks);
  const backendCfg = useBackendsStore((s) => s.config);

  const [debug, setDebug] = useState<Awaited<ReturnType<typeof getAgentDebug>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [refetching, setRefetching] = useState(false);
  const [ctxText, setCtxText] = useState("");
  const [ctxScope, setCtxScope] = useState<"agent" | "global">("agent");
  const [extractFacts, setExtractFacts] = useState(true);
  const [savingCtx, setSavingCtx] = useState(false);


  useEffect(() => {
    if (!openId) {
      setDebug(null);
      setCtxText("");
      setCtxScope("agent");
      return;
    }
    setLoading(true);
    setCtxText("");
    setCtxScope("agent");
    getAgentDebug({ data: { agentId: openId } })
      .then(setDebug)
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Failed to load agent debug"))
      .finally(() => setLoading(false));
  }, [openId]);


  async function handleSaveContext() {
    if (!openId) return;
    const text = ctxText.trim();
    if (!text) return;
    setSavingCtx(true);
    try {
      const r = await saveMemoryItem({
        data: {
          text,
          scope: ctxScope,
          agentId: ctxScope === "agent" ? openId : undefined,
          source: agent ? `settings:${agent.name}` : "settings",
          extractFacts,
        },
      });
      toast.success(`Saved memory (chunk ${r.chunkId.slice(0, 8)}…, ${r.tripleCount} facts)`);
      setCtxText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingCtx(false);
    }
  }

  if (!openId) return null;

  const agent = AGENT_BY_ID[openId];
  const backend = backendCfg.agents[openId];
  const assistantId = ASSISTANT_IDS[openId];
  const agentFallbacks = fallbacks.filter((f) => f.agentId === openId);
  const agentTurns = turns
    .map((t) => ({ ...t, prompt: t.prompts.find((p) => p.agentId === openId) }))
    .filter((t) => t.prompt);

  async function handleRefetch() {
    if (!assistantId) return;
    setRefetching(true);
    try {
      const result = await refetchAgentSnapshot({ data: { agentId: openId! } });
      if (result.ok) {
        toast.success(`Refetched ${agent.name}: ${result.model} · ${result.instructionsLen} chars`);
        // Reload debug view.
        const next = await getAgentDebug({ data: { agentId: openId! } });
        setDebug(next);
      } else {
        toast.error(`Refetch failed: ${result.error}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refetch failed");
    } finally {
      setRefetching(false);
    }
  }

  return (
    <Sheet open={!!openId} onOpenChange={(o) => !o && closeAgent()}>
      <SheetContent side="right" className="w-full max-w-2xl p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-hairline px-5 py-4">
          <div className="flex items-center gap-3">
            <AgentAvatar agent={agent} size="lg" />
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-left text-base">{agent.name}</SheetTitle>
              <div className="text-xs text-muted-foreground">
                @{agent.handle} · {agent.role}
              </div>
            </div>
            <button
              type="button"
              onClick={closeAgent}
              className="inline-flex size-8 items-center justify-center rounded-md hover:bg-muted"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </SheetHeader>

        <div className="flex h-[calc(100dvh-70px)] flex-col overflow-y-auto">
          <div className="flex flex-col gap-5 p-5">
            {loading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" /> Loading agent config…
              </div>
            )}

            {debug && (
              <>
                {/* Snapshot status */}
                <section>
                  <SectionTitle>Snapshot status</SectionTitle>
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-hairline bg-surface p-3">
                    {debug.hasSnapshot ? (
                      <CheckCircle2 size={16} className="mt-0.5 text-emerald-500" />
                    ) : (
                      <AlertTriangle size={16} className="mt-0.5 text-amber-500" />
                    )}
                    <div className="min-w-0 flex-1 text-[13px]">
                      {debug.hasSnapshot ? (
                        <>
                          <div className="font-medium">
                            Authored — using OpenAI snapshot
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {debug.snapshotName ?? "(unnamed)"} · fetched{" "}
                            {debug.fetchedAt
                              ? new Date(debug.fetchedAt).toLocaleString()
                              : "—"}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="font-medium">
                            Fallback — no OpenAI snapshot, using in-repo persona prompt
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            Set correct assistantId and run{" "}
                            <code className="rounded bg-muted px-1">bun run fetch:assistants</code>
                            .
                          </div>
                        </>
                      )}
                    </div>
                    {assistantId && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={refetching}
                        onClick={handleRefetch}
                      >
                        {refetching ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <RefreshCw size={12} />
                        )}
                        <span className="ml-1.5">Refetch</span>
                      </Button>
                    )}
                  </div>
                </section>

                {/* Backend + model */}
                <section>
                  <SectionTitle>Backend & model</SectionTitle>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
                    <Field label="Backend" value={backend?.backend ?? "lovable"} />
                    <Field label="Model" value={debug.resolvedModel} />
                    <Field
                      label="Assistant ID"
                      value={assistantId ?? "—"}
                      mono
                    />
                    <Field
                      label="RAG store"
                      value={backend?.rag?.store ?? "none"}
                    />
                    <Field
                      label="RAG chunks"
                      value={String(backend?.rag?.chunks ?? false)}
                    />
                    <Field
                      label="RAG triples"
                      value={String(backend?.rag?.triples ?? false)}
                    />
                    <Field
                      label="File search"
                      value={String(backend?.rag?.fileSearch ?? false)}
                    />
                    <Field
                      label="RAG sharing"
                      value={backend?.rag?.sharing ?? "shared"}
                    />
                  </div>
                </section>


                {/* Tools */}
                <section>
                  <SectionTitle>Snapshot tools</SectionTitle>
                  {debug.snapshotTools.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      No snapshot tools.
                    </p>
                  ) : (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {debug.snapshotTools.map((t: string, i: number) => (
                        <li
                          key={i}
                          className="rounded-md bg-muted px-2 py-0.5 text-[11px]"
                        >
                          {t}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* System prompt */}
                <section>
                  <SectionTitle>
                    System prompt (exactly what is sent as{" "}
                    <code className="text-[11px]">instructions</code>)
                  </SectionTitle>
                  <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-hairline bg-surface p-3 text-[11px] leading-relaxed whitespace-pre-wrap font-mono">
                    {debug.previewInstructions}
                  </pre>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Scene/priorTurn block is inserted at reply time and not shown here.
                    Roster block is included.
                  </p>
                </section>

                {/* Add context to memory — directly under the system prompt. */}
                <section>
                  <SectionTitle>Add context to memory</SectionTitle>
                  <div className="mt-2 rounded-lg border border-hairline bg-surface p-3">
                    <textarea
                      value={ctxText}
                      onChange={(e) => setCtxText(e.target.value)}
                      disabled={savingCtx}
                      rows={3}
                      placeholder={`Fact, note, or reference for ${agent.name}. Saved as an embedded chunk; facts auto-extracted.`}
                      className="w-full resize-y rounded-md border border-hairline bg-surface px-2 py-1.5 text-[12px] font-mono outline-none focus:border-primary"
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                      <div className="flex items-center gap-1 rounded-md border border-hairline bg-surface p-0.5">
                        <button
                          type="button"
                          onClick={() => setCtxScope("agent")}
                          className={`rounded px-2 py-0.5 ${ctxScope === "agent" ? "bg-primary text-primary-foreground" : ""}`}
                        >
                          {agent.name} only
                        </button>
                        <button
                          type="button"
                          onClick={() => setCtxScope("global")}
                          className={`rounded px-2 py-0.5 ${ctxScope === "global" ? "bg-primary text-primary-foreground" : ""}`}
                        >
                          shared (all agents)
                        </button>
                      </div>
                      <label className="flex items-center gap-1.5 text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={extractFacts}
                          onChange={(e) => setExtractFacts(e.target.checked)}
                        />
                        extract facts (triples)
                      </label>
                      <Button
                        size="sm"
                        className="ml-auto"
                        disabled={savingCtx || !ctxText.trim()}
                        onClick={handleSaveContext}
                      >
                        {savingCtx ? <Loader2 size={12} className="animate-spin" /> : <PlusCircle size={12} />}
                        <span className="ml-1.5">Save to memory</span>
                      </Button>
                    </div>
                  </div>
                </section>

                {/* Agent fallbacks */}

                {agentFallbacks.length > 0 && (
                  <section>
                    <SectionTitle>Recent fallbacks for this agent</SectionTitle>
                    <ul className="mt-2 flex flex-col gap-1.5">
                      {agentFallbacks.slice(0, 10).map((f) => (
                        <li
                          key={f.id}
                          className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px]"
                        >
                          <div className="flex items-center gap-1.5">
                            <AlertTriangle size={11} className="text-amber-500" />
                            <span className="font-medium">{f.subsystem}</span>
                            <span className="ml-auto text-muted-foreground">
                              {new Date(f.ts).toLocaleTimeString()}
                            </span>
                          </div>
                          <p className="mt-0.5 text-muted-foreground">{f.reason}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {/* Prompt history */}
                {agentTurns.length > 0 && (
                  <section>
                    <SectionTitle>Last prompts sent ({agentTurns.length})</SectionTitle>
                    <div className="mt-2 flex flex-col gap-2">
                      {agentTurns.slice(0, 5).map((t) => (
                        <details
                          key={t.turnId}
                          className="rounded-lg border border-hairline bg-surface"
                        >
                          <summary className="cursor-pointer px-3 py-2 text-[12px]">
                            <span className="text-muted-foreground">
                              {new Date(t.ts).toLocaleTimeString()}
                            </span>{" "}
                            · {t.prompt!.backend} · {t.prompt!.model} ·{" "}
                            <span className="text-muted-foreground">
                              user: “{t.userText.slice(0, 60)}
                              {t.userText.length > 60 ? "…" : ""}”
                            </span>
                          </summary>
                          <pre className="max-h-72 overflow-auto border-t border-hairline p-3 text-[10px] leading-relaxed whitespace-pre-wrap font-mono">
                            {t.prompt!.instructions}
                          </pre>
                        </details>
                      ))}
                    </div>
                  </section>
                )}

                {/* Memory DB — live, real diagnostic + context capture. At the bottom. */}
                <section>
                  <SectionTitle>Memory DB (live)</SectionTitle>
                  <div className="mt-2">
                    <MemoryDbPanel agentId={openId} agentName={agent.name} />
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border border-hairline bg-surface px-2.5 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={mono ? "font-mono text-[11px] break-all" : "text-[12px]"}>
        {value}
      </div>
    </div>
  );
}

// Re-export type so consumers don't need to import from lib.
export type { AgentId };
