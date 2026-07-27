import { useCallback, useRef, useState } from "react";
import { transcribeAudio } from "../lib/voice/transcribe.functions";

// Push-to-talk dictation for the composer: record mic audio, show a live level meter, then send
// the clip to the Whisper server fn and return the transcript. The caller injects it into the input.

export interface DictationController {
  recording: boolean;
  transcribing: boolean;
  level: number; // 0..1, for the recording meter
  error: string | null;
  supported: boolean;
  start: () => Promise<string | null>; // resolves to an error message on failure, null on success
  stop: () => Promise<string>; // resolves to the transcript ("" on failure/empty)
  cancel: () => void;
}

export function useDictation(): DictationController {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  const supported =
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setLevel(0);
  }, []);

  const start = useCallback(async (): Promise<string | null> => {
    setError(null);
    if (!supported) {
      const msg = "Dictation isn't supported on this device.";
      setError(msg);
      return msg;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);

      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      return null;
    } catch (err) {
      // Most commonly a denied mic permission — surface it so a tap that "does nothing" explains itself.
      const msg =
        err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")
          ? "Microphone blocked. Allow mic access for this site, then tap again."
          : err instanceof Error
            ? err.message
            : "Microphone unavailable";
      setError(msg);
      cleanup();
      return msg;
    }
  }, [supported, cleanup]);

  const stop = useCallback(async (): Promise<string> => {
    const rec = recorderRef.current;
    if (!rec) return "";
    const mime = rec.mimeType || "audio/webm";
    const done = new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: mime }));
    });
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
    setRecording(false);
    cleanup();
    const blob = await done;
    recorderRef.current = null;
    if (!blob.size) return "";
    setTranscribing(true);
    try {
      const b64 = await blobToBase64(blob);
      const res = await transcribeAudio({ data: { audioBase64: b64, mimeType: mime } });
      if (!res.ok) {
        setError(res.error);
        return "";
      }
      return res.text;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed");
      return "";
    } finally {
      setTranscribing(false);
    }
  }, [cleanup]);

  const cancel = useCallback(() => {
    try {
      recorderRef.current?.stop();
    } catch {
      /* noop */
    }
    recorderRef.current = null;
    setRecording(false);
    cleanup();
  }, [cleanup]);

  return { recording, transcribing, level, error, supported, start, stop, cancel };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
