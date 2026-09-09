/**
 * PRIVO Page Agent — LLM proxy as a Cloudflare Worker.
 *
 * Deploy:
 *   npx wrangler deploy proxy/worker.js --name PRIVO-llm-proxy
 *   npx wrangler secret put ANTHROPIC_API_KEY
 *
 * Then in src/config.ts:
 *   baseURL: 'https://PRIVO-llm-proxy.<your-subdomain>.workers.dev/v1'
 */
const UPSTREAM = 'https://api.anthropic.com'

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*', // tighten to your extension origin if desired
	'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	'Access-Control-Max-Age': '86400',
}

export default {
	async fetch(request, env) {
		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })

		const url = new URL(request.url)
		if (!url.pathname.startsWith('/v1/')) {
			return json({ error: 'Only /v1/* is proxied' }, 404)
		}

		const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
			method: request.method,
			headers: {
				'Content-Type': request.headers.get('content-type') ?? 'application/json',
				Authorization: `Bearer ${env.ANTHROPIC_API_KEY}`, // key lives in Worker secrets
			},
			body: request.body,
		})

		const headers = new Headers(upstream.headers)
		for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
		return new Response(upstream.body, { status: upstream.status, headers })
	},
}

function json(obj, status = 200) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
	})
}
