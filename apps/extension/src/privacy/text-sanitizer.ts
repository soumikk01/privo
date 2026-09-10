// ─── Privo — Text Sanitizer ───────────────────────────────────────────────────
//
// Replaces detected PII/secret values in text with stable placeholders.
// Operates on the DetectedItem list produced by pii-detector + secret-detector.
//
// Example:
//   Input:  "Email: user@example.com  Account: 483920184"
//   Output: "Email: EMAIL_1  Account: ACCOUNT_NUMBER_1"
//
// Replacement is done right-to-left (by end position) to preserve offsets.

import type { DetectedItem } from './privacy-types'

/**
 * Sanitize a text string by replacing all detected PII items with placeholders.
 *
 * @param text - Raw text to sanitize
 * @param detectedItems - Items detected by pii-detector / secret-detector in this text
 * @returns Sanitized text with raw values replaced by placeholder labels
 */
export function sanitizeText(text: string, detectedItems: DetectedItem[]): string {
	if (!text || detectedItems.length === 0) return text

	// Only process items that have position information and are from 'text' or 'dom' or 'ocr'
	const positioned = detectedItems.filter(
		(item) => typeof item.start === 'number' && typeof item.end === 'number'
	)
	if (positioned.length === 0) {
		// Fallback: string replacement for items without position info
		return sanitizeTextByValue(text, detectedItems)
	}

	// Sort descending by start position — replace from end to start
	// so earlier offsets remain valid after each substitution.
	const sorted = [...positioned].sort((a, b) => (b.start ?? 0) - (a.start ?? 0))

	let result = text
	for (const item of sorted) {
		const { start, end, placeholder } = item
		if (start === undefined || end === undefined) continue
		result = result.slice(0, start) + placeholder + result.slice(end)
	}

	// Also replace any items that lacked char offsets (e.g. from DOM scanner)
	const unpositioned = detectedItems.filter(
		(item) => typeof item.start !== 'number' || typeof item.end !== 'number'
	)
	if (unpositioned.length > 0) {
		result = sanitizeTextByValue(result, unpositioned)
	}

	return result
}

/**
 * Fallback sanitizer: replaces raw values by string search when position info is missing.
 * Less precise but catches items found via DOM or vision with no text offset.
 */
function sanitizeTextByValue(text: string, items: DetectedItem[]): string {
	let result = text
	for (const item of items) {
		if (!item.rawValue) continue
		// Escape for regex use
		const escaped = item.rawValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		result = result.replace(new RegExp(escaped, 'g'), item.placeholder)
	}
	return result
}

/**
 * Sanitize multiple text strings in a single pass.
 * Each string is scanned for the full list of detected items.
 *
 * @param texts - Array of raw texts
 * @param detectedItems - All detected items across the scan session
 * @returns Array of sanitized texts in the same order
 */
export function sanitizeTexts(texts: string[], detectedItems: DetectedItem[]): string[] {
	return texts.map((t) => sanitizeText(t, detectedItems))
}
