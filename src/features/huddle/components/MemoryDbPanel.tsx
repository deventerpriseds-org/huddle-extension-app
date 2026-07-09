import { useState } from "react";
import { Loader2, Play, Wrench, RefreshCw, CheckCircle2, XCircle, HelpCircle, ChevronDown, Beaker, PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { diagnoseRagStore, runRagBootstrap, verifyRagRoundTrip, saveMemoryItem } from "../lib/rag.functions";
import { toast } from "sonner";

type Diagnostic = Awaited<ReturnType<typeof diagnoseRagStore>>;
type Bootstrap = Awaited<ReturnType<typeof runRagBootstrap>>;
type RoundTrip = Awaited<ReturnType<typeof verifyRagRoundTrip>>;

interface MemoryDbPanelProps {
  agentId?: string;
  agentName?: string;
}

export function MemoryDbPanel({ agentId, agentName }: MemoryDbPanelProps = {}) {
  const [diag, setDiag] = useState<Diagnostic | null>(null);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [rt, setRt] = useState<RoundTrip | null>(null);
  const [running, setRunning] = useState<"diag" | "boot" | "rt" | "save" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [ctxText, setCtxText] = useState("");
  const [ctxScope, setCtxScope] = useState<"agent" | "global">(agentId ? "agent" : "global");
  const [extractFacts, setExtractFacts] = useState(true);

  async function runDiag() {
    setRunning("diag");
    try {
      const r = await diagnoseRagStore();
      setDiag(r);
      if (!r.handshake.ok) {
        toast.error(`Memory DB unreachable: ${firstError(r)}`);
      } else {
        toast.success("Memory DB reachable");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Diagnostic failed");
    } finally {
      setRunning(null);
    }
  }

  async function runBoot() {
    setRunning("boot");
    try {
      const r = await runRagBootstrap();
      setBoot(r);
      if (r.ok) {
        toast.success("Bootstrap complete — rag_chunks + rag_triples ready");
        // Re-run diagnostic to refresh row counts.
        const d = await diagnoseRagStore();
        setDiag(d);
      } else {
        toast.error(`Bootstrap failed: ${r.error?.message ?? "unknown"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bootstrap failed");
    } finally {
      setRunning(null);
    }
  }
  async function runRt() {
    setRunning("rt");
    try {
      const r = await verifyRagRoundTrip();
      setRt(r);
      if (r.ok) toast.success(`Round-trip OK — wrote+read+deleted (marker ${r.marker.slice(-6)})`);
      else toast.error(`Round-trip failed: ${firstRtError(r)}`);
      // refresh diag afterwards for accurate row counts
      const d = await diagnoseRagStore();
      setDiag(d);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Round-trip crashed");
    } finally {
      setRunning(null);
    }
  }

  async function saveCtx() {
    const text = ctxText.trim();
    if (!text) return;
    setRunning("save");
    try {
      const r = await saveMemoryItem({
        data: {
          text,
          scope: ctxScope,
          agentId: ctxScope === "agent" ? agentId : undefined,
          source: agentName ? `settings:${agentName}` : "settings",
          extractFacts,
        },
      });
      toast.success(`Saved memory (chunk ${r.chunkId.slice(0, 8)}…, ${r.tripleCount} facts)`);
      setCtxText("");
      const d = await diagnoseRagStore();
      setDiag(d);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setRunning(null);
    }
  }


  const status = statusOf(diag);

  return (
    <div className="rounded-lg border border-hairline bg-surface">
      <div className="flex items-start gap-2 p-3">
        <StatusIcon status={status} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">
            {status === "unknown"
              ? "Memory DB status unknown — run diagnostic"
              : status === "ok"
              ? "Memory DB reachable"
              : `Memory DB unreachable — ${firstError(diag!)}`}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {diag
              ? `Last checked ${new Date(diag.timestamp).toLocaleTimeString()}`
              : "Never checked. Static config chips do not mean the DB works."}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-hairline p-2">
        <Button size="sm" variant="outline" disabled={!!running} onClick={runDiag}>
          {running === "diag" ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          <span className="ml-1.5">Run diagnostic</span>
        </Button>
        <Button size="sm" variant="outline" disabled={!!running} onClick={runBoot}>
          {running === "boot" ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
          <span className="ml-1.5">Run bootstrap (create tables)</span>
        </Button>
        <Button size="sm" variant="outline" disabled={!!running} onClick={runRt}>
          {running === "rt" ? <Loader2 size={12} className="animate-spin" /> : <Beaker size={12} />}
          <span className="ml-1.5">Verify round-trip</span>
        </Button>
        {diag && (
          <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
            <ChevronDown
              size={12}
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            />
            <span className="ml-1.5">Details</span>
          </Button>
        )}
      </div>

      {expanded && diag && (
        <div className="border-t border-hairline p-3">
          <DiagBlock diag={diag} />
        </div>
      )}
      {boot && !boot.ok && boot.error && (
        <div className="border-t border-hairline p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Bootstrap error
          </div>
          <pre className="mt-1 overflow-auto rounded bg-muted p-2 text-[10px] font-mono whitespace-pre-wrap">
            {boot.error.code ? `[${boot.error.code}] ` : ""}
            {boot.error.message}
            {boot.error.detail ? `\n\n${boot.error.detail}` : ""}
          </pre>
        </div>
      )}
      {rt && (
        <div className="border-t border-hairline p-3">
          <RoundTripBlock rt={rt} />
        </div>
      )}
    </div>
  );
}

function firstRtError(r: RoundTrip): string {
  const s = r.steps;
  if (s.bootstrap && !s.bootstrap.ok) return `bootstrap: ${s.bootstrap.error ?? "failed"}`;
  if (s.write && !s.write.ok) return `write: ${s.write.error ?? "failed"}`;
  if (s.semanticSearch && !s.semanticSearch.ok) return `search: ${s.semanticSearch.error ?? "failed"}`;
  if (s.semanticSearch && !s.semanticSearch.matched) return `search: wrote id was not the top hit`;
  if (s.directRead && !s.directRead.ok) return `direct read: ${s.directRead.error ?? "row not found"}`;
  if (s.cleanup && !s.cleanup.ok) return `cleanup: ${s.cleanup.error ?? "failed"}`;
  return "unknown";
}

function RoundTripBlock({ rt }: { rt: RoundTrip }) {
  const s = rt.steps;
  return (
    <div className="flex flex-col gap-2 text-[11px]">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Round-trip · marker {rt.marker}
      </div>
      <Row label="Bootstrap" ok={s.bootstrap?.ok} value={s.bootstrap ? (s.bootstrap.ok ? "schema ready" : s.bootstrap.error ?? "failed") : "—"} />
      <Row label="Write chunk" ok={s.write?.ok} value={s.write ? (s.write.ok ? `id=${s.write.id} (${s.write.ms}ms)` : s.write.error ?? "failed") : "—"} />
      <Row
        label="Semantic search"
        ok={s.semanticSearch?.ok && s.semanticSearch?.matched}
        value={
          s.semanticSearch
            ? s.semanticSearch.ok
              ? `hits=${s.semanticSearch.hitCount} top=${s.semanticSearch.topId ?? "none"} score=${s.semanticSearch.topScore?.toFixed(4) ?? "?"} matched=${s.semanticSearch.matched ? "yes" : "NO"} (${s.semanticSearch.ms}ms)`
              : s.semanticSearch.error ?? "failed"
            : "—"
        }
      />
      <Row label="Direct read" ok={s.directRead?.ok} value={s.directRead ? (s.directRead.ok ? `text len=${s.directRead.text?.length ?? 0} (${s.directRead.ms}ms)` : s.directRead.error ?? "row missing") : "—"} />
      <Row label="Cleanup" ok={s.cleanup?.ok} value={s.cleanup ? (s.cleanup.ok ? `deleted ${s.cleanup.deleted}` : s.cleanup.error ?? "failed") : "—"} />
    </div>
  );
}

function statusOf(d: Diagnostic | null): "unknown" | "ok" | "fail" {
  if (!d) return "unknown";
  return d.handshake.ok ? "ok" : "fail";
}

function StatusIcon({ status }: { status: "unknown" | "ok" | "fail" }) {
  if (status === "ok") return <CheckCircle2 size={16} className="mt-0.5 text-emerald-500" />;
  if (status === "fail") return <XCircle size={16} className="mt-0.5 text-red-500" />;
  return <HelpCircle size={16} className="mt-0.5 text-muted-foreground" />;
}

function firstError(d: Diagnostic): string {
  if (d.connectionString.parseError) return d.connectionString.parseError;
  if (!d.dns.ok) return `DNS: ${d.dns.error ?? "unresolvable"}`;
  if (!d.tcp.ok) return `TCP: ${d.tcp.error ?? "no route"}`;
  if (!d.handshake.ok) {
    const e = d.handshake.error;
    return e ? `Postgres: ${e.code ? `[${e.code}] ` : ""}${e.message}` : "handshake failed";
  }
  return "";
}

function DiagBlock({ diag }: { diag: Diagnostic }) {
  const cs = diag.connectionString;
  const tables = diag.server.tables;
  const rows = diag.server.rows;
  return (
    <div className="flex flex-col gap-2 text-[11px]">
      <Row
        label="Connection string"
        value={
          cs.parseError
            ? `parse error: ${cs.parseError}`
            : cs.host
            ? `${cs.user ?? "?"}@${cs.host}:${cs.port} db=${cs.database ?? "?"} sslmode=${cs.sslmode ?? "(default)"}`
            : "not configured"
        }
      />
      <Row
        label="DNS"
        ok={diag.dns.ok}
        value={
          diag.dns.ok
            ? `${diag.dns.addresses?.join(", ") ?? ""} (${diag.dns.ms}ms)`
            : diag.dns.error ?? "failed"
        }
      />
      <Row
        label="TCP :5432"
        ok={diag.tcp.ok}
        value={
          diag.tcp.ok
            ? `connected in ${diag.tcp.ms}ms`
            : `${diag.tcp.error ?? "failed"} (after ${diag.tcp.ms ?? 0}ms)`
        }
      />
      <Row
        label="Postgres handshake"
        ok={diag.handshake.ok}
        value={
          diag.handshake.ok
            ? `authenticated in ${diag.handshake.ms}ms`
            : renderPgError(diag.handshake.error)
        }
      />
      {diag.server.version && <Row label="Server" value={diag.server.version} />}
      {diag.server.extensions && (
        <Row
          label="Extensions"
          ok={diag.server.extensions.includes("vector")}
          value={diag.server.extensions.join(", ")}
        />
      )}
      {tables && (
        <Row
          label="Tables"
          ok={tables.rag_chunks && tables.rag_triples}
          value={`rag_chunks=${tables.rag_chunks ? "yes" : "MISSING"}, rag_triples=${
            tables.rag_triples ? "yes" : "MISSING"
          }`}
        />
      )}
      {rows && (
        <Row
          label="Row counts"
          value={`rag_chunks=${rows.rag_chunks}, rag_triples=${rows.rag_triples}`}
        />
      )}
      {!diag.handshake.ok && (
        <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-100">
          <div className="mb-1 font-medium">Most likely causes (ordered)</div>
          <ol className="list-decimal pl-4 space-y-0.5">
            <li>Azure Flexible Server has public access disabled (private endpoint only).</li>
            <li>Firewall doesn&apos;t allow Cloudflare Worker egress IPs — Workers use rotating IPs, so a fixed allowlist won&apos;t work.</li>
            <li>TLS / <code>sslmode</code> mismatch in the connection string.</li>
            <li>Wrong password / user (Postgres error <code>28P01</code>).</li>
          </ol>
        </div>
      )}
    </div>
  );
}

function renderPgError(e?: { message: string; code?: string; severity?: string; routine?: string; detail?: string }): string {
  if (!e) return "handshake failed";
  const parts = [e.code ? `[${e.code}]` : "", e.severity ?? "", e.message].filter(Boolean);
  const line = parts.join(" ");
  return e.detail ? `${line}\n${e.detail}` : line;
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <div className="w-32 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="flex-1 min-w-0 flex items-start gap-1.5">
        {ok === true && <CheckCircle2 size={11} className="mt-0.5 text-emerald-500 shrink-0" />}
        {ok === false && <XCircle size={11} className="mt-0.5 text-red-500 shrink-0" />}
        <div className="font-mono text-[10px] break-all whitespace-pre-wrap">{value}</div>
      </div>
    </div>
  );
}

export function MemoryDbRefreshButton({ onClick, running }: { onClick: () => void; running: boolean }) {
  return (
    <Button size="sm" variant="ghost" disabled={running} onClick={onClick}>
      <RefreshCw size={12} className={running ? "animate-spin" : ""} />
    </Button>
  );
}
