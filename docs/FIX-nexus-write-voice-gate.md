# FIX — Nexus write voice-gate lifecycle (PR #114)

<!--
WHAT:          Fixes for the voice-gate lifecycle defects V1-V5 the loop-3 verifier found, with the tests and
               mutation verdicts that prove each fix.
WHY:           docs/VERIFY-nexus-write-tool-3.md (probe: mut-verify-114-3/probe-voice.ts): a hang-up mid-write
               muted every later call until reload (V3); typed entry never reset the gate (V2); a new call or a
               late transcription swallowed the first reply after a failed write (V4/V5); an executor THROW was
               read as a successful write (V1, latent).
RESPONDS TO:   docs/VERIFY-nexus-write-tool-3.md V1-V5.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      scripts/nexus-write-voice-gate.test.ts (offline); scripts/run-nexus-fix-suites.sh;
               mut-voice-gate/ (mutation anchors + verdicts).
-->

Scope: `src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts`, the gate in
`src/features/huddle/lib/nexus/nexus-write-shared.ts`, and the catch in
`src/features/huddle/lib/voice/realtime-tools.server.ts`. No routing file is touched. Offline only.

Invariants kept: nothing is spoken, captioned or persisted while a write is pending; a failure speaks only the
code-built status text.

## Log (written as the work went)

- Baseline before any edit: all 10 suites in `scripts/run-nexus-fix-suites.sh` green (39/12/115/39/190/92/36/51/185/315),
  `npx tsc --noEmit -p .` clean.
- Commit `02944b8`: V1 server catch. Commit `e95ba75`: V1 parser + V2-V5 gate/hook + tests (the shared file holds both
  the V1 parser hunk and the V5 keyed reset, so they landed together). Commit (mut-voice-gate): anchors m1-m13.

## Per defect

| # | Verifier finding | Fix | Status (offline) | Tests |
|---|---|---|---|---|
| V1 | executor THROW -> `{error,tool}` (no `ok:false`) read as a clean write: raw text streamed + empty "Saved in Nexus:" | `realtime-tools.server.ts` catch returns `ok:false` for every tool, and for `write_nexus_assignments` also `persisted:"unknown"` (the throw may follow the POST). Defence in depth in `nexusWriteResultsFrom`: a write output with no `results` and a non-empty `error` is a request-level failure; `persisted:"unknown"` is kept (status line says "Unknown — check Nexus: the whole write request"). | implemented; mechanism verified offline (a real throw via a throwing `items` getter) | VG-V1a..i |
| V2 | typed entry (`sendText`) never reset the gate -> rest of a typed session silent + unpersisted | `sendText` calls `nexusGateRef.current.reset()` before `response.create`; same deferred rule (held while a write is pending/undelivered) | implemented; verified offline | VG-V2a..g, VG-H2 |
| V3 | hang-up mid-write: `.then` returned before `noteToolOutput`; gate one `useRef` never recreated -> every later call mute until reload | `cleanup()` and `connect()` each install a fresh gate; the write call captures `writeGate`, and the result/rejection settles THAT gate **before** the hang-up check returns | implemented; verified offline (sim + source pins) | VG-V3a..f, VG-H3a..e |
| V4 | failed write delivered, hang-up, new call -> greeting swallowed | fresh gate on `connect()` (and on `cleanup()`) | implemented; verified offline | VG-V4a..c, VG-H4 |
| V5 | `transcription.completed` arriving after the new reply's `text.done` -> that reply swallowed | reset at `input_audio_buffer.committed` (the server creates the reply only after it), keyed by `item_id`; `transcription.completed` resets with the same key, so the late one is a no-op and can never reset a LATER write's exchange | implemented; verified offline | VG-V5a..i, VG-H5a/b |

Invariants re-proved in the new suite: a user turn (typed or committed) during a pending write releases nothing
(VG-V2e/f, VG-V5e/f); a failure still speaks only the code-built status (VG-V1c, V2a, V4a, V5c).

