// WHAT:       Offline checks for the OneDrive feed file-staleness alert: the pure working-hours decision
//             (lib/correspondence/feed-staleness.ts), the bell text, one-row-per-file idempotency and
//             auto-clear (through an in-memory twin of the bell store), the bell display of the `feed` system
//             kind, the config keys, and the OFF gate (zero calls, zero writes).
// WHY:        Owner decision 2026-11-13: emails.json stopped updating 2026-11-11 14:02 UTC and nobody noticed for
//             two days. The real bell SQL is exercised separately in scripts/feed-staleness-sql.test.ts.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/IMPL-feed-staleness.md.
//
// Run: bun scripts/feed-staleness.test.ts      All data synthetic (.example).
import {
  applyFeedStaleness,
  decideFeedStaleness,
  feedAlertText,
  feedAttentionId,
  feedEpisode,
  sinceLabel,
  stalenessLogLine,
  teamsDueInstant,
  workingMsBetween,
  workingSpanLabel,
  type FeedAlertStore,
  type FeedMeta,
  type FeedReadStatus,
  type FeedUrgentNotifier,
  INCOMPLETE_STATUS,
} from "../src/features/huddle/lib/correspondence/feed-staleness";
import { feedFilesToCheck, runFeedStalenessCheck, urgentFeedDirective, urgentFeedEmailBody } from "../src/features/huddle/lib/correspondence/feed-staleness.server";
import { parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import {
  ATTENTION_KINDS,
  DEFAULT_URGENT_KINDS,
  badgeCount,
  bellItems,
  toAttentionItem,
} from "../src/features/huddle/lib/attention/attention";

let fail = 0;
let pass = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

// Fixed instants, written in UTC. November 2026 is EST (UTC-5): Mon 9, Tue 10, Wed 11, Thu 12, Fri 13, Sat 14.
const U = (iso: string) => Date.parse(iso);
const H = 3_600_000;
const ok = (iso: string): FeedMeta => ({ kind: "ok", lastModifiedMs: U(iso) });

// ---------------------------------------------------------------------------------------------
// A: working hours (Mon-Fri 08:00-18:00 America/New_York)
// ---------------------------------------------------------------------------------------------
t("A1 Fri 18:00 -> Mon 09:00 counts 1 working hour (weekend + nights not counted)",
  workingMsBetween(U("2026-11-06T23:00:00Z"), U("2026-11-09T14:00:00Z")) / H, 1);
t("A2 weekend gap: Fri 17:00 -> Mon 10:00 = 3 working hours",
  workingMsBetween(U("2026-11-06T22:00:00Z"), U("2026-11-09T15:00:00Z")) / H, 3);
t("A3 overnight: Tue 17:00 -> Wed 09:00 = 2 working hours",
  workingMsBetween(U("2026-11-10T22:00:00Z"), U("2026-11-11T14:00:00Z")) / H, 2);
t("A4 inside one working day: Wed 09:00 -> 12:30 = 3.5 h",
  workingMsBetween(U("2026-11-11T14:00:00Z"), U("2026-11-11T17:30:00Z")) / H, 3.5);
t("A5 entirely at night / weekend counts nothing (Sat 10:00 -> Sun 20:00)",
  workingMsBetween(U("2026-11-14T15:00:00Z"), U("2026-11-16T01:00:00Z")), 0);
t("A6 reversed range counts nothing", workingMsBetween(U("2026-11-12T15:00:00Z"), U("2026-11-11T15:00:00Z")), 0);
t("A7 DST boundary: Fri Oct 30 17:00 EDT -> Mon Nov 2 09:00 EST = 2 working hours",
  workingMsBetween(U("2026-10-30T21:00:00Z"), U("2026-11-02T14:00:00Z")) / H, 2);

// ---------------------------------------------------------------------------------------------
// B: email / sent decision
// ---------------------------------------------------------------------------------------------
t("B1 Friday 18:00 -> Monday 09:00 is NOT stale (default 6 h)",
  decideFeedStaleness("email", ok("2026-11-06T23:00:00Z"), U("2026-11-09T14:00:00Z"), 6).state, "fresh");
t("B2 overnight is NOT stale: Tue 17:00 -> Wed 10:00 (3 h)",
  decideFeedStaleness("email", ok("2026-11-10T22:00:00Z"), U("2026-11-11T15:00:00Z"), 6).state, "fresh");
t("B3 exactly 6 working hours is NOT stale (MORE than N)",
  decideFeedStaleness("email", ok("2026-11-11T14:00:00Z"), U("2026-11-11T20:00:00Z"), 6).state, "fresh");
t("B4 6 h + 1 min IS stale",
  decideFeedStaleness("email", ok("2026-11-11T14:00:00Z"), U("2026-11-11T20:01:00Z"), 6),
  { state: "stale", sinceMs: U("2026-11-11T14:00:00Z"), workingHours: 6 });
t("B5 staleHours is honoured (2 h)",
  decideFeedStaleness("sent", ok("2026-11-11T14:00:00Z"), U("2026-11-11T16:30:00Z"), 2).state, "stale");
const trigger = decideFeedStaleness("email", ok("2026-11-11T14:02:00Z"), U("2026-11-13T15:00:00Z"), 6);
t("B6 the trigger case: emails.json last changed Wed 14:02 UTC, checked Fri 10:00 ET -> stale, 20 working hours",
  trigger, { state: "stale", sinceMs: U("2026-11-11T14:02:00Z"), workingHours: 20 });
t("B7 trigger case text names the file, the time and the span; no content",
  trigger.state === "stale" ? feedAlertText("email", trigger, U("2026-11-13T15:00:00Z")) : null,
  { title: "Work email file hasn't updated since Wed 9:02 AM (2 working days)", detail: "Check the Power Automate email flow." });
t("B8 a weekend-long quiet sent.json (Fri 17:30 -> Mon 11:00) is NOT stale (3.5 h)",
  decideFeedStaleness("sent", ok("2026-11-06T22:30:00Z"), U("2026-11-09T16:00:00Z"), 6).state, "fresh");
t("B9 a modification time in the future (clock skew) is fresh",
  decideFeedStaleness("email", ok("2026-11-13T16:00:00Z"), U("2026-11-13T15:00:00Z"), 6).state, "fresh");

// ---------------------------------------------------------------------------------------------
// C: Teams 6pm rule (no change since the most recent weekday 18:00, after a 60-minute grace)
// ---------------------------------------------------------------------------------------------
t("C1 due instant on Fri 10:00 ET is Thu 18:00 ET", new Date(teamsDueInstant(U("2026-11-13T15:00:00Z"))).toISOString(), "2026-11-12T23:00:00.000Z");
t("C2 due instant on Mon 10:00 ET is the previous Friday 18:00 ET", new Date(teamsDueInstant(U("2026-11-09T15:00:00Z"))).toISOString(), "2026-11-06T23:00:00.000Z");
t("C3 due instant on Thu 18:59 ET (grace not over) is still Wed 18:00", new Date(teamsDueInstant(U("2026-11-12T23:59:00Z"))).toISOString(), "2026-11-11T23:00:00.000Z");
t("C4 updated Thu 18:30, checked Fri 10:00 -> fresh",
  decideFeedStaleness("teams", ok("2026-11-12T23:30:00Z"), U("2026-11-13T15:00:00Z"), 6).state, "fresh");
t("C5 last updated Thu 17:55, checked Thu 19:01 -> stale (nothing after 6pm)",
  decideFeedStaleness("teams", ok("2026-11-12T22:55:00Z"), U("2026-11-13T00:01:00Z"), 6).state, "stale");
t("C6 last updated Thu 17:55, checked Thu 18:59 -> fresh (grace)",
  decideFeedStaleness("teams", ok("2026-11-12T22:55:00Z"), U("2026-11-12T23:59:00Z"), 6).state, "fresh");
t("C7 updated Fri 18:20, checked Mon 10:00 -> fresh (no weekend expectation)",
  decideFeedStaleness("teams", ok("2026-11-06T23:20:00Z"), U("2026-11-09T15:00:00Z"), 6).state, "fresh");
t("C8 last updated Fri 17:00, checked Sat 12:00 -> stale (Friday evening missed)",
  decideFeedStaleness("teams", ok("2026-11-06T22:00:00Z"), U("2026-11-07T17:00:00Z"), 6).state, "stale");
const teamsStale = decideFeedStaleness("teams", ok("2026-11-11T23:12:00Z"), U("2026-11-13T15:00:00Z"), 6);
t("C9 Teams stale text",
  teamsStale.state === "stale" ? feedAlertText("teams", teamsStale, U("2026-11-13T15:00:00Z")).title : null,
  "Teams chat file hasn't updated since Wed 6:12 PM (expected after 6 PM each weekday)");

// ---------------------------------------------------------------------------------------------
// D: missing / unreadable are their own reasons
// ---------------------------------------------------------------------------------------------
const now = U("2026-11-13T15:00:00Z");
t("D1 missing file -> missing (every file kind)", ["email", "sent", "teams"].map((f) => decideFeedStaleness(f as "email", { kind: "missing" }, now, 6).state), ["missing", "missing", "missing"]);
t("D2 unreadable file -> unreadable", decideFeedStaleness("sent", { kind: "unreadable" }, now, 6).state, "unreadable");
t("D3 a lastModified that is not a number -> transient (no information this check)", decideFeedStaleness("email", { kind: "ok", lastModifiedMs: NaN }, now, 6).state, "transient");
t("D3b a transient read -> transient", decideFeedStaleness("teams", { kind: "transient" }, now, 6).state, "transient");
t("D4 missing text", feedAlertText("sent", { state: "missing" }, now), { title: "Work sent-mail file is missing from OneDrive", detail: "Check the Power Automate sent-mail flow." });
t("D5 unreadable text", feedAlertText("teams", { state: "unreadable" }, now).title, "Teams chat file can't be read from OneDrive");
t("D6 episodes", [feedEpisode({ state: "missing" }), feedEpisode({ state: "unreadable" }), feedEpisode({ state: "stale", sinceMs: U("2026-11-11T14:02:00Z"), workingHours: 20 })], ["missing", "unreadable", "stale:2026-11-11T14:02:00.000Z"]);
t("D8 since label: weekday within 6 days, month+day beyond", [sinceLabel(U("2026-11-11T14:02:00Z"), now), sinceLabel(U("2026-11-03T14:02:00Z"), now)], ["Wed 9:02 AM", "Nov 3, 9:02 AM"]);
t("D7 span labels", [workingSpanLabel(1), workingSpanLabel(9), workingSpanLabel(10), workingSpanLabel(25)], ["1 working hour", "9 working hours", "1 working day", "2 working days"]);

// ---------------------------------------------------------------------------------------------
// E: bell -- ONE row per file, idempotent across heartbeats, auto-clear, dismiss holds per episode.
// In-memory twin of raiseFeedAttention / clearFeedAttention / notePendingFeedAttention (the SQL itself:
// feed-staleness-sql.test.ts).
// ---------------------------------------------------------------------------------------------
type Row = { id: string; owner: string; episode: string; title: string; detail: string; since: string | null; status: string; pending: string | null };
function twin() {
  const rows = new Map<string, Row>();
  let writes = 0;
  const store: FeedAlertStore = {
    async raise(r) {
      const e = rows.get(r.id);
      if (e) e.pending = null;
      const open = e && (e.status === "owed" || e.status === "drafted");
      const later = !e || r.sinceIso === null || e.since === null || r.sinceIso > e.since;
      const write =
        !e ||
        (open && (e.episode !== r.episode || e.title !== r.title || e.detail !== r.detail)) ||
        e.status === "replied" ||
        (e.status === "dismissed" && e.episode !== r.episode && later);
      if (!write) return false;
      rows.set(r.id, { id: r.id, owner: r.ownerEmail, episode: r.episode, title: r.title, detail: r.detail, since: r.sinceIso ?? e?.since ?? null, status: open ? e!.status : "owed", pending: null });
      writes++;
      return true;
    },
    async clear(id) {
      const e = rows.get(id);
      if (e) e.pending = null;
      if (!e || !["owed", "drafted", "dismissed"].includes(e.status)) return false;
      e.status = "replied";
      writes++;
      return true;
    },
    async notePending(r) {
      const e = rows.get(r.id);
      const before = e?.pending ?? null;
      if (e) e.pending = r.reason;
      else rows.set(r.id, { id: r.id, owner: r.ownerEmail, episode: "", title: "", detail: "", since: null, status: "replied", pending: r.reason });
      return before === r.reason;
    },
  };
  return { rows, store, writes: () => writes };
}
const O = "owner@eds.example";
const open = (rows: Map<string, Row>) => [...rows.values()].filter((r) => r.status === "owed").length;
{
  const tw = twin();
  const stale = [{ file: "email" as const, meta: ok("2026-11-11T14:02:00Z") }];
  const r1 = await applyFeedStaleness(O, stale, now, 6, tw.store);
  const r2 = await applyFeedStaleness(O, stale, now + 60_000, 6, tw.store);
  const r3 = await applyFeedStaleness(O, stale, now + 120_000, 6, tw.store);
  t("E1 stale file raises ONE row on the first heartbeat", [r1.raised, open(tw.rows)], [1, 1]);
  t("E2 next heartbeats with the same episode and text write nothing (no duplicate)", [r2.raised, r3.raised, tw.writes(), tw.rows.size], [0, 0, 1, 1]);
  const r4a = await applyFeedStaleness(O, stale, now + 2 * H, 6, tw.store);
  t("E3a two more hours, same '2 working days' text -> no write", [r4a.raised, tw.writes()], [0, 1]);
  const r4 = await applyFeedStaleness(O, stale, U("2026-11-16T15:00:00Z"), 6, tw.store);
  t("E3b Monday: text becomes '3 working days' -> the SAME row refreshed in place (still one row)",
    [r4.raised, tw.rows.size, open(tw.rows), tw.rows.get(feedAttentionId(O, "email"))?.title],
    [1, 1, 1, "Work email file hasn't updated since Wed 9:02 AM (3 working days)"]);
  const fresh = [{ file: "email" as const, meta: ok("2026-11-13T16:30:00Z") }];
  const r5 = await applyFeedStaleness(O, fresh, now + 2 * H, 6, tw.store);
  const r6 = await applyFeedStaleness(O, fresh, now + 2 * H + 60_000, 6, tw.store);
  t("E4 file updates -> the row clears itself; clearing again writes nothing", [r5.cleared, r6.cleared, open(tw.rows), tw.rows.get(feedAttentionId(O, "email"))?.status], [1, 0, 0, "replied"]);
}
{
  const tw = twin();
  const stale = [{ file: "sent" as const, meta: ok("2026-11-11T14:02:00Z") }];
  await applyFeedStaleness(O, stale, now, 6, tw.store);
  tw.rows.get(feedAttentionId(O, "sent"))!.status = "dismissed"; // owner taps Dismiss
  const r1 = await applyFeedStaleness(O, stale, now + 3 * H, 6, tw.store);
  t("E5 dismissed: the same stale episode never reopens it", [r1.raised, open(tw.rows)], [0, 0]);
  const m = [{ file: "sent" as const, meta: { kind: "missing" } as FeedMeta }];
  const r2a = await applyFeedStaleness(O, m, now + 4 * H, 6, tw.store);
  const r2 = await applyFeedStaleness(O, m, now + 4 * H + 600_000, 6, tw.store);
  t("E6 dismissed: a NEW hard reason (missing on 2 consecutive checks) reopens the same row; the first sighting does not",
    [r2a.raised, r2a.pending, r2.raised, open(tw.rows), tw.rows.size], [0, 1, 1, 1, 1]);
}
{
  const tw = twin();
  const missing = [{ file: "teams" as const, meta: { kind: "missing" } as FeedMeta }];
  await applyFeedStaleness(O, missing, now, 6, tw.store);
  await applyFeedStaleness(O, missing, now + 600_000, 6, tw.store);
  await applyFeedStaleness(O, [{ file: "teams", meta: ok("2026-11-12T23:30:00Z") }], now + H, 6, tw.store);
  const r1 = await applyFeedStaleness(O, missing, now + 2 * H, 6, tw.store);
  const r = await applyFeedStaleness(O, missing, now + 2 * H + 600_000, 6, tw.store);
  t("E7 missing -> restored (auto-clear) -> missing again (2 checks) raises again (same reason, new problem)", [r1.raised, r.raised, open(tw.rows)], [0, 1, 1]);
}
{
  const tw = twin();
  tw.store.raise = async () => {
    throw new Error("db down");
  };
  const r = await applyFeedStaleness(O, [{ file: "email", meta: ok("2026-11-11T14:02:00Z") }, { file: "teams", meta: ok("2026-11-12T23:30:00Z") }], now, 6, tw.store);
  t("E8 one file's store failure does not stop the others", [r.failed, r.states], [1, { email: "stale", teams: "fresh" }]);
}
// Verifier loop 4, 4c: a transient read failure changes NOTHING; a hard reason needs 2 consecutive checks.
const tr = (file: "email" | "sent" | "teams") => [{ file, meta: { kind: "transient" } as FeedMeta }];
{
  const tw = twin();
  const stale = [{ file: "email" as const, meta: ok("2026-11-11T14:02:00Z") }];
  await applyFeedStaleness(O, stale, now, 6, tw.store);
  tw.rows.get(feedAttentionId(O, "email"))!.status = "dismissed";
  const w0 = tw.writes();
  const a = await applyFeedStaleness(O, tr("email"), now + 600_000, 6, tw.store);
  const b = await applyFeedStaleness(O, stale, now + 1_200_000, 6, tw.store);
  const row = tw.rows.get(feedAttentionId(O, "email"))!;
  t("T1 dismissed stale alert + ONE transient failure + same stale file: stays dismissed, same episode, zero writes",
    [a.raised, a.states.email, b.raised, row.status, row.episode, tw.writes() - w0], [0, "transient", 0, "dismissed", "stale:2026-11-11T14:02:00.000Z", 0]);
  const c1 = await applyFeedStaleness(O, tr("email"), now + 1_800_000, 6, tw.store);
  const c2 = await applyFeedStaleness(O, tr("email"), now + 2_400_000, 6, tw.store);
  const c3 = await applyFeedStaleness(O, tr("email"), now + 3_000_000, 6, tw.store);
  t("T6 a run of transient failures (a 30-minute Graph outage) still changes nothing: no raise, no pending, still dismissed",
    [c1.raised + c2.raised + c3.raised, (c1.pending ?? 0) + (c2.pending ?? 0) + (c3.pending ?? 0), row.status, row.pending], [0, 0, "dismissed", null]);
}
{
  const tw = twin();
  const fresh = [{ file: "email" as const, meta: ok("2026-11-13T14:30:00Z") }];
  await applyFeedStaleness(O, fresh, now, 6, tw.store);
  const a = await applyFeedStaleness(O, tr("email"), now + 600_000, 6, tw.store);
  const b = await applyFeedStaleness(O, fresh, now + 1_200_000, 6, tw.store);
  t("T2 fresh file + one transient failure: no 'can't be read' item, nothing written", [a.raised, b.raised, open(tw.rows), tw.writes()], [0, 0, 0, 0]);
}
{
  const tw = twin();
  const u = [{ file: "sent" as const, meta: { kind: "unreadable" } as FeedMeta }];
  const fresh = [{ file: "sent" as const, meta: ok("2026-11-13T14:30:00Z") }];
  const a = await applyFeedStaleness(O, u, now, 6, tw.store);
  const openAfterFirst = open(tw.rows);
  const b = await applyFeedStaleness(O, u, now + 600_000, 6, tw.store);
  t("T3 a 403 raises 'can't be read' only on the 2nd consecutive check", [a.raised, a.pending, openAfterFirst, b.raised, open(tw.rows)], [0, 1, 0, 1, 1]);
  const tw2 = twin();
  await applyFeedStaleness(O, u, now, 6, tw2.store);
  await applyFeedStaleness(O, tr("sent"), now + 600_000, 6, tw2.store);
  const c = await applyFeedStaleness(O, u, now + 1_200_000, 6, tw2.store);
  const tw3 = twin();
  await applyFeedStaleness(O, u, now, 6, tw3.store);
  await applyFeedStaleness(O, fresh, now + 600_000, 6, tw3.store);
  const d = await applyFeedStaleness(O, u, now + 1_200_000, 6, tw3.store);
  const tw4 = twin();
  await applyFeedStaleness(O, u, now, 6, tw4.store);
  const e = await applyFeedStaleness(O, [{ file: "sent", meta: { kind: "missing" } }], now + 600_000, 6, tw4.store);
  t("T4 403/transient/403 raises (transient neither confirms nor resets); 403/fresh/403 and 403/404 do not",
    [c.raised, d.raised, e.raised], [1, 0, 0]);
}
{
  const tw = twin();
  const staleA = [{ file: "email" as const, meta: ok("2026-11-11T14:02:00Z") }];
  const m = [{ file: "email" as const, meta: { kind: "missing" } as FeedMeta }];
  const id = feedAttentionId(O, "email");
  await applyFeedStaleness(O, staleA, now, 6, tw.store);
  tw.rows.get(id)!.status = "dismissed";
  await applyFeedStaleness(O, m, now + 600_000, 6, tw.store);
  await applyFeedStaleness(O, m, now + 1_200_000, 6, tw.store);
  const reopenedMissing = tw.rows.get(id)!.status;
  tw.rows.get(id)!.status = "dismissed";
  const back = await applyFeedStaleness(O, staleA, now + 1_800_000, 6, tw.store);
  const backStatus = tw.rows.get(id)!.status;
  const later = await applyFeedStaleness(O, [{ file: "email", meta: ok("2026-11-12T14:02:00Z") }], U("2026-11-16T15:00:00Z"), 6, tw.store);
  t("T5 dismissed reopens only on NEW: missing x2 reopens; back to the SAME old last-modified stays dismissed; a LATER last-modified reopens",
    [reopenedMissing, back.raised, backStatus, later.raised, tw.rows.get(id)!.status], ["owed", 0, "dismissed", 1, "owed"]);
}
t("E9 ids: one per file, attn-feed- prefix, owner case-insensitive", [
  feedAttentionId(O, "email").startsWith("attn-feed-email-"),
  feedAttentionId(O, "email") === feedAttentionId("OWNER@eds.example", "email"),
  new Set(["email", "sent", "teams"].map((f) => feedAttentionId(O, f as "email"))).size,
], [true, true, 3]);
t("E10 log line carries file names, states and counts only",
  stalenessLogLine({ states: { email: "stale", teams: "missing" }, raised: 2, cleared: 0, failed: 0 }),
  "[feed-staleness] email=stale teams=missing raised=2 cleared=0");

// ---------------------------------------------------------------------------------------------
// F: bell display -- `feed` is a system kind: shown and counted outside the owner's "What counts" list,
// and the list itself is unchanged.
// ---------------------------------------------------------------------------------------------
const row = (o: Record<string, unknown>) => ({ id: "x", kind: null, huddle_id: null, subject: null, from_name: null, from_address: null, received_at: null, created_at: null, ...o });
const feedRow = row({ id: feedAttentionId(O, "email"), kind: "feed", subject: "Work email file hasn't updated since Wed 9:02 AM (2 working days)", from_name: "Check the Power Automate email flow.", huddle_id: "dm-iris-chase", received_at: "2026-11-11T14:02:00.000Z" });
t("F1 the owner's kind list is unchanged (no new 'What counts' checkbox)", ATTENTION_KINDS, ["email", "meeting", "appointment", "chat"]);
t("F2 default urgent kinds unchanged", DEFAULT_URGENT_KINDS, ["email", "meeting", "appointment", "chat"]);
t("F3 a feed row becomes a bell item with its title, detail and stale-since time", toAttentionItem(feedRow), {
  id: feedAttentionId(O, "email"), kind: "feed", title: "Work email file hasn't updated since Wed 9:02 AM (2 working days)",
  detail: "Check the Power Automate email flow.", huddleId: "dm-iris-chase", at: "2026-11-11T14:02:00.000Z",
});
t("F4 a feed row is listed and counted even when the owner counts NO kinds", [bellItems([feedRow], []).length, badgeCount(bellItems([feedRow], []))], [1, 1]);
const legacy = [row({ id: "e1", kind: "email", subject: "Hi", received_at: "2026-11-12T10:00:00Z" }), row({ id: "m1", kind: "meeting", subject: "Standup", received_at: "2026-11-12T11:00:00Z" }), row({ id: "z1", kind: "mystery" })];
t("F5 flag OFF => no feed rows => bell output for existing rows is exactly as before", bellItems(legacy, ["email"]).map((i) => i.id), ["e1"]);
t("F6 an unknown kind is still dropped", toAttentionItem(row({ kind: "mystery" })), null);

// ---------------------------------------------------------------------------------------------
// G: config keys + the OFF gate (zero calls, zero writes)
// ---------------------------------------------------------------------------------------------
const base = { enabled: true, ownerLogins: [O], driveUser: "drive@eds.example", mailbox: "work@corp.example", synthetic: true, subjectPrefix: "[TEST]" };
const cfgWith = (correspondence: unknown, extra: Record<string, unknown> = {}) => parseFeedsConfig(JSON.stringify({ ...base, ...extra, correspondence }))!;
t("G1 staleAlerts defaults OFF; staleHours defaults 6", [cfgWith(undefined).correspondence.staleAlerts, cfgWith(undefined).correspondence.staleHours], [false, 6]);
t("G2 only a literal true switches staleAlerts on", ["true", 1, "yes", null, false, {}, true].map((v) => cfgWith({ staleAlerts: v }).correspondence.staleAlerts), [false, false, false, false, false, false, true]);
t("G3 staleHours: integer >= 1, capped 200; junk -> 6", [3, "4", 0, -2, "abc", 2.9, 999].map((v) => cfgWith({ staleHours: v }).correspondence.staleHours), [3, 4, 6, 6, 6, 2, 200]);
t("G4 staleAlerts does not switch ingest on", cfgWith({ staleAlerts: true }).correspondence.ingest, false);
t("G5 files checked = the enabled ones only (email default on; sent/teams opt-in)", [
  feedFilesToCheck(cfgWith({ staleAlerts: true })).map((f) => f.file),
  feedFilesToCheck(cfgWith({ staleAlerts: true }, { sent: true, teams: true })).map((f) => f.file),
  feedFilesToCheck(cfgWith({ staleAlerts: true }, { email: { enabled: false }, teams: true })).map((f) => f.file),
], [["email"], ["email", "sent", "teams"], ["teams"]]);

function countingDeps(meta: FeedMeta) {
  const n = { reads: 0, raises: 0, clears: 0, logs: 0 };
  return {
    n,
    deps: {
      readMeta: async () => (n.reads++, meta),
      store: { raise: async () => (n.raises++, true), clear: async () => (n.clears++, false), notePending: async () => (n.raises++, false) },
      now: () => now,
      log: () => void n.logs++,
    },
  };
}
{
  const off = countingDeps({ kind: "missing" });
  const a = await runFeedStalenessCheck(null, off.deps);
  const b = await runFeedStalenessCheck(cfgWith({ ingest: true, bell: true, proposals: true }, { sent: true, teams: true }), off.deps);
  const c = await runFeedStalenessCheck(cfgWith({ staleAlerts: "true" }, { sent: true, teams: true }), off.deps);
  t("G6 flag OFF (absent config / everything else on / non-literal true): no result, ZERO reads, ZERO writes, ZERO logs", [a, b, c, off.n], [null, null, null, { reads: 0, raises: 0, clears: 0, logs: 0 }]);
  const on = countingDeps(ok("2026-11-11T14:02:00Z"));
  const r = await runFeedStalenessCheck(cfgWith({ staleAlerts: true }, { sent: true, teams: true }), on.deps);
  t("G7 flag ON: one metadata read per configured file, and the bell is written", [on.n.reads, on.n.raises, r?.raised], [3, 3, 3]);
}

// The heartbeat entry with the flag OFF: no Graph call, nothing awaited beyond the old path.
{
  let fetches = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("no network in tests");
  }) as typeof fetch;
  const saved = process.env.HUDDLE_ONEDRIVE_FEEDS;
  try {
    const { runCorrespondenceIngest } = await import("../src/features/huddle/lib/correspondence/ingest.server");
    process.env.HUDDLE_ONEDRIVE_FEEDS = JSON.stringify({ ...base, sent: true, teams: true, correspondence: { staleAlerts: false } });
    const r1 = await runCorrespondenceIngest();
    delete process.env.HUDDLE_ONEDRIVE_FEEDS;
    const r2 = await runCorrespondenceIngest();
    t("G8 runCorrespondenceIngest with staleAlerts OFF / no config: null and ZERO fetches", [r1, r2, fetches], [null, null, 0]);
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.HUDDLE_ONEDRIVE_FEEDS;
    else process.env.HUDDLE_ONEDRIVE_FEEDS = saved;
  }
}

