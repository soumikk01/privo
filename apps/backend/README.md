<p align="center">
  <img src="https://raw.githubusercontent.com/soumikk01/Privo_Extension_Backend/main/icon.svg" alt="Privo Logo" width="90" height="90" />
</p>

<h1 align="center">Privo Page Agent — Backend</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen?style=flat-square&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/Fastify-v5-black?style=flat-square&logo=fastify" alt="Fastify" />
  <img src="https://img.shields.io/badge/TypeScript-ESM-blue?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Port-8787-orange?style=flat-square" alt="Port" />
</p>

<p align="center">
  Privacy-first backend for the <strong>Privo Page Agent</strong> Chrome extension.<br/>
  Secures your Anthropic API key server-side and provides tamper-proof capture verification.
</p>

---

The backend server for the **Privo Page Agent** Chrome extension. It has two responsibilities:

1. **LLM proxy** — forwards requests from the extension to the Anthropic API, keeping the API key server-side and never in the browser
2. **Capture registry** — stores SHA-256 hashes of sealed page captures with HMAC signatures, enabling tamper-detection: any pixel change after sealing breaks verification

Built with [Fastify v5](https://fastify.dev/), TypeScript (ESM), Zod for schema validation, and standard Node.js `crypto` for HMAC and constant-time comparison.

---

## Table of contents

1. [How it relates to the extension](#how-it-relates-to-the-extension)
2. [Routes (full reference)](#routes-full-reference)
3. [Architecture](#architecture)
4. [Data model](#data-model)
5. [Security model (full)](#security-model-full)
6. [Project layout (every file explained)](#project-layout-every-file-explained)
7. [First-time setup](#first-time-setup)
8. [Environment variables](#environment-variables)
9. [Running the server](#running-the-server)
10. [Secret management](#secret-management)
11. [Rate limits](#rate-limits)
12. [Error responses](#error-responses)
13. [Deployment considerations](#deployment-considerations)
14. [Upgrading to a real database](#upgrading-to-a-real-database)
15. [Troubleshooting](#troubleshooting)

---

## How it relates to the extension

The Chrome extension (`privo-page-agent`) talks to this backend over HTTP on `localhost:8787`:

```text
Extension (side panel)
  │
  ├── POST /captures          — register the SHA-256 of a sealed PNG capture
  ├── GET  /captures/:sha     — verify a capture (public, used by /validate page)
  └── ALL  /v1/*              — proxy LLM calls to Anthropic
        (Authorization header is set here — the API key never touches the browser)
```

The extension and backend share a secret (`EXTENSION_SECRET` / `VITE_EXTENSION_SECRET`). Every protected request carries this secret in an `X-Extension-Secret` header. The backend verifies it before processing.

---

## Routes (full reference)

### `GET /health`

No authentication required. Returns the current service state.

**Response `200`:**

```json
{
  "ok": true,
  "service": "privo-capture",
  "captures": 42,
  "llmProxy": true,
  "authRequired": true,
  "env": "development"
}
```

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | Always `true` if the server is running |
| `captures` | number | Number of records currently in the registry |
| `llmProxy` | boolean | `true` if `ANTHROPIC_API_KEY` is configured |
| `authRequired` | boolean | `true` if `EXTENSION_SECRET` is set |
| `env` | string | `"production"` or `"development"` |

---

### `GET /validate`

No authentication required. Returns a self-contained HTML page with no external dependencies.

The page lets anyone drag-and-drop a sealed PNG capture and verify it:
1. SHA-256 is computed in the browser using `crypto.subtle.digest`
2. The hash is sent to `GET /captures/:sha`
3. The result is shown as "Authentic" or "No match" / "Signature invalid"

All database values are inserted via `textContent` (never `innerHTML`) — stored XSS is impossible. The `apiBase` URL embedded in the inline `<script>` tag is serialised with `safeJson()` which Unicode-escapes `<`, `>`, and `&` to prevent `</script>` breakout.

---

### `POST /captures`

**Authentication required:** `X-Extension-Secret: <EXTENSION_SECRET>`

Registers a sealed capture. Idempotent — if the SHA-256 is already registered, returns the existing record without creating a duplicate.

**Request body:**

```json
{
  "sha256": "a3f1b2c4d5e6...",
  "meta": {
    "captureId": "PV-260826-A1B2C3D4",
    "url": "https://example.com/orders/12345",
    "title": "My Orders — Example Store",
    "capturedAt": 1724651234567,
    "extVersion": "0.1.0"
  }
}
```

| Field | Type | Validation | Description |
|---|---|---|---|
| `sha256` | string | `/^[0-9a-f]{64}$/` | SHA-256 hex of the sealed PNG |
| `meta.captureId` | string | 1–40 chars | Capture ID in `PV-YYMMDD-XXXXXXXX` format |
| `meta.url` | string | valid URL, max 2000 chars | Page URL at time of capture |
| `meta.title` | string | max 300 chars, optional | Page `<title>` at time of capture |
| `meta.capturedAt` | number | integer, optional | Epoch milliseconds when the capture was taken |
| `meta.extVersion` | string | max 20 chars, optional | Extension version string |

**`capturedAt` validation:** If the value is `≤ 0` or `> now + 60 seconds`, it is stored as `null`. This rejects impossible timestamps (1970-era, far-future) while allowing the 60-second grace window for clock skew.

**Response `201` (new record):**

```json
{
  "sha256": "a3f1b2c4d5e6...",
  "captureId": "PV-260826-A1B2C3D4",
  "url": "https://example.com/orders/12345",
  "title": "My Orders — Example Store",
  "capturedAt": 1724651234567,
  "extVersion": "0.1.0",
  "registeredAt": "2026-08-26T06:30:00.000Z",
  "signature": "7c3b9f..."
}
```

**Response `200` (already registered):**

Same record plus `"alreadyRegistered": true`.

**Response `400`:** Body validation error — `{ "error": "sha256 must be 64 lowercase hex characters" }` (or similar).

**Response `401`:** Missing or incorrect `X-Extension-Secret` header.

---

### `GET /captures/:sha`

No authentication required. This is the public verification endpoint — anyone with a sealed capture file can verify it.

`:sha` must be exactly 64 lowercase hex characters. Returns `400` if the format is invalid.

**Response `200` — record found:**

```json
{
  "valid": true,
  "record": {
    "sha256": "a3f1b2c4d5e6...",
    "captureId": "PV-260826-A1B2C3D4",
    "url": "https://example.com/orders/12345",
    "title": "My Orders — Example Store",
    "capturedAt": 1724651234567,
    "extVersion": "0.1.0",
    "registeredAt": "2026-08-26T06:30:00.000Z",
    "signature": "7c3b9f..."
  }
}
```

`valid: true` — the stored HMAC signature matches the record contents. The record has not been tampered with.

`valid: false` — the record exists but the HMAC signature does not match. Someone has modified the registry entry (changed the URL, title, etc.) after it was created.

**Response `404`:** No record with this SHA-256 was ever registered. The file was never sealed by the extension, or was modified after sealing.

---

### `ALL /v1/*`

**Authentication required:** `X-Extension-Secret: <EXTENSION_SECRET>`

Proxies any HTTP method to `https://api.anthropic.com/v1/*`. The extension uses this to make LLM calls without exposing the Anthropic API key in the browser.

What the proxy does:
- Replaces the `Authorization` header with `Bearer <ANTHROPIC_API_KEY>` from the environment
- Forwards the request body as-is (already JSON from the extension)
- Forwards `anthropic-version` header if present (defaults to `2023-06-01`)
- Streams the response body directly using `Readable.fromWeb()` — no buffering, so streaming completions (SSE) work end-to-end
- Forwards `x-request-id`, `anthropic-ratelimit-requests-limit`, `anthropic-ratelimit-tokens-limit` response headers back to the extension

**Rate limit:** 30 requests per minute per IP (separate from the global 120/min).

---

## Architecture

```text
Request arrives
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│  @fastify/cors                                              │
│  ├── origin must start with chrome-extension://             │
│  └── in dev: localhost allowed; no-origin (curl) allowed    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  @fastify/helmet                                            │
│  X-Frame-Options: DENY                                      │
│  X-Content-Type-Options: nosniff                            │
│  Strict-Transport-Security (HSTS)                           │
│  Referrer-Policy: no-referrer                               │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  @fastify/rate-limit                                        │
│  Global: 120 req/min per client IP                          │
│  POST /captures: 20 req/min per IP                          │
│  ALL /v1/*: 30 req/min per IP                               │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Route handlers                                             │
│                                                             │
│  GET /health     → read db size, env state                  │
│  GET /validate   → buildValidatePage()                      │
│  GET /captures/:sha → HMAC verify + return record           │
│  POST /captures  → auth → zod validate → sign → persist     │
│  ALL /v1/*       → auth → proxy → stream response           │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────┐  ┌─────────────────────────┐
│  data/captures.json           │  │  https://api.anthropic   │
│  (in-memory + file sync)      │  │  .com (LLM upstream)     │
└───────────────────────────────┘  └─────────────────────────┘
```

### Authentication flow (POST /captures and /v1/*)

```text
Request
  │
  ├── header: X-Extension-Secret = <value>
  │
  ▼
requireSecret(header)
  ├── if EXTENSION_SECRET not configured → allow (dev only)
  ├── if header missing → return false → 401
  └── safeCompare(EXTENSION_SECRET, header)
        └── timingSafeEqual(Buffer.from(a), Buffer.from(b))
              ├── lengths differ → false (early exit without timing leak)
              └── constant-time comparison → true/false
```

### HMAC signing flow (POST /captures)

When a capture is registered:

```text
sha256 + captureId + registeredAt
           │
           ▼
  createHmac('sha256', SIGNING_SECRET)
    .update(`${sha256}|${captureId}|${registeredAt}`)
    .digest('hex')
           │
           ▼
  stored as record.signature
```

When a capture is verified (GET /captures/:sha):

```text
record.sha256 + record.captureId + record.registeredAt
           │
           ▼
  recompute HMAC with same SIGNING_SECRET
           │
           ▼
  safeCompare(expected, record.signature)  ← timingSafeEqual
           │
       ┌───┴───┐
     match   no match
    valid:true  valid:false
```

This means even if someone gains write access to `data/captures.json`, they cannot forge a valid record without knowing `SIGNING_SECRET`.

### Streaming (LLM proxy)

```text
Extension sends POST /v1/messages  {stream: true}
          │
          ▼
Backend fetches from api.anthropic.com
          │
          ▼
upstream.body  ← ReadableStream (Web Streams API)
          │
          ▼
Readable.fromWeb(upstream.body)  ← Node.js Readable stream
          │
          ▼
reply.send(readable)  ← Fastify streams directly to client
```

No `arrayBuffer()` buffering — the first token reaches the extension immediately. Server-sent events (SSE) work end-to-end.

---

## Data model

### `CaptureRecord` (stored in `data/captures.json`)

```typescript
type CaptureRecord = {
  sha256: string       // 64 hex chars — SHA-256 of the sealed PNG
  captureId: string    // PV-YYMMDD-XXXXXXXX
  url: string          // page URL (max 2000 chars)
  title: string        // page <title> (max 300 chars)
  capturedAt: number | null  // epoch ms, or null if timestamp was invalid
  extVersion: string   // e.g. "0.1.0"
  registeredAt: string // ISO 8601 UTC string — server-set
  signature: string    // HMAC-SHA256 hex of (sha256|captureId|registeredAt)
}
```

The file is a JSON object keyed by `sha256`:

```json
{
  "a3f1b2...": { "sha256": "a3f1b2...", "captureId": "PV-260826-A1B2C3D4", ... },
  "9d8c7e...": { "sha256": "9d8c7e...", ... }
}
```

Loaded into the `db` variable in memory at startup. Every write calls `persist()` which does a synchronous `writeFileSync` (safe for single-instance, low-write-rate use).

### Storage locations

| Path | Mode | Contents |
|---|---|---|
| `data/captures.json` | 0644 | Capture registry (JSON object) |
| `data/.signing-secret` | 0600 | Auto-generated 32-byte hex HMAC key |

Both are in `data/` which is created automatically on first startup if it does not exist.

---

## Security model (full)

### 1. API key never reaches the browser

The extension's `config.ts` sets `apiKey: ''` — no key is bundled with the extension. The backend sets `Authorization: Bearer <ANTHROPIC_API_KEY>` on every upstream request. An attacker who intercepts the extension's LLM requests sees no usable credentials.

### 2. Shared secret with constant-time comparison

```typescript
function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false      // early exit — no timing leak
  return timingSafeEqual(ba, bb)                 // constant time
}
```

Length is checked first (different lengths are structurally impossible for matching secrets, and short-circuiting here leaks no information). `timingSafeEqual` from Node.js `crypto` ensures the comparison time does not vary with the number of matching bytes.

Used for **both** `EXTENSION_SECRET` authentication and HMAC signature verification.

### 3. CORS: chrome-extension:// origins only

```typescript
origin: (origin, cb) => {
  if (!origin) return cb(null, IS_DEV)          // curl/scripts blocked in prod
  if (origin.startsWith('chrome-extension://')) return cb(null, true)
  if (IS_DEV && origin.startsWith('http://localhost')) return cb(null, true)
  cb(new Error('CORS: origin not allowed'), false)
}
```

In production:
- No-origin requests (curl, scripts, server-to-server) are blocked
- Only `chrome-extension://` origins are allowed
- No wildcard (`*`) anywhere

### 4. Rate limiting per client IP

```
Global:           120 requests/minute per IP
POST /captures:    20 requests/minute per IP (tighter — write endpoint)
ALL /v1/*:         30 requests/minute per IP
```

`trustProxy: '127.0.0.1'` tells Fastify to read the real client IP from `X-Forwarded-For` when the request comes through a local reverse proxy (nginx, Caddy). Without this setting, all requests appear to come from `127.0.0.1` and share a single rate limit bucket.

**If you run without a reverse proxy** (direct binding on a public port): remove `trustProxy` or set it to `false` — otherwise a client can spoof `X-Forwarded-For` to bypass per-IP rate limits.

### 5. Security headers (Helmet)

`@fastify/helmet` adds:
- `X-Frame-Options: SAMEORIGIN` — prevents clickjacking
- `X-Content-Type-Options: nosniff` — prevents MIME sniffing
- `Strict-Transport-Security` — HSTS (enforced when served over HTTPS)
- `Referrer-Policy: no-referrer`
- `X-DNS-Prefetch-Control: off`

CSP is intentionally disabled (`contentSecurityPolicy: false`) because `/validate` uses an inline script block. A per-request nonce-based CSP is the future improvement.

### 6. Host header injection prevention

The `/validate` route includes `apiBase` (derived from the `Host` header) in an inline `<script>` block. Before using the host:

```typescript
const rawHost = req.headers['host'] ?? `localhost:${PORT}`
const host = /^[a-zA-Z0-9._[\]%-]+$/.test(rawHost) ? rawHost : `localhost:${PORT}`
```

Only hostnames with safe characters are used. Anything suspicious falls back to `localhost:PORT`.

The URL is then embedded with `safeJson()`:

```typescript
function safeJson(v: string): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}
// var API = ${safeJson(apiBase)};  ← inside <script> tag
```

`JSON.stringify` alone does not escape `<`, `>`, `&`, so a Host like `evil.com</script><script>alert(1)//` would break out of the script tag. The Unicode escapes prevent this.

### 7. Stored XSS prevention on /validate

The `/validate` page renders database values via `textContent` throughout — never `innerHTML`. Even if a malicious actor registers a capture with a script tag in the URL or title, it will be displayed as literal text and never executed.

### 8. Request body validation (Zod)

`POST /captures` body is validated with a strict Zod schema before any processing:
- `sha256`: must match `/^[0-9a-f]{64}$/`
- `captureId`: 1–40 characters
- `url`: valid URL, max 2000 characters
- `title`: max 300 characters
- `capturedAt`: finite integer (or null)
- `extVersion`: max 20 characters

Validation errors return `400` with the first failing constraint's message.

### 9. Timestamp range clamping

```typescript
const capturedAt =
  typeof meta.capturedAt === 'number' &&
  meta.capturedAt > 0 &&
  meta.capturedAt <= NOW() + 60_000
    ? meta.capturedAt
    : null
```

Rejects `capturedAt = 0` (Unix epoch default), negative values, and values more than 60 seconds in the future. Out-of-range values are stored as `null` rather than erroring — the capture is still registered.

### 10. Production startup guard

```typescript
if (!EXTENSION_SECRET) {
  if (!IS_DEV) {
    console.error('[fatal] EXTENSION_SECRET must be set in production.')
    process.exit(1)
  }
  console.warn('[warn] EXTENSION_SECRET not set — protected routes are OPEN (dev only)')
}
```

The server refuses to start in production without a configured secret. In development the server starts with a warning.

---

## Project layout (every file explained)

```text
privo-page-agent-ext-be/
│
├── src/
│   │
│   ├── index.ts              Main server file. Everything lives here:
│   │                         ├─ loadEnv()      — reads .env file manually
│   │                         │                   (no dotenv dependency)
│   │                         ├─ constants      — ANTHROPIC_API_KEY, EXTENSION_SECRET,
│   │                         │                   PORT, UPSTREAM, IS_DEV
│   │                         ├─ startup guard  — process.exit(1) if secret empty in prod
│   │                         ├─ signing secret — auto-generate if absent, print to stdout
│   │                         ├─ db             — captures.json in-memory + persist()
│   │                         ├─ sign()         — HMAC-SHA256 over (sha256|id|registeredAt)
│   │                         ├─ safeCompare()  — timingSafeEqual wrapper
│   │                         ├─ captureBodySchema — Zod schema for POST /captures
│   │                         ├─ requireSecret() — authenticates X-Extension-Secret header
│   │                         ├─ Fastify app    — plugins: cors, helmet, rate-limit
│   │                         ├─ GET /health
│   │                         ├─ GET /validate
│   │                         ├─ GET /captures/:sha
│   │                         ├─ POST /captures
│   │                         ├─ ALL /v1/*
│   │                         └─ app.listen()
│   │
│   └── validate-page.ts      HTML page builder for GET /validate.
│                              esc() — HTML-escapes all database values
│                              safeJson() — Unicode-escapes < > & in inline script
│                              buildValidatePage() — returns full HTML string
│                              The page uses no external assets, CDNs, or fonts.
│
├── data/                     Created on first startup (gitignored)
│   ├── captures.json         Capture registry
│   └── .signing-secret       Auto-generated HMAC signing key (mode 0600)
│
├── dist/                     TypeScript compiled output (tsc build)
│   ├── index.js
│   └── validate-page.js
│
├── icon.svg                  Privo logo
├── package.json              Dependencies + scripts (dev/build/start/typecheck)
├── tsconfig.json             TypeScript config (ESNext, NodeNext modules)
└── .env                      Secrets — NEVER commit (gitignored)
```

### Why there is no `dotenv` dependency

`loadEnv()` in `index.ts` reads `.env` manually using `readFileSync`. This avoids a dependency while keeping the same behaviour: reads the first `.env` found (next to the compiled output or next to `process.cwd()`). The implementation is intentionally minimal — it handles `KEY=value`, quoted values, and skips blank lines and comments.

---

## First-time setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure `.env`

Copy `.env.example` to `.env` and fill in your Anthropic API key:

```env
# Fresh key from console.anthropic.com
ANTHROPIC_API_KEY=sk-ant-api03-...

# Must match VITE_EXTENSION_SECRET in the extension's .env
EXTENSION_SECRET=your-generated-secret

# HMAC signing key — keep stable across restarts
SIGNING_SECRET=your-generated-signing-secret

PORT=8787
```

If you leave `SIGNING_SECRET` blank, the server auto-generates one on first run and prints:

```
[init] Generated signing secret → data/.signing-secret
[init] Persist across restarts by adding to .env:
[init]   SIGNING_SECRET=<value>
```

Copy that value into `.env` — otherwise a server restart invalidates all existing HMAC signatures and `GET /captures/:sha` returns `valid: false` for every record.

### 3. Verify the extension secret matches

```bash
# This repo:
grep EXTENSION_SECRET .env

# Extension repo:
grep VITE_EXTENSION_SECRET ../privo-page-agent/.env
```

The values after `=` must be identical.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes (for LLM proxy) | — | Anthropic API key. Injected into the `Authorization` header when proxying to `api.anthropic.com`. Never sent to the browser. Returns `500` on `/v1/*` if missing. |
| `EXTENSION_SECRET` | Yes (production) | — | Shared secret with the extension. Verified with `timingSafeEqual` on every protected request. Server refuses to start in production if empty. |
| `SIGNING_SECRET` | Yes (production) | auto-generated | HMAC-SHA256 key for signing capture records. Auto-generated on first run if absent (printed to stdout — copy to `.env`). Changing it invalidates all existing signatures. |
| `PORT` | No | `8787` | TCP port to listen on. Must match `baseURL` in the extension's `src/config.ts`. |
| `UPSTREAM` | No | `https://api.anthropic.com` | LLM upstream URL. Override for local testing (e.g. a mock server). |
| `NODE_ENV` | No | `""` | Set to `production` to enable strict mode: no-origin CORS blocked, empty `EXTENSION_SECRET` = fatal startup. |

---

## Running the server

### Development (auto-restart on file changes)

```bash
npm run dev
```

Uses `nodemon` watching `src/` and `.env` for changes. On change: kills the previous process and restarts with `tsx src/index.ts`. No compilation step — `tsx` transpiles on-the-fly.

```
Privo Capture backend  →  http://localhost:8787
  LLM proxy    /v1/*   →  https://api.anthropic.com (key loaded)
  Registry     /captures  (0 record(s))
  Validator    http://localhost:8787/validate
  Auth         X-Extension-Secret required
  Mode         development
```

### Production

```bash
npm run build   # TypeScript → dist/ (tsc)
npm start       # node dist/index.js
```

Set `NODE_ENV=production` before starting. A process manager like PM2 is recommended:

```bash
npm install -g pm2
NODE_ENV=production pm2 start dist/index.js --name privo-capture
pm2 save
pm2 startup
```

### Type checking (no emit)

```bash
npm run typecheck
```

---

## Secret management

### How secrets are generated

Both secrets were generated with:

```bash
openssl rand -hex 32
```

This produces 32 bytes of cryptographically random data encoded as 64 lowercase hex characters. The command uses the OS entropy pool (`/dev/urandom` on macOS/Linux).

Alternatively, with Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Rotating `EXTENSION_SECRET`

Rotating means temporarily breaking the extension until you rebuild it. Steps:

1. Generate a new secret:
   ```bash
   openssl rand -hex 32
   ```
2. Update `EXTENSION_SECRET` in this repo's `.env`
3. Update `VITE_EXTENSION_SECRET` in the extension repo's `.env`
4. Restart the backend: `npm run dev` (or restart the PM2 process)
5. Rebuild the extension: `yarn build` (in `privo-page-agent`)
6. Reload the extension in Chrome (`chrome://extensions` → reload icon)

### Rotating `SIGNING_SECRET`

**Warning:** rotating invalidates all existing HMAC signatures. `GET /captures/:sha` will return `valid: false` for every previously registered capture. Only rotate if the key is compromised.

Steps: same as above but only the backend needs to change. The extension does not use `SIGNING_SECRET`.

---

## Rate limits

| Route | Limit | Scope |
|---|---|---|
| All routes | 120 req/min | Per client IP |
| `POST /captures` | 20 req/min | Per client IP |
| `ALL /v1/*` | 30 req/min | Per client IP |

Rate limit exceeded response:

```json
{
  "error": "Too many requests",
  "retryAfter": "1 minute"
}
```

The `Retry-After` value is also set in the response header.

Rate limits use an in-memory store (per process). For distributed deployments, swap to a Redis-backed store by passing a `store` option to `@fastify/rate-limit`:

```typescript
import RedisStore from '@fastify/rate-limit/redis-store'
// store: new RedisStore({ client: redisClient })
```

---

## Error responses

All error responses are JSON with an `error` field:

| Status | Meaning |
|---|---|
| `400` | Bad request — invalid SHA-256 format, failed Zod validation |
| `401` | Missing or incorrect `X-Extension-Secret` header |
| `404` | No capture with that SHA-256 registered |
| `429` | Rate limit exceeded |
| `500` | `ANTHROPIC_API_KEY` not configured, or upstream error |

---

## Deployment considerations

### Running behind a reverse proxy (nginx, Caddy)

When a reverse proxy sits in front of this server, set `NODE_ENV=production` and ensure the proxy:

1. **Strips** any client-supplied `X-Forwarded-For` header before adding its own
2. **Sets** `X-Forwarded-For` to the real client IP

This is required for per-IP rate limiting to work correctly. `trustProxy: '127.0.0.1'` is already set — Fastify reads `X-Forwarded-For` only when the TCP connection comes from `127.0.0.1`.

Example nginx configuration:

```nginx
location / {
    proxy_pass         http://127.0.0.1:8787;
    proxy_set_header   X-Forwarded-For $remote_addr;  # strip any client XFF, set real IP
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Host $host;
    proxy_http_version 1.1;
}
```

### Direct public binding (no reverse proxy)

If you bind directly on a public IP (development / small internal deployment):

- Set `trustProxy: false` in `src/index.ts` (or remove it) — otherwise clients can spoof `X-Forwarded-For`
- Add TLS termination or ensure the deployment is VPN-only
- Consider IP allowlisting at the firewall level

### HTTPS

The server does not terminate TLS itself. Use a reverse proxy (nginx + Certbot, Caddy) or a managed service (Cloud Run, Railway, Fly.io) for TLS.

---

## Upgrading to a real database

The JSON file works well for a single-instance server with infrequent writes (each sealed capture is one write). When you need more:

**SQLite** (single file, no server, ACID, concurrent reads, querying):

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

Replace `captures.json` operations in `src/index.ts`:
- `JSON.parse(readFileSync(DB_PATH))` → `db.prepare('SELECT * FROM captures').all()`
- `writeFileSync(DB_PATH, JSON.stringify(db))` → `db.prepare('INSERT INTO captures VALUES (...)').run(...)`

**PostgreSQL** (multi-instance, distributed, full SQL):

Use `pg` or `@vercel/postgres`. Swap `@fastify/rate-limit`'s default store to Redis-backed for accurate cross-instance rate limiting.

**Signals that you need a database:**
- More than ~5000 capture records (startup JSON parse starts to noticeably slow)
- Multiple backend instances (concurrent writes to the JSON file corrupt it)
- Need to query captures by URL, user, or date range
- Need atomic transactions (e.g. check-then-register without race condition)

---

## Troubleshooting

**Server won't start — `[fatal] EXTENSION_SECRET must be set`**
- You are running with `NODE_ENV=production` but `EXTENSION_SECRET` is empty in `.env`
- Add the secret (must match `VITE_EXTENSION_SECRET` in the extension)

**`GET /captures/:sha` returns `valid: false` for everything**
- The `SIGNING_SECRET` changed since the records were registered
- Check `data/.signing-secret` — if it differs from the `SIGNING_SECRET` env var, the server generated a new key on startup
- Set `SIGNING_SECRET` in `.env` to the correct value and restart

**LLM calls return `500` with "ANTHROPIC_API_KEY is not configured"**
- Add a valid `ANTHROPIC_API_KEY` to `.env` and restart the server

**Extension gets `401 Unauthorized`**
- `EXTENSION_SECRET` in this repo's `.env` does not match `VITE_EXTENSION_SECRET` in the extension's `.env`
- They must be exactly equal (same hex string, no spaces, same case)
- Rebuild the extension after changing its `.env`: `yarn build`

**Rate limit hit during development**
- You can temporarily increase the limit in `src/index.ts` (`max: 120 → 600`)
- Or run with `NODE_ENV=` (not `production`) which uses the same limits but allows no-origin requests from curl

**Captures gallery shows `LOCAL` instead of `SEALED`**
- Backend was offline when the capture was taken
- The capture is still valid locally with its watermark
- Future captures will be sealed once the backend is reachable

**`data/captures.json` is corrupted**
- Delete it — the server will start fresh with an empty registry
- Or restore from a backup (the file is plain JSON, easy to inspect and repair)
