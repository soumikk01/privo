// ─── Privo — PII Detector ─────────────────────────────────────────────────────
//
// Multi-source, contextual PII detection engine.
//
// Detection approach (layered confidence scoring):
//   1. Pattern match — regex gives base confidence (0.4–0.7)
//   2. Context boost — nearby keywords raise confidence (+0.0 – +0.3)
//   3. Field semantics — DOM field type raises confidence (passed in as hint)
//   4. Deduplication — same raw value → same placeholder (via registry)
//
// Minimum confidence for redaction: REDACTION_THRESHOLD (0.6)
//
// IMPORTANT: Detection is contextual. A 12-digit number alone is NOT Aadhaar.
// A 12-digit number adjacent to "Aadhaar" / inside input[name*=aadhaar] IS.

import { uid } from '../vendor/core/utils'
import type { PlaceholderRegistry } from './placeholder-registry'
import type { DetectedItem, PiiCategory } from './privacy-types'

export const REDACTION_THRESHOLD = 0.6

// ── Pattern library ───────────────────────────────────────────────────────────

interface PatternRule {
	category: PiiCategory
	pattern: RegExp
	baseConfidence: number
	/** Keywords that must appear nearby (+chars) to boost confidence */
	contextKeywords?: RegExp
	contextBoost?: number
}

