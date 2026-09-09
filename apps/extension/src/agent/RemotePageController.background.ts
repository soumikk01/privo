// execute_javascript is absent even though it's disabled at the LLM tool layer —
// defence in depth so the raw message channel can't bypass that restriction.
const PROXIABLE_ACTIONS = new Set([
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

export function handlePageControlMessage(
	message: { type: 'PAGE_CONTROL'; action: string; payload: unknown; targetTabId: number },
	sender: chrome.runtime.MessageSender,
	sendResponse: (response: unknown) => void
): true | undefined {
	const PREFIX = '[RemotePageController.background]'

	if (sender.id !== chrome.runtime.id) {
		console.warn(PREFIX, 'Rejected message from unknown sender', sender.id)
		sendResponse({ success: false, error: 'Unauthorized sender' })
		return
	}

	const { action, payload, targetTabId } = message

	if (action === 'get_my_tab_id') {
		sendResponse({ tabId: sender.tab?.id ?? null })
		return
	}

	if (!PROXIABLE_ACTIONS.has(action)) {
		console.warn(PREFIX, `Blocked disallowed action: ${action}`)
		sendResponse({ success: false, error: `Action '${action}' is not permitted` })
		return
	}

	chrome.tabs
		.sendMessage(targetTabId, { type: 'PAGE_CONTROL', action, payload })
		.then((result) => sendResponse(result))
		.catch((error) => {
			console.error(PREFIX, error)
			sendResponse({
				success: false,
				error: error instanceof Error ? error.message : String(error),
			})
		})

	return true // async response
}
