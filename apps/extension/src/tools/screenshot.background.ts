// Only the background SW may call captureVisibleTab — MV3 rate-limits it to ~2/sec.

export interface FullPageEntry {
	/** One dataUrl per viewport segment, top-to-bottom. */
	segments: string[]
	/**
	 * Actual CSS-pixel scrollY at which each segment was captured (parallel to
	 * segments). The browser clamps scrollTo at the page bottom, so the last
	 * offset is usually NOT a multiple of viewportHeight — stitching must place
	 * segments at these real offsets or the bottom of the page duplicates.
	 */
	offsets: number[]
	/** Full CSS pixel height of the page (0 if unknown). */
	scrollHeight: number
	/** CSS pixel height of the viewport (0 if unknown). */
	viewportHeight: number
	/** CSS pixel width of the viewport (0 if unknown). */
	viewportWidth: number
	/** True when the page was only partially captured because MAX_SEGMENTS was reached. */
	truncated: boolean
	tabUrl: string
	tabTitle: string
}

const MAX_SEGMENTS = 15 // safety cap — ~15 viewports is already a very long page

export function handleScreenshotMessage(
	message: { type: 'SCREENSHOT_CONTROL'; action: string; payload?: { targetTabId?: number } },
	_sender: chrome.runtime.MessageSender,
	sendResponse: (response: unknown) => void
): true | undefined {
	const targetTabId = message.payload?.targetTabId

	if (message.action === 'capture_full_page') {
		captureFullPage(targetTabId)
			.then((entry) => sendResponse({ success: true, entry }))
			.catch((error) => {
				console.error('[Screenshot.background]', error)
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		return true
	}

	if (message.action === 'capture_visible') {
		captureVisible(targetTabId)
			.then((entry) => sendResponse({ success: true, entry }))
			.catch((error) => {
				console.error('[Screenshot.background]', error)
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error),
				})
			})
		return true
	}

	sendResponse({ success: false, error: `Unknown screenshot action: ${message.action}` })
	return undefined
}

// ─── full-page capture ────────────────────────────────────────────────────────

async function captureFullPage(targetTabId?: number): Promise<FullPageEntry> {
	const tab = await resolveTargetTab(targetTabId)
	if (!tab.id || tab.windowId === undefined) throw new Error('Could not resolve a target tab.')

	// The target tab must be active for captureVisibleTab to work.
	if (!tab.active) {
		await chrome.tabs.update(tab.id, { active: true })
		await delay(350)
	}

	// Remove the agent overlay so it never appears in captured evidence.
	try {
		await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_CONTROL', action: 'hide_mask_now' })
		await delay(80)
	} catch {
		/* no content script on this page (chrome://, PDF, etc.) */
	}

	// Primary path: one atomic CDP render of the whole document — no scrolling,
	// no stitching, no window for the page to mutate mid-capture. Falls back to
	// scroll-and-stitch when the debugger can't attach (chrome:// pages,
	// enterprise policy, user pressed Cancel on the debugger infobar).
	try {
		return await captureFullPageViaDebugger(tab)
	} catch (error) {
		console.warn('[Screenshot.background] CDP capture failed, falling back to stitch:', error)
		return await captureFullPageViaStitch(tab)
	}
}

// ─── CDP one-shot capture (primary) ───────────────────────────────────────────

// Chromium's GPU compositor caps any screenshot dimension at 16384 device px —
// taller captures silently truncate or repeat content.
const MAX_DEVICE_PX = 16384

/**
 * Full-page capture via chrome.debugger — the same call Chrome DevTools'
 * "Capture full size screenshot" issues: Page.captureScreenshot with
 * captureBeyondViewport, which transiently expands the rendering surface to
 * the full document. Fixed/sticky elements paint exactly once; nothing in the
 * DOM is hidden or mutated; the frame is a single moment in time.
 */
