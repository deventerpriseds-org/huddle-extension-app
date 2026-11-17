// WHAT: loop-3 verifier real-PG probe (header copied from scripts/actions-view-server.test.ts lines 11-56). Synthetic data only.
import { mock } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceItem } from "../src/features/huddle/lib/correspondence/source-item";
import type { NewProposal } from "../src/features/huddle/lib/proposals/proposals";

const BIN = ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin"].find((d) => existsSync(join(d, "initdb")));
if (!BIN) {
  console.log("SKIP: no PostgreSQL binaries found");
  process.exit(0);
}
const PORT = 55000 + Math.floor(Math.random() * 900);
const dir = mkdtempSync(join(tmpdir(), "actions-"));
const asPg = process.getuid?.() === 0 ? ["runuser", "-u", "postgres", "--"] : [];
const run = (cmd: string[]) => {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr || r.stdout}`);
};
if (asPg.length) execSync(`chown postgres ${dir}`);
run([...asPg, `${BIN}/initdb`, "-D", `${dir}/data`, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
execSync(`openssl req -new -x509 -days 1 -nodes -subj /CN=localhost -keyout ${dir}/data/server.key -out ${dir}/data/server.crt 2>/dev/null`);
if (asPg.length) execSync(`chown postgres ${dir}/data/server.key ${dir}/data/server.crt && chmod 600 ${dir}/data/server.key`);
writeFileSync(`${dir}/data/postgresql.auto.conf`, `port=${PORT}\nssl=on\nunix_socket_directories='${dir}'\nlisten_addresses='127.0.0.1'\n`);
if (asPg.length) execSync(`chown postgres ${dir}/data/postgresql.auto.conf`);
run([...asPg, `${BIN}/pg_ctl`, "-D", `${dir}/data`, "-l", `${dir}/log`, "-w", "start"]);
const stop = () => spawnSync(asPg[0] ?? `${BIN}/pg_ctl`, asPg.length ? [...asPg.slice(1), `${BIN}/pg_ctl`, "-D", `${dir}/data`, "-m", "immediate", "stop"] : ["-D", `${dir}/data`, "-m", "immediate", "stop"]);

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

// Synthetic identities only (this repo is public).
const O = "owner@eds.example";
const OTHER = "someone-else@eds.example";
const LIB = join(import.meta.dir, "../src/features/huddle/lib");
// The caller resolves to O (no journey / identity service in a test).
mock.module(join(LIB, "journey/identity.ts"), () => ({ resolveTaskEmail: async (c: { entra_email?: string }) => c?.entra_email }));
mock.module(join(LIB, "identity/identity.server.ts"), () => ({ resolveScopeByEmail: async (e: string) => ({ emails: [e] }) }));
mock.module(join(LIB, "identity/scheduling-config.server.ts"), () => ({ DEFAULT_TZ: "America/New_York" }));

// ===== loop-3 verifier probe body (synthetic data only) =====
const modelAnswer: { v: unknown } = { v: null };
const calls = { n: 0 };
mock.module(join(LIB, "openai-responses.server.ts"), () => ({
  callOpenAIRouter: async () => {
    calls.n++;
    if (modelAnswer.v === null) throw new Error("429");
    return modelAnswer.v;
  },
}));
const item = (id: string): SourceItem => ({ source: "teams", sourceItemId: id, identityBasis: "provider_id", threadId: "chat-1", at: "2026-11-16T10:00:00.000Z", contentHash: "h1", drivePath: "/automation/test-log.jsonl", driveItemId: "drive-item-1", fileEtag: '"{e1},1"', internetMessageId: null });

try {
  process.env.AZURE_PG_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  const { pgLedger: L } = await import("../src/features/huddle/lib/correspondence/ledger.server");
  const { pgProposalStore: P } = await import("../src/features/huddle/lib/proposals/proposals-store.server");
  const { proposalId } = await import("../src/features/huddle/lib/proposals/proposals");
  const A = await import("../src/features/huddle/lib/actions/actions.server");
  const { correctionFor, correctionHides, resolveActionsSettings } = await import("../src/features/huddle/lib/actions/actions");
  const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
  const { teamsSourceItemId } = await import("../src/features/huddle/lib/correspondence/source-item");
  const { setActionsSettingsRaw } = await import("../src/features/huddle/lib/email/email-replies.server");
  const { setSystemTime } = await import("bun:test");
  const pool = getSharedPool();
  const hides = (stored: unknown, k: string) => correctionHides(correctionFor(stored, k), k);
  const column = async (id: string) => (await pool.query(`SELECT owner_correction c FROM chat.task_proposals WHERE id = $1`, [id])).rows[0]?.c ?? null;
  const cand = (norm: string, sid: string): NewProposal => ({ id: proposalId(O, { source: "teams", sourceItemId: sid }, norm), owner: O, title: norm, normTitle: norm, evidence: `please ${norm} soon`, assignee: null, dueText: null, dueDate: null, ref: { source: "teams", sourceItemId: sid, at: "2026-11-16T10:00:00.000Z", context: "Test-context" } });
  const verdict = (sid: string, key: string, propId: string | null) =>
    pool.query(`UPDATE chat.correspondence_ledger SET result_ids = result_ids || jsonb_build_object('action', $3::jsonb) WHERE source = $1 AND source_item_id = $2`, ["teams", sid, JSON.stringify({ v: 1, key, status: "open", proposalId: propId, at: "2026-11-09T10:00:00.000Z" })]);

  // ── V3-D4c: TRUE concurrency (Promise.all, separate pool connections), 5 rounds, two chats sharing one proposal
  let bothSurvive = 0;
  for (let r = 0; r < 5; r++) {
    const a = `cA${r}:m1`, b = `cB${r}:m1`;
    await L.observe(O, [item(a), item(b)]);
    const pa = cand(`test-shared item ${r}`, a);
    await P.upsert(pa);
    await P.upsert(cand(`test-shared item ${r}`, b));
    const KA = `teams:cA${r}|${a}`, KB = `teams:cB${r}|${b}`;
    await verdict(a, KA, pa.id);
    await verdict(b, KB, pa.id);
    const [x, y] = await Promise.all([
      A.correctItemFor([O], [O], { proposalId: pa.id, reason: "not_mine", itemKey: KA }, "2026-11-16T10:00:00.000Z"),
      A.correctItemFor([O], [O], { proposalId: pa.id, reason: "not_mine", itemKey: KB }, "2026-11-16T10:00:01.000Z"),
    ]);
    const c = await column(pa.id);
    if (x.ok && y.ok && hides(c, KA) && hides(c, KB)) bothSurvive++;
    // Undo A concurrently with a re-Wrong? on B: A shown, B still hidden.
    const [u, w] = await Promise.all([
      A.correctItemFor([O], [O], { proposalId: pa.id, itemKey: KA, undo: true }, "2026-11-16T10:01:00.000Z"),
      A.correctItemFor([O], [O], { proposalId: pa.id, reason: "already_handled", itemKey: KB }, "2026-11-16T10:01:01.000Z"),
    ]);
    const c2 = await column(pa.id);
    if (!(u.ok && w.ok && !hides(c2, KA) && hides(c2, KB))) bothSurvive -= 100;
  }
  t("V3-D4c 5 rounds of concurrent Wrong?/Wrong? then Undo/Wrong? on two chats sharing one proposal: no lost update", bothSurvive, 5);

  // ── V3-D2c: 25 CONCURRENT attempt records on the SAME ledger row -> 25 counted (atomic append)
  await L.observe(O, [item("cnt:m1")]);
  await Promise.all(Array.from({ length: 25 }, (_, i) => A.recordActionCall([O], { source: "teams", sourceItemId: "cnt:m1" }, `2026-11-20T12:00:${String(i).padStart(2, "0")}.000Z`)));
  t("V3-D2c 25 concurrent recordActionCall on one row -> 25 counted for the day", await A.actionCallsToday([O], "2026-11-20T05:00:00.000Z"), 25);

  // ── V3-O1 / V3-O2: the REAL heartbeat + the REAL page read, model mocked to ADMIT an item.
  process.env.HUDDLE_ONEDRIVE_FEEDS = JSON.stringify({ enabled: true, synthetic: true, ownerLogins: [O], driveUser: O, mailbox: "owner@work.example", sourceLogin: "login@work.example", subjectPrefix: "HUDDLE-PA-SBX-", teams: { ownerSenderIds: ["owner-guid-0001"] }, correspondence: { ingest: true, ownerNames: ["Owen Example"] } });
  await setActionsSettingsRaw(O, resolveActionsSettings({ dailyCap: 100 }));
  const msgRow = (chat: string, mid: string, at: string, text: string, hash: string) => ({
    ...item(teamsSourceItemId(chat, mid)), threadId: chat, at, contentHash: hash,
    content: { kind: "teams", chatId: chat, chatName: null, messageId: mid, at, sender: { id: "other-guid", name: "Pat Example", isApp: false }, fromOwner: false, text, webUrl: null, mentionedUserIds: [], ownerUserId: "owner-guid-0001" },
  });
  const ask = (quote: string) => ({ open_item: true, kind: "action", category: "person_request", confidence: "high", todo: "Send the synthetic budget sheet", due: "Friday", quote, reason: "Pat asked for it" });
  const caller = { entra_email: O };
  const page = async () => {
    const p = (await A.getActionsPage(caller)) as Record<string, unknown>;
    return p;
  };
  const brief = (p: Record<string, unknown>) => {
    const items = (p.items as { itemKey: string; display: { quote: string | null } }[] | undefined) ?? (p.sections as unknown) ?? null;
    return { status: p.status, keys: Object.keys(p), items: JSON.stringify(items).slice(0, 600), hidden: p.hidden, notChecked: p.notChecked, counts: p.counts };
  };
  const runPass = async (iso: string) => {
    setSystemTime(new Date(iso));
    const r = await A.runActionsClassify();
    setSystemTime();
    return r;
  };
  const F = `19:v3f_x${"@"}unq.gbl.spaces`;
  const G = `19:v3g_x${"@"}unq.gbl.spaces`;
  // Chat F (Dismiss path) and chat G (Done path): same ask, message 1.
  await L.storeContent(O, [msgRow(F, "1", "2026-11-16T14:00:00.000Z", "Could you please send the synthetic budget sheet by Friday?", "f1"), msgRow(G, "1", "2026-11-16T14:00:00.000Z", "Could you please send the synthetic forecast deck by Friday?", "g1")] as never);
  modelAnswer.v = ask("send the synthetic budget sheet by Friday");
  // First pass judges F only if the model answer fits F; give G its own answer on a second pass by key order -> simpler: one pass per chat answer.
  const r1 = await runPass("2026-11-16T15:00:01.000Z");
  console.log("O1 pass1", JSON.stringify(r1));
  const pageA = await page();
  console.log("O1 page after pass1", JSON.stringify(brief(pageA)));
  // Find the backing proposals.
  const props = (await pool.query(`SELECT id, state, title, norm_title, sources FROM chat.task_proposals WHERE owner_email = $1 AND norm_title ILIKE '%budget%' ORDER BY created_at`, [O])).rows;
  console.log("O1 proposals after pass1", JSON.stringify(props.map((x) => ({ id: x.id.slice(0, 12), state: x.state, norm: x.norm_title }))));
  // Dismiss F's proposal.
  for (const x of props) await pool.query(`UPDATE chat.task_proposals SET state='dismissed', decided_at=now() WHERE id=$1`, [x.id]);
  const pageB = await page();
  console.log("O1 page after Dismiss", JSON.stringify(brief(pageB)));
  // A follow-up in chat F with the SAME ask.
  await L.storeContent(O, [msgRow(F, "2", "2026-11-16T16:00:00.000Z", "Following up: could you please send the synthetic budget sheet by Friday?", "f2")] as never);
  const before = calls.n;
  const r2 = await runPass("2026-11-16T16:10:01.000Z");
  console.log("O1 pass2", JSON.stringify(r2), "model calls this pass", calls.n - before);
  const v2 = (await pool.query(`SELECT result_ids->'action' a FROM chat.correspondence_ledger WHERE source='teams' AND source_item_id=$1`, [teamsSourceItemId(F, "2")])).rows[0]?.a;
  console.log("O1 stored verdict for the follow-up", JSON.stringify(v2));
  const pageC = await page();
  console.log("O1 page after follow-up", JSON.stringify(brief(pageC)));
  const pc = pageC as { hidden?: Record<string, number>; notChecked?: unknown };
  t("V3-O1 follow-up after Dismiss: verdict open, onBoard true, no proposal (suppressed)", [v2?.status, v2?.onBoard === true, v2?.proposalId ?? null], ["open", true, null]);

  // ── V3-O2: EDIT the latest message (same message id, new content hash, the quote no longer in the text)
  await L.observe(O, [{ ...item(teamsSourceItemId(F, "2")), threadId: F, at: "2026-11-16T16:00:00.000Z", contentHash: "f2-edited" }]);
  await L.storeContent(O, [msgRow(F, "2", "2026-11-16T16:00:00.000Z", "Never mind, all sorted now, thanks.", "f2-edited")] as never);
  const cnt = (await pool.query(`SELECT content_hash, content->>'text' t, result_ids->'action'->>'quote' q, result_ids->'action'->>'key' k FROM chat.correspondence_ledger WHERE source='teams' AND source_item_id=$1`, [teamsSourceItemId(F, "2")])).rows[0];
  const before2 = calls.n;
  const r3 = await runPass("2026-11-16T16:30:01.000Z");
  console.log("O2 after edit", JSON.stringify(cnt), "pass", JSON.stringify(r3), "model calls", calls.n - before2);
  t("V3-O2 edited latest message: row shows new text + new hash, old verdict (old quote) kept, NOT re-judged", [cnt?.content_hash, cnt?.t, cnt?.q, calls.n - before2], ["f2-edited", "Never mind, all sorted now, thanks.", "send the synthetic budget sheet by Friday", 0]);
  console.log("O2 page", JSON.stringify(brief(await page())));
} catch (e) {
  fail++;
  console.log(`FAIL harness: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : "error"}`);
} finally {
  try {
    const { getSharedPool } = await import("../src/features/huddle/lib/db/shared-pool.server");
    await getSharedPool().end();
  } catch {
    /* closed */
  }
  stop();
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
