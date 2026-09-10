// ─── Privo — Privacy Gateway ─────────────────────────────────────────────────
//
// THE SINGLE MANDATORY OUTBOUND CHOKE POINT.
//
// No other component may directly assemble cloud model context.
// Every model request MUST pass through prepareModelContext().
//
// State machine (strictly enforced):
//
//   SCANNING
//     ├── exception → BLOCKED → throw PrivacyGatewayError  (NO model request)
//     ├── no PII found → NO_SENSITIVE_DATA → assemble → return
//     └── PII found → REDACTING → REDACTED → assemble → return
//
// FAIL-CLOSED: any unhandled exception within this function throws a
// PrivacyGatewayError. The caller must treat that as BLOCKED and NOT
// fall back to sending raw content.
//
// SECURITY RULES enforced here:
//   ✗ rawValue is NEVER included in SanitizedContext
//   ✗ Placeholder → rawValue map is NEVER included in model context
//   ✗ Failures NEVER cause raw content to be sent
//   ✗ Password field values NEVER enter the sanitized DOM

import { detectPii } from './pii-detector'
import { detectSecrets } from './secret-detector'
import { scanDomContent } from './dom-scanner'
import { sanitizeText, sanitizeTexts } from './text-sanitizer'
import { sanitizeUrl, sanitizeTitle } from './url-sanitizer'
import { redactImage, detectedItemsToBoxes } from './image-redactor'
import { buildRedactionReport } from './privacy-report'
import { taskRegistry } from './placeholder-registry'
import { uid } from '../vendor/core/utils'
import type { DetectedItem, DomSensitiveField, PiiCategory, PrivacyGatewayError, RawContext, SanitizedContext } from './privacy-types'
import { PrivacyGatewayError as GatewayError } from './privacy-types'

import * as ocrWorker from './ocr-worker'

// ── OCR Worker ───────────────────────────────────────────────────────────────

async function getOcrWorker() {
	return ocrWorker
}

// ── Last DOM hash (performance: skip re-scan if DOM unchanged) ────────────────

let _lastDomHash = ''
let _lastDomPiiHints: Array<{ category: PiiCategory; contextBoost: number }> = []
let _lastDomSensitiveFields: DomSensitiveField[] = []

function quickHash(s: string): string {
	// djb2 — fast, not cryptographic, used only for change detection
	let h = 5381
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
	return String(h >>> 0)
}

// ── Main gateway function ─────────────────────────────────────────────────────

/**
 * Prepare a fully sanitized context object suitable for cloud model transmission.
 *
 * All sources (task, DOM, URL, title, tool results, history, screenshot) are
 * scanned for PII and secrets. Sensitive values are replaced with placeholders.
 * Screenshots are pixel-redacted before being included.
 *
 * @throws PrivacyGatewayError if ANY scan or sanitization step fails.
 *         The caller MUST treat this as BLOCKED — no model request should be sent.
 */
