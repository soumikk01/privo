export const DEFAULT_LLM_CONFIG = {
	baseURL: 'http://localhost:8787/v1',
	model: 'claude-sonnet-4-6',
	apiKey: '', // key lives server-side — do not set here
	maxSteps: 40,
	maxRetries: 3, // network/5xx/rate-limit errors retry with exponential backoff before failing the task

	// Anthropic's OpenAI-compat endpoint only accepts 'auto' | 'required' | 'none'.
	disableNamedToolChoice: true,

	// The engine's modelPatch rewrites claude-* requests to Anthropic-native format
	// (tool_choice {type:'any'}, thinking). The OpenAI-compat endpoint rejects that.
	// transformRequestBody runs after modelPatch, so this always wins.
	transformRequestBody: (body: Record<string, unknown>) => {
		const tc = body.tool_choice as { type?: string; name?: string } | string | undefined
		if (tc && typeof tc === 'object') {
			if (tc.type === 'any') body.tool_choice = 'required'
			else if (tc.type === 'tool' && tc.name)
				body.tool_choice = { type: 'function', function: { name: tc.name } }
		}
		delete body.thinking
		return body
	},
}

export const BACKEND_URL = DEFAULT_LLM_CONFIG.baseURL.replace(/\/v1\/?$/, '')

// If empty, protected routes are open — only safe in local dev with no network exposure.
export const EXTENSION_SECRET: string = import.meta.env.VITE_EXTENSION_SECRET ?? ''

export const llmFetch: typeof globalThis.fetch = (input, init = {}) => {
	const headers = new Headers(init.headers)
	if (EXTENSION_SECRET) {
		headers.set('X-Extension-Secret', EXTENSION_SECRET)
	}
	return fetch(input, { ...init, headers })
}
