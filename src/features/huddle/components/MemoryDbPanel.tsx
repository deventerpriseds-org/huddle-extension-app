import { useState } from "react";
import { Loader2, Play, Wrench, RefreshCw, CheckCircle2, XCircle, HelpCircle, ChevronDown, Beaker } from "lucide-react";
import { Button } from "@/components/ui/button";
import { diagnoseRagStore, runRagBootstrap, verifyRagRoundTrip } from "../lib/rag.functions";
import { toast } from "sonner";

type Diagnostic = Awaited<ReturnType<typeof diagnoseRagStore>>;
type Bootstrap = Awaited<ReturnType<typeof runRagBootstrap>>;
type RoundTrip = Awaited<ReturnType<typeof verifyRagRoundTrip>>;

export function MemoryDbPanel() {
  const [diag, setDiag] = useState<Diagnostic | null>(null);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [rt, setRt] = useState<RoundTrip | null>(null);
  const [running, setRunning] = useState<"diag" | "boot" | "rt" | null>(null);
  const [expanded, setExpanded] = useState(false);

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
