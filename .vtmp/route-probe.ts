// Calls the real POST handler of src/routes/api/public/polish.ts with crafted inputs.
process.env.JOURNEY_PROXY_TOKEN = "s3cret";
process.env.CROSS_APP_TURN_SUBJECT = "subject@example.com";
delete process.env.OPENAI_API_KEY;
let bodyRead = 0;
const { Route } = await import("../src/routes/api/public/polish.ts");
const POST = (Route as any).options.server.handlers.POST;
function req(body: string | null, headers: Record<string, string> = {}) {
  const r = new Request("https://h/api/public/polish", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  const origJson = r.json.bind(r);
  (r as any).json = () => {
    bodyRead++;
    return origJson();
  };
  return r;
}
async function run(name: string, r: Request) {
  const before = bodyRead;
  let res: Response;
  try {
    res = await POST({ request: r });
  } catch (e) {
    console.log(`${name}: THREW ${e}`);
    return;
  }
  const t = await res.text();
  console.log(`${name}: ${res.status} bodyRead=${bodyRead - before} ${t.slice(0, 160)}`);
}
const ok = { "x-webhook-secret": "s3cret" };
await run("C1 no secret", req('{"action":"profiles"}'));
await run("C1 wrong secret", req('{"action":"profiles"}', { "x-webhook-secret": "nope" }));
await run("C1 secret trailing space", req('{"action":"profiles"}', { "x-webhook-secret": "s3cret " }));
await run("C1 right secret", req('{"action":"profiles"}', ok));
await run("C2 top caller", req('{"action":"profiles","caller":{"entra_email":"a@b"}}', ok));
await run(
  "C2 nested Entra-Email",
  req('{"action":"polish","request":{"mode":"polish","draft":"hi","X":{"Entra-Email":"a@b"}}}', ok),
);
await run(
  "C2 in settings USER",
  req('{"action":"polish","settings":{"USER":"a@b"},"request":{"mode":"polish","draft":"hi"}}', ok),
);
const deep = '{"action":"profiles","a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":{"email":"a@b"}}}}}}}}}}';
await run("C2 depth-9 email", req(deep, ok));
const wide = JSON.stringify({ action: "profiles", pad: Array.from({ length: 5001 }, () => ({})), z: { email: "a@b" } });
await run("C2 node-cap email", req(wide, ok));
await run("C4 content-length 64001", req('{"action":"profiles"}', { ...ok, "content-length": "64001" }));
const big = JSON.stringify({
  action: "polish",
  request: { mode: "polish", draft: "x".repeat(39_000) },
  settings: { rules: "y".repeat(40_000) },
});
await run(`C4 ${big.length}B body, no CL header`, req(big, ok));
await run("C4 malformed json", req('{"action":', ok));
await run("C4 array", req("[1]", ok));
await run("C4 null", req("null", ok));
await run("C4 unknown action send_email", req('{"action":"send_email"}', ok));
await run(
  "C4 span start>end",
  req('{"action":"polish","request":{"mode":"span","text":"abc","start":2,"end":1,"instruction":"x"}}', ok),
);
await run(
  "C4 settings string",
  req('{"action":"polish","settings":"weird","request":{"mode":"polish","draft":"hi"}}', ok),
);
await run(
  "C4 settings junk",
  req(
    '{"action":"polish","settings":{"engine":"zzz","tones":"x","formality":"NaN","rules":7},"request":{"mode":"polish","draft":"hi"}}',
    ok,
  ),
);
await run(
  "C9 profileId 90 chars",
  req(JSON.stringify({ action: "polish", profileId: "p".repeat(90), request: { mode: "polish", draft: "hi" } }), ok),
);
await run(
  "C9 draft 45000 chars",
  req(JSON.stringify({ action: "polish", request: { mode: "polish", draft: "d".repeat(45_000) } }), ok),
);
await run(
  "C9 instruction 600 chars",
  req(JSON.stringify({ action: "polish", request: { mode: "revise", text: "t", instruction: "i".repeat(600) } }), ok),
);
await run(
  "C9 merge empty draft",
  req(JSON.stringify({ action: "polish", request: { mode: "merge", draft: "", edited: "e" } }), ok),
);
await run("C4 model missing key", req('{"action":"polish","request":{"mode":"polish","draft":"hi"}}', ok));
process.env.OPENAI_API_KEY = "sk-x";
const realFetch = globalThis.fetch;
const seen: string[] = [];
globalThis.fetch = (async (u: any) => {
  seen.push(String(u));
  return new Response("boom", { status: 500 });
}) as any;
await run("C4 model 500", req('{"action":"polish","request":{"mode":"polish","draft":"hi"}}', ok));
globalThis.fetch = (async () => {
  throw new TypeError("net");
}) as any;
await run("C4 model network", req('{"action":"polish","request":{"mode":"polish","draft":"hi"}}', ok));
globalThis.fetch = (async (u: any, init: any) => {
  seen.push(String(u));
  return new Response(JSON.stringify({ output_text: "Polished." }), { status: 200 });
}) as any;
await run("C3 happy path", req('{"action":"polish","request":{"mode":"polish","draft":"hi"}}', ok));
globalThis.fetch = realFetch;
console.log("outbound URLs seen:", [...new Set(seen)].join(", "));
