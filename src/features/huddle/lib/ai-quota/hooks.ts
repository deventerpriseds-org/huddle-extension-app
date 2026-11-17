// WHAT:       Client-safe reporting hooks for the background-AI-job quota alert. The shared model-call helpers call
//             these; they forward to the server module (ai-quota.server.ts) through a globalThis registry it fills
//             when it loads, so NO node-only import (node:async_hooks) is pulled into a module a browser chunk can reach.
// WHY:        2026-11-17 build check: a static import of ai-quota.server from openai-responses.server put
//             `node:async_hooks` into the client `routing-*.js` chunk (routing.ts reaches the helper). Vite shims it as
//             an empty module, so `new AsyncLocalStorage()` would throw when that chunk evaluates in the browser.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-quota-alert-background.md (Step 6).
//
// Before the server module has loaded, no background job can have started (runAsAiJob loads it), so a missing
// registry is correctly a no-op. Every hook swallows its own errors.

export interface AiQuotaHooks {
  noteAiFailure(err: unknown): void;
  noteAiSuccess(): void;
  noteAiResponse(res: Response): void;
}

export const AI_QUOTA_HOOKS_KEY = "__huddleAiQuotaHooks";

const hooks = (): AiQuotaHooks | undefined => (globalThis as Record<string, unknown>)[AI_QUOTA_HOOKS_KEY] as AiQuotaHooks | undefined;

export function reportAiFailure(err: unknown): void {
  try {
    hooks()?.noteAiFailure(err);
  } catch {
    /* never affect the model call */
  }
}

export function reportAiSuccess(): void {
  try {
    hooks()?.noteAiSuccess();
  } catch {
    /* never affect the model call */
  }
}

export function reportAiResponse(res: Response): void {
  try {
    hooks()?.noteAiResponse(res);
  } catch {
    /* never affect the model call */
  }
}
