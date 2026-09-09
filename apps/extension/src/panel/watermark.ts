export interface CaptureMeta {
	captureId: string
	url: string
	title: string
	capturedAt: number // epoch ms
}

export async function watermarkImage(dataUrl: string, meta: CaptureMeta): Promise<Blob> {
	const img = await loadImage(dataUrl)

	const scale = Math.max(1, img.width / 1280) // keep text legible on hi-dpi captures

	const canvas = document.createElement('canvas')
	canvas.width = img.width
	canvas.height = img.height
	const ctx = canvas.getContext('2d')!

	// 1. original capture, untouched
	ctx.drawImage(img, 0, 0)

	// 2. forensic watermark strip — bottom right, solid and legible
	const fontS = Math.round(11 * scale)
	ctx.font = `600 ${fontS}px ui-monospace, 'SF Mono', 'Courier New', monospace`

	const ts = new Date(meta.capturedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
	const host = safeHost(meta.url)
	const brand = 'PRIVO'
	const brandW = ctx.measureText(brand).width

	const sep = '  ·  '
	const variants = [
		`${sep}${ts}${sep}${meta.captureId}${sep}${host}`,
		`${sep}${ts}${sep}${meta.captureId}`,
		`${sep}${ts}`,
	]
	const padX = Math.round(12 * scale)
	const padY = Math.round(7 * scale)
	const r = Math.round(5 * scale)
	const margin = Math.round(16 * scale)
	const maxW = canvas.width - margin * 2

	const detail = variants.find((v) => padX + brandW + ctx.measureText(v).width + padX <= maxW) ?? variants[2]
	const detailW = ctx.measureText(detail).width

	const badgeW = padX + brandW + detailW + padX
	const badgeH = fontS + padY * 2
	const x = canvas.width - badgeW - margin
	const y = canvas.height - badgeH - margin
	const midY = y + badgeH / 2

	// Background — solid dark navy, readable against any page content
	ctx.beginPath()
	ctx.roundRect(x, y, badgeW, badgeH, r)
	ctx.fillStyle = 'rgba(5, 8, 22, 0.90)'
	ctx.fill()

	// Blue accent behind the brand label
	const brandRegionW = padX + brandW + Math.round(6 * scale)
	ctx.save()
	ctx.beginPath()
	ctx.roundRect(x, y, brandRegionW, badgeH, [r, 0, 0, r])
	ctx.clip()
	ctx.fillStyle = 'rgba(24, 78, 200, 0.65)'
	ctx.fillRect(x, y, brandRegionW, badgeH)
	ctx.restore()

	// Border
	ctx.beginPath()
	ctx.roundRect(x, y, badgeW, badgeH, r)
	ctx.strokeStyle = 'rgba(70, 140, 255, 0.55)'
	ctx.lineWidth = Math.max(1, Math.round(scale))
	ctx.stroke()

	// Brand text
	ctx.textBaseline = 'middle'
	ctx.font = `700 ${fontS}px ui-monospace, 'SF Mono', 'Courier New', monospace`
	ctx.fillStyle = 'rgba(160, 210, 255, 1.0)'
	ctx.fillText(brand, x + padX, midY)

	// Metadata text
	ctx.font = `500 ${fontS}px ui-monospace, 'SF Mono', 'Courier New', monospace`
	ctx.fillStyle = 'rgba(230, 226, 220, 0.95)'
	ctx.fillText(detail, x + padX + brandW, midY)

	const blob = await new Promise<Blob | null>((r2) => canvas.toBlob(r2, 'image/png'))
	if (!blob) throw new Error('Failed to encode sealed PNG')
	return blob
}

export async function sha256Hex(blob: Blob): Promise<string> {
	const buf = await blob.arrayBuffer()
	const digest = await crypto.subtle.digest('SHA-256', buf)
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader()
		r.onload = () => resolve(r.result as string)
		r.onerror = reject
		r.readAsDataURL(blob)
	})
}

export function newCaptureId(): string {
	// DC-YYMMDD-XXXXXXXX  (8 random hex chars = ~4 billion values per day)
	const d = new Date()
	const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
	const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
	return `DC-${ymd}-${rand}`
}

function safeHost(url: string): string {
	try {
		return new URL(url).host
	} catch {
		return url.slice(0, 40)
	}
}

// Segments are placed at the REAL scroll offset each was captured at (the
// browser clamps scrollTo at the page bottom, so the last offset is rarely a
// multiple of viewportHeight). Falls back to i*viewportHeight when offsets are
// missing (older captures).
export async function stitchSegments(
	segments: string[],
	meta: {
		viewportHeight: number
		viewportWidth: number
		scrollHeight: number
		offsets?: number[]
	}
): Promise<string> {
	if (segments.length === 0) throw new Error('stitchSegments: segments array is empty')
	if (segments.length === 1) return segments[0]

	const images = await Promise.all(segments.map(loadImage))

	// PNG width ÷ CSS viewport width = device pixel ratio of the captured tab.
	const scale = images[0].naturalWidth / meta.viewportWidth
	const vhPx = Math.ceil(meta.viewportHeight * scale)
	const maxScrollPx = Math.max(0, Math.ceil((meta.scrollHeight - meta.viewportHeight) * scale))

	// Canvas covers only what was actually captured — if the capture stopped
	// early (page refused to scroll, MAX_SEGMENTS), there must be no blank strip.
	// Sized by the LAST image's real pixel height, not ceil(viewport*scale):
	// fractional DPRs make those differ by 1px, which would leave a blank row.
	const lastOffset = meta.offsets?.[segments.length - 1]
	const lastImgH = images[images.length - 1].naturalHeight
	const coveredPx =
		typeof lastOffset === 'number'
			? Math.min(Math.ceil(meta.scrollHeight * scale), Math.round(lastOffset * scale) + lastImgH)
			: Math.ceil(meta.scrollHeight * scale)
	const totalPx = coveredPx

	const canvas = document.createElement('canvas')
	canvas.width = images[0].naturalWidth
	canvas.height = totalPx
	const ctx = canvas.getContext('2d')!

	let prevBottom = 0
	for (let i = 0; i < images.length; i++) {
		const cssOffset = meta.offsets?.[i]
		let dstY =
			typeof cssOffset === 'number'
				? Math.min(Math.round(cssOffset * scale), maxScrollPx)
				: Math.min(i * vhPx, maxScrollPx)
		// Fractional-DPR rounding can open a 1–2px hairline gap between segments —
		// clamp so each segment abuts the previous one (1px overlap is invisible;
		// a gap row is a visible dark seam).
		if (i > 0 && dstY > prevBottom) dstY = prevBottom
		const remaining = totalPx - dstY
		if (remaining <= 0) break
		const drawH = Math.min(remaining, images[i].naturalHeight)
		ctx.drawImage(images[i], 0, 0, images[i].naturalWidth, drawH, 0, dstY, canvas.width, drawH)
		prevBottom = dstY + drawH
	}

	return canvas.toDataURL('image/png')
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => resolve(img)
		img.onerror = () => reject(new Error('Failed to load capture image'))
		img.src = src
	})
}
