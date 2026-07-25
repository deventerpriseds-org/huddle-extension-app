# E2E UI verification (headless)

Drives the real app in headless Chromium via a **dev-only auth bypass** so authenticated views can be
verified without MSAL sign-in. The bypass is double-gated (`import.meta.env.DEV` **and**
`VITE_E2E_AUTH_BYPASS=1`) so it is dead-code-eliminated from the production bundle — the prod deploy
never sets the flag.

## Run

```bash
# 1) start the dev server with the bypass on (Chromium is pre-installed at /opt/pw-browsers)
VITE_E2E_AUTH_BYPASS=1 npx vite dev --port 4173 --host 127.0.0.1 &

# 2) run a spec against it
PORT=4173 node e2e/artifacts-ui.e2e.mjs
```

Each spec prints an `✅/❌` line per acceptance criterion and writes screenshots to `/tmp/artifacts-ui-*.png`.
Exit code is non-zero if any check fails.

## Specs
- `artifacts-ui.e2e.mjs` — Artifact workspace (AC-18..23): rail nav, folder tree, status filters, list
  rows (name/author/status), preview pane, Approve / Request-changes, filter narrowing. Data comes from
  the component's dev-only `E2E_ROWS` fixture (same gate as the bypass); the live server-fn data path is
  verified separately against the deployed app.

## Adding a spec
Reuse the launch + (optional) `page.route("**/_serverFn/**", …)` pattern. Note: replaying **prod**
server-fn response bodies into a **dev** client does not decode (dev/prod seroval-codec differences) —
prefer a dev-gated component fixture for data, and verify the live fn path separately.
