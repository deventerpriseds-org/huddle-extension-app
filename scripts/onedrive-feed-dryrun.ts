// WHAT:       Runs the REAL OneDrive feed files through the shipped validator, mapper and screen, and
//             prints verdicts and counts only. Read-only; announces nothing; writes nothing.
// WHY:        Unit fixtures prove the logic; this proves the logic against the envelopes Power Automate
//             actually publishes (field names, header shape, time formats). Run by
//             graph-permission-check.yml section 6. THIS REPO'S LOGS ARE PUBLIC: no subjects, senders,
//             bodies or ids are printed -- sender DOMAIN and verdict reason only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:trinnex-onedrive-feed.
// 2026-11-12: extended (not copied) for the rolling Teams log and the correspondence ingest: Teams verdict
//             counts, skip reasons and field-presence flags; email has_internetMessageId / has_sent_items.
//             Still counts and yes/no only (AC docs/ac/AC-correspondence-checklist.md AC-7.3, AC-8.3).
// Env: TOKEN (app-only Graph), FEED_DRIVE_USER, HUDDLE_ONEDRIVE_FEEDS (same JSON the app reads),
//      (own addresses are derived from the config). Run: npx -y tsx scripts/onedrive-feed-dryrun.ts
import {
  eligibleFeedMessages,
  mapFeedAppointments,
  mapFeedMessage,
  parseFeedsConfig,
  validateAppointmentSnapshot,
  validateEmailSnapshot,
} from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { INBOUND_EMAIL_MODE_DEFAULT, screenMessage } from "../src/features/huddle/lib/email/inbound-email";
import { parseTeamsLog, teamsParseNote } from "../src/features/huddle/lib/external-feeds/teams-log";
import { ledgerEmailItems } from "../src/features/huddle/lib/correspondence/ingest-pass";

const cfg = parseFeedsConfig(process.env.HUDDLE_ONEDRIVE_FEEDS);
if (!cfg) {
  console.log("config: OFF / invalid — nothing to check");
  process.exit(0);
}
const token = process.env.TOKEN ?? "";
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
    const v = screenMessage(m, INBOUND_EMAIL_MODE_DEFAULT, cfg.mailbox).reason;
    console.log(
      `  - from domain ${dom(m.fromAddress)} | name ${m.fromName ? "yes" : "no"} | headers ${m.headerNames?.length ?? 0} | body ${m.bodyText ? "yes" : "no"} | received ${m.receivedDateTime ? "yes" : "no"} | eligible ${eligible.some((x) => x.id === m.id)} | verdict ${v}`,
    );
  }
  // Correspondence ingest (counts / yes-no only): what the ledger would record, and whether the fields the
  // reply detection needs exist at all (OQ-1, OQ-6).
  const led = ledgerEmailItems(ev.snapshot.records, cfg, { path: cfg.email.path, etag: null });
  const own = cfg.mailbox.toLowerCase();
  console.log(
    `  ledger items ${led.items.length} | skipped ${led.skipped} | has_internetMessageId ${ev.snapshot.records.some((r) => !!r.internetMessageId)} | has_conversationId ${mapped.some((m) => !!m.conversationId)} | has_sent_items ${mapped.some((m) => String(m.fromAddress ?? "").toLowerCase() === own)}`,
  );
}
if (cfg.teams.enabled) {
  const r = await fetch(`${base}${cfg.teams.path}:/content`, { headers: { Authorization: `Bearer ${token}` } });
  const text = r.ok ? await r.text() : "";
  console.log(`teams: HTTP ${r.status} | bytes ${text.length} | maxBytes ${cfg.maxBytes} | over_cap ${text.length > cfg.maxBytes}`);
  if (r.ok) {
    const p = parseTeamsLog(text, cfg);
    const ms = p.messages;
    console.log(
      `  ${p.rejected ? `REJECTED ${p.rejected}` : "parsed"} | lines ${p.lines} | messages ${ms.length} | duplicates ${p.duplicates} | chats ${new Set(ms.map((m) => m.chatId)).size}`,
    );
    console.log(`  skips: ${teamsParseNote(p) ?? "none"}`);
    console.log(
      `  has_sender_id ${ms.some((m) => !!m.senderId)} | has_sender_name ${ms.some((m) => !!m.senderName)} | has_app_sender ${ms.some((m) => m.senderIsApp)} | has_chat_name ${ms.some((m) => !!m.chatName)} | has_web_url ${ms.some((m) => !!m.webUrl)} | owner_ids_configured ${cfg.teams.ownerSenderIds.length > 0} | owner_messages ${ms.filter((m) => m.fromOwner === true).length}`,
    );
  }
} else {
  console.log("teams: not configured (HUDDLE_ONEDRIVE_FEEDS.teams absent or disabled)");
}
console.log(`correspondence: ingest ${cfg.correspondence.ingest} | bell ${cfg.correspondence.bell} | proposals ${cfg.correspondence.proposals} | sources ${cfg.correspondence.sources.join(",")}`);
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
