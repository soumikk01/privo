import { PRIVACY_PATTERNS } from './patterns'

export interface ValidationResult {
	valid: boolean
	violations: string[]
	cleanedContent: string
}

/**
 * Validates that sanitized text contains no remaining CONFIDENTIAL PII or secret leakages.
 * Acts as a final defense-in-depth safety check before data leaves the browser.
 */
export function validateSanitizedContent(content: string): ValidationResult {
	const violations: string[] = []
	let cleanedContent = content

	for (const pattern of PRIVACY_PATTERNS) {
		pattern.regex.lastIndex = 0
		let match: RegExpExecArray | null

		while ((match = pattern.regex.exec(cleanedContent)) !== null) {
			const leakedSnippet = match[0]
			violations.push(`Residual ${pattern.name} found: "${leakedSnippet.slice(0, 10)}..."`)

			// Defense-in-depth: forcibly strip any residual match missed in primary pass
			cleanedContent =
				cleanedContent.slice(0, match.index) +
				pattern.redactLabel +
				cleanedContent.slice(match.index + leakedSnippet.length)

			// Reset index to re-scan
			pattern.regex.lastIndex = 0
		}
	}

	return {
		valid: violations.length === 0,
		violations,
		cleanedContent
	}
}
