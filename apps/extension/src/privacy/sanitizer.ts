import { ContentToken } from './types'

export interface SanitizationResult {
	sanitizedText: string
	redactedCount: number
	redactedTokens: ContentToken[]
}

/**
 * Sanitizes classified tokens by replacing CONFIDENTIAL tokens with placeholders.
 */
export function sanitizeTokens(tokens: ContentToken[]): SanitizationResult {
	let sanitizedText = ''
	let redactedCount = 0
	const redactedTokens: ContentToken[] = []

	for (const token of tokens) {
		if (token.label === 'CONFIDENTIAL') {
			const placeholder = token.redactLabel || '[REDACTED]'
			sanitizedText += placeholder
			redactedCount++
			redactedTokens.push(token)
		} else {
			sanitizedText += token.text
		}
	}

	return {
		sanitizedText,
		redactedCount,
		redactedTokens
	}
}
