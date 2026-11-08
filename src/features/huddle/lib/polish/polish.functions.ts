// WHAT:       polishTextFn — the in-app door onto the Polish engine (lib/polish/polish.server.ts
//             runPolish), plus the Send-sheet destinations. Takes a structured request (polish a draft /
//             revise / rewrite a selected span / merge hand edits) plus writing settings; the prompt is
//             built SERVER-side, so this is never an open proxy to the model.
// WHY:        Polish needs a model call. Reuses Huddle's existing OPENAI_API_KEY and model ladder
//             (gpt-5.6-luna = Fast, gpt-5.6-terra = Best) — no new secret, no new provider.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/polish-core.test.ts (prompt + splice rules)

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { type PolishRequest } from "./polish-core";
import { POLISH_MAX as MAX, PolishRequestSchema as Req } from "./polish-schema";
import type { PolishResult } from "./polish.server";

export type { PolishResult };

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();

export const polishTextFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        profileName: z.string().min(1).max(80),
        settings: z.unknown(),
        request: Req,
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<PolishResult> => {
    if (!data.caller?.entra_email) return { ok: false, error: "Sign in to use Polish." };
    const { runPolish } = await import("./polish.server");
    return runPolish(data.profileName, data.settings, data.request as PolishRequest);
  });

// ---------------------------------------------------------------- profiles (eds-tools phase 2)
// The user's own writing profiles live in the shared eds-tools service, so Nexus and any later app see
// the same set. Keyed by the signed-in Entra email (the same key the cross-app route's subject uses).
// The workspace blob keeps a copy and is the fallback when eds-tools can't be reached.

const ProfileIn = z
  .object({ id: z.string().min(1).max(80), name: z.string().min(1).max(80) })
  .passthrough();

export const polishProfilesFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }) => {
    const email = data.caller?.entra_email;
    if (!email) return { ok: false as const, error: "Sign in to load your profiles." };
    const { loadOwnPolishProfiles } = await import("./polish.server");
    const own = await loadOwnPolishProfiles(email);
    return { ok: true as const, ...own };
  });

export const savePolishProfilesFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        profiles: z.array(ProfileIn).max(30),
        lastProfileId: z.string().max(80),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const email = data.caller?.entra_email;
    if (!email) return { ok: false, error: "Sign in to save your profiles." };
    const { edsToolsProfiles } = await import("./polish.server");
    const saved = await edsToolsProfiles(email, {
      profiles: data.profiles as never,
      lastProfileId: data.lastProfileId,
    });
    return saved ? { ok: true } : { ok: false, error: "Couldn't reach the shared tools service." };
  });

// ---------------------------------------------------------------- send-to destinations
// Each reuses an EXISTING Huddle path: email drafts = graph-email.server `createGraphDraft` (the same
// call agents' create_email_draft uses, so the allowed-mailbox list HUDDLE_EMAIL_FROM governs it);
// Word = render.server `renderMarkdownToDocx` + artifacts.server `createArtifact` (lands in Files under
// "Polish") + `mirrorArtifactToOneDrive` (path-keyed, idempotent). No new secret, table or sender.

async function callerEmail(caller: { entra_object_id?: string; entra_email?: string } | undefined) {
  if (!caller?.entra_email) return null;
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller.entra_email;
}

export const polishDestinationsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(
    async ({ data }): Promise<{ mailboxes: string[]; graph: boolean; signedIn: boolean }> => {
      const email = await callerEmail(data.caller);
      const { emailFromOptions, graphEmailConfigured } =
        await import("../email/graph-email.server");
      if (!email) return { mailboxes: [], graph: false, signedIn: false };
      return { mailboxes: emailFromOptions(), graph: graphEmailConfigured(), signedIn: true };
    },
  );

export const polishEmailDraftFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        from: z.string().min(3).max(200),
        to: z.string().max(1000).optional(),
        subject: z.string().min(1).max(300),
        text: z.string().min(1).max(MAX),
      })
      .parse(raw),
  )
  .handler(
    async ({ data }): Promise<{ ok: boolean; webLink?: string; from?: string; error?: string }> => {
      const email = await callerEmail(data.caller);
      if (!email) return { ok: false, error: "Sign in to create a draft." };
      const { createGraphDraft, graphEmailConfigured } =
        await import("../email/graph-email.server");
      if (!graphEmailConfigured())
        return { ok: false, error: "Email isn't configured on the server yet." };
      const { polishedToHtml } = await import("./polish-core");
      const to = (data.to ?? "")
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
      const r = await createGraphDraft({
        from: data.from,
        to,
        subject: data.subject,
        body: polishedToHtml(data.text),
        html: true,
        callerEmail: email,
      });
      if (!r.ok) {
        const consent = /\b403\b/.test(r.error ?? "");
        return {
          ok: false,
          error: consent
            ? "Drafting in that mailbox isn't permitted yet (Mail.ReadWrite consent)."
            : (r.error ?? "Couldn't create the draft."),
        };
      }
      return { ok: true, webLink: r.webLink, from: r.from };
    },
  );

