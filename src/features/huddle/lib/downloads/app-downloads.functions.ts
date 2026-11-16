// WHAT:       Server fn behind Huddle's Settings "Download" tab: asks bridge-builder for the newest Huddle and
//             TaskOS builds with fresh links. JOURNEY_PROXY_TOKEN stays on the server.
// WHY / EVIDENCE: see ./app-downloads.ts. SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { DEFAULT_BRIDGE_BUILDER_API_URL, DOWNLOAD_APPS, shapeDownloads, type DownloadRow } from "./app-downloads";

const Caller = z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional();

type Result = { ok: true; apps: DownloadRow[] } | { ok: false; reason: string };

export const getAppDownloadsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }): Promise<Result> => {
    if (!data.caller?.entra_email) return { ok: false, reason: "sign_in_required" };
    const token = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();
    if (!token) return { ok: false, reason: "not_configured" };
    const base = (process.env.BRIDGE_BUILDER_API_URL || DEFAULT_BRIDGE_BUILDER_API_URL).replace(/\/+$/, "");
    const ids = DOWNLOAD_APPS.map((a) => a.appId).join(",");
    try {
      const r = await fetch(`${base}/api/getLatestApk?appId=${ids}`, {
        headers: { "x-journey-proxy-token": token },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return { ok: false, reason: `bridge_${r.status}` };
      const body = (await r.json()) as { apps?: unknown };
      return { ok: true, apps: shapeDownloads(body?.apps) };
    } catch {
      return { ok: false, reason: "bridge_unreachable" };
    }
  });