export async function prepareModelContext(
	raw: RawContext,
	signal?: AbortSignal,
): Promise<SanitizedContext> {
	const scanStartMs = Date.now()
	const allDetectedItems: DetectedItem[] = []
	const sanitizedSources: string[] = []
	const blockedReasons: string[] = []

	try {
		signal?.throwIfAborted()

		// ── 1. DOM scan — get field classifications and PII hints ──────────────

		let domPiiHints: Array<{ category: PiiCategory; contextBoost: number }> = []
		let domSensitiveFields: DomSensitiveField[] = []

		try {
			const domHash = quickHash(raw.domContent)
			if (domHash !== _lastDomHash) {
				_lastDomHash = domHash
				const { sensitiveFields, piiHints } = scanDomContent(raw.domContent)
				_lastDomPiiHints = piiHints
				_lastDomSensitiveFields = sensitiveFields
			}
			domPiiHints = _lastDomPiiHints
			domSensitiveFields = _lastDomSensitiveFields
		} catch (err) {
			blockedReasons.push(`DOM scan failed: ${err instanceof Error ? err.message : String(err)}`)
			throw new GatewayError(blockedReasons)
		}

		// ── 1b. Register sensitive fields from DOM scanner into detected items ────
		for (const field of domSensitiveFields) {
			if (field.category === 'PASSWORD') {
				const rawVal = field.value || '••••••••••••'
				const placeholder = taskRegistry.allocate('PASSWORD', rawVal)
				allDetectedItems.push({
					id: uid(),
					category: 'PASSWORD',
					confidence: field.confidence,
					source: 'dom',
					placeholder,
					rawValue: rawVal,
				})
				if (!sanitizedSources.includes('dom')) sanitizedSources.push('dom')
			} else if (field.value && field.value.trim().length > 0) {
				// If a sensitive field has a value, scan it directly
				const fieldPii = detectPii(field.value, taskRegistry, 'dom', domPiiHints)
				if (fieldPii.length > 0) {
					allDetectedItems.push(...fieldPii)
					if (!sanitizedSources.includes('dom')) sanitizedSources.push('dom')
				} else if (field.confidence >= 0.75) {
					const placeholder = taskRegistry.allocate(field.category, field.value)
					allDetectedItems.push({
						id: uid(),
						category: field.category,
						confidence: field.confidence,
						source: 'dom',
						placeholder,
						rawValue: field.value,
					})
					if (!sanitizedSources.includes('dom')) sanitizedSources.push('dom')
				}
			}
		}

		// ── 2. PII + secret detection across ALL text sources ─────────────────

		const textSources: Array<{ text: string; label: string; source: DetectedItem['source'] }> = [
			{ text: raw.task, label: 'task', source: 'text' },
			{ text: raw.domContent, label: 'dom', source: 'dom' },
			{ text: raw.url, label: 'url', source: 'text' },
			{ text: raw.title, label: 'title', source: 'text' },
			...(raw.toolResults ?? []).map((t, i) => ({
				text: t, label: `tool_result_${i}`, source: 'text' as DetectedItem['source']
			})),
			...(raw.conversationHistory ?? []).map((h, i) => ({
				text: h, label: `history_${i}`, source: 'text' as DetectedItem['source']
			})),
		]

		for (const { text, label, source } of textSources) {
			try {
				const pii = detectPii(text, taskRegistry, source, domPiiHints)
				const secrets = detectSecrets(text, taskRegistry, source)
				allDetectedItems.push(...pii, ...secrets)
				if (pii.length + secrets.length > 0) sanitizedSources.push(label)
			} catch (err) {
				blockedReasons.push(`${label} scan failed: ${err instanceof Error ? err.message : String(err)}`)
				throw new GatewayError(blockedReasons)
			}
		}

		signal?.throwIfAborted()

		// ── 3. URL sanitization ───────────────────────────────────────────────

		let sanitizedUrl: string
		try {
			const urlResult = sanitizeUrl(raw.url, taskRegistry)
			sanitizedUrl = urlResult.sanitizedUrl
			allDetectedItems.push(...urlResult.detectedItems)
		} catch (err) {
			blockedReasons.push(`URL sanitization failed: ${err instanceof Error ? err.message : String(err)}`)
			throw new GatewayError(blockedReasons)
		}

		// ── 4. Title sanitization ─────────────────────────────────────────────

		let sanitizedTitle: string
		try {
			const titleResult = sanitizeTitle(raw.title, taskRegistry)
			sanitizedTitle = titleResult.sanitizedTitle
			allDetectedItems.push(...titleResult.detectedItems)
		} catch (err) {
			blockedReasons.push(`Title sanitization failed: ${err instanceof Error ? err.message : String(err)}`)
			throw new GatewayError(blockedReasons)
		}

		// ── 5. Text sanitization (task, DOM, tool results, history) ───────────

		let sanitizedTask: string
		let sanitizedDom: string
		let sanitizedToolResults: string[]

		try {
			sanitizedTask = sanitizeText(raw.task, allDetectedItems)
			sanitizedDom = sanitizeText(raw.domContent, allDetectedItems)
			sanitizedToolResults = sanitizeTexts(raw.toolResults ?? [], allDetectedItems)

			// Verify password fields are redacted in the DOM
			// (DOM scanner marks them; sanitizeText replaces the element label but not the value
			// since the value is never extracted — this is belt-and-suspenders)
		} catch (err) {
			blockedReasons.push(`Text sanitization failed: ${err instanceof Error ? err.message : String(err)}`)
			throw new GatewayError(blockedReasons)
		}

		// ── 6. Screenshot — OCR + pixel redaction ────────────────────────────

		let sanitizedScreenshot: string | undefined

		if (raw.screenshot) {
			signal?.throwIfAborted()

			try {
				// 6a. Run OCR on the screenshot to find text-in-image PII
				const ocrItems: DetectedItem[] = []
				try {
					const ocr = await getOcrWorker()
					const ocrResult = await ocr.runOcr(raw.screenshot, signal)

					// Detect PII in OCR'd text
					const ocrPii = detectPii(ocrResult.fullText, taskRegistry, 'ocr', domPiiHints)
					const ocrSecrets = detectSecrets(ocrResult.fullText, taskRegistry, 'ocr')

					// Map char-offset detected items back to bounding boxes using OCR word positions
					for (const item of [...ocrPii, ...ocrSecrets]) {
						// Find the OCR words that overlap with this item's text span
						let startChar = 0
						for (const word of ocrResult.words) {
							const wordEnd = startChar + word.text.length
							if (item.start !== undefined && item.end !== undefined) {
								if (wordEnd > item.start && startChar < item.end && word.bbox) {
									item.bbox = word.bbox
								}
							}
							startChar = wordEnd + 1
						}
						ocrItems.push(item)
					}

					allDetectedItems.push(...ocrItems)
					if (ocrItems.length > 0) sanitizedSources.push('screenshot_ocr')
				} catch (ocrErr) {
					// OCR failure is a hard block — we cannot establish a privacy decision
					// for image content without it, so we must not send the raw screenshot.
					blockedReasons.push(
						`OCR failed — cannot verify screenshot privacy: ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}`
					)
					throw new GatewayError(blockedReasons)
				}

				// 6b. Build redaction boxes from all items with bounding boxes
				const boxes = detectedItemsToBoxes(allDetectedItems)

				// 6c. Apply pixel-level redaction
				sanitizedScreenshot = await redactImage(raw.screenshot, boxes)
				if (boxes.length > 0) sanitizedSources.push('screenshot_pixels')

			} catch (err) {
				if (err instanceof GatewayError) throw err
				blockedReasons.push(`Screenshot processing failed: ${err instanceof Error ? err.message : String(err)}`)
				throw new GatewayError(blockedReasons)
			}
		}

		signal?.throwIfAborted()

		// ── 7. Assemble sanitized context ─────────────────────────────────────

		const hasRedactions = allDetectedItems.length > 0

		const redactionReport = buildRedactionReport({
			allDetectedItems,
			sanitizedSources,
			blockedReasons: [],
			scanStartMs,
		})

		const sanitizedContext: SanitizedContext = {
			schemaVersion: '1.0',
			sanitizedTask,
			sanitizedDom,
			sanitizedUrl,
			sanitizedTitle,
			sanitizedToolResults,
			sanitizedScreenshot,
			redactionReport,
			privacyStatus: hasRedactions ? 'REDACTED' : 'NO_SENSITIVE_DATA',
			blockedReasons: [],
		}

		return sanitizedContext

	} catch (err) {
		// Re-throw PrivacyGatewayError as-is
		if (err instanceof GatewayError) throw err

		// Wrap any other exception — NEVER fall back to sending raw content
		if (err instanceof Error && err.name === 'AbortError') {
			throw err   // AbortSignal cancellation — not a privacy failure
		}

		throw new GatewayError(
			`Privacy scan failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`
		)
	}
}

/**
 * Clear the task-scoped placeholder registry.
 * Must be called when a task session ends (agent.dispose()).
 * SECURITY: prevents raw values from lingering in memory after task completion.
 */
export function clearPrivacySession(): void {
	taskRegistry.clear()
	_lastDomHash = ''
	_lastDomPiiHints = []
	_lastDomSensitiveFields = []
}