async function captureFullPageViaDebugger(tab: chrome.tabs.Tab): Promise<FullPageEntry> {
	const dbg = { tabId: tab.id! }
	await chrome.debugger.attach(dbg, '1.3')

	try {
		// Lazy-load sweep: captureBeyondViewport renders one frame WITHOUT
		// scrolling, so IntersectionObserver/loading=lazy content would come out
		// as empty boxes. Scroll through the page first to force it in, then
		// return to the top (capturing while scrolled has produced offset images).
		await sweepForLazyContent(tab.id!)

		const metrics = (await chrome.debugger.sendCommand(dbg, 'Page.getLayoutMetrics')) as {
			cssContentSize?: { width: number; height: number }
			contentSize?: { width: number; height: number }
			cssVisualViewport?: { clientWidth: number; clientHeight: number }
		}
		const size = metrics.cssContentSize ?? metrics.contentSize
		if (!size) throw new Error('Page.getLayoutMetrics returned no content size')

		const ev = (await chrome.debugger.sendCommand(dbg, 'Runtime.evaluate', {
			expression: 'window.devicePixelRatio',
			returnByValue: true,
		})) as { result?: { value?: unknown } }
		const dpr = typeof ev?.result?.value === 'number' && ev.result.value > 0 ? ev.result.value : 1

		// Stay under the GPU texture cap — clip overly tall pages and flag it.
		const maxCssHeight = Math.floor(MAX_DEVICE_PX / dpr) - 8
		const truncated = size.height > maxCssHeight

		const params: Record<string, unknown> = {
			format: 'png',
			fromSurface: true,
			captureBeyondViewport: true,
		}
		if (truncated) {
			params.clip = { x: 0, y: 0, width: size.width, height: maxCssHeight, scale: 1 }
		}

		const shot = (await chrome.debugger.sendCommand(dbg, 'Page.captureScreenshot', params)) as {
			data?: string
		}
		if (!shot?.data) throw new Error('Page.captureScreenshot returned no data')

		return {
			segments: [`data:image/png;base64,${shot.data}`],
			offsets: [0],
			scrollHeight: size.height,
			viewportHeight: metrics.cssVisualViewport?.clientHeight ?? 0,
			viewportWidth: metrics.cssVisualViewport?.clientWidth ?? 0,
			truncated,
			tabUrl: tab.url ?? '',
			tabTitle: tab.title ?? '',
		}
	} finally {
		await chrome.debugger.detach(dbg).catch(() => {})
		// Release the content script's mask lock set by hide_mask_now — the CDP
		// path never sends restore_fixed_elements, which normally clears it.
		await chrome.tabs
			.sendMessage(tab.id!, { type: 'PAGE_CONTROL', action: 'restore_fixed_elements' })
			.catch(() => {})
	}
}

/** Scroll top→bottom→top to trigger lazy-loaded content before a one-shot capture. */
async function sweepForLazyContent(tabId: number): Promise<void> {
	try {
		const info = (await chrome.tabs.sendMessage(tabId, {
			type: 'PAGE_CONTROL',
			action: 'get_scroll_info',
		})) as { scrollHeight: number; viewportHeight: number }
		if (!info || info.scrollHeight <= info.viewportHeight + 50) return

		// Cap sweep work on infinite-scroll pages.
		const maxSweep = Math.min(info.scrollHeight, info.viewportHeight * 20)
		for (let y = info.viewportHeight; y < maxSweep; y += info.viewportHeight) {
			await chrome.tabs.sendMessage(tabId, {
				type: 'PAGE_CONTROL',
				action: 'scroll_to_position',
				payload: { y },
			})
			await delay(150)
		}
		await chrome.tabs.sendMessage(tabId, {
			type: 'PAGE_CONTROL',
			action: 'scroll_to_position',
			payload: { y: 0 },
		})
		// Let images decode and layout settle back at the top.
		await delay(350)
	} catch {
		/* content script unavailable — capture what's rendered */
	}
}

// ─── scroll-and-stitch capture (fallback) ─────────────────────────────────────

