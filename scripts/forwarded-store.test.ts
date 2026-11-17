// WHAT:          Offline suite: a stored "Fw:" email keeps its FORWARDED email (EmailContent.forwarded), and the
//                back-fill's refill plan picks exactly the stored forwards that gain it.
// WHY:           Owner 2026-11-16: "about 3 of 5 forwarded emails lost the forwarded part when they were stored, so the
//                AI only sees the cover note." Root cause: stored bodyText is htmlToText output, which cuts at Outlook's
//                divRplyFwdMsg / appendonsend marker and drops <blockquote> -- right for Iris's live text, wrong as the
//                only stored copy of a forward. Also PINS that bodyText, the content hash and the live text are unchanged.
// SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-correspondence-tuning-fixes.md (fix 1).
// Run: bun scripts/forwarded-store.test.ts        ALL DATA SYNTHETIC (example.invalid addresses, made-up names).
import { forwardedPart, forwardedPartText } from "../src/features/huddle/lib/correspondence/forwarded";
import { forwardsFromLedger, type LedgerReportRow } from "../src/features/huddle/lib/correspondence/report-from-ledger";
import {
  emailContent,
  emailSourceItem,
  planForwardRefill,
  sentSourceItems,
  stableHash,
  type EmailContent,
  type StoredForwardFlags,
} from "../src/features/huddle/lib/correspondence/source-item";
import { htmlToText, mapFeedMessage, type OneDriveFeedsConfig } from "../src/features/huddle/lib/external-feeds/onedrive-feed";

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${name} :: ${JSON.stringify(got)}`);
  }
};

const MBX = "owner@example.invalid";
const rec = (id: string, subject: string, content: string, html = true, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  subject,
  conversationId: `conv-${id}`,
  receivedDateTime: "2026-11-10T14:00:00Z",
  from: "pat@example.invalid",
  body: { contentType: html ? "html" : "text", content },
  ...extra,
});

// ── Shapes (synthetic). Each forwarded body holds a distinct ask, so a missing forwarded part is visible.
const OWA =
  '<div>See below.<br>Pat Example</div><hr style="display:inline-block;width:98%">' +
  '<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Synthetic Team &lt;team@example.invalid&gt;<br>' +
  "<b>Sent:</b> Monday, November 9, 2026 9:00 AM<br><b>To:</b> Owner Example<br><b>Cc:</b> Lee Example<br><b>Subject:</b> Synthetic reminder</font><div>&nbsp;</div></div>" +
  "<div>Please complete the synthetic form by Friday.</div>";
const NEW_OUTLOOK =
  '<div>FYI</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Synthetic Team<br><b>Sent:</b> Monday<br>' +
  "<b>Subject:</b> Synthetic training</div><div>Please finish the synthetic training by Dec 2.</div>";
const CLASSIC =
  '<div class="WordSection1"><p class="MsoNormal">Can you take this?</p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in">' +
  '<p class="MsoNormal"><b>From:</b> Synthetic Team &lt;team@example.invalid&gt; <br><b>Sent:</b> Monday, November 9, 2026 9:00 AM<br>' +
  '<b>To:</b> Owner Example<br><b>Subject:</b> Synthetic report</p></div></div><p class="MsoNormal">Please send the synthetic report today.</p></div>';
const GMAIL =
  '<div dir="ltr">Forwarding this.<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>' +
  'From: <strong class="gmail_sendername" dir="auto">Synthetic Team</strong> <span dir="auto">&lt;team@example.invalid&gt;</span><br>' +
  "Date: Mon, Nov 9, 2026 at 9:00 AM<br>Subject: Synthetic budget<br>To: &lt;owner@example.invalid&gt;<br></div><br><br>" +
  '<div dir="ltr">Please review the synthetic budget by Thursday.</div></div></div>';
const TAGGED =
  '<div>Thoughts?</div><div id="divRplyFwdMsg"><b>From:</b> Vendor Example<br><b>Sent:</b> Tue<br><b>Subject:</b> Synthetic invoice</div>' +
  "<div>Please approve synthetic invoice 0001 by Monday.</div>";
const APPLE =
  '<div>See below</div><div><br><blockquote type="cite"><div>Begin forwarded message:</div><br><div><b>From: </b>Synthetic Team</div>' +
  "<div><b>Subject: </b>Synthetic form</div><div><b>Date: </b>Nov 9</div><br><div>Please sign the synthetic form.</div></blockquote></div>";
const PLAIN = "See below.\n\n-----Original Message-----\nFrom: Synthetic Team\nSent: Monday\nSubject: Synthetic\n\nPlease send the synthetic timesheet today.";

const cases: [string, string, string, boolean, string, Partial<Record<"from" | "sent" | "to" | "cc" | "subject", string>>][] = [
  ["OWA / Outlook web (divRplyFwdMsg)", "FW: Synthetic reminder", OWA, true, "Please complete the synthetic form by Friday.", { from: "Synthetic Team <team@example.invalid>", sent: "Monday, November 9, 2026 9:00 AM", to: "Owner Example", cc: "Lee Example", subject: "Synthetic reminder" }],
  ["new Outlook (appendonsend + divRplyFwdMsg)", "Fw: Synthetic training", NEW_OUTLOOK, true, "Please finish the synthetic training by Dec 2.", { from: "Synthetic Team", sent: "Monday", subject: "Synthetic training" }],
  ["classic Outlook desktop (border-top header, no id)", "FW: Synthetic report", CLASSIC, true, "Please send the synthetic report today.", { from: "Synthetic Team <team@example.invalid>", to: "Owner Example", subject: "Synthetic report" }],
  ["Gmail (---------- Forwarded message ---------)", "Fwd: Synthetic budget", GMAIL, true, "Please review the synthetic budget by Thursday.", { from: "Synthetic Team <team@example.invalid>", sent: "Mon, Nov 9, 2026 at 9:00 AM", subject: "Synthetic budget", to: "<owner@example.invalid>" }],
  ["[TAG] FW: subject", "[EXTERNAL] FW: Synthetic invoice", TAGGED, true, "Please approve synthetic invoice 0001 by Monday.", { from: "Vendor Example", subject: "Synthetic invoice" }],
  ["EXT: FW: subject", "EXT: FW: Synthetic invoice", TAGGED, true, "Please approve synthetic invoice 0001 by Monday.", { from: "Vendor Example" }],
  ["Apple Mail (blockquote type=cite)", "Fwd: Synthetic form", APPLE, true, "Please sign the synthetic form.", { from: "Synthetic Team", sent: "Nov 9", subject: "Synthetic form" }],
  ["plain text (-----Original Message-----)", "FW: Synthetic", PLAIN, false, "Please send the synthetic timesheet today.", { from: "Synthetic Team", sent: "Monday", subject: "Synthetic" }],
];

// ── A. forwardedPart per shape
for (const [name, subj, body, html, ask, fields] of cases) {
  const p = forwardedPart(subj, body, html);
  t(`A ${name}: forwarded body holds the forwarded ask`, !!p && p.body.includes(ask), p);
  for (const [k, v] of Object.entries(fields)) t(`A ${name}: header ${k}`, !!p && p[k as keyof typeof p] === v, p);
  t(`A ${name}: the forwarder's cover note is not in the forwarded part`, !!p && !/See below|FYI|Can you take this|Forwarding this|Thoughts\?/.test(`${p.body} ${p.from}`), p);
}

