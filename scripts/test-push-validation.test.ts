// WHAT:       Proves /api/public/test-push rejects a malformed `huddleId` with a 400 instead of crashing.
// WHY:        Verifier loop 1 (work deeplink-transcript), finding 1: `{"huddleId":123}` reached `.trim()`
//             outside the try and threw, returning an unhandled 500.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   .claude/evidence/VERIFY-deeplink-transcript-1.md (branch claude_verify-deeplink-transcript)
//
// Run:  bun scripts/test-push-validation.test.ts   (npm run test:test-push)
// Only rejected inputs are exercised: a valid one would call journey's send_push for real.

process.env.JOURNEY_PROXY_TOKEN = "s3cret";
const { Route } = await import("../src/routes/api/public/test-push");

let pass = 0,
  fail = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const POST = (Route as any).options.server.handlers.POST;
async function call(body: unknown) {
  const raw = JSON.stringify(body);
  const res: Response = await POST({
    request: new Request("http://localhost/api/public/test-push", {
      method: "POST",
      headers: {
        "x-webhook-secret": "s3cret",
        "content-type": "application/json",
        "content-length": String(raw.length),
      },
      body: raw,
    }),
  });
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

const bad: [string, unknown][] = [
  ["T-number huddleId rejected with 400", 123],
  ["T-object huddleId rejected with 400", { a: 1 }],
  ["T-bad-chars huddleId rejected with 400", "dm-x?y=1"],
  ["T-uppercase huddleId rejected with 400", "DM-IRIS"],
];
for (const [label, huddleId] of bad) {
  const r = await call({
    caller: { entra_email: "t@example.com" },
    channels: ["messages"],
    huddleId,
  });
  const ok = r.status === 400 && r.body.error === "invalid_huddle_id";
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label} — got ${r.status} ${JSON.stringify(r.body)}`);
  if (ok) pass++;
  else fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