export const polishWordDocFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        name: z.string().min(1).max(120),
        text: z.string().min(1).max(MAX),
        onedrive: z.boolean().default(true),
      })
      .parse(raw),
  )
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      error?: string;
      artifactId?: string;
      onedriveUrl?: string | null;
      onedriveError?: string;
      needsConsent?: boolean;
      fileName?: string;
      docxBase64?: string;
    }> => {
      const email = await callerEmail(data.caller);
      if (!email) return { ok: false, error: "Sign in to save a document." };
      try {
        const { polishedToMarkdown, splitSubject } = await import("./polish-core");
        const { renderMarkdownToDocx, ensureExtension, MIME_BY_FORMAT } =
          await import("../artifacts/render.server");
        const { subject } = splitSubject(data.text);
        const { bytes } = await renderMarkdownToDocx(polishedToMarkdown(data.text), {
          title: subject || data.name,
        });
        const fileName = ensureExtension(data.name, "docx");
        const docxBase64 = Buffer.from(bytes).toString("base64");
        // Saving to Files (and OneDrive) is best-effort: the download still works if storage is down.
        let artifactId: string | undefined;
        let onedriveUrl: string | null | undefined;
        let onedriveError: string | undefined;
        let needsConsent: boolean | undefined;
        try {
          const { createArtifact, mirrorArtifactToOneDrive } =
            await import("../artifacts/artifacts.server");
          const created = await createArtifact({
            userEmail: email,
            folder: "Polish",
            name: fileName,
            mime: MIME_BY_FORMAT.docx,
            bytes,
            status: "approved", // your own finished copy, not an agent deliverable awaiting review
          });
          artifactId = created.id;
          if (data.onedrive) {
            const m = await mirrorArtifactToOneDrive(email, created.id);
            if (m.ok) onedriveUrl = m.onedrive_url ?? null;
            else {
              onedriveError = m.error;
              needsConsent = m.needsConsent;
            }
          }
        } catch (e) {
          onedriveError = e instanceof Error ? e.message : "Couldn't save to Files.";
        }
        return {
          ok: true,
          artifactId,
          onedriveUrl,
          onedriveError,
          needsConsent,
          fileName,
          docxBase64,
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "Couldn't make the Word document.",
        };
      }
    },
  );

// Google Drive goes through NEXUS, which already owns the owner's Google connection (drive.file
// scope, nexus-hub api/src/lib/google.ts). Same call shape as nexus-write.server `nexusWriteFetch`:
// X-UAT-Token + the server-held NEXUS_OWNER_ID — no new secret, no Google token held in Huddle.
// Contract: docs/polish/CONTRACT-polish-ecosystem.md §3.
export const polishGoogleDriveFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        name: z.string().min(1).max(120),
        text: z.string().min(1).max(MAX),
      })
      .parse(raw),
  )
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      webViewLink?: string;
      needsReconnect?: boolean;
      error?: string;
    }> => {
      const email = await callerEmail(data.caller);
      if (!email) return { ok: false, error: "Sign in to save to Google Drive." };
      const { nexusBase, nexusOwner } = await import("../nexus/nexus.server");
      const { uatToken } = await import("../nexus/nexus-write.server");
      const base = nexusBase();
      const owner = nexusOwner();
      const token = uatToken();
      if (!base || !owner || !token)
        return {
          ok: false,
          error: "Huddle isn't linked to Nexus yet, so Google Drive is unavailable.",
        };
      try {
        const { polishedToMarkdown, splitSubject } = await import("./polish-core");
        const { renderMarkdownToDocx, ensureExtension } =
          await import("../artifacts/render.server");
        const { subject } = splitSubject(data.text);
        const { bytes } = await renderMarkdownToDocx(polishedToMarkdown(data.text), {
          title: subject || data.name,
        });
        const url = new URL(`${base}/api/polish/gdrive`);
        url.searchParams.set("owner", owner);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 30_000);
        try {
          const res = await fetch(url.toString(), {
            method: "POST",
            signal: ctl.signal,
            headers: { "Content-Type": "application/json", "X-UAT-Token": token },
            body: JSON.stringify({
              fileName: ensureExtension(data.name, "docx"),
              docxBase64: Buffer.from(bytes).toString("base64"),
            }),
          });
          const j = (await res.json().catch(() => null)) as {
            ok?: boolean;
            webViewLink?: string;
            needsReconnect?: boolean;
            error?: string;
          } | null;
          if (res.ok && j?.ok) return { ok: true, webViewLink: j.webViewLink };
          if (j?.needsReconnect)
            return {
              ok: false,
              needsReconnect: true,
              error: "Reconnect Google in Nexus Settings to allow Drive.",
            };
          if (res.status === 404)
            return {
              ok: false,
              error: "Nexus doesn't have Google Drive saving yet (update pending).",
            };
          return { ok: false, error: j?.error ?? `Nexus couldn't save to Drive (${res.status}).` };
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        const aborted = (e as { name?: string })?.name === "AbortError";
        return {
          ok: false,
          error: aborted
            ? "Nexus took too long to answer. Try again."
            : "Couldn't reach Nexus. Try again or download the .docx.",
        };
      }
    },
  );