// ---------------------------------------------------------------------------------------------
// H: the metadata read (readFeedFileMeta) and the UNCHANGED existing read request, against a stubbed fetch.
// Dummy credentials (.example); no network.
// ---------------------------------------------------------------------------------------------
{
  const envKeys = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"] as const;
  const savedEnv = envKeys.map((k) => process.env[k]);
  process.env.AZURE_TENANT_ID = "tenant.example";
  process.env.AZURE_CLIENT_ID = "client.example";
  process.env.AZURE_CLIENT_SECRET = "secret.example";
  const realFetch = globalThis.fetch;
  const seen: { url: string; method: string }[] = [];
  let drive: () => Response = () => new Response("{}", { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth2/")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    seen.push({ url, method: String(init?.method ?? "GET") });
    return drive();
  }) as typeof fetch;
  try {
    const srv = await import("../src/features/huddle/lib/external-feeds/onedrive-feed.server");
    const cfg = cfgWith({ staleAlerts: true }, { teams: true });
    const meta = async (resp: () => Response) => {
      drive = resp;
      return srv.readFeedFileMeta(cfg, cfg.email.path);
    };
    t("H1 200 with lastModifiedDateTime -> ok with that instant",
      await meta(() => new Response(JSON.stringify({ lastModifiedDateTime: "2026-11-11T14:02:00Z" }), { status: 200 })),
      { kind: "ok", lastModifiedMs: U("2026-11-11T14:02:00Z") });
    t("H2 the metadata read is a GET of $select=lastModifiedDateTime only (no download)",
      [seen.at(-1)?.method, seen.at(-1)?.url.endsWith("?$select=lastModifiedDateTime"), seen.some((s) => s.url.includes(":/content"))], ["GET", true, false]);
    t("H3 404 -> missing", await meta(() => new Response("", { status: 404 })), { kind: "missing" });
    t("H4 403 -> unreadable", await meta(() => new Response("", { status: 403 })), { kind: "unreadable" });
    t("H5 500 / 503 / 429 / 401 -> transient (only 403 means unreadable)",
      [await meta(() => new Response("", { status: 500 })), await meta(() => new Response("", { status: 503 })), await meta(() => new Response("", { status: 429 })), await meta(() => new Response("", { status: 401 }))],
      [{ kind: "transient" }, { kind: "transient" }, { kind: "transient" }, { kind: "transient" }]);
    t("H6 200 without a usable date -> transient", await meta(() => new Response(JSON.stringify({ lastModifiedDateTime: "soon" }), { status: 200 })), { kind: "transient" });
    t("H7 network failure / timeout -> transient (never throws)",
      [await meta(() => { throw new Error("ECONNRESET"); }), await meta(() => { throw new DOMException("timed out", "TimeoutError"); })],
      [{ kind: "transient" }, { kind: "transient" }]);
    // Flag-OFF pin: the EXISTING reader's metadata request is byte-for-byte what it was (id,eTag,size).
    seen.length = 0;
    drive = () => new Response("", { status: 404 });
    const tr = await srv.readTeamsLogFile(cfg, null);
    t("H8 existing fetchDriveFile metadata request still selects exactly id,eTag,size",
      [tr, seen.length, seen[0]?.url.endsWith("?$select=id,eTag,size")], [{ ok: false, reason: "missing" }, 1, true]);
  } finally {
    globalThis.fetch = realFetch;
    envKeys.forEach((k, i) => (savedEnv[i] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[i])));
  }
}

