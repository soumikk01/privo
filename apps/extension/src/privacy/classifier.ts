import { PRIVACY_PATTERNS } from './patterns'
import { ContentToken, PrivacyLabel } from './types'

/**
 * Classifies raw DOM content into tokens marked as CONFIDENTIAL or SHAREABLE.
 *
 * Scans string content for PII patterns, sensitive metadata tags, and secret formats.
 */
export function classifyContent(content: string): ContentToken[] {
	if (!content || typeof content !== 'string') {
		return []
	}

	const tokens: ContentToken[] = []
	const matches: Array<{ start: number; end: number; text: string; label: PrivacyLabel; redactLabel: string; reason: string }> = []

	// 1. Scan for regex patterns
	for (const pattern of PRIVACY_PATTERNS) {
		// Reset regex index
		pattern.regex.lastIndex = 0
		let match: RegExpExecArray | null

		while ((match = pattern.regex.exec(content)) !== null) {
			const matchedText = match[0]
			const start = match.index
			const end = start + matchedText.length

			matches.push({
				start,
				end,
				text: matchedText,
				label: 'CONFIDENTIAL',
				redactLabel: pattern.redactLabel,
				reason: `Matched pattern: ${pattern.name}`
			})
		}
	}

	// 2. Scan for form input element secrets (e.g. password fields, secret attributes in serialized DOM)
	const sensitiveAttributeRegex = /(?:type|name|id|autocomplete)\s*=\s*["']?(?:password|cvv|cvc|ssn|secret|creditcard|cardnumber)["']?/gi
	let attrMatch: RegExpExecArray | null
	while ((attrMatch = sensitiveAttributeRegex.exec(content)) !== null) {
		// Redact surrounding token window
		const start = Math.max(0, attrMatch.index)
		const end = Math.min(content.length, attrMatch.index + attrMatch[0].length)
		matches.push({
			start,
			end,
			text: attrMatch[0],
			label: 'CONFIDENTIAL',
			redactLabel: '[REDACTED_SENSITIVE_FIELD]',
			reason: 'Matched sensitive DOM attribute'
		})
	}

	// Sort matches by start position
	matches.sort((a, b) => a.start - b.start)

	// De-overlap matches
	const nonOverlappingMatches: typeof matches = []
	let lastEnd = 0

	for (const m of matches) {
		if (m.start >= lastEnd) {
			nonOverlappingMatches.push(m)
			lastEnd = m.end
		}
	}

	// 3. Build token sequence (interleaving SHAREABLE and CONFIDENTIAL tokens)
	let currentIndex = 0
	let tokenId = 0

	for (const m of nonOverlappingMatches) {
		if (m.start > currentIndex) {
			const text = content.slice(currentIndex, m.start)
			tokens.push({
				id: `token-${++tokenId}`,
				text,
				startIndex: currentIndex,
				endIndex: m.start,
				label: 'SHAREABLE'
			})
		}

		tokens.push({
			id: `token-${++tokenId}`,
			text: m.text,
			startIndex: m.start,
			endIndex: m.end,
			label: 'CONFIDENTIAL',
			redactLabel: m.redactLabel,
			reason: m.reason
		})

		currentIndex = m.end
	}

	if (currentIndex < content.length) {
		const text = content.slice(currentIndex)
		tokens.push({
			id: `token-${++tokenId}`,
			text,
			startIndex: currentIndex,
			endIndex: content.length,
			label: 'SHAREABLE'
		})
	}

	return tokens
}
