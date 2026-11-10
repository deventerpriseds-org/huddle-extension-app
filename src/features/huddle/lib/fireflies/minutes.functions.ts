import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// WHAT:       Server actions behind Settings -> Meeting minutes: read/save the minutes source (Fireflies
//             summary | Luna from transcript), recipients and update-email switch, and list recent
//             Fireflies meetings with their email + OneDrive results (the visible failure state).
// WHY:        Owner handoff 2026-11-10: "Add a clear, persistent Huddle control for the minutes source...
//             Keep recipients configurable. Do not hard-code addresses in client code." Only the minutes
//             owner (or someone whose linked addresses include it) may read or change these.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/fireflies-minutes.test.ts; .claude/actions.md ACT:fireflies-minutes.

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();

/** The minutes owner, if (and only if) the signed-in caller IS that owner (any of his linked addresses). */
async function authorisedOwner(caller: z.infer<typeof Caller>): Promise<string | null> {
  const { resolveTaskEmail } = await import("../journey/identity");
  const me = ((await resolveTaskEmail(caller)) ?? caller?.entra_email ?? "").toLowerCase();
  if (!me) return null;
  const { minutesOwner } = await import("./fireflies.server");
  const owner = minutesOwner();
  if (!owner) return null;
  if (me === owner) return owner;
  const { getSelfEmailRows } = await import("../identity/identity.server");
  const mine = (await getSelfEmailRows(me)).map((r) => r.email.toLowerCase());
  return mine.includes(owner) ? owner : null;
}

export const getMinutesSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }) => {
    try {
      const owner = await authorisedOwner(data.caller);
      if (!owner) return { ok: false as const, error: "Meeting minutes belong to another account." };
      const { loadMinutesSettings } = await import("./fireflies.server");
      const { listRecentMeetings } = await import("./minutes-store.server");
      const s = await loadMinutesSettings(owner);
      const { sendableTiers } = await import("./recipient-check.server");
      const recipientStatus = s.recipients?.length ? await sendableTiers(owner, s.recipients) : [];
      const meetings = (await listRecentMeetings(owner, 8)).map((m) => ({
        id: m.meeting_id,
        title: m.title,
        at: m.meeting_at,
        source: m.minutes_source,
        kind: m.summary_kind,
        email: m.email_status,
        emailError: m.email_error,
        emailedAt: m.email_sent_at,
        emailsSent: m.emails_sent,
        onedrive: m.onedrive_status,
        onedrivePath: m.onedrive_path,
        onedriveError: m.onedrive_error,
        deliveries: m.deliveries,
      }));
      return {
        ok: true as const,
        source: s.source,
        recipients: s.recipients ?? [],
        recipientsValid: !!s.recipients?.length,
        // Recipients the existing send gate would NOT auto-send to (the whole email would become a draft).
        draftRecipients: recipientStatus.filter((r) => !r.sends).map((r) => r.address),
        updateEmails: s.updateEmails,
        configured: {
          webhookSecret: !!(process.env.FIREFLIES_WEBHOOK_SECRET ?? "").trim(),
          apiKey: !!(process.env.FIREFLIES_API_KEY ?? "").trim(),
        },
        meetings,
      };
    } catch (err) {
      console.error("[minutes] settings read failed", err instanceof Error ? err.message : err);
      return { ok: false as const, error: "Couldn't load meeting-minutes settings." };
    }
  });

export const setMinutesSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        source: z.enum(["fireflies", "luna"]),
        recipients: z.array(z.string().max(254)).max(10),
        updateEmails: z.boolean(),
      })
      .parse(raw),
  )
  .handler(async ({ data }) => {
    try {
      const owner = await authorisedOwner(data.caller);
      if (!owner) return { ok: false, error: "Meeting minutes belong to another account." };
      const { parseRecipients } = await import("./minutes");
      const recipients = parseRecipients(data.recipients);
      if (!recipients) return { ok: false, error: "Add at least one valid email address." };
      const { setMinutesSettings } = await import("./minutes-store.server");
      await setMinutesSettings(owner, {
        minutes_source: data.source,
        recipients,
        update_emails: data.updateEmails,
      });
      return { ok: true };
    } catch (err) {
      console.error("[minutes] settings save failed", err instanceof Error ? err.message : err);
      return { ok: false, error: "Couldn't save that setting." };
    }
  });
