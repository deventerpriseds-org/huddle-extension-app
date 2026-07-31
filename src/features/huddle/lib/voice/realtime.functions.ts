import { createServerFn } from "@tanstack/react-start";

export type RealtimeSessionResult =
  | { ok: true; clientSecret: string }
  | { ok: false; error: string };

export const getRealtimeSession = createServerFn({ method: "POST" })
  .inputValidator((_raw: unknown) => ({}))
  .handler(async (): Promise<RealtimeSessionResult> => {
    const key = (process.env.OPENAI_API_KEY ?? "").trim();
    if (!key) return { ok: false, error: "OPENAI_API_KEY not configured" };
    try {
      const res = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-realtime-preview-2025-06-03",
          modalities: ["text"],
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            silence_duration_ms: 800,
            threshold: 0.5,
            create_response: false,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `OpenAI sessions ${res.status}: ${body.slice(0, 200)}` };
      }
      const body = (await res.json()) as { client_secret?: { value?: string } };
      const secret = body?.client_secret?.value;
      if (!secret) return { ok: false, error: "OpenAI returned no client_secret" };
      return { ok: true, clientSecret: secret };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
