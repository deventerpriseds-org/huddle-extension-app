import { useEffect, useState } from "react";
import {
  X,
  RefreshCw,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  PlusCircle,
  Trash2,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AGENT_BY_ID, type AgentId } from "../data/agents";
import { useAgentPanelStore } from "../lib/agent-panel-store";
import { useBackendsStore, ASSISTANT_IDS } from "../lib/agent-backends";
import { getAgentDebug, refetchAgentSnapshot } from "../lib/agent-inspect.functions";
import { synthesizeSpeech } from "../lib/voice/tts.functions";
import { getVoiceOverridesFn, setVoiceOverrideFn } from "../lib/voice/voice-config.functions";
import { saveMemoryItem, listMemoryItems, deleteMemoryItem } from "../lib/rag.functions";
import { provisionAgentVectorStores } from "../lib/openai-provisioning.functions";
import { AgentAvatar } from "./AgentAvatar";
import { MemoryDbPanel } from "./MemoryDbPanel";
import { toast } from "sonner";

type MemoryChunk = {
  id: string;
  scope: "agent" | "global";
  agentId: string | null;
  text: string;
  source: string | null;
  createdAt: string;
};

export function AgentSettingsDrawer() {
  const openId = useAgentPanelStore((s) => s.openAgentId);
  const closeAgent = useAgentPanelStore((s) => s.closeAgent);
  const turns = useAgentPanelStore((s) => s.turns);
  const fallbacks = useAgentPanelStore((s) => s.fallbacks);
  const backendCfg = useBackendsStore((s) => s.config);

  const setAgent = useBackendsStore((s) => s.setAgent);

  const [debug, setDebug] = useState<Awaited<ReturnType<typeof getAgentDebug>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [refetching, setRefetching] = useState(false);
  const [ctxText, setCtxText] = useState("");
  const [ctxScope, setCtxScope] = useState<"agent" | "global">("agent");
  const [extractFacts, setExtractFacts] = useState(true);
  const [savingCtx, setSavingCtx] = useState(false);
  const [memoryItems, setMemoryItems] = useState<MemoryChunk[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  // Per-agent voice id (ElevenLabs). `voiceInput` is the editable field (override or default); busy tags
  // which voice action is in flight.
  const [voiceInput, setVoiceInput] = useState("");
  const [voiceBusy, setVoiceBusy] = useState<null | "test" | "save" | "reset">(null);

  async function refreshMemoryList(agentId: string) {
    setMemoryLoading(true);
    try {
      const r = await listMemoryItems({ data: { agentId, limit: 100 } });
      setMemoryItems(r.rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load memory list");
    } finally {
      setMemoryLoading(false);
    }
  }

  useEffect(() => {
    if (!openId) {
      setDebug(null);
      setCtxText("");
      setCtxScope("agent");
      setMemoryItems([]);
      setVoiceInput("");
      return;
    }
    setLoading(true);
    setCtxText("");
    setCtxScope("agent");
    setMemoryItems([]);
    getAgentDebug({ data: { agentId: openId } })
      .then(setDebug)
      .catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : "Failed to load agent debug"),
      )
      .finally(() => setLoading(false));
    // Seed the voice field with the saved override if any, else the agents.ts default.
    const fallbackVoice = AGENT_BY_ID[openId]?.voiceId ?? "";
    getVoiceOverridesFn()
      .then((r) => setVoiceInput((r.ok && r.overrides[openId]) || fallbackVoice))
      .catch(() => setVoiceInput(fallbackVoice));
    refreshMemoryList(openId);
  }, [openId]);

  async function handleTestVoice() {
    if (!openId) return;
    setVoiceBusy("test");
    try {
      const name = AGENT_BY_ID[openId]?.name ?? "your assistant";
      const r = await synthesizeSpeech({
        data: { agentId: openId, text: `Hi, this is ${name}. How do I sound?`, voiceId: voiceInput.trim() || undefined },
      });
      if (r.ok && r.audioBase64) await new Audio(`data:audio/mpeg;base64,${r.audioBase64}`).play().catch(() => {});
      else toast.error(r.ok ? "No audio returned" : r.error);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setVoiceBusy(null);
    }
  }

  async function handleSaveVoice() {
    if (!openId) return;
    setVoiceBusy("save");
    try {
      const r = await setVoiceOverrideFn({ data: { agentId: openId, voiceId: voiceInput.trim() } });
      if (r.ok) toast.success("Voice saved — applies to every voice path.");
      else toast.error(r.error);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setVoiceBusy(null);
    }
  }

  async function handleResetVoice() {
    if (!openId) return;
    setVoiceBusy("reset");
    try {
      const r = await setVoiceOverrideFn({ data: { agentId: openId, voiceId: "" } });
      if (r.ok) {
        setVoiceInput(AGENT_BY_ID[openId]?.voiceId ?? "");
        toast.success("Reset to the default voice.");
      } else toast.error(r.error);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setVoiceBusy(null);
    }
  }

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
      await refreshMemoryList(openId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingCtx(false);
    }
  }

  async function handleDeleteMemory(id: string) {
    if (!openId) return;
    setDeletingId(id);
    try {
      const r = await deleteMemoryItem({ data: { id } });
      if (r.deleted > 0) {
        toast.success("Memory item deleted");
        setMemoryItems((prev) => prev.filter((m) => m.id !== id));
      } else {
        toast.error("Nothing deleted (item may already be gone)");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
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

  async function handleProvisionStore() {
    if (!openId) return;
    setProvisioning(true);
    try {
      const existing = backend?.rag?.openaiVectorStoreId
        ? { [openId]: backend.rag.openaiVectorStoreId }
        : {};
      const r = await provisionAgentVectorStores({ data: { existing, onlyMissing: true } });
      if (!r.ok) {
        toast.error(r.error ?? "Provision failed");
        return;
      }
      const mine = r.results.find((row) => row.agentId === openId);
      if (!mine || !mine.vectorStoreId) {
        toast.error(mine?.error ?? "No store id returned");
        return;
      }
      setAgent(openId, {
        rag: {
          ...(backend?.rag ?? {
            store: "azure" as const,
            chunks: true,
            triples: true,
            fileSearch: false,
            sharing: "shared" as const,
          }),
          openaiVectorStoreId: mine.vectorStoreId,
          fileSearch: true,
        },
      });
      toast.success(
        mine.created
          ? `Vector store created: ${mine.vectorStoreId}`
          : `Reusing existing vector store: ${mine.vectorStoreId}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Provision failed");
    } finally {
      setProvisioning(false);
    }
  }

  function toggleWebSearch(next: boolean) {
    if (!openId) return;
    setAgent(openId, { webSearch: next });
  }

  function toggleJourney(next: boolean) {
    if (!openId) return;
    setAgent(openId, { journey: { enabled: next } });
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
                          <div className="font-medium">Authored — using OpenAI snapshot</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {debug.snapshotName ?? "(unnamed)"} · fetched{" "}
                            {debug.fetchedAt ? new Date(debug.fetchedAt).toLocaleString() : "—"}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="font-medium">
                            Fallback — no OpenAI snapshot, using in-repo persona prompt
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            Set correct assistantId and run{" "}
                            <code className="rounded bg-muted px-1">bun run fetch:assistants</code>.
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
                    <Field label="Assistant ID" value={assistantId ?? "—"} mono />
                    <Field label="RAG store" value={backend?.rag?.store ?? "none"} />
                    <Field label="RAG chunks" value={String(backend?.rag?.chunks ?? false)} />
                    <Field label="RAG triples" value={String(backend?.rag?.triples ?? false)} />
                    <Field label="File search" value={String(backend?.rag?.fileSearch ?? false)} />
                    <Field label="RAG sharing" value={backend?.rag?.sharing ?? "shared"} />
                  </div>
                </section>

                {/* Voice (ElevenLabs) — editable + testable per agent, persisted globally */}
                <section>
                  <SectionTitle>Voice (ElevenLabs)</SectionTitle>
                  <div className="mt-2 flex flex-col gap-2 rounded-lg border border-hairline bg-surface p-3 text-[12px]">
                    <label className="font-medium" htmlFor="voice-id-input">Voice ID</label>
                    <input
                      id="voice-id-input"
                      type="text"
                      value={voiceInput}
                      onChange={(e) => setVoiceInput(e.target.value)}
                      placeholder={agent?.voiceId}
                      spellCheck={false}
                      className="w-full rounded-md border border-hairline bg-background px-2 py-1.5 font-mono text-[12px]"
                    />
                    <div className="text-[11px] text-muted-foreground">
                      Default: <code>{agent?.voiceId}</code>. <b>Test</b> previews the value above without
                      saving; <b>Save</b> applies it to every voice path (1:1, ceremony, group) across devices.
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button size="sm" variant="secondary" disabled={voiceBusy !== null || !voiceInput.trim()} onClick={handleTestVoice}>
                        {voiceBusy === "test" ? <Loader2 size={13} className="animate-spin" /> : null}
                        <span className="ml-1.5">Test voice</span>
                      </Button>
                      <Button size="sm" disabled={voiceBusy !== null} onClick={handleSaveVoice}>
                        {voiceBusy === "save" ? <Loader2 size={13} className="animate-spin" /> : null}
                        <span className="ml-1.5">Save</span>
                      </Button>
                      <Button size="sm" variant="ghost" disabled={voiceBusy !== null} onClick={handleResetVoice}>
                        {voiceBusy === "reset" ? <Loader2 size={13} className="animate-spin" /> : null}
                        <span className="ml-1.5">Reset to default</span>
                      </Button>
                    </div>
                  </div>
                </section>

                {/* Hosted tools: web search + OpenAI vector store */}
                <section>
                  <SectionTitle>Hosted tools</SectionTitle>
                  <div className="mt-2 flex flex-col gap-2 rounded-lg border border-hairline bg-surface p-3">
                    <label className="flex items-start gap-2 text-[12px]">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={!!backend?.webSearch}
                        onChange={(e) => toggleWebSearch(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium">Tavily web search</div>
                        <div className="text-[11px] text-muted-foreground">
                          Adds the <code>tavily_web_search</code> tool to this agent's Responses
                          call. The agent sends the user's query verbatim to Tavily for current web
                          results.
                        </div>
                      </div>
                    </label>

                    <label className="flex items-start gap-2 border-t border-hairline pt-2 text-[12px]">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={backend?.journey?.enabled ?? true}
                        onChange={(e) => toggleJourney(e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="font-medium">Journey-voice tools</div>
                        <div className="text-[11px] text-muted-foreground">
                          Gives this agent the journey-voice tool catalog (tasks, calendar, email,
                          Slack, web search) via the <code>huddle-proxy</code>. Requires the user's
                          sign-in email to match a journey-voice account.
                        </div>
                      </div>
                    </label>

                    <div className="border-t border-hairline pt-2 flex items-start gap-2">
                      <div className="min-w-0 flex-1 text-[12px]">
                        <div className="font-medium">OpenAI vector store (file_search)</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground break-all">
                          {backend?.rag?.openaiVectorStoreId ? (
                            <>
                              ID: <code>{backend.rag.openaiVectorStoreId}</code> · file_search=
                              {String(backend.rag.fileSearch)}
                            </>
                          ) : (
                            "No vector store provisioned yet."
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={provisioning}
                        onClick={handleProvisionStore}
                      >
                        {provisioning ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <PlusCircle size={12} />
                        )}
                        <span className="ml-1.5">
                          {backend?.rag?.openaiVectorStoreId
                            ? "Reverify / recreate"
                            : "Provision store"}
                        </span>
                      </Button>
                    </div>
                  </div>
                </section>

                {/* Tools */}
                <section>
                  <SectionTitle>Snapshot tools</SectionTitle>
                  {debug.snapshotTools.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">No snapshot tools.</p>
                  ) : (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {debug.snapshotTools.map((t: string, i: number) => (
                        <li key={i} className="rounded-md bg-muted px-2 py-0.5 text-[11px]">
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
                    Scene/priorTurn block is inserted at reply time and not shown here. Roster block
                    is included.
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
                        {savingCtx ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <PlusCircle size={12} />
                        )}
                        <span className="ml-1.5">Save to memory</span>
                      </Button>
                    </div>
                  </div>

                  {/* Persistent list of saved memory items visible to this agent. */}
                  <div className="mt-3 rounded-lg border border-hairline bg-surface">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-hairline">
                      <div className="text-[11px] font-medium">
                        Saved memory for {agent.name}
                        <span className="ml-1.5 text-muted-foreground">({memoryItems.length})</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => openId && refreshMemoryList(openId)}
                        disabled={memoryLoading}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-50"
                      >
                        {memoryLoading ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <RefreshCw size={10} />
                        )}
                        Refresh
                      </button>
                    </div>
                    {memoryItems.length === 0 ? (
                      <p className="px-3 py-3 text-[11px] text-muted-foreground">
                        {memoryLoading
                          ? "Loading…"
                          : "No memory items yet. Anything saved above will appear here and persist."}
                      </p>
                    ) : (
                      <ul className="max-h-72 overflow-y-auto divide-y divide-hairline">
                        {memoryItems.map((m) => (
                          <li key={m.id} className="flex items-start gap-2 px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <span
                                  className={
                                    m.scope === "global"
                                      ? "rounded bg-primary/10 text-primary px-1.5 py-0.5"
                                      : "rounded bg-muted px-1.5 py-0.5"
                                  }
                                >
                                  {m.scope === "global" ? "shared" : "agent"}
                                </span>
                                <span>{new Date(m.createdAt).toLocaleString()}</span>
                                {m.source && <span className="truncate">· {m.source}</span>}
                              </div>
                              <p className="mt-1 text-[12px] whitespace-pre-wrap break-words">
                                {m.text}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleDeleteMemory(m.id)}
                              disabled={deletingId === m.id}
                              className="shrink-0 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                              aria-label="Delete memory item"
                            >
                              {deletingId === m.id ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Trash2 size={12} />
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
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
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono text-[11px] break-all" : "text-[12px]"}>{value}</div>
    </div>
  );
}

// Re-export type so consumers don't need to import from lib.
export type { AgentId };
