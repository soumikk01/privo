import { describe, expect, it } from 'vitest'
import { classifyContent } from '../classifier'
import { transformPageContentForPrivacy } from '../pipeline'
import { validateSanitizedContent } from '../validator'

describe('Privacy Pipeline - Classification & Sanitization', () => {
	it('redacts email addresses from DOM content', () => {
		const rawDOM = 'User account page for john.doe@example.com with profile info.'
		const result = transformPageContentForPrivacy(rawDOM)

		expect(result.safeContent).not.toContain('john.doe@example.com')
		expect(result.safeContent).toContain('[REDACTED_EMAIL]')
		expect(result.redactedCount).toBe(1)
		expect(result.validated).toBe(true)
	})

	it('redacts phone numbers and SSN', () => {
		const rawDOM = 'Contact us at 555-123-4567 or SSN 123-45-6789.'
		const result = transformPageContentForPrivacy(rawDOM)

		expect(result.safeContent).not.toContain('555-123-4567')
		expect(result.safeContent).not.toContain('123-45-6789')
		expect(result.safeContent).toContain('[REDACTED_PHONE]')
		expect(result.safeContent).toContain('[REDACTED_SSN]')
		expect(result.redactedCount).toBe(2)
	})

	it('redacts API keys and secrets', () => {
		const rawDOM = 'API Key configured: sk-1234567890abcdef1234567890.'
		const result = transformPageContentForPrivacy(rawDOM)

		expect(result.safeContent).not.toContain('sk-1234567890abcdef1234567890')
		expect(result.safeContent).toContain('[REDACTED_API_KEY]')
	})

	it('redacts sensitive form attributes', () => {
		const rawDOM = '<input type="password" value="mysecretpass123" />'
		const result = transformPageContentForPrivacy(rawDOM)

		expect(result.safeContent).toContain('[REDACTED_SENSITIVE_FIELD]')
	})

	it('leaves pure SHAREABLE content intact', () => {
		const rawDOM = 'Welcome to Example.com! Browse our public products and documentation.'
		const result = transformPageContentForPrivacy(rawDOM)

		expect(result.safeContent).toBe(rawDOM)
		expect(result.redactedCount).toBe(0)
		expect(result.validated).toBe(true)
	})

	it('validator passes defense-in-depth scan on clean content', () => {
		const clean = 'This is completely safe text with no PII.'
		const validation = validateSanitizedContent(clean)
		expect(validation.valid).toBe(true)
		expect(validation.violations.length).toBe(0)
	})
})
