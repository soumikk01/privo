# LLM proxy

Keeps the Anthropic API key **out of the browser** and bypasses the org-level
"CORS requests are not allowed for this Organization" restriction — the extension
talks to this proxy, and the proxy attaches the real key server-side.

Two interchangeable flavors:

## Local (Node 18+, zero dependencies)

```bash
ANTHROPIC_API_KEY=sk-ant-... node proxy/server.mjs
# → http://localhost:8787/v1
```

## Cloud (Cloudflare Worker, free tier is plenty)

```bash
npx wrangler deploy proxy/worker.js --name PRIVO-llm-proxy
npx wrangler secret put ANTHROPIC_API_KEY
# → https://PRIVO-llm-proxy.<subdomain>.workers.dev/v1
```

## Point the extension at it

In `src/config.ts`:

```ts
export const DEFAULT_LLM_CONFIG = {
    baseURL: 'http://localhost:8787/v1',   // or your Worker URL
    model: 'claude-sonnet-4-6',
    apiKey: '',                            // not needed — proxy holds the key
    maxSteps: 40,
}
```

Then `npm run build` and reload the extension. The panel won't ask for a key
when the base URL isn't `api.anthropic.com`.

## Hardening before wider rollout

- Replace `Access-Control-Allow-Origin: *` with your extension's origin
  (`chrome-extension://<extension-id>`).
- Add an auth token check (shared secret header) so only your extension can use it.
- Log usage per user/team if you need cost attribution.
