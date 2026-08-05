import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type {
  CeremonyRunSummary,
  CeremonyToolEvent,
  CeremonyTranscriptRow,
} from "./ceremony-transcript.server";

// Client-callable server functions for persisting + reading interactive ceremony transcripts. Every
// call resolves the signed-in user's canonical email (the SAME resolution the task board / artifacts
// use — resolveTaskEmail) and scopes reads/writes to it, so one user can never read another's run.
// The server-only pg module is imported dynamically so it never bundles into the client.

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();

async function callerEmail(
  caller: { entra_object_id?: string; entra_email?: string } | undefined,
): Promise<string | null> {
  if (!caller?.entra_email) return null;
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller.entra_email;
}

const TurnInput = z.object({
  seq: z.number().int(),
  speaker: z.enum(["user", "agent", "system"]),
  agentId: z.string().nullish(),
  text: z.string(),
  kind: z.string().nullish(),
  interrupted: z.boolean().nullish(),
  blockId: z.string().nullish(),
  sentenceIndex: z.number().int().nullish(),
  blockTotal: z.number().int().nullish(),
  ts: z.number().nullish(),
});

// Persist a batch of ceremony turns. Fire-and-forget safe: returns {ok:false} instead of throwing so
// a DB failure can never stall or break the live ceremony on the client.
export const saveCeremonyTranscript = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        runId: z.string().min(1),
        huddleId: z.string().min(1),
        turns: z.array(TurnInput).max(500),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; inserted: number }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { ok: false, inserted: 0 };
    try {
      const { appendCeremonyTurns } = await import("./ceremony-transcript.server");
      return await appendCeremonyTurns(email, data.runId, data.huddleId, data.turns);
    } catch {
      return { ok: false, inserted: 0 };
    }
  });

// Ordered transcript for one run, scoped to the caller — wrong owner returns [].
export const getCeremonyTranscript = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, runId: z.string().min(1) }).parse(raw),
  )
  .handler(async ({ data }): Promise<{ rows: CeremonyTranscriptRow[] }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { rows: [] };
    try {
      const { getCeremonyRun } = await import("./ceremony-transcript.server");
      return { rows: await getCeremonyRun(email, data.runId) };
    } catch {
      return { rows: [] };
    }
  });

// E (F13) — poll the REAL tool lifecycle for a live barge/ceremony run. The client narration driver
// calls this concurrently while a barge answer is in flight and voices ONE honest cue per tool START
// (in that tool's agent voice). `sinceId` is a `> id` cursor so each poll returns only new events;
// wrong owner returns []. Lean by design — safe to poll every ~700ms during the brief barge window.
export const getCeremonyToolEvents = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({ caller: Caller, runId: z.string().min(1), sinceId: z.string().optional() })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ events: CeremonyToolEvent[] }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { events: [] };
    try {
      const { getCeremonyToolEvents: read } = await import("./ceremony-transcript.server");
      return { events: await read(email, data.runId, data.sinceId ?? "0") };
    } catch {
      return { events: [] };
    }
  });

// Distinct runs for the caller, newest first.
export const listCeremonyRunsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, limit: z.number().int().min(1).max(100).optional() }).parse(raw),
  )
  .handler(async ({ data }): Promise<{ runs: CeremonyRunSummary[] }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { runs: [] };
    try {
      const { listCeremonyRuns } = await import("./ceremony-transcript.server");
      return { runs: await listCeremonyRuns(email, data.limit ?? 20) };
    } catch {
      return { runs: [] };
    }
  });
