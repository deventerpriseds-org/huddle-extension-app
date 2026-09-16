// WHAT:       Batch 6.5 cleanup + verification -- lists the Drafts folder of the allowed mailbox via
//             Microsoft Graph, PROVES the probe's message is a draft (it is in the Drafts folder and
//             `isDraft` is true, and `sentDateTime` shows it was never sent), then DELETES it.
// WHY:        The batch brief requires that any draft created is verified to BE a draft and then
//             removed. Huddle's own code has no delete-draft path (`graph-email.server.ts` exports
//             createGraphDraft and sendGraphEmail only), so the cleanup has to speak to Graph
//             directly, with the same app-only client credentials the app itself uses.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/cross-app-agent/BATCH-6-RESULTS.md §6.5 in deventerpriseds-org/nexus-hub.
//
// It matches ONLY on a subject containing the batch run marker, so it can never touch a real draft.
const MARKER = process.env.B6_MARKER || "B6-20260907-K7QX";
const MAILBOX = process.env.HUDDLE_EMAIL_FROM?.split(",")[0]?.trim() || "dev@enterpriseds.io";
const TENANT = process.env.ENTRA_TENANT_ID || process.env.AZURE_TENANT_ID;
const CLIENT = process.env.GRAPH_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const SECRET = process.env.GRAPH_CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET;
const GRAPH = "https://graph.microsoft.com/v1.0";
const DELETE = (process.env.B6_DELETE ?? "true") !== "false";

if (!TENANT || !CLIENT || !SECRET) {
  console.log("### BLOCKED: Graph app credentials absent in this job's env. Nothing listed, nothing deleted.");
  process.exit(0);
}
const tk = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
});
if (!tk.ok) { console.log(`### BLOCKED: token ${tk.status} ${(await tk.text()).slice(0, 300)}`); process.exit(0); }
const token = (await tk.json()).access_token;
const H = { Authorization: `Bearer ${token}` };

const url = `${GRAPH}/users/${encodeURIComponent(MAILBOX)}/mailFolders/drafts/messages?$top=50&$select=id,subject,isDraft,sentDateTime,createdDateTime,toRecipients,parentFolderId&$orderby=createdDateTime desc`;
const res = await fetch(url, { headers: H });
console.log(`### GET drafts -> http ${res.status}`);
const body = await res.text();
if (res.status !== 200) { console.log(`### body: ${body.slice(0, 600)}`); process.exit(0); }
const items = (JSON.parse(body).value || []);
console.log(`### drafts in ${MAILBOX}: ${items.length}`);
const mine = items.filter((m) => String(m.subject || "").includes(MARKER));
console.log(`### drafts matching marker ${MARKER}: ${mine.length}`);
for (const m of mine) {
  console.log(`###   id=${m.id}`);
  console.log(`###   subject=${JSON.stringify(m.subject)}`);
  console.log(`###   isDraft=${m.isDraft}  sentDateTime=${m.sentDateTime}  createdDateTime=${m.createdDateTime}`);
  console.log(`###   toRecipients=${JSON.stringify(m.toRecipients)}`);
}
if (!DELETE) { console.log("### B6_DELETE=false — listing only."); process.exit(0); }
for (const m of mine) {
  const d = await fetch(`${GRAPH}/users/${encodeURIComponent(MAILBOX)}/messages/${m.id}`, { method: "DELETE", headers: H });
  console.log(`### DELETE ${m.id} -> http ${d.status}`);
}
const after = await fetch(url, { headers: H });
const rem = ((await after.json()).value || []).filter((m) => String(m.subject || "").includes(MARKER));
console.log(`### REMAINING drafts matching marker after cleanup: ${rem.length}`);
