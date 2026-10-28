// WHAT:       The voice-gate LIFECYCLE defects V1-V5 from the loop-3 verifier, pinned as tests against their fixes:
//             V1 an executor THROW is a failure (ok:false, persisted unknown) on the server AND in the parser;
//             V2 typed entry resets the gate like a spoken turn (deferred while a write is pending);
//             V3 a hang-up mid-write cannot mute later calls (fresh gate per call; the result settles the gate
//                it was noted on, even after the hang-up);
//             V4 a new call after a delivered failure starts with a fresh gate (its greeting is spoken);
//             V5 the reply to a new user turn is never part of the previous write turn (reset at
//                input_audio_buffer.committed, keyed by item id so the late transcription is a no-op).
// WHY:        docs/VERIFY-nexus-write-tool-3.md V1-V5 (probe mut-verify-114-3/probe-voice.ts): V3 left every
//             later call on a MeetingBar mute until reload; V2/V4/V5 swallowed replies; V1 read a throw as a save.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/FIX-nexus-write-voice-gate.md (RESPONDS TO docs/VERIFY-nexus-write-tool-3.md V1-V5);
//             mutation anchors + verdicts in mut-voice-gate/.
//
// OFFLINE ONLY: `fetch` throws on any call. Nothing reaches a real Nexus, Huddle, DB or board.
// Run: bun scripts/nexus-write-voice-gate.test.ts

import { readFileSync } from "node:fs";
import {
  NEXUS_WRITE_TOOL_NAME as N,
  createNexusWriteSpeechGate,
  nexusWriteFailureMessage,
  nexusWriteResultsFrom,
  nexusWriteAnyUnpersisted,
  presentNexusWriteTurn,
} from "../src/features/huddle/lib/nexus/nexus-write-shared";

let pass = 0;
let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want);
  console.log(`  ${ok ? "ok" : "not ok"} ${name}: ${String(got)}${ok ? "" : `  (EXPECTED ${String(want)})`}`);
  ok ? pass++ : fail++;
};

const FAIL = JSON.stringify({ ok: true, persisted: false, results: [{ index: 0, title: "Research Proposal", action: "failed", persisted: false, error: "http_500" }] });
const OK = JSON.stringify({ ok: true, persisted: true, results: [{ index: 0, title: "Research Proposal", action: "inserted", persisted: true, due_local: "Fri, Oct 30, 2026, 11:59 PM EDT", course: { id: "c782", code: "MGT-782", name: null } }] });
const MSG = nexusWriteFailureMessage(nexusWriteResultsFrom([{ tool: N, ok: false, detail: FAIL }]));
const LEGACY_THROWN = JSON.stringify({ error: "TypeError: boom", tool: N }); // the pre-fix catch shape (verifier V1)

// A simulator that drives the gate EXACTLY as useVoiceCallRealtimeSpeak.ts does after this fix (the wiring is
// source-pinned by VG-H*):
//   connect() / hangUp()  -> a FRESH gate (connect + cleanup each install one)
//   call(name)            -> noteToolCall on the current gate; returns settle(output) bound to THAT gate
//                            (the hook's `writeGate`), callable after a hang-up
//   committed(id) / transcribed(id) -> gate.reset(id)   typed() -> gate.reset()
//   say(text)             -> the reply streams as deltas, then text.done (finalize)    responseDone -> flush
const sim = () => {
  let gate = createNexusWriteSpeechGate();
  const spoken: string[] = [];
  const persisted: string[] = [];
  let tail = "";
  const textDone = (raw: string) => {
    const out = gate.finalize(raw);
    if (out.mode === "whole") {
      tail = "";
      if (out.speak) spoken.push(out.speak);
    } else {
      if (out.speak) tail += `\n\n${out.speak}`;
      if (!gate.holding && tail.trim()) spoken.push(tail.trim());
      tail = "";
    }
    if (out.full) persisted.push(out.full);
  };
  return {
    spoken,
    persisted,
    get gate() {
      return gate;
    },
    connect: () => {
      gate = createNexusWriteSpeechGate();
    },
    hangUp: () => {
      gate = createNexusWriteSpeechGate();
    },
    call: (name: string) => {
      gate.noteToolCall(name);
      const g = gate;
      return (output: string) => g.noteToolOutput(name, output);
    },
    committed: (id: string) => gate.reset(id),
    transcribed: (id: string) => gate.reset(id),
    typed: () => gate.reset(),
    say: (text: string) => {
      tail += text;
      if (!gate.holding) {
        spoken.push(tail.trim());
        tail = "";
      }
      textDone(text);
    },
    responseDone: () => {
      const f = gate.flush();
      if (f) {
        tail = "";
        if (f.speak) spoken.push(f.speak);
        if (f.full) persisted.push(f.full);
      }
    },
  };
};
const last = (xs: string[]) => xs[xs.length - 1];

