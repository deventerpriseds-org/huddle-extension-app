// WHAT:       polishTextFn — the one server call behind the Polish tool. Takes a structured request
//             (polish a draft / revise / rewrite a selected span / merge hand edits) plus writing
//             settings, builds the prompt SERVER-side from polish-core, calls OpenAI Responses, and
//             returns the finished full text.
// WHY:        Polish needs a model call; the client never sends raw prompt text, so this cannot be
//             used as an open proxy to the model. Reuses Huddle's existing OPENAI_API_KEY and model
//             ladder (gpt-5.6-luna = Fast, gpt-5.6-terra = Best) — no new secret, no new provider.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/polish-core.test.ts (prompt + splice rules)

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  applyResult,
  buildPolishPrompt,
  normalizeSettings,
  type PolishRequest,
} from "./polish-core";

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();
const MAX = 40_000;

const Req = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("polish"), draft: z.string().min(1).max(MAX) }),
  z.object({
    mode: z.literal("revise"),
    text: z.string().min(1).max(MAX),
    instruction: z.string().min(1).max(500),
  }),
  z.object({
    mode: z.literal("span"),
    text: z.string().min(1).max(MAX),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    instruction: z.string().min(1).max(500),
  }),
  z.object({
    mode: z.literal("merge"),
    draft: z.string().min(1).max(MAX),
    edited: z.string().min(1).max(MAX),
  }),
]);

/** Fast / Best → a rung of the existing model ladder (lib/model-policy.ts LADDER). */
const ENGINE_MODEL = {
  fast: { model: "gpt-5.6-luna", effort: "low" },
  best: { model: "gpt-5.6-terra", effort: "medium" },
} as const;

export type PolishResult = { ok: true; text: string; model: string } | { ok: false; error: string };

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
    const req = data.request as PolishRequest;
    if (req.mode === "span" && !(req.start < req.end && req.end <= req.text.length)) {
      return { ok: false, error: "That selection no longer matches the text. Select it again." };
    }
    const key = process.env.OPENAI_API_KEY;
    if (!key)
      return { ok: false, error: "Polish isn't configured on the server yet (missing model key)." };

    const settings = normalizeSettings(data.settings);
    const { system, input } = buildPolishPrompt(data.profileName, settings, req);
    const { model, effort } = ENGINE_MODEL[settings.engine];

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 40_000); // stays under the ~45s hosting ceiling
    try {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, instructions: system, input, reasoning: { effort } }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("[polish] OpenAI", res.status, body.slice(0, 300));
        if (res.status === 429)
          return { ok: false, error: "The model is busy or out of quota. Try again in a minute." };
        return {
          ok: false,
          error: `The model returned an error (${res.status}). Your text is unchanged; try again.`,
        };
      }
      const json = (await res.json()) as {
        output_text?: string;
        output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
      };
      const text =
        json.output_text ??
        (json.output ?? [])
          .filter((o) => o.type === "message")
          .flatMap((o) => o.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join("");
      if (!text.trim())
        return { ok: false, error: "Nothing came back. Try again or simplify the instruction." };
      return { ok: true, text: applyResult(req, text), model };
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      return {
        ok: false,
        error: aborted
          ? "That took too long. Try Fast, or polish a shorter piece."
          : "Couldn't reach the model. Your text is unchanged; try again.",
      };
    } finally {
      clearTimeout(timer);
    }
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
