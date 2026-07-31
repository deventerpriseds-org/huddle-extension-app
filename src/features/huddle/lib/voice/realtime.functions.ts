import { createServerFn } from "@tanstack/react-start";

export type RealtimeSessionResult =
  | { ok: true; clientSecret: string }
  | { ok: false; error: string };

// OpenAI Realtime GA model. The beta preview model + the /v1/realtime/sessions mint endpoint were
// retired — that endpoint now 404s ("Invalid URL (POST /v1/realtime/sessions)"), which is why the
// 1:1 voice mic never connected (confirmed live via the voice-1on1-diagnostic). GA mints the
// ephemeral client secret at /v1/realtime/client_secrets and the browser does the WebRTC SDP
// exchange at /v1/realtime/calls (see useCeremonyVoice). Keep REALTIME_MODEL in sync with the model
// the client sends on the SDP call.
export const REALTIME_MODEL = "gpt-realtime";

export const getRealtimeSession = createServerFn({ method: "POST" })
  .inputValidator((_raw: unknown) => ({}))
  .handler(async (): Promise<RealtimeSessionResult> => {
    const key = (process.env.OPENAI_API_KEY ?? "").trim();
    if (!key) return { ok: false, error: "OPENAI_API_KEY not configured" };
    try {
      // GA ephemeral-secret mint. Config is intentionally minimal here — the browser sends a full
      // `session.update` (transcription + server_vad, create_response:false) over the data channel
      // once the connection is open (see useCeremonyVoice.startListening).
      const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: REALTIME_MODEL,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `OpenAI client_secrets ${res.status}: ${body.slice(0, 200)}` };
      }
      // GA returns the ephemeral key as a top-level `value` (ek_… prefix). Fall back to the legacy
      // `client_secret.value` shape defensively in case of an intermediate API revision.
      const body = (await res.json()) as { value?: string; client_secret?: { value?: string } };
      const secret = body?.value ?? body?.client_secret?.value;
      if (!secret) return { ok: false, error: "OpenAI returned no ephemeral client secret" };
      return { ok: true, clientSecret: secret };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
