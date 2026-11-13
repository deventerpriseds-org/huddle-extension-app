// WHAT:       Verifier loop-4 probes for the file-staleness decision (feed-staleness.ts): working-hours math
//             around DST, weekends, Friday->Monday, the Teams 18:00 + 60 min rule, labels, flag parsing.
// WHY:        New, owner-approved feature; verified at full depth independently of the implementer's suite.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-correspondence-proposals-4.md
import * as S from "../src/features/huddle/lib/correspondence/feed-staleness";
import { parseFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { feedFilesToCheck, runFeedStalenessCheck } from "../src/features/huddle/lib/correspondence/feed-staleness.server";

const P = (id: string, v: unknown) => console.log(`PROBE ${id} ${JSON.stringify(v)}`);
const U = (s: string) => Date.parse(s);
const H = 3_600_000;
const wh = (a: string, b: string) => S.workingMsBetween(U(a), U(b)) / H;

// Working hours (ET = UTC-4 EDT until 2026-11-01 06:00Z, UTC-5 EST after; DST starts 2026-03-08 07:00Z)
P("WH Fri 17:00 EDT -> Mon 09:00 EST across DST end (expect 2)", wh("2026-10-30T21:00:00Z", "2026-11-02T14:00:00Z"));
P("WH Fri 17:00 EST -> Mon 09:00 EDT across DST start (expect 2)", wh("2026-03-06T22:00:00Z", "2026-03-09T13:00:00Z"));
P("WH Sat noon -> Sun noon (expect 0)", wh("2026-11-14T17:00:00Z", "2026-11-15T17:00:00Z"));
P("WH Mon 07:00 -> Mon 19:00 (expect 10)", wh("2026-11-16T12:00:00Z", "2026-11-17T00:00:00Z"));
P("WH Tue 18:00 -> Wed 08:00 (expect 0)", wh("2026-11-17T23:00:00Z", "2026-11-18T13:00:00Z"));
P("WH full week Mon 00:00 -> next Mon 00:00 (expect 50)", wh("2026-11-16T05:00:00Z", "2026-11-23T05:00:00Z"));
P("WH reversed (expect 0)", wh("2026-11-17T00:00:00Z", "2026-11-16T12:00:00Z"));
P("WH 2 years (bounded walk, expect < 520*10)", wh("2024-11-16T05:00:00Z", "2026-11-16T05:00:00Z"));
P("WH Wed 11/11 09:02 EST -> Fri 11/13 10:00 EST (the real incident, expect 10.97+10+2=~22.97)", wh("2026-11-11T14:02:00Z", "2026-11-13T15:00:00Z"));

const meta = (iso: string): S.FeedMeta => ({ kind: "ok", lastModifiedMs: U(iso) });
const dec = (f: S.FeedFile, last: string, now: string, h = 6) => S.decideFeedStaleness(f, meta(last), U(now), h);
// email/sent threshold
P("EM Thu 12:00 -> Thu 18:00 exactly 6h (expect fresh: strictly MORE)", dec("email", "2026-11-12T17:00:00Z", "2026-11-12T23:00:00Z").state);
P("EM Thu 12:00 -> Fri 08:01 (6h01m, expect stale)", dec("email", "2026-11-12T17:00:00Z", "2026-11-13T13:01:00Z"));
P("EM Fri 15:00 -> Mon 10:00 (5h, expect fresh)", dec("email", "2026-11-13T20:00:00Z", "2026-11-16T15:00:00Z").state);
P("EM Fri 15:00 -> Mon 11:01 (6h01m, expect stale)", dec("email", "2026-11-13T20:00:00Z", "2026-11-16T16:01:00Z").state);
P("EM future lastModified (skew) -> fresh", dec("email", "2026-11-13T20:00:00Z", "2026-11-13T19:00:00Z").state);
P("EM NaN -> unreadable", S.decideFeedStaleness("email", { kind: "ok", lastModifiedMs: NaN }, U("2026-11-13T19:00:00Z"), 6).state);
P("EM staleHours 1", dec("email", "2026-11-13T14:00:00Z", "2026-11-13T15:30:00Z", 1).state);
// Teams 18:00 + 60 min grace, weekdays only
P("TM Mon 18:59 ET, last Fri 18:05 -> fresh (Mon grace not over)", dec("teams", "2026-11-13T23:05:00Z", "2026-11-16T23:59:00Z").state);
P("TM Mon 19:00 ET, last Fri 18:05 -> stale", dec("teams", "2026-11-13T23:05:00Z", "2026-11-17T00:00:00Z").state);
P("TM Mon 19:00 ET, last Mon 18:30 -> fresh", dec("teams", "2026-11-16T23:30:00Z", "2026-11-17T00:00:00Z").state);
P("TM Sat 10:00, last Fri 18:05 -> fresh", dec("teams", "2026-11-13T23:05:00Z", "2026-11-14T15:00:00Z").state);
P("TM Sat 10:00, last Fri 17:00 -> stale (Fri run missed)", dec("teams", "2026-11-13T22:00:00Z", "2026-11-14T15:00:00Z").state);
P("TM Mon 10:00, last Fri 18:05 -> fresh (weekend not due)", dec("teams", "2026-11-13T23:05:00Z", "2026-11-16T15:00:00Z").state);
P("TM DST-end Mon 2026-11-02 19:00 EST (00:00Z), last Mon 18:10 EST (23:10Z) -> fresh", dec("teams", "2026-11-02T23:10:00Z", "2026-11-03T00:00:00Z").state);
P("TM DST-end Mon 2026-11-02 19:00 EST, last Mon 17:30 EST (22:30Z, i.e. 18:30 if read as EDT) -> stale", dec("teams", "2026-11-02T22:30:00Z", "2026-11-03T00:00:00Z").state);
P("TM teamsDueInstant DST-start Mon 2026-03-09 20:00 EDT -> 22:00Z", new Date(S.teamsDueInstant(U("2026-03-10T00:00:00Z"))).toISOString());
P("TM flow writes 17:58 every evening (early) -> stale at 19:00", dec("teams", "2026-11-16T22:58:00Z", "2026-11-17T00:00:00Z").state);
P("TM flow scheduled 23:00Z: EDT summer writes 19:00:30 ET -> stale between 19:00 and 19:00:30", S.decideFeedStaleness("teams", meta("2026-07-14T23:00:30Z"), U("2026-07-14T23:00:10Z"), 6).state);
// labels
P("LBL 9h", S.workingSpanLabel(9));
P("LBL 10h", S.workingSpanLabel(10));
P("LBL 19h", S.workingSpanLabel(19));
P("LBL 1h", S.workingSpanLabel(1));
const st = S.decideFeedStaleness("email", meta("2026-11-11T14:02:00Z"), U("2026-11-13T15:00:00Z"), 6);
P("TXT incident", st.state === "fresh" ? null : S.feedAlertText("email", st, U("2026-11-13T15:00:00Z")));
P("TXT missing", S.feedAlertText("sent", { state: "missing" }, 0));
P("TXT unreadable", S.feedAlertText("teams", { state: "unreadable" }, 0));
P("TXT teams stale", S.feedAlertText("teams", { state: "stale", sinceMs: U("2026-11-12T23:05:00Z"), workingHours: null }, U("2026-11-14T15:00:00Z")));
P("TXT old >6 days", S.feedAlertText("email", { state: "stale", sinceMs: U("2026-11-01T14:00:00Z"), workingHours: 80 }, U("2026-11-13T15:00:00Z")).title);
P("ID", [S.feedAttentionId("Owner@EDS.example ", "email"), S.feedAttentionId("owner@eds.example", "email"), S.feedAttentionId("owner@eds.example", "teams")]);

// flag parsing
const base = { enabled: true, ownerLogins: ["owner@huddle.example"], driveUser: "owner@work.example", mailbox: "owner@work.example", synthetic: false };
for (const v of [undefined, false, "true", 1, "yes", null, {}, true]) {
  const c = parseFeedsConfig(JSON.stringify({ ...base, correspondence: { staleAlerts: v } }))!;
  P(`FLAG staleAlerts=${JSON.stringify(v)}`, c.correspondence.staleAlerts);
}
for (const v of [undefined, 0, -3, "8", 8.9, 500, "abc", null]) {
  const c = parseFeedsConfig(JSON.stringify({ ...base, correspondence: { staleAlerts: true, staleHours: v } }))!;
  P(`FLAG staleHours=${JSON.stringify(v)}`, c.correspondence.staleHours);
}
const cfgOn = parseFeedsConfig(JSON.stringify({ ...base, correspondence: { staleAlerts: true } }))!;
P("FILES default config (email default-on, teams/sent opt-in)", feedFilesToCheck(cfgOn).map((f) => f.file));
P("FILES email disabled", feedFilesToCheck(parseFeedsConfig(JSON.stringify({ ...base, emails: { enabled: false }, email: { enabled: false }, correspondence: { staleAlerts: true } }))!).map((f) => f.file));
// OFF => zero calls through the injected deps
let calls = 0;
const spy = { readMeta: async () => { calls++; return { kind: "missing" } as S.FeedMeta; }, store: { raise: async () => { calls++; return true; }, clear: async () => { calls++; return true; } }, now: () => { calls++; return 0; }, log: () => { calls++; } };
const cfgOff = parseFeedsConfig(JSON.stringify({ ...base, teams: true, sent: true }))!;
P("OFF runFeedStalenessCheck", { rep: await runFeedStalenessCheck(cfgOff, spy), calls });
P("OFF null cfg", { rep: await runFeedStalenessCheck(null, spy), calls });
// ON: log line content
const logs: string[] = [];
const spy2 = { readMeta: async (_c: unknown, p: string) => (p.includes("sent") ? ({ kind: "unreadable" } as S.FeedMeta) : ({ kind: "ok", lastModifiedMs: U("2026-11-11T14:02:00Z") } as S.FeedMeta)), store: { raise: async () => true, clear: async () => false }, now: () => U("2026-11-13T15:00:00Z"), log: (l: string) => logs.push(l) };
const cfgAll = parseFeedsConfig(JSON.stringify({ ...base, teams: true, sent: true, correspondence: { staleAlerts: true } }))!;
P("ON report", await runFeedStalenessCheck(cfgAll, spy2));
P("ON logs", logs);
