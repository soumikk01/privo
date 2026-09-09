import { BACKEND_URL, EXTENSION_SECRET } from './config'
import type { FullPageEntry } from './tools/screenshot.background'
import {
	blobToDataUrl,
	newCaptureId,
	sha256Hex,
	stitchSegments,
	watermarkImage,
} from './panel/watermark'

export interface SealedCapture {
	id: string
	sha256: string
	dataUrl: string
	url: string
	title: string
	capturedAt: number
	sealed: boolean // registered with the backend?
}

export async function sealCapture(targetTabId?: number): Promise<SealedCapture> {
	// 0. Suppress the overlay so it doesn't appear in the capture.
	await chrome.storage.local.set({ maskSuppressed: true })

	// 1. Full-page capture via background (only service worker can call captureVisibleTab).
	let response: { success: boolean; entry?: FullPageEntry; error?: string } | null
	try {
		response = (await chrome.runtime.sendMessage({
			type: 'SCREENSHOT_CONTROL',
			action: 'capture_full_page',
			payload: targetTabId !== undefined ? { targetTabId } : {},
		})) as typeof response
	} finally {
		void chrome.storage.local.set({ maskSuppressed: false })
	}

	if (!response?.success || !response.entry) {
		throw new Error(response?.error ?? 'Screenshot failed — no response from background')
	}

	const raw = response.entry

	// 2. Stitch multiple viewport segments into one image (if full-page capture).
	let sourceDataUrl: string
	if (raw.segments.length > 1 && raw.viewportHeight > 0 && raw.scrollHeight > 0) {
		sourceDataUrl = await stitchSegments(raw.segments, {
			viewportHeight: raw.viewportHeight,
			viewportWidth: raw.viewportWidth,
			scrollHeight: raw.scrollHeight,
			offsets: raw.offsets,
		})
	} else {
		sourceDataUrl = raw.segments[0]
	}

	// 3. Burn in watermark badge.
	const meta = {
		captureId: newCaptureId(),
		url: raw.tabUrl,
		title: raw.tabTitle,
		capturedAt: Date.now(),
	}
	const sealedBlob = await watermarkImage(sourceDataUrl, meta)

	// 4. Hash the sealed PNG — any later modification changes this.
	const sha256 = await sha256Hex(sealedBlob)

	// 5. Register with backend for tamper-evidence verification.
	let sealed = false
	try {
		const reg = await fetch(`${BACKEND_URL}/captures`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(EXTENSION_SECRET ? { 'X-Extension-Secret': EXTENSION_SECRET } : {}),
			},
			body: JSON.stringify({
				sha256,
				meta: { ...meta, extVersion: chrome.runtime.getManifest().version },
			}),
		})
		sealed = reg.ok
	} catch {
		sealed = false
	}

	// 6. Persist to the gallery (rolling, last 10).
	const capture: SealedCapture = {
		id: meta.captureId,
		sha256,
		dataUrl: await blobToDataUrl(sealedBlob),
		url: meta.url,
		title: meta.title,
		capturedAt: meta.capturedAt,
		sealed,
	}
	const { captures = [] } = (await chrome.storage.local.get('captures')) as {
		captures?: SealedCapture[]
	}
	captures.unshift(capture)
	await chrome.storage.local.set({ captures: captures.slice(0, 10) })

	return capture
}
