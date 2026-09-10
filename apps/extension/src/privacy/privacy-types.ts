// ─── Privo Privacy Subsystem — Shared Types ───────────────────────────────────
// ALL privacy-related modules import from this file only.
// rawValue fields are MEMORY-ONLY — never serialized to model context.

// ── PII Categories ────────────────────────────────────────────────────────────

export type PiiCategory =
	// Personal identifiers
	| 'NAME'
	| 'EMAIL'
	| 'PHONE'
	| 'ADDRESS'
	| 'DATE_OF_BIRTH'
	// Government IDs
	| 'GOVERNMENT_ID'
	| 'AADHAAR'
	| 'PASSPORT'
	| 'DRIVER_LICENSE'
	// Financial
	| 'ACCOUNT_NUMBER'
	| 'CARD_NUMBER'
	| 'BANK_INFO'
	// Credentials / authentication
	| 'PASSWORD'
	| 'OTP'
	| 'SECURITY_ANSWER'
	// Developer secrets
	| 'API_KEY'
	| 'ACCESS_TOKEN'
	| 'JWT'
	| 'PRIVATE_KEY'
	| 'SESSION_TOKEN'
	| 'WEBHOOK_SECRET'
	| 'DB_CONNECTION_STRING'

// ── Detected Item ─────────────────────────────────────────────────────────────

/**
 * Represents a single piece of detected sensitive information.
 *
 * SECURITY: rawValue is ONLY populated inside the privacy engine.
 * It must NEVER be included in SanitizedContext or any model-bound structure.
 * Strip it using toPublicDetectedItem() before passing outside privacy modules.
 */
export interface DetectedItem {
	id: string
	category: PiiCategory
	confidence: number                       // 0.0 – 1.0
	source: 'dom' | 'text' | 'ocr' | 'vision'
	start?: number                           // char offset in source text
	end?: number
	bbox?: [number, number, number, number]  // [x, y, w, h] for visual regions
	placeholder: string                      // e.g. "EMAIL_1"
	rawValue?: string                        // ⚠️ MEMORY ONLY — never serialize
}

/** Safe version of DetectedItem — rawValue stripped, safe to expose to UI/reports */
export type PublicDetectedItem = Omit<DetectedItem, 'rawValue'>

export function toPublicDetectedItem(item: DetectedItem): PublicDetectedItem {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { rawValue: _stripped, ...safe } = item
	return safe
}

// ── Page Element (unified DOM+OCR+vision representation) ──────────────────────

export interface PageElement {
	id: string
	type: 'button' | 'input' | 'link' | 'text' | 'image' | 'dialog' | 'form' | 'unknown'
	bbox: [number, number, number, number]
	text?: string
	confidence: number
	source: 'dom' | 'ocr' | 'vision' | 'combined'
	sensitive?: boolean
}

// ── DOM sensitive field (position only, never value) ─────────────────────────

export interface DomSensitiveField {
	/** The [N] index from the PageController element tree */
	elementId: string
	category: PiiCategory
	confidence: number
	fieldType: string
	autocomplete?: string
	label?: string
}

// ── Privacy status ────────────────────────────────────────────────────────────

export type PrivacyStatus =
	| 'SCANNING'
	| 'NO_SENSITIVE_DATA'
	| 'REDACTED'
	| 'BLOCKED'

// ── Redaction report (safe — no raw values) ───────────────────────────────────

export interface RedactionReport {
	/** Public detected items — rawValue already stripped */
	detectedItems: PublicDetectedItem[]
	redactedCategories: PiiCategory[]
	sanitizedSources: string[]    // which fields were sanitized: 'task'|'dom'|'url'|'title'|'screenshot'|...
	blockedReasons: string[]
	scanDurationMs: number
	timestamp: number
}

// ── Redaction bounding box (for image-redactor) ───────────────────────────────

export interface RedactionBox {
	x: number
	y: number
	width: number
	height: number
	category: PiiCategory
	label: string   // "EMAIL_1" shown as overlay label
}

// ── Sanitized context sent to model ──────────────────────────────────────────

/**
 * The ONLY structure that may be transmitted to the cloud model adapter.
 * Every field has been processed by the privacy gateway.
 * rawValue mappings are NOT present here.
 */
export interface SanitizedContext {
	schemaVersion: '1.0'
	sanitizedTask: string
	sanitizedDom: string
	sanitizedUrl: string
	sanitizedTitle: string
	sanitizedToolResults: string[]
	/** Pixel-redacted PNG dataURL — original pixels of sensitive regions replaced */
	sanitizedScreenshot?: string
	redactionReport: RedactionReport
	privacyStatus: PrivacyStatus
	blockedReasons: string[]
}

// ── Raw context input to the gateway ─────────────────────────────────────────

export interface RawContext {
	task: string
	domContent: string          // raw DOM text from RemotePageController
	screenshot?: string         // raw screenshot dataURL (pre-redaction)
	toolResults?: string[]
	url: string
	title: string
	/** Conversation history entries — also sanitized before model transmission */
	conversationHistory?: string[]
}

// ── OCR result ────────────────────────────────────────────────────────────────

export interface OcrWord {
	text: string
	confidence: number
	bbox: [number, number, number, number]  // [x, y, w, h]
}

export interface OcrResult {
	words: OcrWord[]
	fullText: string
}

// ── Privacy gateway error ─────────────────────────────────────────────────────

export class PrivacyGatewayError extends Error {
	readonly reasons: string[]
	constructor(reasons: string | string[]) {
		const arr = Array.isArray(reasons) ? reasons : [reasons]
		super(`Privacy gateway blocked: ${arr.join('; ')}`)
		this.name = 'PrivacyGatewayError'
		this.reasons = arr
	}
}