// ── B. the stored record: bodyText / hash UNCHANGED, `forwarded` added
const cfg = { mailbox: MBX } as unknown as OneDriveFeedsConfig;
for (const [name, subj, body, html, ask] of cases) {
  const r = rec("b", subj, body, html);
  const mapped = mapFeedMessage(r, MBX);
  const c = emailContent(r, mapped);
  t(`B ${name}: stored content carries the forwarded ask`, !!c.forwarded && c.forwarded.body.includes(ask), c.forwarded);
  t(`B ${name}: bodyText is exactly the live mapper's text (unchanged)`, c.bodyText === mapped.bodyText, c.bodyText);
}
const owaRec = rec("b1", "FW: Synthetic reminder", OWA);
const owaMapped = mapFeedMessage(owaRec, MBX);
t("B-1 the defect being fixed: the live text of an OWA forward is the cover note only", !owaMapped.bodyText!.includes("synthetic form") && owaMapped.bodyText!.includes("See below"), owaMapped.bodyText);
const item = emailSourceItem(owaRec, owaMapped, { path: "p", etag: "e" }, MBX)!;
t("B-2 content hash is unchanged by the forwarded field (same formula as before)", item.contentHash === stableHash([owaMapped.subject, owaMapped.bodyText ?? owaMapped.bodyPreview, owaMapped.fromAddress, owaMapped.receivedDateTime, ""]), item.contentHash);
t("B-3 the SourceItem's stored content carries it", !!(item.content as EmailContent).forwarded);
t("B-4 the in-memory email the processors read is unchanged (cover note only)", item.email!.bodyText === owaMapped.bodyText);
const notFwd = emailContent(rec("b5", "Re: Synthetic reminder", OWA), mapFeedMessage(rec("b5", "Re: Synthetic reminder", OWA), MBX));
t("B-5 a reply (not a forward) gets NO forwarded field", !("forwarded" in notFwd) && notFwd.isForward === false, notFwd);
const noPart = emailContent(rec("b6", "FW: x", "<div>only the cover note</div>"), mapFeedMessage(rec("b6", "FW: x", "<div>only the cover note</div>"), MBX));
t("B-6 a forward with no readable forwarded part gets NO forwarded field (never an empty one)", noPart.isForward && !("forwarded" in noPart), noPart);
const sent = sentSourceItems([rec("s1", "FW: Synthetic reminder", OWA, true, { sentDateTime: "2026-11-10T15:00:00Z" })], cfg, { path: "sent" });
t("B-7 a Sent Items forward stores its forwarded part too", sent.items.length === 1 && !!(sent.items[0].content as EmailContent).forwarded?.body.includes("synthetic form"), sent);

