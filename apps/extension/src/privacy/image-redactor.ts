// ─── Privo — Image Redactor ───────────────────────────────────────────────────
//
// Canvas-based pixel-level redaction of screenshots.
// Called BEFORE watermarking/hashing/registration in seal.ts.
//
// Input:  raw screenshot dataURL + list of sensitive bounding boxes
// Output: new PNG dataURL with sensitive regions replaced by opaque fill blocks
//
// CRITICAL: This actually modifies pixels. It does NOT instruct the model to
// "ignore" regions. The original pixels are gone from the output.
//
// Redaction style:
//   - Fill color: #0d1117 (dark neutral — visually distinct but non-destructive to layout)
//   - Optional centered label text: "EMAIL_1", "ACCOUNT_1" etc.
//   - Label text: white, monospace, scaled to box size

import type { PiiCategory, RedactionBox } from './privacy-types'

// ── Redaction fill style ──────────────────────────────────────────────────────

const FILL_COLOR = '#0d1117'          // dark navy
const LABEL_COLOR = '#7d8590'         // muted gray text
const LABEL_MIN_BOX_WIDTH = 60        // don't try to label tiny boxes

// ── Core redact function ──────────────────────────────────────────────────────

/**
 * Apply pixel-level redaction to a screenshot.
 *
 * @param dataUrl - Raw screenshot as PNG/JPEG data URL
 * @param boxes   - Sensitive regions to redact with their placeholder labels
 * @returns New PNG dataUrl with sensitive pixels replaced
 */
export async function redactImage(dataUrl: string, boxes: RedactionBox[]): Promise<string> {
	if (boxes.length === 0) return dataUrl

	const img = await loadImage(dataUrl)

	const canvas = document.createElement('canvas')
	canvas.width = img.naturalWidth
	canvas.height = img.naturalHeight
	const ctx = canvas.getContext('2d')!

	// 1. Draw the original image
	ctx.drawImage(img, 0, 0)

	// 2. Apply redaction boxes
	for (const box of boxes) {
		if (box.width <= 0 || box.height <= 0) continue

		// Solid fill — obliterates the original pixels
		ctx.fillStyle = FILL_COLOR
		ctx.fillRect(box.x, box.y, box.width, box.height)

		// Optional label — only if box is wide enough to be readable
		if (box.width >= LABEL_MIN_BOX_WIDTH) {
			const fontSize = Math.min(11, Math.max(8, Math.floor(box.height * 0.45)))
			ctx.font = `500 ${fontSize}px ui-monospace, 'SF Mono', Menlo, monospace`
			ctx.fillStyle = LABEL_COLOR
			ctx.textAlign = 'center'
			ctx.textBaseline = 'middle'
			const labelText = box.label || categoryToLabel(box.category)
			// Clip label to box bounds
			ctx.save()
			ctx.rect(box.x, box.y, box.width, box.height)
			ctx.clip()
			ctx.fillText(labelText, box.x + box.width / 2, box.y + box.height / 2)
			ctx.restore()
		}
	}

	return canvas.toDataURL('image/png')
}

// ── Utility: build redaction boxes from detected items + viewport positions ───

/**
 * Convert detected items that have bounding boxes into RedactionBox entries.
 * Used when OCR or vision detection returns pixel coordinates.
 */
export function detectedItemsToBoxes(
	items: Array<{ bbox?: [number, number, number, number]; placeholder: string; category: PiiCategory }>
): RedactionBox[] {
	return items
		.filter((item) => item.bbox && item.bbox[2] > 0 && item.bbox[3] > 0)
		.map((item) => ({
			x: item.bbox![0],
			y: item.bbox![1],
			width: item.bbox![2],
			height: item.bbox![3],
			category: item.category,
			label: item.placeholder,
		}))
}

/**
 * Build redaction boxes from DOM sensitive field viewport positions.
 * Called by the privacy gateway after obtaining element positions from the content script.
 *
 * @param fields - DOM sensitive field descriptors with element IDs
 * @param elementPositions - Map of elementId → viewport rect
 */
export function domFieldsToBoxes(
	fields: Array<{ elementId: string; category: PiiCategory; placeholder: string }>,
	elementPositions: Map<string, { x: number; y: number; width: number; height: number }>
): RedactionBox[] {
	const boxes: RedactionBox[] = []
	for (const field of fields) {
		const pos = elementPositions.get(field.elementId)
		if (!pos || pos.width === 0 || pos.height === 0) continue
		boxes.push({
			x: pos.x,
			y: pos.y,
			width: pos.width,
			height: pos.height,
			category: field.category,
			label: field.placeholder,
		})
	}
	return boxes
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function categoryToLabel(category: PiiCategory): string {
	// Shorten to keep it readable in small boxes
	const short: Partial<Record<PiiCategory, string>> = {
		CARD_NUMBER: 'CARD',
		ACCOUNT_NUMBER: 'ACCT',
		DATE_OF_BIRTH: 'DOB',
		GOVERNMENT_ID: 'GOVT ID',
		DRIVER_LICENSE: 'DL',
		SECURITY_ANSWER: 'SECRET',
		DB_CONNECTION_STRING: 'DB CRED',
		WEBHOOK_SECRET: 'SECRET',
	}
	return short[category] ?? category
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => resolve(img)
		img.onerror = () => reject(new Error('redactImage: failed to load source image'))
		img.src = src
	})
}

// ── Redaction quality measurement ─────────────────────────────────────────────

/**
 * Verify that the redaction boxes are covered in the output image.
 * Samples pixels in each box and checks they match the fill color.
 *
 * Used in tests to confirm redaction actually modified pixels.
 *
 * @returns Coverage ratio: 1.0 = all sampled pixels are redacted, 0.0 = none
 */
export async function measureRedactionCoverage(
	redactedDataUrl: string,
	boxes: RedactionBox[],
	sampleRate = 0.1,  // sample 10% of pixels per box
): Promise<number> {
	if (boxes.length === 0) return 1.0

	const img = await loadImage(redactedDataUrl)
	const canvas = document.createElement('canvas')
	canvas.width = img.naturalWidth
	canvas.height = img.naturalHeight
	const ctx = canvas.getContext('2d')!
	ctx.drawImage(img, 0, 0)

	// Parse expected fill color
	const fillR = parseInt(FILL_COLOR.slice(1, 3), 16)
	const fillG = parseInt(FILL_COLOR.slice(3, 5), 16)
	const fillB = parseInt(FILL_COLOR.slice(5, 7), 16)
	const tolerance = 20  // allow slight JPEG compression drift

	let totalSamples = 0
	let coveredSamples = 0

	for (const box of boxes) {
		const step = Math.max(1, Math.round(1 / sampleRate))
		for (let y = Math.floor(box.y); y < box.y + box.height; y += step) {
			for (let x = Math.floor(box.x); x < box.x + box.width; x += step) {
				if (x >= canvas.width || y >= canvas.height) continue
				const pixel = ctx.getImageData(x, y, 1, 1).data
				totalSamples++
				if (
					Math.abs(pixel[0] - fillR) <= tolerance &&
					Math.abs(pixel[1] - fillG) <= tolerance &&
					Math.abs(pixel[2] - fillB) <= tolerance
				) {
					coveredSamples++
				}
			}
		}
	}

	return totalSamples > 0 ? coveredSamples / totalSamples : 1.0
}
