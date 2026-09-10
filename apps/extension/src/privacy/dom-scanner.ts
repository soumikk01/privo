// ─── Privo — DOM Scanner ──────────────────────────────────────────────────────
//
// Inspects DOM element metadata (field types, labels, autocomplete attributes)
// to identify sensitive fields WITHOUT extracting their values.
//
// The DOM scanner classifies field positions. Values never pass through here.
// The results feed confidence hints to the PII detector and redaction pipeline.

import type { DomSensitiveField, PiiCategory } from './privacy-types'

// ── Sensitive field classification rules ──────────────────────────────────────

interface FieldRule {
	category: PiiCategory
	confidence: number
	/** Match against input type attribute */
	inputType?: RegExp
	/** Match against autocomplete attribute */
	autocomplete?: RegExp
	/** Match against name, id, or aria-label (case-insensitive) */
	namePattern?: RegExp
	/** Match against nearby label text or placeholder */
	labelPattern?: RegExp
}

const FIELD_RULES: FieldRule[] = [
	// Password — near-certain from type alone
	{
		category: 'PASSWORD',
		confidence: 1.0,
		inputType: /^password$/i,
	},

	// Email
	{
		category: 'EMAIL',
		confidence: 0.95,
		inputType: /^email$/i,
	},
	{
		category: 'EMAIL',
		confidence: 0.85,
		autocomplete: /^email$/i,
	},
	{
		category: 'EMAIL',
		confidence: 0.75,
		namePattern: /\bemail\b/i,
	},

	// Phone
	{
		category: 'PHONE',
		confidence: 0.9,
		inputType: /^tel$/i,
	},
	{
		category: 'PHONE',
		confidence: 0.8,
		autocomplete: /^tel$/i,
	},
	{
		category: 'PHONE',
		confidence: 0.7,
		namePattern: /\b(phone|mobile|tel|contact)\b/i,
	},

	// Card number
	{
		category: 'CARD_NUMBER',
		confidence: 0.95,
		autocomplete: /^cc-number$/i,
	},
	{
		category: 'CARD_NUMBER',
		confidence: 0.8,
		namePattern: /\b(card[\s_\-]?num|cardno|cc[\s_\-]?num)\b/i,
	},

	// CVV / security code
	{
		category: 'SECURITY_ANSWER',
		confidence: 0.9,
		autocomplete: /^cc-csc$/i,
	},
	{
		category: 'SECURITY_ANSWER',
		confidence: 0.8,
		namePattern: /\b(cvv|cvc|csc|security[\s_]?code)\b/i,
	},

	// Card expiry
	{
		category: 'CARD_NUMBER',
		confidence: 0.8,
		autocomplete: /^cc-exp/i,
	},

	// OTP / one-time code
	{
		category: 'OTP',
		confidence: 0.88,
		namePattern: /\b(otp|one[\s_\-]?time|verification[\s_]?code|passcode|2fa|mfa|auth[\s_]?code)\b/i,
	},
	{
		category: 'OTP',
		confidence: 0.8,
		labelPattern: /\b(otp|one[\s_\-]?time|verification\s+code)\b/i,
	},
	{
		category: 'OTP',
		confidence: 0.75,
		autocomplete: /^one-time-code$/i,
	},

	// Aadhaar
	{
		category: 'AADHAAR',
		confidence: 0.9,
		namePattern: /\b(aadhaar|aadhar|uid)\b/i,
	},
	{
		category: 'AADHAAR',
		confidence: 0.85,
		labelPattern: /\b(aadhaar|aadhar)\b/i,
	},

	// PAN / Government ID
	{
		category: 'GOVERNMENT_ID',
		confidence: 0.85,
		namePattern: /\b(pan|pancard|govt[\s_]?id|national[\s_]?id)\b/i,
	},

	// Bank account / IFSC
	{
		category: 'ACCOUNT_NUMBER',
		confidence: 0.85,
		namePattern: /\b(account[\s_]?no|acc[\s_]?no|acct|bank[\s_]?acc)\b/i,
	},
	{
		category: 'BANK_INFO',
		confidence: 0.85,
		namePattern: /\b(ifsc|swift[\s_]?code|sort[\s_]?code)\b/i,
	},

	// Name
	{
		category: 'NAME',
		confidence: 0.75,
		autocomplete: /^(name|given-name|family-name|full-name)$/i,
	},
	{
		category: 'NAME',
		confidence: 0.65,
		namePattern: /\b(full[\s_]?name|first[\s_]?name|last[\s_]?name|applicant[\s_]?name)\b/i,
	},

	// Address
	{
		category: 'ADDRESS',
		confidence: 0.8,
		autocomplete: /^street-address$/i,
	},
	{
		category: 'ADDRESS',
		confidence: 0.7,
		namePattern: /\b(address|street|city|state|pincode|zipcode)\b/i,
	},

	// DOB
	{
		category: 'DATE_OF_BIRTH',
		confidence: 0.85,
		namePattern: /\b(dob|date[\s_]?of[\s_]?birth|birth[\s_]?date)\b/i,
	},
	{
		category: 'DATE_OF_BIRTH',
		confidence: 0.75,
		autocomplete: /^bday/i,
	},

	// Security question answer
	{
		category: 'SECURITY_ANSWER',
		confidence: 0.8,
		namePattern: /\b(security[\s_]?answer|secret[\s_]?answer)\b/i,
	},
	{
		category: 'SECURITY_ANSWER',
		confidence: 0.75,
		labelPattern: /\b(mother.?s\s+maiden|first\s+pet|first\s+school)\b/i,
	},
]

