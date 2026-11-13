// WHAT:          Bun --preload stub for scripts/proposals-preview.test.ts: replaces fetch so the preview script runs
//                with no network. A GET of a feed file returns STUB_EMAIL / STUB_SENT / STUB_TEAMS; the OneDrive PUT
//                and sendMail return 201/202 and are counted in STUB_LOG (a file) so the test can see them.
// WHY:           Verifier loop 4 (8.3): a non-JSON feed file made the preview's uncaught JSON.parse print the first
//                characters of the content into a PUBLIC log. The test drives the real script end to end.
// SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/IMPL-task-proposals.md "Verifier loop-4 fix pass".
import { appendFileSync } from "node:fs";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = decodeURIComponent(String(input));
  const method = String(init?.method ?? "GET");
  if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, `${method} ${url.includes("sendMail") ? "sendMail" : url.includes("Huddle Preview") ? "preview-file" : "feed"}\n`);
  if (method === "PUT") return new Response("{}", { status: 201 });
  if (url.includes("sendMail")) return new Response("", { status: 202 });
  const body = url.includes("sent.json") ? process.env.STUB_SENT : /teams/i.test(url) ? process.env.STUB_TEAMS : process.env.STUB_EMAIL;
  return body === undefined ? new Response("", { status: 404 }) : new Response(body, { status: 200 });
}) as typeof fetch;
