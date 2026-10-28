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
