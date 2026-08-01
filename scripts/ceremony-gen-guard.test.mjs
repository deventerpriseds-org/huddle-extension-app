// Offline proof of the ceremony-voice generation-guard invariant (A1 mic-deaf fix).
//
// The bug: the WebRTC `dc.onmessage` handler in useCeremonyVoice.ts guarded on the PLAYBACK
// generation counter (`genRef`), which a barge bumps (bargeFreeze/speakInterjection) to kill the
// live speaker loop. After the first barge, `genRef.current !== gen` was permanently true, so the
// handler dropped EVERY subsequent Realtime event (speech_started, transcription) — the mic went
// deaf after one barge.
//
// The fix: a separate CONNECTION-lifetime counter (`connGenRef`) that a barge never touches. The
// handler guards on connGen; only start/stop of the listen session changes it.
//
// This models the two counters exactly as the hook uses them and asserts the invariant that was
// violated. Run: `node scripts/ceremony-gen-guard.test.mjs` (or `bun`).

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// ── Model of the two-counter connection guard ────────────────────────────────
function makeVoiceState() {
  return { genRef: 0, connGenRef: 0 };
}
// startListening captures the connection generation.
function startListening(s) {
  s.connGenRef += 1;
  return { connGen: s.connGenRef };
}
// A barge bumps ONLY the playback gen (bargeFreeze / speakInterjection).
function barge(s) {
  s.genRef += 1;
}
// stopListening bumps BOTH — kills playback AND invalidates the connection.
function stopListening(s) {
  s.genRef += 1;
  s.connGenRef += 1;
}
// The message handler processes an event iff its captured connGen still matches.
function handlerAlive(s, conn) {
  return s.connGenRef === conn.connGen;
}

// ── OLD (buggy) model: handler guarded on genRef ─────────────────────────────
// Reproduce the original failure to prove the test actually distinguishes the fix.
function oldHandlerAlive(s, capturedGen) {
  return s.genRef === capturedGen;
}

console.log("A1 generation-guard invariant");

// 1. Old behavior: mic goes deaf after the first barge.
{
  const s = makeVoiceState();
  s.genRef += 1;
  const capturedGen = s.genRef; // old startListening captured genRef
  assert(oldHandlerAlive(s, capturedGen), "OLD: handler alive before any barge");
  barge(s);
  assert(!oldHandlerAlive(s, capturedGen), "OLD: handler DEAD after 1 barge (reproduces the bug)");
}

// 2. New behavior: handler survives arbitrarily many barges.
{
  const s = makeVoiceState();
  const conn = startListening(s);
  assert(handlerAlive(s, conn), "NEW: handler alive right after connect");
  for (let i = 1; i <= 5; i++) {
    barge(s);
    assert(handlerAlive(s, conn), `NEW: handler still alive after barge #${i} (mic NOT deaf)`);
  }
}

// 3. New behavior: a barge answer (speakInterjection) also bumps genRef — still no effect on conn.
{
  const s = makeVoiceState();
  const conn = startListening(s);
  barge(s); // bargeFreeze
  s.genRef += 1; // speakInterjection bumps genRef again to voice the answer
  assert(handlerAlive(s, conn), "NEW: handler alive through freeze+interjection cycle");
}

// 4. New behavior: stopListening DOES invalidate the handler (intended teardown).
{
  const s = makeVoiceState();
  const conn = startListening(s);
  barge(s);
  assert(handlerAlive(s, conn), "NEW: alive after barge (pre-stop)");
  stopListening(s);
  assert(!handlerAlive(s, conn), "NEW: handler dead after stopListening (correct teardown)");
}

// 5. New behavior: a re-connect (start after stop) supersedes an older connection's handler.
{
  const s = makeVoiceState();
  const conn1 = startListening(s);
  stopListening(s);
  const conn2 = startListening(s);
  assert(!handlerAlive(s, conn1), "NEW: old connection's handler stays dead after re-connect");
  assert(handlerAlive(s, conn2), "NEW: new connection's handler is live");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
