// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Deploy-target override. Lovable's plugin defaults Nitro to `cloudflare-module`
// and HARD-forces it inside the Lovable sandbox, so the Lovable preview always
// builds for Cloudflare regardless of this. Outside the sandbox (e.g. a GitHub
// Actions runner) setting NITRO_PRESET retargets the SSR build — e.g.
// `node-server` for Azure App Service. Only applied when the env var is set, so
// local/Lovable builds are unaffected.
const nitroPreset = process.env.NITRO_PRESET?.trim();

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  ...(nitroPreset ? { nitro: { preset: nitroPreset } } : {}),
});
