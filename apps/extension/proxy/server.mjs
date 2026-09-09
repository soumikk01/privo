/**
 * ⛔ DEPRECATED — DO NOT RUN THIS FILE ⛔
 *
 * This legacy server has critical security vulnerabilities:
 *   • CORS: Access-Control-Allow-Origin: *  (any web page can call it)
 *   • POST /captures: no authentication
 *   • /v1/*:          no authentication  (open LLM proxy at operator's expense)
 *   • GET  /validate: stored XSS via innerHTML with unsanitised database fields
 *
 * Use the Fastify backend at PRIVO-page-agent-ext-be/ instead:
 *   cd ../PRIVO-page-agent-ext-be && npm run dev
 *
 * This file is kept only for historical reference. Never run it in any environment.
 */
throw new Error('DEPRECATED: use PRIVO-page-agent-ext-be instead. See comment above.')

/**
 * Original file kept below for reference only.
 * @deprecated
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

// ---------- config ----------

for (const rel of ['../.env', './.env']) {
	try {
		const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
		for (const line of text.split('\n')) {
			const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
			if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
		}
	} catch {
		/* no .env there — fine */
	}
}

const UPSTREAM = process.env.UPSTREAM ?? 'https://api.anthropic.com'
const API_KEY = process.env.ANTHROPIC_API_KEY
const PORT = Number(process.env.PORT ?? 8787)

const DB_PATH = fileURLToPath(new URL('./captures.json', import.meta.url))
const SECRET_PATH = fileURLToPath(new URL('./.secret', import.meta.url))

// signing secret: generated once, kept server-side only
if (!existsSync(SECRET_PATH)) writeFileSync(SECRET_PATH, randomBytes(32).toString('hex'))
const SECRET = readFileSync(SECRET_PATH, 'utf8').trim()

/** @type {Record<string, any>} sha256 → record */
let db = {}
try {
	db = JSON.parse(readFileSync(DB_PATH, 'utf8'))
} catch {
	/* fresh start */
}
const persist = () => writeFileSync(DB_PATH, JSON.stringify(db, null, 1))

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Access-Control-Max-Age': '86400',
}
const json = (res, status, obj) => {
	res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' })
	res.end(JSON.stringify(obj))
}

const sign = (sha256, captureId, registeredAt) =>
	createHmac('sha256', SECRET).update(`${sha256}|${captureId}|${registeredAt}`).digest('hex')

// ---------- server ----------

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://x')

	if (req.method === 'OPTIONS') {
		res.writeHead(204, CORS)
		return res.end()
	}

	// -- health --
	if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'PRIVO-capture' })

	// -- capture registry --
	if (url.pathname === '/captures' && req.method === 'POST') {
		const chunks = []
		for await (const c of req) chunks.push(c)
		let body
		try {
			body = JSON.parse(Buffer.concat(chunks).toString())
		} catch {
			return json(res, 400, { error: 'Invalid JSON' })
		}
		const { sha256, meta } = body ?? {}
		if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) return json(res, 400, { error: 'sha256 (hex) required' })
		if (!meta?.captureId || !meta?.url) return json(res, 400, { error: 'meta.captureId and meta.url required' })
		if (db[sha256]) return json(res, 200, { ...db[sha256], alreadyRegistered: true })

		const registeredAt = new Date().toISOString()
		const record = {
			sha256,
			captureId: String(meta.captureId).slice(0, 40),
			url: String(meta.url).slice(0, 2000),
			title: String(meta.title ?? '').slice(0, 300),
			capturedAt: meta.capturedAt ?? null,
			extVersion: String(meta.extVersion ?? '').slice(0, 20),
			registeredAt,
			signature: sign(sha256, meta.captureId, registeredAt),
		}
		db[sha256] = record
		persist()
		console.log(`[registry] sealed ${record.captureId} (${sha256.slice(0, 12)}…) ${record.url}`)
		return json(res, 201, record)
	}

	const shaMatch = url.pathname.match(/^\/captures\/([0-9a-f]{64})$/)
	if (shaMatch && req.method === 'GET') {
		const record = db[shaMatch[1]]
		if (!record) return json(res, 404, { valid: false, error: 'No capture registered with this hash' })
		const expected = sign(record.sha256, record.captureId, record.registeredAt)
		return json(res, 200, { valid: expected === record.signature, record })
	}

	// -- validation page --
	if (url.pathname === '/validate') {
		res.writeHead(200, { ...CORS, 'Content-Type': 'text/html; charset=utf-8' })
		return res.end(VALIDATE_PAGE)
	}

	// -- LLM proxy --
	if (url.pathname.startsWith('/v1/')) {
		if (!API_KEY) return json(res, 500, { error: 'ANTHROPIC_API_KEY not configured on the backend' })
		const chunks = []
		for await (const c of req) chunks.push(c)
		try {
			const upstream = await fetch(UPSTREAM + req.url, {
				method: req.method,
				headers: {
					'Content-Type': req.headers['content-type'] ?? 'application/json',
					Authorization: `Bearer ${API_KEY}`,
				},
				body: chunks.length ? Buffer.concat(chunks) : undefined,
			})
			res.writeHead(upstream.status, {
				...CORS,
				'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
			})
			for await (const chunk of upstream.body) res.write(chunk)
			return res.end()
		} catch (err) {
			return json(res, 502, { error: `Proxy error: ${err?.message ?? err}` })
		}
	}

	json(res, 404, { error: 'Unknown route' })
})