const hook = readFileSync("src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts", "utf8");
const block = (start: RegExp, len: number) => {
  const m = start.exec(hook);
  return m ? hook.slice(m.index, m.index + len) : "";
};

const main = async () => {
  console.log("=== V1: an executor THROW is a failure, never a save ===");
  {
    // Server: make executeNexusWriteTool throw for real (a getter on `items` that throws) and read the output.
    Object.assign(process.env, { NEXUS_API_URL: "https://nexus.test", NEXUS_OWNER_ID: "owner-1", UAT_BYPASS_TOKEN: "uat-secret-token" });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      throw new Error(`unexpected network call in offline test: ${String(input)}`);
    }) as typeof fetch;
    const { executeRealtimeTool } = await import("../src/features/huddle/lib/voice/realtime-tools.server");
    const args = {
      get items(): unknown {
        throw new Error("boom-getter");
      },
    } as Record<string, unknown>;
    const r = await executeRealtimeTool(N, args, { agentId: "elle-quinn" as never, caller: {}, huddleId: "dm-elle-quinn", timeZone: "UTC" });
    const o = JSON.parse(r.output) as Record<string, unknown>;
    t("VG-V1a server: a thrown write executor reports ok:false", o.ok, false);
    t("VG-V1b server: ...persisted:\"unknown\" (the POST may have landed) and the error", `${o.persisted}|${o.error}`, "unknown|boom-getter");
    const g = createNexusWriteSpeechGate();
    g.noteToolCall(N);
    g.noteToolOutput(N, r.output);
    const out = g.finalize("Done — your Research Proposal is in Nexus for Oct 30.");
    const UNKNOWN_MSG = nexusWriteFailureMessage(nexusWriteResultsFrom([{ tool: N, ok: false, detail: r.output }]));
    t("VG-V1c gate: that output takes the FAILURE path -- only the code-built status, spoken whole", `${out.mode}|${out.speak === UNKNOWN_MSG}|${out.full === UNKNOWN_MSG}`, "whole|true|true");
    t("VG-V1d ...and the status says UNKNOWN for the whole request, never 'Saved'", `${UNKNOWN_MSG.includes("Unknown — check Nexus: the whole write request")}|${/Saved in Nexus|• Saved:/.test(UNKNOWN_MSG)}`, "true|false");

    // Parser defence: the pre-fix `{error,tool}` shape (no ok, no results) is a request-level failure.
    const legacy = nexusWriteResultsFrom([{ tool: N, ok: true, detail: LEGACY_THROWN }]);
    t("VG-V1e parser: {error,tool} without ok:false is a request-level failure", `${legacy.length}|${legacy[0]?.request_level}|${legacy[0]?.persisted}|${nexusWriteAnyUnpersisted(legacy)}`, "1|true|false|true");
    const g2 = createNexusWriteSpeechGate();
    g2.noteToolCall(N);
    g2.noteToolOutput(N, LEGACY_THROWN);
    const out2 = g2.finalize("I couldn't save that, there was an error.");
    t("VG-V1f gate: legacy throw shape holds and speaks no 'Saved in Nexus:' header", `${out2.mode}|${/Saved in Nexus/.test(out2.full + out2.speak)}`, "whole|false");
    const text = presentNexusWriteTurn([{ agentId: "elle", text: "Done — it's in Nexus." }], [{ agentId: "elle", tool: N, ok: false, detail: LEGACY_THROWN }]);
    t("VG-V1g text presenter: the same detail replaces the model's 'Done' with the code-built status", text[0]?.text.startsWith("Nexus write status:") && !text[0]?.text.includes("Done"), true);
    // Not over-broad: a clean write and a per-item result carrying an `error` field still read from `results`.
    t("VG-V1h a clean write is still a clean write", nexusWriteAnyUnpersisted(nexusWriteResultsFrom([{ tool: N, ok: true, detail: OK }])), false);
    t("VG-V1i an empty error string is not a failure signal", nexusWriteResultsFrom([{ tool: N, ok: true, detail: JSON.stringify({ ok: true, error: "" }) }]).length, 0);
  }

  console.log("=== V2: TYPED entry resets the gate like a spoken turn ===");
  {
    let s = sim();
    s.call(N)(FAIL);
    s.say("Sorry, it failed.");
    t("VG-V2a exchange 1: only the code-built message", `${s.spoken.length}|${last(s.spoken) === MSG}`, "1|true");
    s.typed(); // user types "what's due this week?"
    s.say("You have the Case Brief due Monday.");
    t("VG-V2b the reply to the typed turn is spoken", last(s.spoken), "You have the Case Brief due Monday.");
    t("VG-V2c ...and captioned/persisted", last(s.persisted), "You have the Case Brief due Monday.");
    t("VG-V2d ...and the gate no longer holds", s.gate.holding, false);

    // Typed while the write is pending: the reset is DEFERRED -- nothing is released early.
    s = sim();
    const settle = s.call(N);
    s.typed();
    s.say("Done, it's in!");
    t("VG-V2e typed mid-write: nothing spoken/persisted while pending", `${s.spoken.length}|${s.persisted.length}`, "0|0");
    settle(FAIL);
    s.say("Saved it.");
    t("VG-V2f ...then ONLY the code-built message", `${s.spoken.length}|${last(s.spoken) === MSG}|${s.persisted.length}`, "1|true|1");
    s.say("Anything else?");
    t("VG-V2g ...and the deferred reset lands after the delivery (next reply is normal)", last(s.spoken), "Anything else?");

    const send = block(/const sendText = useCallback\(/, 1400);
    t("VG-H2 hook: sendText resets the gate BEFORE asking for a response", /nexusGateRef\.current\.reset\(\);[\s\S]{0,400}type: "response\.create"/.test(send), true);
  }

  console.log("=== V3: hang-up while a write is pending ===");
  {
    const s = sim();
    const settle = s.call(N);
    const old = s.gate;
    s.hangUp();
    t("VG-V3a after the hang-up the current gate holds nothing", s.gate.holding, false);
    settle(FAIL); // the result lands after the hang-up
    t("VG-V3b the late result settled the gate it was noted on (pending -> 0: flush can deliver)", old.flush()?.full === MSG, true);
    t("VG-V3c ...and did not touch the current gate", `${s.gate.holding}|${s.gate.uses.length}`, "false|0");
    s.connect();
    s.say("Hi Von, what can I help with?");
    t("VG-V3d next call: the greeting is spoken", last(s.spoken), "Hi Von, what can I help with?");
    t("VG-V3e ...and persisted", last(s.persisted), "Hi Von, what can I help with?");
    s.committed("item-u1");
    s.say("Your next class is Monday.");
    t("VG-V3f ...and later replies are spoken", last(s.spoken), "Your next class is Monday.");

    const cleanup = block(/const cleanup = useCallback\(\(\) => \{/, 700);
    t("VG-H3a hook: cleanup() installs a fresh gate", /nexusGateRef\.current = createNexusWriteSpeechGate\(\);/.test(cleanup), true);
    const fc = block(/case "response\.function_call_arguments\.done": \{/, 2600);
    t("VG-H3b hook: the write call captures its gate", /nexusGateRef\.current\.noteToolCall\(name\);\s*\n\s*const writeGate = nexusGateRef\.current;/.test(fc), true);
    const then = block(/\.then\(\(r\) => \{/, 700);
    const settleAt = then.indexOf("writeGate.noteToolOutput(name, r.ok ? output");
    const checkAt = then.indexOf('if (genRef.current !== gen || dc.readyState !== "open") return;');
    t("VG-H3c hook: the result settles the captured gate BEFORE the hang-up check returns", settleAt >= 0 && checkAt > settleAt, true);
    const caught = block(/\.catch\(\(err\) => \{/, 300);
    t("VG-H3d hook: a rejected tool call settles the captured gate too", /writeGate\.noteToolOutput\(name,/.test(caught), true);
    t("VG-H3e hook: no tool-result path settles nexusGateRef.current (a later call's gate)", /nexusGateRef\.current\.noteToolOutput/.test(hook), false);
  }

  console.log("=== V4: failed write delivered, hang-up WITHOUT speaking, new call ===");
  {
    const s = sim();
    s.call(N)(FAIL);
    s.say("whatever");
    t("VG-V4a the failure was delivered as the only words", `${s.spoken.length}|${last(s.spoken) === MSG}`, "1|true");
    s.hangUp();
    s.connect();
    s.say("Hi Von!");
    t("VG-V4b new call: the greeting is spoken", last(s.spoken), "Hi Von!");
    t("VG-V4c ...deltas stream (not holding)", s.gate.holding, false);
    const connect = block(/const connect = useCallback\(/, 1200);
    t("VG-H4 hook: connect() installs a fresh gate for the new call", /const gen = genRef\.current;\s*\n\s*nexusGateRef\.current = createNexusWriteSpeechGate\(\);/.test(connect), true);
  }

  console.log("=== V5: the reply to a new user turn is not part of the previous write turn ===");
  {
    // Transcription arrives AFTER the reply's text.done; committed arrived before it (server VAD order).
    let s = sim();
    s.call(N)(FAIL);
    s.say("x");
    s.committed("item-u1");
    s.say("Your next class is Monday.");
    t("VG-V5a the reply to the new utterance is spoken (reset at committed)", last(s.spoken), "Your next class is Monday.");
    s.transcribed("item-u1"); // late
    s.say("Anything else?");
    t("VG-V5b ...the late transcription changes nothing", last(s.spoken), "Anything else?");

    // The late transcription must NOT reset a LATER write's exchange (dedupe by item id).
    s = sim();
    s.call(N)(FAIL);
    s.say("x");
    s.committed("item-u1");
    s.call(N)(FAIL); // the new turn's write also fails
    s.say("y");
    const n = s.spoken.length;
    t("VG-V5c the second write's failure is delivered as the only words", last(s.spoken) === MSG, true);
    s.transcribed("item-u1"); // the FIRST turn's late transcription
    s.say("It is on your list for Oct 30.");
    t("VG-V5d ...a late transcription of the EARLIER turn cannot release a model sentence after it", `${s.spoken.length - n}|${s.persisted.includes("It is on your list for Oct 30.")}`, "0|false");

    // Invariant: a user turn committed WHILE the write is pending defers -- nothing early.
    s = sim();
    const settle = s.call(N);
    s.committed("item-u2");
    s.say("Done!");
    t("VG-V5e committed mid-write: nothing spoken/persisted while pending", `${s.spoken.length}|${s.persisted.length}`, "0|0");
    settle(FAIL);
    s.say("All set.");
    t("VG-V5f ...then ONLY the code-built message", `${s.spoken.length}|${last(s.spoken) === MSG}`, "1|true");
    // Same rule as L3-V9: the reset requested mid-write lands right after the delivery (u2's exchange is clean).
    t("VG-V5g ...the deferred reset landed once the message was delivered", `${s.gate.holding}|${s.gate.uses.length}`, "false|0");
    s.transcribed("item-u2");
    s.say("Your class is Monday.");
    t("VG-V5i ...and u2's late transcription is a no-op (the next reply streams normally)", `${s.spoken.length}|${last(s.spoken)}`, "2|Your class is Monday.");

    // A distinct, un-keyed reset (typed) is never deduped away.
    s = sim();
    s.call(N)(FAIL);
    s.say("x");
    s.typed();
    s.call(N)(FAIL);
    s.say("y");
    s.typed();
    s.say("Back to normal.");
    t("VG-V5h un-keyed (typed) resets are each honoured", last(s.spoken), "Back to normal.");

    const committed = block(/case "input_audio_buffer\.committed": \{/, 1200);
    t("VG-H5a hook: input_audio_buffer.committed resets the gate keyed by item_id", /nexusGateRef\.current\.reset\(typeof msg\.item_id === "string" \? msg\.item_id : undefined\);/.test(committed), true);
    const tr = block(/case "conversation\.item\.input_audio_transcription\.completed": \{/, 1400);
    t("VG-H5b hook: transcription.completed resets with the SAME key (so it is a no-op after committed)", /nexusGateRef\.current\.reset\(typeof msg\.item_id === "string" \? msg\.item_id : undefined\);/.test(tr), true);
  }
};

await main();
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
