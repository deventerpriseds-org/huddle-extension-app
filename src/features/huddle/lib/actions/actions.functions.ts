// WHAT:       Client-callable server functions behind the Actions view: the page read, the "What shows" settings
//             save, and Wrong? / Undo. Row buttons (Add as task / Edit / Done / Dismiss / triage) do NOT live here:
//             they call the EXISTING actOnProposalFn (proposals.functions.ts) with from:"actions".
// WHY:        Owner-approved Actions view (2026-11-16); AC-C-1 (no parallel action endpoint), AC-F-1/F-2.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-actions-view.md.
//
// Server modules are imported dynamically so pg / server-only deps never reach the client bundle.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { ActionsPage } from "./actions.server";

const Caller = z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional();
const PropId = z.string().regex(/^prop-[0-9a-f]{1,32}$/);

export const getActionsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }): Promise<ActionsPage> => {
    try {
      const { getActionsPage } = await import("./actions.server");
      return await getActionsPage(data.caller);
    } catch (e) {
      console.error("[actions] read failed", e instanceof Error ? e.name : "error");
      return { status: "error", error: "Couldn't load your actions." };
    }
  });

export const setActionsSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, settings: z.record(z.string(), z.unknown()) }).parse(raw))
  .handler(async ({ data }) => {
    try {
      const { saveActionsSettings } = await import("./actions.server");
      return await saveActionsSettings(data.caller, data.settings);
    } catch {
      return { ok: false, error: "Couldn't save that setting." };
    }
  });

export const correctActionFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        proposalId: PropId,
        reason: z.string().max(40).optional(),
        text: z.string().max(2000).optional(),
        itemKey: z.string().max(600).optional(),
        listSender: z.string().max(254).nullable().optional(),
        undo: z.boolean().optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    try {
      const { correctActionItem } = await import("./actions.server");
      return await correctActionItem(data.caller, data);
    } catch {
      return { ok: false, error: "Couldn't save that." };
    }
  });
