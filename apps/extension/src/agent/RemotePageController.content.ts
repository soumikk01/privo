import { PageController } from '@page-agent/page-controller'

export function initPageController() {
	let pageController: PageController | null = null
	let intervalID: number | null = null
	// While in the future, the mask must NEVER be created or shown — set by
	// hide_mask_now right before a sealed capture. Guards against the 500ms poll
	// re-creating the overlay mid-capture and burning it into evidence.
	let maskLockedUntil = 0

	const myTabIdPromise = chrome.runtime
		.sendMessage({ type: 'PAGE_CONTROL', action: 'get_my_tab_id' })
		.then((response) => {
			return (response as { tabId: number | null }).tabId
		})
		.catch((error) => {
			console.error('[RemotePageController.ContentScript]: Failed to get my tab id', error)
			return null
		})

	function getPC(): PageController {
		if (!pageController) {
			pageController = new PageController({
				enableMask: false,
				viewportExpansion: 400,
			})
		}
		return pageController
	}

	intervalID = window.setInterval(async () => {
		// [PRIVO] added: when the extension is reloaded/updated, content scripts from
		// the previous version keep running but lose their runtime context. Detect that
		// and shut this instance down instead of throwing "Extension context invalidated"
		// on every tick. The new version's content script takes over on page reload.
		if (!chrome.runtime?.id) {
			if (intervalID) clearInterval(intervalID)
			intervalID = null
			try {
				pageController?.dispose()
			} catch {
				/* ignore — context is gone */
			}
			pageController = null
			return
		}

		const agentHeartbeat = (await chrome.storage.local.get('agentHeartbeat')).agentHeartbeat
		const now = Date.now()
		const agentInTouch = typeof agentHeartbeat === 'number' && now - agentHeartbeat < 2_000

		const isAgentRunning = (await chrome.storage.local.get('isAgentRunning')).isAgentRunning
		const currentTabId = (await chrome.storage.local.get('currentTabId')).currentTabId

		// [PRIVO] added: maskSuppressed is set by the panel right before a sealed
		// capture so the gradient border + simulated cursor never appear in evidence.
		const maskSuppressed = (await chrome.storage.local.get('maskSuppressed')).maskSuppressed

		const maskLocked = Date.now() < maskLockedUntil

		const shouldShowMask =
			isAgentRunning &&
			agentInTouch &&
			!maskSuppressed &&
			!maskLocked &&
			currentTabId === (await myTabIdPromise)

		if (shouldShowMask) {
			const pc = getPC()
			pc.initMask()
			await pc.showMask()
		} else if (maskSuppressed || maskLocked) {
			// Capture in progress — hideMask() only fades; dispose() removes the DOM
			// instantly so the overlay can never appear in a captured frame.
			try {
				pageController?.dispose()
			} catch {
				/* already gone */
			}
			pageController = null
		} else {
			if (pageController) {
				pageController.hideMask()
				pageController.cleanUpHighlights()
			}
		}

		if (!isAgentRunning && agentInTouch) {
			if (pageController) {
				pageController.dispose()
				pageController = null
			}
		}
	}, 500)

	// execute_javascript excluded — defence in depth, mirrors the LLM tool layer.
	const ALLOWED_ACTIONS = new Set([
		'get_last_update_time',
		'get_browser_state',
		'update_tree',
		'clean_up_highlights',
		'hide_mask_now',
		'hide_fixed_elements',
		'restore_fixed_elements',
		'click_element',
		'input_text',
		'select_option',
		'scroll',
		'scroll_horizontally',
		'get_scroll_info',
		'scroll_to_position',
	])

	chrome.runtime.onMessage.addListener((message, sender, sendResponse): true | undefined => {
		if (sender.id !== chrome.runtime.id) return

		if (message.type !== 'PAGE_CONTROL') return

		const { action, payload } = message

		if (!ALLOWED_ACTIONS.has(action)) {
			sendResponse({ success: false, error: `Action '${action}' is not permitted` })
			return
		}

		// [PRIVO] added: instantly remove the visual overlay (gradient border +
		// simulated cursor) before a sealed capture. hideMask() only fades out —
		// dispose() removes the DOM immediately, so evidence never contains it.
		if (action === 'hide_mask_now') {
			// Lock long enough to cover the slowest multi-segment capture
			// (15 segments × ~600ms). restore_fixed_elements releases it early.
			maskLockedUntil = Date.now() + 20_000
			try {
				pageController?.dispose()
			} catch {
				/* already gone */
			}
			pageController = null
			sendResponse({ success: true })
			return
		}

		// Hide position:fixed and position:sticky elements before multi-segment capture
		// so they don't appear duplicated across every stitched viewport segment
		// (e.g. pinned nav bars, floating chat buttons, cookie banners, sticky headers).
		if (action === 'hide_fixed_elements') {
			const all = Array.from(document.querySelectorAll<HTMLElement>('*'))
			// Read pass first (batched) — interleaving reads and writes forces a reflow per element.
			const toHide = all.filter((el) => {
				const pos = getComputedStyle(el).position
				return pos === 'fixed' || pos === 'sticky'
			})
			// Write pass after all reads are done.
			const hidden = toHide.map((el) => {
				const vis = el.style.visibility
				el.style.visibility = 'hidden'
				return { el, vis }
			})
			;(window as any).__PRIVOHiddenFixed = hidden
			// Scroll anchoring can silently move scrollY after a scroll settles when
			// lazy content loads above the viewport — disable it for the capture.
			;(window as any).__PRIVOPrevOverflowAnchor = document.documentElement.style.overflowAnchor
			document.documentElement.style.overflowAnchor = 'none'
			sendResponse({ success: true })
			return
		}

		if (action === 'restore_fixed_elements') {
			const hidden = (window as any).__PRIVOHiddenFixed as Array<{ el: HTMLElement; vis: string }> | undefined
			if (hidden) {
				hidden.forEach(({ el, vis }) => { el.style.visibility = vis })
				delete (window as any).__PRIVOHiddenFixed
			}
			if ('__PRIVOPrevOverflowAnchor' in window) {
				document.documentElement.style.overflowAnchor =
					((window as any).__PRIVOPrevOverflowAnchor as string) ?? ''
				delete (window as any).__PRIVOPrevOverflowAnchor
			}
			maskLockedUntil = 0
			sendResponse({ success: true })
			return
		}

		if (action === 'get_scroll_info') {
			sendResponse({
				scrollHeight: Math.max(
					document.documentElement.scrollHeight,
					document.body?.scrollHeight ?? 0
				),
				viewportHeight: window.innerHeight,
				viewportWidth: window.innerWidth,
				scrollY: window.scrollY,
			})
			return
		}

		if (action === 'scroll_to_position') {
			const y = (payload as { y: number } | undefined)?.y ?? 0
			window.scrollTo({ top: y, behavior: 'instant' })
			// Report where the page ACTUALLY landed — the browser clamps scrollTo at
			// (scrollHeight - viewportHeight). Stitching must use this real offset.
			sendResponse({ success: true, y: window.scrollY })
			return
		}

		const methodName = getMethodName(action)
		const pc = getPC() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>

		pc[methodName](...((payload as unknown[]) || []))
			.then((result) => sendResponse(result))
			.catch((error: unknown) =>
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error),
				})
			)

		return true
	})
}

function getMethodName(action: string): string {
	switch (action) {
		case 'get_last_update_time':    return 'getLastUpdateTime'
		case 'get_browser_state':       return 'getBrowserState'
		case 'update_tree':             return 'updateTree'
		case 'clean_up_highlights':     return 'cleanUpHighlights'
		case 'click_element':           return 'clickElement'
		case 'input_text':              return 'inputText'
		case 'select_option':           return 'selectOption'
		case 'scroll':                  return 'scroll'
		case 'scroll_horizontally':     return 'scrollHorizontally'
		default:                        throw new Error(`[RemotePageController] unknown action: ${action}`)
	}
}