// ── Representation of a DOM element for scanning ─────────────────────────────

export interface DomElementMeta {
	/** The [N] index from the PageController element tree */
	elementId: string
	tagName: string
	inputType?: string
	autocomplete?: string
	name?: string
	id?: string
	ariaLabel?: string
	placeholder?: string
	/** Text of the closest associated <label> */
	labelText?: string
	/** Text surrounding this element in the DOM */
	surroundingText?: string
}

// ── Scan ──────────────────────────────────────────────────────────────────────

/**
 * Scan a list of DOM element descriptors for sensitive field classification.
 *
 * The input is derived from the PageController browser state — it contains
 * only metadata (types, attributes, labels), not field values.
 *
 * @returns Array of sensitive field classifications, sorted by confidence desc
 */
export function scanDomElements(elements: DomElementMeta[]): DomSensitiveField[] {
	const results: DomSensitiveField[] = []

	for (const el of elements) {
		// Only scan input-like elements
		if (!['input', 'textarea', 'select'].includes(el.tagName.toLowerCase())) continue

		let best: DomSensitiveField | null = null

		for (const rule of FIELD_RULES) {
			let match = false

			if (rule.inputType && el.inputType) {
				match = rule.inputType.test(el.inputType)
			}
			if (!match && rule.autocomplete && el.autocomplete) {
				match = rule.autocomplete.test(el.autocomplete)
			}
			if (!match && rule.namePattern) {
				const combined = [el.name, el.id, el.ariaLabel, el.placeholder]
					.filter(Boolean).join(' ')
				match = rule.namePattern.test(combined)
			}
			if (!match && rule.labelPattern) {
				const labelCombined = [el.labelText, el.surroundingText]
					.filter(Boolean).join(' ')
				match = rule.labelPattern.test(labelCombined)
			}

			if (match && (!best || rule.confidence > best.confidence)) {
				best = {
					elementId: el.elementId,
					category: rule.category,
					confidence: rule.confidence,
					fieldType: el.inputType ?? el.tagName,
					autocomplete: el.autocomplete,
					label: el.labelText,
				}
			}
		}

		if (best) results.push(best)
	}

	return results.sort((a, b) => b.confidence - a.confidence)
}

/**
 * Parse the raw browser-state DOM text from PageController into element descriptors.
 * The PageController emits a compact text like:
 *   [12]<input type="password" name="password" />
 *   [13]<input type="email" id="email" placeholder="user@example.com" />
 *
 * This parser extracts element IDs and attributes from that format.
 */
export function parseElementsFromDomText(domText: string): DomElementMeta[] {
	const elements: DomElementMeta[] = []
	// Match lines like [N]<tagname attr="val" ... />  or  [N]<tagname attr="val" ...>text</tagname>
	const lineRe = /\[(\d+)\]<(\w+)([^>]*)>/gi
	let m: RegExpExecArray | null
	while ((m = lineRe.exec(domText)) !== null) {
		const elementId = m[1]
		const tagName = m[2]
		const attrStr = m[3]

		const getAttr = (name: string): string | undefined => {
			const r = new RegExp(`\\s${name}=["']?([^"'>\\s]*)["']?`, 'i')
			const match = r.exec(attrStr)
			return match ? match[1] : undefined
		}

		elements.push({
			elementId,
			tagName,
			inputType: getAttr('type'),
			autocomplete: getAttr('autocomplete'),
			name: getAttr('name'),
			id: getAttr('id'),
			ariaLabel: getAttr('aria-label'),
			placeholder: getAttr('placeholder'),
		})
	}
	return elements
}

/**
 * Convenience: scan a raw DOM text string from the agent's browser state.
 * Returns both the sensitive fields AND DOM hints suitable for feeding into detectPii().
 */
export function scanDomContent(domText: string): {
	sensitiveFields: DomSensitiveField[]
	piiHints: Array<{ category: PiiCategory; contextBoost: number }>
} {
	const elements = parseElementsFromDomText(domText)
	const sensitiveFields = scanDomElements(elements)
	const piiHints = sensitiveFields.map((f) => ({
		category: f.category,
		contextBoost: Math.min(0.3, f.confidence * 0.35),
	}))
	return { sensitiveFields, piiHints }
}