// ---------------------------------------------------------------------------------------------
// I: incomplete file = URGENT (owner 2026-11-13): bell row + Iris chat + email, once per episode. The file is
// still refused by the reader exactly as before; the check only reads the reader's recorded status.
// ---------------------------------------------------------------------------------------------
{
  const lm = U("2026-11-13T14:30:00Z");
  const inc = (checked: string): FeedReadStatus => ({ status: INCOMPLETE_STATUS, checkedMs: U(checked) });
  t("I1 email: reader saw the CURRENT copy incomplete -> incomplete (even though the file is fresh)",
    decideFeedStaleness("email", ok("2026-11-13T14:30:00Z"), now, 6, inc("2026-11-13T14:31:00Z")), { state: "incomplete", sinceMs: lm });
  t("I2 sent: same rule", decideFeedStaleness("sent", ok("2026-11-13T14:30:00Z"), now, 6, inc("2026-11-13T14:35:00Z")).state, "incomplete");
  t("I3 teams has no complete flag: an incomplete status is ignored", decideFeedStaleness("teams", ok("2026-11-13T14:30:00Z"), now, 6, inc("2026-11-13T14:31:00Z")).state, "fresh");
  t("I4 a copy published AFTER the incomplete read, read < 2h ago -> transient (wait for the reader; no clear, no re-raise)",
    decideFeedStaleness("email", ok("2026-11-13T14:30:00Z"), now, 6, inc("2026-11-13T14:00:00Z")).state, "transient");
  t("I5 ...but if the reader has not looked for 2h+, the plain staleness decision applies again",
    decideFeedStaleness("email", ok("2026-11-13T14:30:00Z"), now, 6, inc("2026-11-13T12:30:00Z")).state, "fresh");
  t("I6 any other reader status (ok / unchanged / rejected:other) -> plain staleness",
    ["ok", "unchanged", "rejected:not_json", "error"].map((st) => decideFeedStaleness("email", ok("2026-11-13T14:30:00Z"), now, 6, { status: st, checkedMs: U("2026-11-13T14:31:00Z") }).state),
    ["fresh", "fresh", "fresh", "fresh"]);
  t("I7 missing / unreadable still win over a stale incomplete status",
    [decideFeedStaleness("email", { kind: "missing" }, now, 6, inc("2026-11-13T14:31:00Z")).state, decideFeedStaleness("email", { kind: "unreadable" }, now, 6, inc("2026-11-13T14:31:00Z")).state],
    ["missing", "unreadable"]);
  t("I8 incomplete takes precedence over stale (an old AND incomplete file says incomplete)",
    decideFeedStaleness("email", ok("2026-11-11T14:02:00Z"), now, 6, inc("2026-11-13T14:31:00Z")).state, "incomplete");
  const txt = feedAlertText("email", { state: "incomplete", sinceMs: lm }, now);
  t("I9 bell text: URGENT, names the file and the flow, carries no content and no clock-dependent label",
    [txt.title, /complete: false/.test(txt.detail), /Power Automate email flow/.test(txt.detail), feedAlertText("email", { state: "incomplete", sinceMs: lm }, now + 9 * 86_400_000).title === txt.title],
    ["URGENT: Work email file is incomplete -- Huddle is not using it", true, true, true]);
  t("I10 episode is one 'incomplete' incident (not per republish)", feedEpisode({ state: "incomplete", sinceMs: lm }), "incomplete");

  // Apply: once per episode.
  const tw = twin();
  const sentTo: string[] = [];
  const notify: FeedUrgentNotifier = async (r) => (sentTo.push(`${r.file}:${r.title}`), true);
  const incNow = [{ file: "email" as const, meta: ok("2026-11-13T14:30:00Z"), read: inc("2026-11-13T14:31:00Z") }];
  const a = await applyFeedStaleness(O, incNow, now, 6, tw.store, notify);
  const b = await applyFeedStaleness(O, incNow, now + 60_000, 6, tw.store, notify);
  const c = await applyFeedStaleness(O, [{ file: "email" as const, meta: ok("2026-11-13T15:30:00Z"), read: inc("2026-11-13T15:31:00Z") }], now + H, 6, tw.store, notify);
  t("I11 first incomplete check: ONE bell row AND one urgent announcement", [a.raised, a.urgent, open(tw.rows), sentTo.length], [1, 1, 1, 1]);
  t("I12 later checks while still incomplete (even a re-published incomplete copy): no rewrite, no repeat announcement",
    [b.raised, b.urgent, c.raised, c.urgent, sentTo.length], [0, 0, 0, 0, 1]);
  const d = await applyFeedStaleness(O, [{ file: "email" as const, meta: ok("2026-11-13T16:00:00Z"), read: { status: "ok", checkedMs: U("2026-11-13T16:01:00Z") } }], now + 2 * H, 6, tw.store, notify);
  t("I13 a complete file read OK -> the row clears itself", [d.cleared, open(tw.rows)], [1, 0]);
  const e = await applyFeedStaleness(O, [{ file: "email" as const, meta: ok("2026-11-13T17:00:00Z"), read: inc("2026-11-13T17:01:00Z") }], now + 3 * H, 6, tw.store, notify);
  t("I14 incomplete AGAIN after it cleared = a new incident -> announced again", [e.raised, e.urgent, sentTo.length], [1, 1, 2]);
  tw.rows.get(feedAttentionId(O, "email"))!.status = "dismissed";
  const f = await applyFeedStaleness(O, [{ file: "email" as const, meta: ok("2026-11-13T17:30:00Z"), read: inc("2026-11-13T17:31:00Z") }], now + 4 * H, 6, tw.store, notify);
  t("I15 dismissed during the same incomplete incident: stays dismissed, no announcement", [f.raised, f.urgent, sentTo.length], [0, 0, 2]);
  const tw2 = twin();
  const sent2: string[] = [];
  const n2: FeedUrgentNotifier = async (r) => (sent2.push(r.file), true);
  await applyFeedStaleness(O, [{ file: "sent" as const, meta: ok("2026-11-11T14:02:00Z") }], now, 6, tw2.store, n2);
  const g = await applyFeedStaleness(O, [{ file: "sent" as const, meta: ok("2026-11-11T14:02:00Z") }], now + 60_000, 6, tw2.store, n2);
  t("I16 stale / missing alerts stay bell-only: never announced by chat or email", [g.urgent, sent2.length], [0, 0]);
  const h = await applyFeedStaleness(O, [{ file: "sent" as const, meta: ok("2026-11-13T14:30:00Z"), read: inc("2026-11-13T14:31:00Z") }], now + 2 * H, 6, tw2.store, n2);
  t("I17 an open STALE row that turns incomplete is a new incident: rewritten AND announced", [h.raised, h.urgent, sent2], [1, 1, ["sent"]]);
  const tw3 = twin();
  const thrower: FeedUrgentNotifier = async () => {
    throw new Error("graph down");
  };
  const k = await applyFeedStaleness(O, [...incNow, { file: "sent" as const, meta: ok("2026-11-13T14:30:00Z"), read: inc("2026-11-13T14:31:00Z") }], now, 6, tw3.store, thrower);
  t("I18 a failing announcement never blocks the bell row or the other file", [k.raised, k.urgent, k.failed, open(tw3.rows)], [2, 0, 2, 2]);
  t("I19 log line counts urgent announcements (names/counts only)", stalenessLogLine({ states: { email: "incomplete" }, raised: 1, cleared: 0, failed: 0, urgent: 1 }),
    "[feed-staleness] email=incomplete raised=1 cleared=0 urgent=1");
}
{
  // Wiring: the server check reads the reader status for email/sent only and passes the notifier through.
  const asked: string[] = [];
  const urgent: string[] = [];
  const r = await runFeedStalenessCheck(cfgWith({ staleAlerts: true }, { sent: true, teams: true }), {
    readMeta: async () => ok("2026-11-13T14:30:00Z"),
    store: twin().store,
    now: () => now,
    log: () => {},
    readStatus: async (_c, file) => (asked.push(file), { status: INCOMPLETE_STATUS, checkedMs: U("2026-11-13T14:31:00Z") }),
    notifyUrgent: async (x) => (urgent.push(x.file), true),
  });
  t("I20 server check: reader status asked for email + sent (never teams); both announced once; teams fresh",
    [asked, urgent, r?.states, r?.urgent], [["email", "sent"], ["email", "sent"], { email: "incomplete", sent: "incomplete", teams: "fresh" }, 2]);
  const off = await runFeedStalenessCheck(cfgWith({ staleAlerts: false }, { sent: true }), {
    readMeta: async () => ok("2026-11-13T14:30:00Z"),
    store: twin().store,
    now: () => now,
    log: () => {},
    readStatus: async (_c, file) => (asked.push(`OFF-${file}`), null),
    notifyUrgent: async () => (urgent.push("OFF"), true),
  });
  t("I21 flag OFF: no status read, no announcement", [off, asked.filter((a) => a.startsWith("OFF")).length, urgent.includes("OFF")], [null, 0, false]);
  t("I22 chat directive + email body name the problem and the fix, and say it is not from the user",
    [/not a message from the user/.test(urgentFeedDirective("T", "D")), /Do not call any tools/.test(urgentFeedDirective("T", "D")), urgentFeedEmailBody("T", "D").startsWith("T.\n\nD")],
    [true, true, true]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