const PATTERN_RULES: PatternRule[] = [
	// EMAIL — high confidence standalone (RFC 5321 approximate)
	{
		category: 'EMAIL',
		pattern: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
		baseConfidence: 0.92,
	},

	// PHONE — Indian mobile (10-digit) + international
	{
		category: 'PHONE',
		pattern: /(?:\+91[\s\-]?)?[6-9]\d{9}\b/g,
		baseConfidence: 0.55,
		contextKeywords: /\b(phone|mobile|contact|call|tel|whatsapp|no\.?)\b/i,
		contextBoost: 0.25,
	},
	// International: +country-code-(digits)
	{
		category: 'PHONE',
		pattern: /\+\d{1,3}[\s\-]?\(?\d{1,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{4}\b/g,
		baseConfidence: 0.7,
	},

	// DATE_OF_BIRTH — only with surrounding DOB context
	{
		category: 'DATE_OF_BIRTH',
		pattern: /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/g,
		baseConfidence: 0.25,
		contextKeywords: /\b(dob|date[\s_]?of[\s_]?birth|born|birth[\s_]?date|birthdate|d\.o\.b)\b/i,
		contextBoost: 0.55,
	},

	// AADHAAR — 12 digits, groups of 4 (####-####-####) OR plain 12-digit
	{
		category: 'AADHAAR',
		pattern: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g,
		baseConfidence: 0.3,
		contextKeywords: /\b(aadhaar|aadhar|uid|uidai|unique\s+identification)\b/i,
		contextBoost: 0.55,
	},

	// PASSPORT — Indian: [A-Z][0-9]{7}
	{
		category: 'PASSPORT',
		pattern: /\b[A-Z]\d{7}\b/g,
		baseConfidence: 0.4,
		contextKeywords: /\b(passport|passport\s+no|travel\s+doc)\b/i,
		contextBoost: 0.45,
	},

	// DRIVER LICENSE — Indian formats
	{
		category: 'DRIVER_LICENSE',
		pattern: /\b[A-Z]{2}\d{2}\s?\d{11}\b/g,
		baseConfidence: 0.5,
		contextKeywords: /\b(driving|dl|driver|license|licence)\b/i,
		contextBoost: 0.35,
	},

	// CARD_NUMBER — Luhn-ish: 13–19 digits with optional separators
	{
		category: 'CARD_NUMBER',
		pattern: /\b(?:\d{4}[\s\-]?){3}\d{1,7}\b/g,
		baseConfidence: 0.35,
		contextKeywords: /\b(card|credit|debit|visa|mastercard|rupay|amex|cvv|cvc|expir)\b/i,
		contextBoost: 0.5,
	},

	// ACCOUNT_NUMBER — 9–18 digits with bank/account context
	{
		category: 'ACCOUNT_NUMBER',
		pattern: /\b\d{9,18}\b/g,
		baseConfidence: 0.25,
		contextKeywords: /\b(account|a\/c|acct|bank|savings|current|ifsc|neft|rtgs)\b/i,
		contextBoost: 0.5,
	},

	// OTP — 4–8 digits with OTP context (standalone 4-8 digits alone = low confidence)
	{
		category: 'OTP',
		pattern: /\b\d{4,8}\b/g,
		baseConfidence: 0.2,
		contextKeywords: /\b(otp|one[\s\-]?time|verification\s+code|passcode|2fa|mfa|auth\s+code|confirm\s+code)\b/i,
		contextBoost: 0.65,
	},

	// BANK_INFO — IFSC code + account pairing
	{
		category: 'BANK_INFO',
		pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,   // IFSC format
		baseConfidence: 0.75,
	},

	// NAME — very low standalone confidence; only useful with DOM hints
	// (DOM scanner is the primary source for NAME detection)
	{
		category: 'NAME',
		pattern: /\b[A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g,
		baseConfidence: 0.15,
		contextKeywords: /\b(name|full\s+name|patient|applicant|holder|account\s+holder|your\s+name)\b/i,
		contextBoost: 0.45,
	},

	// ADDRESS — pincode with context
	{
		category: 'ADDRESS',
		pattern: /\b[1-9]\d{5}\b/g,   // Indian PIN code
		baseConfidence: 0.2,
		contextKeywords: /\b(address|pincode|pin|zip|city|state|street|flat|house|road|lane|nagar|colony)\b/i,
		contextBoost: 0.5,
	},

	// SECURITY_ANSWER — only with label context
	{
		category: 'SECURITY_ANSWER',
		pattern: /\S+/g,  // any non-empty value
		baseConfidence: 0.0,   // never fires on its own
		contextKeywords: /\b(security\s+question|secret\s+answer|mother.?s\s+maiden|first\s+pet|first\s+school)\b/i,
		contextBoost: 0.75,
	},
]

// ── Context window for keyword lookup ────────────────────────────────────────

const CONTEXT_WINDOW = 120  // characters to look around a match for keywords

function getContext(text: string, start: number, end: number): string {
	const from = Math.max(0, start - CONTEXT_WINDOW)
	const to = Math.min(text.length, end + CONTEXT_WINDOW)
	return text.slice(from, to)
}

// ── Core detection function ───────────────────────────────────────────────────

/**
 * Scan a plain text string for PII.
 *
 * @param text - The text to scan (DOM content, task, tool result, etc.)
 * @param registry - In-memory placeholder registry for this task session
 * @param source - Where this text came from ('dom' | 'text' | 'ocr' | 'vision')
 * @param domHints - Optional hints from DOM scanner to boost confidence for specific patterns
 * @returns Array of detected items with placeholders allocated
 */
export function detectPii(
	text: string,
	registry: PlaceholderRegistry,
	source: DetectedItem['source'] = 'text',
	domHints: Array<{ category: PiiCategory; contextBoost: number }> = [],
): DetectedItem[] {
	if (!text || !text.trim()) return []

	const detected: DetectedItem[] = []
	const seen = new Set<string>()  // dedup by match position key

	for (const rule of PATTERN_RULES) {
		// Reset regex state (global flag)
		rule.pattern.lastIndex = 0

		let match: RegExpExecArray | null
		while ((match = rule.pattern.exec(text)) !== null) {
			const rawValue = match[0]
			const start = match.index
			const end = start + rawValue.length

			const posKey = `${start}:${end}:${rule.category}`
			if (seen.has(posKey)) continue
			seen.add(posKey)

			// 1. Base confidence from pattern
			let confidence = rule.baseConfidence

			// 2. Context keyword boost
			if (rule.contextKeywords && rule.contextBoost) {
				const ctx = getContext(text, start, end)
				if (rule.contextKeywords.test(ctx)) {
					confidence = Math.min(1.0, confidence + rule.contextBoost)
				}
			}

			// 3. DOM hint boost — if DOM scanner signaled this category on this page
			for (const hint of domHints) {
				if (hint.category === rule.category) {
					confidence = Math.min(1.0, confidence + hint.contextBoost)
				}
			}

			// 4. Skip below threshold
			if (confidence < REDACTION_THRESHOLD) continue

			// 5. Allocate placeholder (deduplicates same raw value)
			const placeholder = registry.allocate(rule.category, rawValue)

			detected.push({
				id: uid(),
				category: rule.category,
				confidence,
				source,
				start,
				end,
				placeholder,
				rawValue,  // MEMORY ONLY — stripped before model context
			})
		}
	}

	// Sort by start position for correct substitution order
	return detected.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
}

// ── Convenience: detect from multiple sources ─────────────────────────────────

export function detectPiiInSources(
	sources: Array<{ text: string; source: DetectedItem['source'] }>,
	registry: PlaceholderRegistry,
	domHints: Array<{ category: PiiCategory; contextBoost: number }> = [],
): DetectedItem[] {
	return sources.flatMap(({ text, source }) =>
		detectPii(text, registry, source, domHints)
	)
}
