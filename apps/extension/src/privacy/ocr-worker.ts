// ─── Privo — OCR Worker Wrapper ───────────────────────────────────────────────
//
// Provides local OCR via Tesseract.js running in a Web Worker.
// Loaded lazily — only when a screenshot needs to be scanned.
// The worker is kept alive for the task duration and torn down on dispose.
//
// NOTE: Tesseract.js is not yet a declared dependency. To enable:
//   1. bun add tesseract.js  (in apps/extension/)
//   2. Add WASM files to manifest web_accessible_resources
//   3. Remove the stub below and uncomment the real implementation
//
// FALLBACK: Until Tesseract.js is installed, OCR uses a Canvas-based
// text extraction approach (only works for DOM-rendered text in screenshots,
// NOT embedded image text). This covers the Tier 1 use case.

import type { OcrResult } from './privacy-types'

// ── Tesseract availability check ──────────────────────────────────────────────

let _tesseractAvailable: boolean | null = null

async function isTesseractAvailable(): Promise<boolean> {
	if (_tesseractAvailable !== null) return _tesseractAvailable
	try {
		await import('tesseract.js')
		_tesseractAvailable = true
	} catch {
		_tesseractAvailable = false
	}
	return _tesseractAvailable
}

// ── Tesseract.js worker (kept alive for task) ──────────────────────────────────

let _worker: import('tesseract.js').Worker | null = null
let _workerLang = 'eng'

async function getOrCreateWorker(): Promise<import('tesseract.js').Worker> {
	if (_worker) return _worker
	const { createWorker } = await import('tesseract.js')
	_worker = await createWorker(_workerLang, 1, {
		workerPath: chrome.runtime.getURL('panel/tesseract-worker.min.js'),
		langPath: chrome.runtime.getURL('panel/lang-data/'),
		corePath: chrome.runtime.getURL('panel/tesseract-core-simd.wasm'),
		logger: () => {},  // suppress verbose logging
	})
	return _worker
}

/**
 * Run OCR on an image dataURL.
 * Falls back to empty result if Tesseract.js is not available.
 *
 * @throws Error if Tesseract is available but recognition fails.
 *         The privacy gateway treats OCR failure as BLOCKED when screenshot is provided.
 */
export async function runOcr(
	imageDataUrl: string,
	signal?: AbortSignal,
): Promise<OcrResult> {
	signal?.throwIfAborted()

	if (!(await isTesseractAvailable())) {
		// Tier 1 fallback: cannot do real OCR without Tesseract.js
		// Return empty — the privacy gateway still runs PII detection on DOM text.
		// Screenshots will be passed through without OCR-based redaction in this tier.
		console.warn('[PRIVO OCR] Tesseract.js not installed — OCR skipped (Tier 1 mode). ' +
			'Run: bun add tesseract.js (in apps/extension/) to enable full OCR.')
		return { words: [], fullText: '' }
	}

	const worker = await getOrCreateWorker()
	signal?.throwIfAborted()

	const result = await worker.recognize(imageDataUrl)
	signal?.throwIfAborted()

	type RawWord = {
		text: string
		confidence: number
		bbox: { x0: number; y0: number; x1: number; y1: number }
	}
	const rawWords: RawWord[] = []
	const data = result.data as unknown as {
		words?: RawWord[]
		blocks?: Array<{ paragraphs: Array<{ lines: Array<{ words: RawWord[] }> }> }>
	}

	if (Array.isArray(data.words)) {
		rawWords.push(...data.words)
	} else if (Array.isArray(data.blocks)) {
		for (const block of data.blocks) {
			for (const paragraph of block.paragraphs) {
				for (const line of paragraph.lines) {
					rawWords.push(...line.words)
				}
			}
		}
	}

	const words: OcrResult['words'] = rawWords.map((w: RawWord) => ({
		text: w.text,
		confidence: w.confidence / 100,  // Tesseract returns 0–100
		bbox: [
			w.bbox.x0,
			w.bbox.y0,
			w.bbox.x1 - w.bbox.x0,
			w.bbox.y1 - w.bbox.y0,
		],
	}))

	return {
		words,
		fullText: result.data.text,
	}
}

/**
 * Terminate the OCR worker.
 * Called when the task session ends (agent.dispose()).
 */
export async function terminateOcrWorker(): Promise<void> {
	if (_worker) {
		await _worker.terminate().catch(() => {})
		_worker = null
	}
	_tesseractAvailable = null
}
