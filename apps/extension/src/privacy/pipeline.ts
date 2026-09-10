import { classifyContent } from './classifier'
import { sanitizeTokens } from './sanitizer'

import { PipelineResult, PrivacyPipelineOptions } from './types'
import { validateSanitizedContent } from './validator'

/**
 * Main privacy pipeline entry point.
 *
 * Takes raw extracted DOM string / page content state, runs local classification,
 * redacts all CONFIDENTIAL tokens, performs final defense-in-depth validation,
 * and returns the safe content to be sent to the LLM.
 *
 * Compatible with PageAgentCore's `transformPageContent` hook.
 */
export function transformPageContentForPrivacy(
	content: string,
	options: PrivacyPipelineOptions = {}
): PipelineResult {
	const { enabled = true, debugLog = false } = options

	if (!enabled || !content) {
		return {
			safeContent: content || '',
			redactedCount: 0,
			validated: true,
			redactedTokens: []
		}
	}

	// 1. Classification pass (DOM extraction -> CONFIDENTIAL vs SHAREABLE tokens)
	const tokens = classifyContent(content)

	// 2. Sanitization pass
	const { sanitizedText, redactedCount, redactedTokens } = sanitizeTokens(tokens)

	// 3. Final Validation pass (defense-in-depth)
	const validation = validateSanitizedContent(sanitizedText)

	if (debugLog && redactedCount > 0) {
		console.log(`[Privo Privacy Pipeline] Redacted ${redactedCount} CONFIDENTIAL token(s).`)
	}

	return {
		safeContent: validation.cleanedContent,
		redactedCount,
		validated: validation.valid,
		redactedTokens
	}
}

/**
 * Adapter helper matching PageAgentCore's `transformPageContent?: (content: string) => string` signature.
 */
export function createPrivacyTransformHook(options: PrivacyPipelineOptions = {}): (content: string) => string {
	return (content: string): string => {
		const result = transformPageContentForPrivacy(content, options)
		return result.safeContent
	}
}