// ── C. the approved Iris email-text behaviour still applies INSIDE the forwarded part
const iris =
  '<div>FYI</div><div id="divRplyFwdMsg"><b>From:</b> Synthetic Team<br><b>Sent:</b> Mon<br><b>Subject:</b> X</div>' +
  '<div>Please confirm &amp; reply by Friday &ndash; thanks.<span style="display:none">HIDDEN-TRACKER</span></div>' +
  '<div><img alt="a > b" src="x">Second line stays.</div>' +
  '<div id="divRplyFwdMsg"><b>From:</b> Older Sender<br><b>Sent:</b> Sun</div><div>OLDER-HISTORY</div>';
const ip = forwardedPart("FW: X", iris, true)!;
t("C-1 entities decoded in the forwarded body", ip.body.includes("Please confirm & reply by Friday – thanks."), ip.body);
t("C-2 hidden text ignored in the forwarded body", !ip.body.includes("HIDDEN-TRACKER"), ip.body);
t("C-3 tag-span fix kept (no `b\">` fragment glued to the next word)", ip.body.includes("Second line stays.") && !ip.body.includes('b">'), ip.body);
t("C-4 the forward's OWN older history is cut (next Outlook marker)", !ip.body.includes("OLDER-HISTORY"), ip.body);
// C-4 is cut one layer up (forwardedText stops at the next Outlook marker). For a PLAIN-TEXT forward the forwarded
// part's own older history is cut only by forwardedPart's newTextOnly call -- this pins that layer in English
// (mutation M1b, docs/qc-evidence/BUILD-correspondence-tuning-fixes.md).
const en = forwardedPart("FW: Synthetic", `${PLAIN}\n\n-----Original Message-----\nFrom: Older Sender\nSent: Sunday\n\nOLDER-PLAIN-HISTORY`, false)!;
t("C-4b plain-text forward: its OWN older history is cut", en.body === "Please send the synthetic timesheet today.", en.body);
const de = "Siehe unten.\n\n-----Ursprüngliche Nachricht-----\nVon: Synthetisches Team\nGesendet: Montag\nBetreff: Synthetisch\n\nBitte bis Freitag ausfüllen.\n\nVon: Älterer Absender\nGesendet: Sonntag\nALTE-HISTORIE";
const dp = forwardedPart("WG: Synthetisch", de, false)!;
t("C-5 German header labels map to from/sent/subject", dp.from === "Synthetisches Team" && dp.sent === "Montag" && dp.subject === "Synthetisch", dp);
t("C-6 non-English quoted history inside the forwarded part is cut", dp.body === "Bitte bis Freitag ausfüllen.", dp.body);
t("C-7 PIN: the live htmlToText still cuts the forward (Iris unchanged)", !htmlToText(iris).includes("Please confirm"), htmlToText(iris));
t("C-8 cap respected", (forwardedPart("FW: x", `<div id="divRplyFwdMsg"><b>From:</b> A<br><b>Sent:</b> B</div><div>${"y".repeat(500)}</div>`, true, 100)?.body.length ?? 0) <= 100);
t("C-9 never throws on junk", forwardedPart("FW: x", null, true) === null && forwardedPart(null, OWA, true) === null);

