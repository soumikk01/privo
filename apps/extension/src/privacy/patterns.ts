/**
 * Pattern definitions for regex-based DOM content classification and PII detection.
 *
 * Each pattern specifies a classification label and a redact label used for replacement.
 */
export interface PrivacyPattern {
	name: string
	category: string
	regex: RegExp
	redactLabel: string
}

export const PRIVACY_PATTERNS: PrivacyPattern[] = [
	{
		name: 'Generic API Key / Secret',
		category: 'API_KEY',
		regex: /\b(?:sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|bearer\s+[a-zA-Z0-9._-]{20,})\b/gi,
		redactLabel: '[REDACTED_API_KEY]'
	},
	{
		name: 'JSON Web Token (JWT)',
		category: 'API_KEY',
		regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		redactLabel: '[REDACTED_JWT]'
	},
	{
		name: 'Email Address',
		category: 'EMAIL',
		regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
		redactLabel: '[REDACTED_EMAIL]'
	},
	{
		name: 'Social Security Number (US SSN)',
		category: 'GOVT_ID',
		regex: /\b\d{3}-\d{2}-\d{4}\b/g,
		redactLabel: '[REDACTED_SSN]'
	},
	{
		name: 'Indian Aadhaar Number',
		category: 'GOVT_ID',
		regex: /\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/g,
		redactLabel: '[REDACTED_AADHAAR]'
	},
	{
		name: 'Credit Card Number',
		category: 'FINANCIAL',
		// Visa, MasterCard, Amex, Discover, etc.
		regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g,
		redactLabel: '[REDACTED_CREDIT_CARD]'
	},
	{
		name: 'Phone Number',
		category: 'PHONE',
		// Word boundary start to avoid matching sub-strings of API keys/hashes
		regex: /\b(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
		redactLabel: '[REDACTED_PHONE]'
	},
	{
		name: 'IPv4 Address',
		category: 'NETWORK',
		regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
		redactLabel: '[REDACTED_IP]'
	}
]
