// WHAT:       Runs the REAL OneDrive feed files through the shipped validator, mapper and screen, and
//             prints verdicts and counts only. Read-only; announces nothing; writes nothing.
// WHY:        Unit fixtures prove the logic; this proves the logic against the envelopes Power Automate
//             actually publishes (field names, header shape, time formats). Run by
//             graph-permission-check.yml section 6. THIS REPO'S LOGS ARE PUBLIC: no subjects, senders,
//             bodies or ids are printed -- sender DOMAIN and verdict reason only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:trinnex-onedrive-feed.
// Env: TOKEN (app-only Graph), FEED_DRIVE_USER, HUDDLE_ONEDRIVE_FEEDS (same JSON the app reads),
//      OWN_ADDRESSES (comma list). Run: npx -y tsx scripts/onedrive-feed-dryrun.ts
import {
  eligibleFeedMessages,
  isFromOwner,
  mapFeedAppointments,
  mapFeedMessage,
  parseFeedsConfig,
  validateAppointmentSnapshot,
  validateEmailSnapshot,
} from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { INBOUND_EMAIL_MODE_DEFAULT, screenMessage } from "../src/features/huddle/lib/email/inbound-email";

const cfg = parseFeedsConfig(process.env.HUDDLE_ONEDRIVE_FEEDS);
if (!cfg) {
  console.log("config: OFF / invalid — nothing to check");
  process.exit(0);
}
const token = process.env.TOKEN ?? "";
const own = (process.env.OWN_ADDRESSES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.driveUser)}/drive/root:`;
const get = async (path: string) => {
  const r = await fetch(`${base}${path}:/content`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, json: r.ok ? await r.json().catch(() => null) : null };
};
const dom = (a: string | null | undefined) => String(a ?? "").split("@")[1] ?? "-";

const e = await get(cfg.email.path);
const ev = validateEmailSnapshot(e.json, cfg);
console.log(`email: HTTP ${e.status} | validation ${ev.ok ? "OK" : `REJECTED ${ev.reason}`}`);
if (ev.ok) {
  const mapped = ev.snapshot.records.map((r) => mapFeedMessage(r, cfg.mailbox));
  const eligible = eligibleFeedMessages(mapped, cfg, ev.snapshot.windowStartUtc);
  console.log(`  records ${mapped.length} | eligible (prefix/window/dedupe) ${eligible.length}`);
  for (const m of mapped) {
    const self = isFromOwner(m, [cfg.mailbox, ...own]);
    const v = self ? "self" : screenMessage(m, INBOUND_EMAIL_MODE_DEFAULT, cfg.mailbox).reason;
    console.log(
      `  - from domain ${dom(m.fromAddress)} | name ${m.fromName ? "yes" : "no"} | headers ${m.headerNames?.length ?? 0} | body ${m.bodyText ? "yes" : "no"} | received ${m.receivedDateTime ? "yes" : "no"} | eligible ${eligible.some((x) => x.id === m.id)} | verdict ${v}`,
    );
  }
}
const a = await get(cfg.appointments.path);
const av = validateAppointmentSnapshot(a.json, cfg);
console.log(`appointments: HTTP ${a.status} | validation ${av.ok ? "OK" : `REJECTED ${av.reason}`}`);
if (av.ok) {
  const evs = mapFeedAppointments(av.snapshot.records, cfg.mailbox, av.snapshot.windowStartUtc, av.snapshot.windowEndUtc!, "America/New_York");
  console.log(`  records ${av.snapshot.records.length} | mapped in window ${evs.length}`);
  for (const x of evs) {
    console.log(`  - start ${x.start ? "parsed" : "MISSING"} | end ${x.end ? "parsed" : "MISSING"} | allDay ${x.isAllDay} | organizer ${x.organizer ? "yes" : "no"} | location ${x.location ? "yes" : "no"}`);
  }
}
