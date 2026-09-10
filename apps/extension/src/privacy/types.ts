/**
 * Classification label for a single DOM content span.
 *
 *  CONFIDENTIAL — must never reach the LLM; will be replaced with [REDACTED]
 *  SHAREABLE    — safe to forward verbatim
 */
export type PrivacyLabel = 'CONFIDENTIAL' | 'SHAREABLE'

/**
 * A classified span of text extracted from BrowserState.content.
 * The classifier produces an ordered array of these covering the entire input.
 */
export interface ContentToken {
	/** Original text of this span */
	raw: string
	/** Privacy classification assigned by the classifier */
	label: PrivacyLabel
	/** Human-readable reason (which pattern triggered); only set for CONFIDENTIAL tokens */
	reason?: string
}

/**
 * Output of the full pipeline (classify → sanitize → validate).
 * The `safeContent` field is the only value that leaves the privacy module.
 * All other fields are for local audit logging only and must never be forwarded.
 */
export interface PipelineResult {
	/** Sanitized content string — safe to send to the LLM */
	safeContent: string
	/** Number of tokens classified CONFIDENTIAL and redacted */
	redactedCount: number
	/** True when the final validation pass found no residual PII */
	validated: boolean
	/**
	 * Tokens that were redacted.
	 * Available for local debug/audit logging — NEVER forward to LLM or backend.
	 */
	redactedTokens: ContentToken[]
}
