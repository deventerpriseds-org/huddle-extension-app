#!/usr/bin/env node
// WHAT:       calls the DEPLOYED uploadChatAttachmentFn (the composer paperclip's server half) with Test- files
//             of several sizes, prints each result, then deletes every artifact it created (deleteArtifactFn).
// WHY:        owner 2026-11-04: "the attachment button has also stopped working". The CCR sandbox cannot
//             reach *.azurestaticapps.net, so this runs on a GitHub runner (agent-serverfn-uat.yml, input
//             `script`) to tell "server upload path broken in prod" apart from "client/device side".
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/BUILD-attachment-fix.md
//
// Ids are path-derived (stable across builds; sendHuddleMessage/getTurnUpdates here equal fn-ids.json).
// Every upload is a `Test-` file and is removed at the end (standing cleanup rule). Writes nothing else.
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const CALLER = { entra_email: process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io" };
const FN = {
  uploadChatAttachmentFn: "2fc35685495586c9b90d3cbc335fc1c15bddcd77eda99d91569f1bbe31a98469",
  deleteArtifactFn: "db3e2540b2d8b35fdeef3e8dbfffad853fde9e8005df06c5b3dfb90f235086b2",
};
// Verified seroval constant indices (see CLAUDE.md "Seroval decoder gotcha").
const CONST = { 0: null, 1: undefined, 2: true, 3: false, 4: -0, 5: Infinity, 6: -Infinity, 7: NaN };
function dec(root) {
  const reg = new Map();
  function w(n) {
    if (n == null || typeof n !== "object") return n;
    switch (n.t) {
      case 0: case 1: return n.s;
      case 3: return typeof n.s === "string" ? BigInt(n.s) : n.s;
      case 2: return n.s in CONST ? CONST[n.s] : undefined;
      case 7: return reg.get(n.i);
      case 9: { const a = []; if (n.i != null) reg.set(n.i, a); for (const it of n.a ?? []) a.push(w(it)); return a; }
      case 10: case 11: { const o = {}; if (n.i != null) reg.set(n.i, o); const k = n.p?.k ?? [], v = n.p?.v ?? []; for (let j = 0; j < k.length; j++) o[k[j]] = w(v[j]); return o; }
      default: return n.s ?? null;
    }
  }
  return w(root);
}
async function call(id, payload) {
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins: defaultSerovalPlugins }));
  const t0 = Date.now();
  const r = await fetch(`${BASE}/_serverFn/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await r.text();
  const ms = Date.now() - t0;
  try { return { http: r.status, ms, bodyBytes: body.length, res: dec(JSON.parse(txt))?.result }; }
  catch { return { http: r.status, ms, bodyBytes: body.length, raw: txt.slice(0, 300) }; }
}

// A minimal JPEG header + filler, so the mime is honest-looking without needing a real image.
function jpegish(bytes) {
  const b = Buffer.alloc(bytes, 0x5a);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[bytes - 2] = 0xff; b[bytes - 1] = 0xd9;
  return b;
}
const CASES = [
  { name: "Test-attach-probe.txt", mime: "text/plain", bytes: Buffer.from("Test attachment probe body\n") },
  { name: "Test-attach-probe-500k.jpg", mime: "image/jpeg", bytes: jpegish(520_000) },
  { name: "Test-attach-probe-3m.jpg", mime: "image/jpeg", bytes: jpegish(3_000_000) },
  { name: "Test-attach-probe-7m.jpg", mime: "image/jpeg", bytes: jpegish(7_000_000) },
];

const created = [];
let failures = 0;
for (const c of CASES) {
  let out;
  try {
    out = await call(FN.uploadChatAttachmentFn, {
      caller: CALLER,
      name: c.name,
      mime: c.mime,
      dataBase64: c.bytes.toString("base64"),
    });
  } catch (e) {
    out = { thrown: String(e) };
  }
  const ok = out?.res?.ok === true && !!out?.res?.id;
  if (ok) created.push(out.res.id); else failures++;
  console.log(`UPLOAD ${ok ? "OK  " : "FAIL"} ${c.name} (${c.bytes.length} B) -> ${JSON.stringify(out).slice(0, 400)}`);
}
for (const id of created) {
  const r = await call(FN.deleteArtifactFn, { caller: CALLER, id });
  console.log(`CLEANUP ${id} -> ${JSON.stringify(r?.res ?? r).slice(0, 200)}`);
}
console.log(`SUMMARY uploads_ok=${CASES.length - failures}/${CASES.length} cleaned=${created.length}`);
process.exit(failures ? 1 : 0);