Existing pin moved (same intent, new call site): `nexus-write-fix.test.ts` FX-V8 now pins
`writeGate.noteToolOutput(name, r.ok ? output` after `const writeGate = nexusGateRef.current;` (was
`nexusGateRef.current.noteToolOutput(...)`, which is exactly the V3 defect). L2-V11 (noteToolCall before
runRealtimeTool) is unchanged and still passes.

## Results

Suites (`bash scripts/run-nexus-fix-suites.sh`, new suite added to it):
nexus-write-redteam 39/0, router-redteam 12/0, nexus-write-tool 115/0, router-winners 39/0, nexus-read-tools 190/0,
cross-app-turn-gate 92/0, voice-toolset-hidden 36/0, nexus-write-fix 51/0, nexus-write-loop2 185/0,
nexus-write-loop3 315/0, **nexus-write-voice-gate 43/0**. Also re-run (they read `realtime-tools.server.ts`):
focus 25/0, email-self-send 73/0, artifact-format-dispatch 48/0. `npx tsc --noEmit -p .`: exit 0, no output.

Mutations (`bash mut-voice-gate/run-mutations.sh`, verbatim in `mut-voice-gate/verdicts.out`): **13/13 FIRED**, every
one `restored: … matches HEAD` and `tree clean`.

| id | defect reinstated | guard | verdict |
|---|---|---|---|
| m1 | cleanup() keeps the old gate | VG-H3a | FIRED |
| m2 | connect() keeps the old gate | VG-H4 | FIRED |
| m3 | hang-up check returns before settling | VG-H3c | FIRED |
| m4 | result settles `nexusGateRef.current` (a later call's gate) | VG-H3e | FIRED |
| m5 | sendText does not reset | VG-H2 | FIRED |
| m6 | committed does not reset | VG-H5a | FIRED |
| m7 | transcription resets un-keyed | VG-H5b | FIRED |
| m8 | gate does not dedupe a user turn's second signal | VG-V5d | FIRED |
| m9 | server catch back to `{error,tool}` | VG-V1a | FIRED |
| m10 | parser counts only `ok:false` | VG-V1e | FIRED |
| m11 | parser downgrades `unknown` to `false` | VG-V1d | FIRED |
| m12 | parser treats an empty error string as failure | VG-V1i | FIRED |
| m13 | keyless (typed) resets deduped against each other | VG-V5h | FIRED |

The verifier's probe re-run on the fixed code (`mut-voice-gate/probe-voice.after.out`): V1 now takes the failure path on
voice and text. Its V2-V5 sections are unchanged BY CONSTRUCTION: the probe drives one gate the way the OLD hook did (no
typed reset, no fresh gate per call, unkeyed reset after text.done), so it cannot see hook-level fixes; VG-V2..V5 drive
the gate the way the fixed hook does, and VG-H* pin that wiring in the hook source.

## Residuals (honest limits)

- **Hook wiring is proved by source pins + a simulator, not by running the React hook.** The pins are mutation-proved
  (m1-m7), but a live WebRTC call has not been exercised. Status: implemented, mechanism verified offline, NOT
  confirmed live.
- **`input_audio_buffer.committed` carrying `item_id`** is per the OpenAI Realtime event reference, not observed
  offline. If a live event lacks it, both signals reset un-keyed: V5 is still fixed (committed precedes the reply), but
  a late transcription could then clear a LATER write exchange right after its failure was delivered (VG-V5d's case).
- **Echo:** the transcription path drops self-echo before resetting; the committed path cannot see the transcript, so
  audio the server commits (echo included) now counts as a new user turn for the gate -- the same way the server treats
  it (it answers it). The echo filter still keeps echo out of captions/persistence. Reset is still deferred while a
  write is pending/undelivered, so echo can never release anything early.
- `huddle.functions.ts:6238` (text path) still emits `{error,tool}` for a throwing MEMORY tool; it is not a Nexus write,
  and the parser defence (V1) covers that shape for the write tool on both surfaces anyway. Not touched (out of scope).
