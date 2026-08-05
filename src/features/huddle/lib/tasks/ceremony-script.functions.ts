// Client-callable RPC for the "current-optimized" ceremony engine (ACT-huddle-18). Kept in its own
// isomorphic file (like huddle.functions.ts) so MeetingBar can import it without pulling server-only
// code — the actual logic lives in ceremony-script.server.ts, dynamically imported inside the handler.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AgentId } from "../../data/agents";
import type { CeremonyType } from "./ceremonies";
import type { CeremonyScriptResult } from "./ceremony-script.server";

const CeremonyScriptInput = z.object({
  ceremonyType: z.enum(["standup", "retro", "planning", "review"]),
  members: z.array(z.string()),
  caller: z
    .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
    .optional(),
  // Accepted for parity with the round-robin payload; not currently used server-side.
  timeZone: z.string().optional(),
});

/**
 * Return the ready-to-speak script for the optimized ceremony engine. ok:true → speak `slots` in order
 * straight to TTS (no server round-robin). ok:false → the client falls back to the current round-robin.
 */
export const getCeremonyScript = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => CeremonyScriptInput.parse(raw))
  .handler(async ({ data }): Promise<CeremonyScriptResult> => {
    try {
      const { resolveCeremonyScript } = await import("./ceremony-script.server");
      return await resolveCeremonyScript(
        data.caller,
        data.ceremonyType as CeremonyType,
        data.members as AgentId[],
      );
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
