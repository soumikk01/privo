// Routes:
//   GET  /health          — liveness check (public)
//   GET  /validate        — drop-a-file validation page (public)
//   GET  /captures/:sha   — look up a capture (public)
//   POST /captures        — register a sealed capture  [X-Extension-Secret]
//   ALL  /v1/*            — LLM proxy to Anthropic     [X-Extension-Secret]

import fastifyCors from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { buildValidatePage } from './validate-page.js'

// ─── env ─────────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url))

function loadEnv() {
  const candidates = [resolve(__dir, '../.env'), resolve(process.cwd(), '.env')]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    break
  }
}
loadEnv()

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const EXTENSION_SECRET  = process.env.EXTENSION_SECRET ?? ''
const PORT              = Number(process.env.PORT ?? 8787)
const UPSTREAM          = process.env.UPSTREAM ?? 'https://api.anthropic.com'
const IS_DEV            = process.env.NODE_ENV !== 'production'

if (!ANTHROPIC_API_KEY) console.warn('[warn] ANTHROPIC_API_KEY not set — LLM proxy returns 500')
if (!EXTENSION_SECRET) {
  if (!IS_DEV) {
    console.error('[fatal] EXTENSION_SECRET must be set in production. Set it in .env and restart.')
    process.exit(1)
  }
  console.warn('[warn] EXTENSION_SECRET not set — protected routes are OPEN (dev only)')
}

// ─── data / signing secret ────────────────────────────────────────────────────

const DATA_DIR    = resolve(__dir, '../data')
const DB_PATH     = resolve(DATA_DIR, 'captures.json')
const SECRET_PATH = resolve(DATA_DIR, '.signing-secret')

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

if (!existsSync(SECRET_PATH)) {
  const generated = randomBytes(32).toString('hex')
  writeFileSync(SECRET_PATH, generated, { mode: 0o600 })
  console.log('[init] Generated signing secret → data/.signing-secret')
  console.log('[init] Persist across restarts by adding to .env:')
  console.log(`[init]   SIGNING_SECRET=${generated}`)
}
const SIGNING_SECRET = (process.env.SIGNING_SECRET ?? readFileSync(SECRET_PATH, 'utf8')).trim()

// ─── data model ──────────────────────────────────────────────────────────────

type CaptureRecord = {
  sha256: string
  captureId: string
  url: string
  title: string
  capturedAt: number | null
  extVersion: string
  registeredAt: string
  signature: string
}

let db: Record<string, CaptureRecord> = {}
try { db = JSON.parse(readFileSync(DB_PATH, 'utf8')) as Record<string, CaptureRecord> } catch { /* fresh */ }

const persist = () => writeFileSync(DB_PATH, JSON.stringify(db, null, 1))

const sign = (sha256: string, captureId: string, registeredAt: string) =>
  createHmac('sha256', SIGNING_SECRET).update(`${sha256}|${captureId}|${registeredAt}`).digest('hex')

/** Constant-time string comparison — prevents timing oracle on secret and HMAC values. */
function safeCompare(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    const len = Math.max(ba.length, bb.length)
    const paddedA = Buffer.concat([ba, Buffer.alloc(len - ba.length)])
    const paddedB = Buffer.concat([bb, Buffer.alloc(len - bb.length)])
    // always runs full constant-time compare; length equality checked after
    return timingSafeEqual(paddedA, paddedB) && ba.length === bb.length
  } catch { return false }
}

// ─── request validation schemas ───────────────────────────────────────────────

const NOW = () => Date.now()

const captureBodySchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
  meta: z.object({
    captureId:   z.string().min(1).max(40),
    url:         z.string().url('meta.url must be a valid URL').max(2000),
    title:       z.string().max(300).optional().default(''),
    capturedAt:  z.number().int().finite().optional().nullable(),
    extVersion:  z.string().max(20).optional().default(''),
  }),
})

// ─── auth helper ──────────────────────────────────────────────────────────────

function requireSecret(header: string | undefined): boolean {
  if (!EXTENSION_SECRET) return true // not configured — allow (dev mode)
  if (!header) return false
  return safeCompare(EXTENSION_SECRET, header)
}

// ─── fastify app ──────────────────────────────────────────────────────────────

// trustProxy: '127.0.0.1' tells Fastify to trust X-Forwarded-For only from the local
// reverse proxy. Without this, req.ip is always 127.0.0.1 (the proxy's TCP address),
// making rate limiting a shared global bucket instead of per-client.
// IMPORTANT: your reverse proxy must strip/overwrite X-Forwarded-For from untrusted clients.
const app = Fastify({ logger: false, trustProxy: '127.0.0.1' })

// Security headers — X-Frame-Options, X-Content-Type-Options, HSTS, etc.
// CSP is intentionally omitted here: /validate uses an inline script block.
// A per-request nonce-based CSP is a future improvement.
await app.register(fastifyHelmet, {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
})

// Global rate limit: 120 req/min per IP.
// For distributed deployments, swap `store` to a Redis-backed store.
await app.register(fastifyRateLimit, {
  global: true,
  max: 120,
  timeWindow: '1 minute',
  errorResponseBuilder: (_req, context) => ({
    error: 'Too many requests',
    retryAfter: context.after,
  }),
})

// CORS — chrome-extension:// origins only; no-origin (curl/scripts) allowed in dev only.
await app.register(fastifyCors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, IS_DEV) // block no-origin requests in production
    if (origin.startsWith('chrome-extension://')) return cb(null, true)
    if (IS_DEV && (origin.startsWith('http://localhost') || origin.startsWith('http://127.'))) {
      return cb(null, true)
    }
    cb(new Error('CORS: origin not allowed'), false)
  },
  allowedHeaders: ['Content-Type', 'X-Extension-Secret'],
  methods: ['GET', 'POST', 'OPTIONS'],
})

