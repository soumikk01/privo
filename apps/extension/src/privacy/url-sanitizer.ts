// ─── Privo — URL & Title Sanitizer ───────────────────────────────────────────
//
// Sanitizes URLs (path, query params, fragment, embedded credentials) and
// page titles before they are sent to the cloud model.
//
// Navigation-critical parts (host, clean path) are preserved.
// Sensitive query param values and credentials are replaced with placeholders.

import { detectPii } from './pii-detector'
import { detectSecrets } from './secret-detector'
import type { PlaceholderRegistry } from './placeholder-registry'
import type { DetectedItem } from './privacy-types'
import { sanitizeText } from './text-sanitizer'

/**
 * Sanitize a URL, removing or replacing sensitive components.
 *
 * Specifically:
 * - Strips user:password@ from URLs (always)
 * - Scans each query parameter value through PII + secret detectors
 * - Replaces sensitive param values with placeholders
 * - Preserves host, path, and non-sensitive params for navigation context
 * - Removes fragment if it contains sensitive patterns
 *
 * @returns sanitized URL string and any items detected
 */
export function sanitizeUrl(
	url: string,
	registry: PlaceholderRegistry,
): { sanitizedUrl: string; detectedItems: DetectedItem[] } {
	const detectedItems: DetectedItem[] = []

	try {
		const u = new URL(url)

		// 1. Strip embedded credentials (user:password@host)
		u.username = ''
		u.password = ''

		// 2. Scan and sanitize query parameter values
		const newParams = new URLSearchParams()
		for (const [key, value] of u.searchParams) {
			const piiItems = detectPii(value, registry, 'text')
			const secretItems = detectSecrets(value, registry, 'text')
			const allItems = [...piiItems, ...secretItems]

			if (allItems.length > 0) {
				detectedItems.push(...allItems)
				// Use the first placeholder as the param value
				newParams.set(key, allItems[0].placeholder)
			} else {
				newParams.set(key, value)
			}
		}
		u.search = newParams.toString()

		// 3. Scan and sanitize the fragment (after #)
		if (u.hash) {
			const fragText = u.hash.slice(1)
			const fragPii = detectPii(fragText, registry, 'text')
			const fragSecrets = detectSecrets(fragText, registry, 'text')
			if (fragPii.length > 0 || fragSecrets.length > 0) {
				detectedItems.push(...fragPii, ...fragSecrets)
				u.hash = ''  // remove sensitive fragment entirely
			}
		}

		return { sanitizedUrl: u.toString(), detectedItems }
	} catch {
		// Invalid URL — run text sanitizer on the raw string as fallback
		const piiItems = detectPii(url, registry, 'text')
		const secretItems = detectSecrets(url, registry, 'text')
		const allItems = [...piiItems, ...secretItems]
		detectedItems.push(...allItems)
		return { sanitizedUrl: sanitizeText(url, allItems), detectedItems }
	}
}

/**
 * Sanitize a page title.
 * Titles can contain names, emails, account numbers (e.g. "Account 4839201 — Dashboard").
 */
export function sanitizeTitle(
	title: string,
	registry: PlaceholderRegistry,
): { sanitizedTitle: string; detectedItems: DetectedItem[] } {
	const piiItems = detectPii(title, registry, 'text')
	const secretItems = detectSecrets(title, registry, 'text')
	const allItems = [...piiItems, ...secretItems]
	return {
		sanitizedTitle: sanitizeText(title, allItems),
		detectedItems: allItems,
	}
}