// ── D. rendering for the judge + the report reads the STORED part first
const txt = forwardedPartText(forwardedPart("FW: Synthetic reminder", OWA, true)!);
t("D-1 rendered text: header lines then the body", txt.startsWith("From: Synthetic Team <team@example.invalid>\nSent: Monday") && txt.endsWith("Please complete the synthetic form by Friday."), txt);
t("D-2 rendered text capped", forwardedPartText({ from: null, sent: null, to: null, cc: null, subject: null, body: "z".repeat(9000) }).length === 6000);
const row = (id: string, c: EmailContent): LedgerReportRow => ({ source: "email", sourceItemId: `${MBX}:${id}`, threadId: c.conversationId, at: c.receivedAt, content: c });
const storedRow = row("r1", emailContent(owaRec, owaMapped));
const oldRow = row("r2", { ...emailContent(owaRec, owaMapped), forwarded: undefined });
delete (oldRow.content as EmailContent).forwarded;
const fw = forwardsFromLedger([storedRow, oldRow]);
t("D-3 report: a row WITH a stored forwarded part is read (the AI sees the forwarded ask)", (fw.forwards.get(`feed:${MBX}:r1`) ?? "").includes("synthetic form"), [...fw.forwards]);
t("D-4 report: a row stored before the field, cover note only, is still counted missing", fw.isForward === 2 && fw.missing === 1, fw);

// ── E. back-fill refill plan
const mk = (id: string, subj: string, body: string) => {
  const r = rec(id, subj, body);
  return emailSourceItem(r, mapFeedMessage(r, MBX), { path: "p", etag: "e" }, MBX)!;
};
const items = [mk("e1", "FW: a", OWA), mk("e2", "FW: b", "<div>cover only</div>"), mk("e3", "Re: c", OWA), mk("e4", "FW: d", NEW_OUTLOOK), mk("e1", "FW: a", TAGGED)];
const flag = (id: string, o: Partial<StoredForwardFlags> = {}): StoredForwardFlags => ({ source: "email", sourceItemId: `${MBX}:${id}`, hasContent: true, hasForwarded: false, purged: false, ...o });
const plan = planForwardRefill(items, [flag("e1"), flag("e2"), flag("e4", { hasForwarded: true }), flag("e5"), flag("e6", { purged: true, hasContent: false })]);
t("E-1 forwards read = distinct forward items (a reply is not one)", plan.forwardsRead === 3 && plan.forwardsWithPart === 2, plan);
t("E-2 stored without the part: e1, e2, e5, e6", plan.storedForwards === 5 && plan.storedMissing === 4, plan);
t("E-3 would gain = only e1 (a version has its forwarded part)", plan.wouldGain === 1 && plan.refill.length === 1 && plan.refill[0].sourceItemId === `${MBX}:e1`, plan);
t("E-4 the NEWEST version of e1 is the one re-written", ((plan.refill[0].content as EmailContent).forwarded?.body ?? "").includes("invoice 0001"), plan.refill[0].content);
t("E-5 still missing = e2 (no readable part) + e5 (no version read); purged e6 never re-written", plan.stillMissing === 2 && plan.purged === 1, plan);
t("E-6 a row that already has the part is left alone", !plan.refill.some((i) => i.sourceItemId.endsWith(":e4")));

console.log(`forwarded-store: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
