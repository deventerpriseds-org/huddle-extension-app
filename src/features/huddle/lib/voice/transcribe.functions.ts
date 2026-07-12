import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Server-side speech-to-text for the composer Dictate button. The client records mic audio
// (MediaRecorder), base64-encodes it, and posts it here; we forward to OpenAI Whisper and return
// the transcript. Reuses the existing OPENAI_API_KEY — no new credential.

const Input = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().optional(),
});

function extFor(mime: string): string {
  if (mime.includes("mp4") || mime.includes("m4a")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "webm";
}

export const transcribeAudio = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => Input.parse(raw))
  .handler(async ({ data }): Promise<{ ok: boolean; text: string; error: string }> => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { ok: false, text: "", error: "transcription not configured" };
    try {
      // base64 → bytes (atob/Uint8Array is portable across Node and Workers runtimes).
      const bin = atob(data.audioBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const mime = data.mimeType || "audio/webm";
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mime }), `audio.${extFor(mime)}`);
      form.append("model", "gpt-4o-mini-transcribe");

      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (!res.ok) {
        const t = await res.text();
        return { ok: false, text: "", error: `transcription failed (${res.status}): ${t.slice(0, 160)}` };
      }
      const j = (await res.json()) as { text?: string };
      return { ok: true, text: (j.text ?? "").trim(), error: "" };
    } catch (err) {
      return { ok: false, text: "", error: err instanceof Error ? err.message : String(err) };
    }
  });
