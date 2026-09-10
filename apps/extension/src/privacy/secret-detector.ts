// ─── Privo — Secret Detector ──────────────────────────────────────────────────
//
// Detects developer/system secrets separate from ordinary PII.
// Applied to: task text, DOM, URL query params, tool results, history.
//
// Secrets that are detected here must be sanitized before cloud transmission.

import { uid } from '../vendor/core/utils'
import type { PlaceholderRegistry } from './placeholder-registry'
import type { DetectedItem } from './privacy-types'
import { REDACTION_THRESHOLD } from './pii-detector'

// ── Secret pattern rules ──────────────────────────────────────────────────────

interface SecretRule {
	category: DetectedItem['category']
	pattern: RegExp
	confidence: number
	name: string
}

const SECRET_RULES: SecretRule[] = [
	// Anthropic API key
	{ name: 'Anthropic API Key', category: 'API_KEY', pattern: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g, confidence: 0.98 },
	// OpenAI API key (legacy sk- and modern sk-proj-)
	{ name: 'OpenAI API Key', category: 'API_KEY', pattern: /\bsk-(?:proj-)?[A-Za-z0-9\-_]{20,}\b/g, confidence: 0.92 },
	// Google API key
	{ name: 'Google API Key', category: 'API_KEY', pattern: /\bAIza[A-Za-z0-9\-_]{35}\b/g, confidence: 0.96 },
	// AWS access key
	{ name: 'AWS Access Key', category: 'API_KEY', pattern: /\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g, confidence: 0.97 },
	// Slack bot token
	{ name: 'Slack Token', category: 'ACCESS_TOKEN', pattern: /\bxox[bpaosr]-[A-Za-z0-9\-]{24,}\b/g, confidence: 0.97 },
	// GitHub tokens
	{ name: 'GitHub Token', category: 'ACCESS_TOKEN', pattern: /\bghp_[A-Za-z0-9]{30,}\b/g, confidence: 0.97 },
	{ name: 'GitHub Token', category: 'ACCESS_TOKEN', pattern: /\bghs_[A-Za-z0-9]{30,}\b/g, confidence: 0.97 },
	// Generic Bearer token in text
	{ name: 'Bearer Token', category: 'ACCESS_TOKEN', pattern: /\bBearer\s+([A-Za-z0-9\-_.~+/]+=*)\b/g, confidence: 0.88 },
	// JWT (three base64url segments)
	{
		name: 'JWT',
		category: 'JWT',
		pattern: /\beyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/g,
		confidence: 0.95,
	},
	// PEM private key
	{ name: 'Private Key', category: 'PRIVATE_KEY', pattern: /-----BEGIN\s(?:RSA\s|EC\s|OPENSSH\s|DSA\s)?PRIVATE KEY-----/g, confidence: 0.99 },
	// Database connection strings with credentials
	{
		name: 'DB Connection',
		category: 'DB_CONNECTION_STRING',
		pattern: /\b(?:postgres|postgresql|mysql|mongodb|redis|mssql|oracle):\/\/[^:@\s]+:[^@\s]+@/gi,
		confidence: 0.95,
	},
	// Webhook secret / generic high-entropy hex secrets (32+ hex chars after 'secret')
	{
		name: 'Webhook Secret',
		category: 'WEBHOOK_SECRET',
		pattern: /(?:secret|token|key|api_?key|webhook)[=:\s]+['"]?([0-9a-fA-F]{32,}|[A-Za-z0-9+/]{40,}=*)['"]?/gi,
		confidence: 0.75,
	},
	// Session token (common patterns)
	{
		name: 'Session Token',
		category: 'SESSION_TOKEN',
		pattern: /(?:session|sess)[_\-]?(?:token|id|key|secret)[=:\s]+['"]?([A-Za-z0-9\-_.]{16,})['"]?/gi,
		confidence: 0.7,
	},
]

/**
 * Scan text for developer/system secrets.
 *
 * @param text - Text to scan
 * @param registry - Placeholder registry for this task session
 * @param source - Origin of the text
 */
export function detectSecrets(
	text: string,
	registry: PlaceholderRegistry,
	source: DetectedItem['source'] = 'text',
): DetectedItem[] {
	if (!text || !text.trim()) return []

	const detected: DetectedItem[] = []
	const seen = new Set<string>()

	for (const rule of SECRET_RULES) {
		rule.pattern.lastIndex = 0

		let match: RegExpExecArray | null
		while ((match = rule.pattern.exec(text)) !== null) {
			const rawValue = match[0]
			const start = match.index
			const end = start + rawValue.length

			if (rule.confidence < REDACTION_THRESHOLD) continue

			const posKey = `${start}:${end}:${rule.category}`
			if (seen.has(posKey)) continue
			seen.add(posKey)

			const placeholder = registry.allocate(rule.category, rawValue)

			detected.push({
				id: uid(),
				category: rule.category,
				confidence: rule.confidence,
				source,
				start,
				end,
				placeholder,
				rawValue,  // MEMORY ONLY
			})
		}
	}

	return detected.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
}

/**
 * Scan URL for secrets in query parameters.
 * Returns detected items and a sanitized URL with sensitive param values replaced.
 */
export function detectSecretsInUrl(
	url: string,
	registry: PlaceholderRegistry,
): { items: DetectedItem[]; sanitizedUrl: string } {
	const items: DetectedItem[] = []
	try {
		const u = new URL(url)
		const sensitiveParams = new Map<string, string>()

		// Scan each query param value
		for (const [key, value] of u.searchParams) {
			const found = detectSecrets(value, registry, 'text')
			if (found.length > 0) {
				items.push(...found)
				sensitiveParams.set(key, found[0].placeholder)
			}
		}

		// Replace sensitive param values with placeholders
		if (sensitiveParams.size > 0) {
			const newU = new URL(url)
			for (const [key, placeholder] of sensitiveParams) {
				newU.searchParams.set(key, placeholder)
			}
			return { items, sanitizedUrl: newU.toString() }
		}
	} catch {
		// Invalid URL — fall through
	}
	return { items, sanitizedUrl: url }
}