// ─── public routes ────────────────────────────────────────────────────────────

app.get('/health', async (_req, reply) => {
  return reply.send({
    ok: true,
    service: 'privo-capture',
    captures: Object.keys(db).length,
    llmProxy: !!ANTHROPIC_API_KEY,
    authRequired: !!EXTENSION_SECRET,
    env: IS_DEV ? 'development' : 'production',
  })
})

app.get('/validate', async (req, reply) => {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'

  // Sanitise Host header — only allow safe characters to prevent header injection
  // (JSON.stringify in the validate page template would otherwise allow </script> breakout).
  const rawHost = req.headers['host'] ?? `localhost:${PORT}`
  const host = /^[a-zA-Z0-9._[\]%-]+$/.test(rawHost) ? rawHost : `localhost:${PORT}`

  reply.type('text/html; charset=utf-8')
  return reply.send(buildValidatePage(`${proto}://${host}`))
})

app.get<{ Params: { sha: string } }>('/captures/:sha', async (req, reply) => {
  const { sha } = req.params
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    return reply.status(400).send({ error: 'Invalid SHA-256 format' })
  }
  const record = db[sha]
  if (!record) {
    return reply.status(404).send({ valid: false, error: 'No capture registered with this hash' })
  }
  const expected = sign(record.sha256, record.captureId, record.registeredAt)
  // Use constant-time comparison for HMAC to prevent timing oracle attacks.
  const valid = safeCompare(expected, record.signature)
  return reply.send({ valid, record })
})

// ─── protected routes ─────────────────────────────────────────────────────────

app.post('/captures', {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
}, async (req, reply) => {
  if (!requireSecret(req.headers['x-extension-secret'] as string | undefined)) {
    return reply.status(401).send({ error: 'Unauthorized' })
  }

  const parsed = captureBodySchema.safeParse(req.body)
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? 'Invalid request body'
    return reply.status(400).send({ error: msg })
  }

  const { sha256, meta } = parsed.data

  if (db[sha256]) {
    return reply.send({ ...db[sha256], alreadyRegistered: true })
  }

  // Clamp capturedAt to a sane window — reject impossible timestamps.
  const capturedAt = typeof meta.capturedAt === 'number' &&
    meta.capturedAt > 0 &&
    meta.capturedAt <= NOW() + 60_000
    ? meta.capturedAt
    : null

  const registeredAt = new Date().toISOString()
  const record: CaptureRecord = {
    sha256,
    captureId:   meta.captureId.slice(0, 40),
    url:         meta.url.slice(0, 2000),
    title:       meta.title.slice(0, 300),
    capturedAt,
    extVersion:  meta.extVersion.slice(0, 20),
    registeredAt,
    signature:   sign(sha256, meta.captureId, registeredAt),
  }

  try {
    db[sha256] = record
    persist()
  } catch (err) {
    delete db[sha256]
    return reply.status(500).send({ error: 'Failed to persist capture record' })
  }

  console.log(`[registry] sealed ${record.captureId} (${sha256.slice(0, 12)}…) ${record.url}`)
  return reply.status(201).send(record)
})

// LLM proxy — all methods, any /v1/* path.
app.all('/v1/*', {
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
}, async (req, reply) => {
  if (!requireSecret(req.headers['x-extension-secret'] as string | undefined)) {
    return reply.status(401).send({ error: 'Unauthorized' })
  }
  if (!ANTHROPIC_API_KEY) {
    return reply.status(500).send({ error: 'ANTHROPIC_API_KEY is not configured on the backend' })
  }

  const upstreamUrl = UPSTREAM + req.url
  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers: {
      'Content-Type':       req.headers['content-type'] ?? 'application/json',
      'Authorization':      `Bearer ${ANTHROPIC_API_KEY}`,
      'anthropic-version':  (req.headers['anthropic-version'] as string | undefined) ?? '2023-06-01',
      ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] as string } : {}),
    },
    body: req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : JSON.stringify(req.body),
  })

  reply.status(upstream.status)
  reply.header('Content-Type', upstream.headers.get('content-type') ?? 'application/json')

  for (const h of ['x-request-id', 'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-tokens-limit']) {
    const v = upstream.headers.get(h)
    if (v) reply.header(h, v)
  }

  // Stream response body directly — no buffering, supports SSE for streaming mode.
  return reply.send(
    upstream.body
      ? Readable.fromWeb(upstream.body as import('stream/web').ReadableStream)
      : null
  )
})

// ─── start ────────────────────────────────────────────────────────────────────

await app.listen({ port: PORT, host: '127.0.0.1' })

console.log(`\nPrivo Capture backend  →  http://localhost:${PORT}`)
console.log(`  LLM proxy    /v1/*   →  ${UPSTREAM} ${ANTHROPIC_API_KEY ? '(key loaded)' : '(NO KEY)'}`)
console.log(`  Registry     /captures  (${Object.keys(db).length} record(s))`)
console.log(`  Validator    http://localhost:${PORT}/validate`)
console.log(`  Auth         ${EXTENSION_SECRET ? 'X-Extension-Secret required' : 'OPEN — set EXTENSION_SECRET to lock down'}`)
console.log(`  Mode         ${IS_DEV ? 'development' : 'production'}`)
console.log()
