// ─── Privo — Privacy Report Builder ──────────────────────────────────────────
//
// Builds a RedactionReport from collected DetectedItem arrays.
// Strips rawValue from all items before packaging — safe for UI/logging/model report.

import type { DetectedItem, PiiCategory, PublicDetectedItem, RedactionReport } from './privacy-types'
import { toPublicDetectedItem } from './privacy-types'

export function buildRedactionReport(params: {
	allDetectedItems: DetectedItem[]
	sanitizedSources: string[]
	blockedReasons: string[]
	scanStartMs: number
}): RedactionReport {
	const { allDetectedItems, sanitizedSources, blockedReasons, scanStartMs } = params

	// Strip rawValue from every item before building the public report
	const publicItems: PublicDetectedItem[] = allDetectedItems.map(toPublicDetectedItem)

	// Unique categories that were found (and thus redacted if above threshold)
	const redactedCategories = [...new Set<PiiCategory>(
		allDetectedItems.map((i) => i.category)
	)]

	return {
		detectedItems: publicItems,
		redactedCategories,
		sanitizedSources,
		blockedReasons,
		scanDurationMs: Date.now() - scanStartMs,
		timestamp: Date.now(),
	}
}