server.listen(PORT, () => {
	console.log(`PRIVO Capture backend on http://localhost:${PORT}`)
	console.log(`  LLM proxy   → ${UPSTREAM} ${API_KEY ? '(key loaded)' : '(NO KEY — set .env)'}`)
	console.log(`  Validation  → http://localhost:${PORT}/validate`)
	console.log(`  Registry    → ${Object.keys(db).length} sealed capture(s)`)
})

// ---------- validation page (inline, no assets) ----------

const VALIDATE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRIVO Capture Validator</title>
<style>
:root{--bg:#F6F3F0;--surface:#fff;--ink:#111113;--ink2:#56555E;--line:#E2DCD5;--accent:#175FFF;--good:#0E7A46;--goods:#DDF2E6;--bad:#B3261E;--bads:#F9E2E0}
@media(prefers-color-scheme:dark){:root{--bg:#111113;--surface:#1B1B1F;--ink:#F2F0ED;--ink2:#B6B4BC;--line:#2B2B31;--accent:#5F8DFF;--good:#58C68C;--goods:#14301F;--bad:#F28B82;--bads:#3A1917}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px;max-width:560px;width:100%}
.eyebrow{font:600 11px/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin:0 0 6px}.eyebrow:before{content:'// '}
h1{margin:0 0 6px;font-size:22px;font-weight:800}p{color:var(--ink2);margin:0 0 18px}
.drop{border:2px dashed var(--line);border-radius:10px;padding:36px;text-align:center;color:var(--ink2);cursor:pointer;transition:border-color .15s}
.drop:hover,.drop.over{border-color:var(--accent);color:var(--ink)}
.result{margin-top:18px;border-radius:10px;padding:16px 18px;display:none}
.result.ok{display:block;background:var(--goods);color:var(--good)}
.result.no{display:block;background:var(--bads);color:var(--bad)}
.result b{display:block;font-size:16px;margin-bottom:6px}
.result dl{display:grid;grid-template-columns:auto 1fr;gap:2px 14px;margin:8px 0 0;font-size:13px;color:var(--ink)}
.result dt{font-weight:600;color:var(--ink2)}.result dd{margin:0;font-family:ui-monospace,monospace;font-size:12px;overflow-wrap:anywhere}
input[type=file]{display:none}
</style></head><body>
<div class="card">
<p class="eyebrow">PRIVO AI</p><h1>Capture Validator</h1>
<p>Drop a sealed capture PNG here. Its SHA-256 is recomputed locally and checked against the registry — any pixel changed since sealing means no match.</p>
<label class="drop" id="drop">Click or drop a PNG to validate<input type="file" id="file" accept="image/png"></label>
<div class="result" id="result"></div>
</div>
<script>
const drop=document.getElementById('drop'),file=document.getElementById('file'),result=document.getElementById('result')
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('over')})
drop.addEventListener('dragleave',()=>drop.classList.remove('over'))
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('over');if(e.dataTransfer.files[0])check(e.dataTransfer.files[0])})
file.addEventListener('change',()=>file.files[0]&&check(file.files[0]))
async function check(f){
 result.className='result';result.textContent='Checking…';result.style.display='block'
 const buf=await f.arrayBuffer()
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buf))].map(b=>b.toString(16).padStart(2,'0')).join('')
 const r=await fetch('/captures/'+hash)
 if(r.ok){const {valid,record}=await r.json()
  result.className='result '+(valid?'ok':'no')
  result.innerHTML='<b>'+(valid?'✔ AUTHENTIC — registered capture':'✖ Record signature invalid')+'</b>'
   +'<dl><dt>Capture ID</dt><dd>'+record.captureId+'</dd><dt>Page</dt><dd>'+record.url+'</dd><dt>Captured</dt><dd>'+(record.capturedAt?new Date(record.capturedAt).toISOString():'—')+'</dd><dt>Registered</dt><dd>'+record.registeredAt+'</dd><dt>SHA-256</dt><dd>'+record.sha256+'</dd></dl>'
 }else{
  result.className='result no'
  result.innerHTML='<b>✖ NO MATCH</b>This file was never sealed by the extension, or it was modified after sealing.'
 }}
</script></body></html>`