async function captureFullPageViaStitch(tab: chrome.tabs.Tab): Promise<FullPageEntry> {
	const tabId = tab.id!

	// Ask the content script for page dimensions.
	let scrollHeight = 0
	let viewportHeight = 0
	let viewportWidth = 0
	let originalScrollY = 0

	try {
		const info = (await chrome.tabs.sendMessage(tabId, {
			type: 'PAGE_CONTROL',
			action: 'get_scroll_info',
		})) as {
			scrollHeight: number
			viewportHeight: number
			viewportWidth: number
			scrollY: number
		}
		scrollHeight = info.scrollHeight
		viewportHeight = info.viewportHeight
		viewportWidth = info.viewportWidth
		originalScrollY = info.scrollY
	} catch {
		// Content script unavailable — fall back to single-viewport capture.
		const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
		return { segments: [dataUrl], offsets: [0], scrollHeight: 0, viewportHeight: 0, viewportWidth: 0, truncated: false, tabUrl: tab.url ?? '', tabTitle: tab.title ?? '' }
	}

	// Page fits in one viewport — no stitching needed.
	if (scrollHeight <= viewportHeight + 50) {
		const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
		return { segments: [dataUrl], offsets: [0], scrollHeight, viewportHeight, viewportWidth, truncated: false, tabUrl: tab.url ?? '', tabTitle: tab.title ?? '' }
	}

	/**
	 * Scroll and return the ACTUAL landed position (browser clamps at page
	 * bottom). Returns null when the content script did not confirm — the caller
	 * must stop capturing rather than fabricate offsets.
	 */
	const scrollTo = async (y: number): Promise<number | null> => {
		const res = (await chrome.tabs
			.sendMessage(tab.id!, {
				type: 'PAGE_CONTROL',
				action: 'scroll_to_position',
				payload: { y },
			})
			.catch(() => null)) as { success?: boolean; y?: number } | null
		return typeof res?.y === 'number' ? res.y : null
	}

	const segments: string[] = []
	const offsets: number[] = []
	let truncated = false

	try {
		// Segment 1 — top of page, with fixed/sticky elements VISIBLE so the header
		// appears once in its natural place.
		await scrollTo(0)
		await delay(120)
		segments.push(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }))
		offsets.push(0)

		// Hide fixed/sticky elements for the remaining segments only — otherwise
		// they repeat in every stitched band.
		await chrome.tabs.sendMessage(tabId, {
			type: 'PAGE_CONTROL',
			action: 'hide_fixed_elements',
		}).catch(() => {})

		let targetY = viewportHeight
		while (targetY < scrollHeight && segments.length < MAX_SEGMENTS) {
			const scrolledY = await scrollTo(targetY)

			// null: content script gone — stop with what we have rather than
			// capturing unscrolled duplicates with fabricated offsets.
			// scrolledY <= last offset: page refused to scroll further (inner scroll
			// container, dynamic collapse) — same treatment.
			if (scrolledY === null || scrolledY <= offsets[offsets.length - 1]) break

			// Wait for the new viewport to paint before capturing.
			// Also respects MV3 captureVisibleTab rate limit (2 per fixed 1s window).
			await delay(500)

			// Re-read scroll state AT CAPTURE TIME — lazy-load/layout shift during
			// the settle delay moves content; the offset stamped on this segment
			// must be where the page is NOW, not where the scroll landed 500ms ago.
			const fresh = (await chrome.tabs
				.sendMessage(tab.id!, { type: 'PAGE_CONTROL', action: 'get_scroll_info' })
				.catch(() => null)) as { scrollHeight: number; scrollY: number } | null
			const actualY = fresh?.scrollY ?? scrolledY
			if (actualY <= offsets[offsets.length - 1]) break

			// Page height changed materially mid-capture (lazy load, virtualized
			// list re-render) — stitching stale offsets would duplicate bands.
			// Stop with the consistent segments we have.
			if (fresh && Math.abs(fresh.scrollHeight - scrollHeight) > viewportHeight * 0.2) {
				truncated = true
				break
			}

			segments.push(await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }))
			offsets.push(actualY)

			// Reached the true bottom (browser clamped the scroll) — done.
			if (actualY < targetY) break
			targetY = actualY + viewportHeight
		}
		truncated = truncated || (segments.length === MAX_SEGMENTS && targetY < scrollHeight)
	} finally {
		// Always restore — if captureVisibleTab throws mid-loop, elements must not stay hidden.
		await chrome.tabs.sendMessage(tabId, {
			type: 'PAGE_CONTROL',
			action: 'restore_fixed_elements',
		}).catch(() => {})
	}

	await scrollTo(originalScrollY)

	return { segments, offsets, scrollHeight, viewportHeight, viewportWidth, truncated, tabUrl: tab.url ?? '', tabTitle: tab.title ?? '' }
}

// ─── single-viewport capture (kept for direct use if needed) ─────────────────

async function captureVisible(targetTabId?: number): Promise<FullPageEntry> {
	const tab = await resolveTargetTab(targetTabId)
	if (!tab.id || tab.windowId === undefined) throw new Error('Could not resolve a target tab.')

	if (!tab.active) {
		await chrome.tabs.update(tab.id, { active: true })
		await delay(350)
	}

	try {
		await chrome.tabs.sendMessage(tab.id, { type: 'PAGE_CONTROL', action: 'hide_mask_now' })
		await delay(150)
	} catch {}

	const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
	return { segments: [dataUrl], offsets: [0], scrollHeight: 0, viewportHeight: 0, viewportWidth: 0, truncated: false, tabUrl: tab.url ?? '', tabTitle: tab.title ?? '' }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

async function resolveTargetTab(targetTabId?: number): Promise<chrome.tabs.Tab> {
	if (targetTabId !== undefined) return chrome.tabs.get(targetTabId)

	const { currentTabId } = (await chrome.storage.local.get('currentTabId')) as {
		currentTabId?: number
	}
	if (typeof currentTabId === 'number') {
		try {
			return await chrome.tabs.get(currentTabId)
		} catch {
			// tab may have been closed — fall through to active tab
		}
	}

	const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
	if (!active) throw new Error('No active tab found.')
	return active
}
