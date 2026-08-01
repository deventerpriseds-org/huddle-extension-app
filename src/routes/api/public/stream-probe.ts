import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// STREAMING PROBE (temporary, diagnostic-only). The 1:1 token-streaming plan rests on ONE premise:
// that the Azure SWA (Nitro `azure-swa` preset) BUFFERS a Node function's streamed HTTP response, so
// a simple journey-style SSE would arrive all-at-once and the poll-partial approach is required. This
// route lets us confirm that premise EMPIRICALLY before writing the 5-file implementation. It emits 6
// chunks ~500ms apart over ~3s, each stamped with a server-side elapsed-ms marker. A client that
// reads the body incrementally can compare chunk arrival gaps: if chunks arrive spread out (~500ms
// apart) → SWA passes the stream through (SSE viable); if they all land at once at ~3s → SWA buffers
// (poll-partial required). No auth: emits nothing but synthetic markers, no secrets, no state.
// DELETE once the premise is settled.

export const Route = createFileRoute("/api/public/stream-probe")({
  server: {
    handlers: {
      GET: async () => {
        const encoder = new TextEncoder();
        const t0 = Date.now();
        const CHUNKS = 6;
        const GAP_MS = 500;

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < CHUNKS; i++) {
              const elapsed = Date.now() - t0;
              controller.enqueue(
                encoder.encode(`chunk=${i} serverElapsedMs=${elapsed}\n`),
              );
              if (i < CHUNKS - 1) {
                await new Promise((r) => setTimeout(r, GAP_MS));
              }
            }
            controller.enqueue(
              encoder.encode(`done totalServerMs=${Date.now() - t0}\n`),
            );
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
