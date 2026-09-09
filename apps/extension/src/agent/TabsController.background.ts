// Stateless by design — MV3 service workers are killed and restarted at any time.
import { isSafeUrl } from './tabTools'
import type { TabAction } from './TabsController'

const PREFIX = '[TabsController.background]'

const debug = console.debug.bind(console, `\x1b[90m${PREFIX}\x1b[0m`)

// tabs.query({ active: true }) is unreliable in multi-window scenarios.
// Extension pages pass their windowId; content scripts fall back to sender.tab.
async function resolveActiveTab(
	payload: { windowId?: number } | undefined,
	sender: chrome.runtime.MessageSender
): Promise<chrome.tabs.Tab> {
	const windowId = payload?.windowId

	if (windowId != null) {
		debug('get_active_tab: resolving via caller-reported windowId', windowId)
		const [tab] = await chrome.tabs.query({ active: true, windowId })
		if (!tab) throw new Error(`No active tab found in window ${windowId}.`)
		return tab
	}

	if (sender.tab) {
		debug('get_active_tab: resolving via sender.tab (content script)', sender.tab.id)
		return sender.tab
	}

	throw new Error(
		'Cannot resolve active tab: caller reported no windowId and is not a content script (no sender.tab).'
	)
}

export function handleTabControlMessage(
	message: { type: 'TAB_CONTROL'; action: TabAction; payload: any },
	sender: chrome.runtime.MessageSender,
	sendResponse: (response: unknown) => void
): true | undefined {
	const { action, payload } = message

	switch (action as TabAction) {
		case 'get_active_tab': {
			debug('get_active_tab', payload)
			resolveActiveTab(payload, sender)
				.then((tab) => {
					debug('get_active_tab: success', tab)
					sendResponse({ success: true, tab })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'get_tab_info': {
			debug('get_tab_info', payload)
			chrome.tabs
				.get(payload.tabId)
				.then((tab) => {
					debug('get_tab_info: success', tab)
					sendResponse(tab)
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'open_new_tab': {
			debug('open_new_tab', payload)
			const urlCheck = isSafeUrl(payload.url)
			if (!urlCheck.ok) {
				sendResponse({ error: `URL rejected: ${urlCheck.reason}` })
				return
			}
			chrome.tabs
				.create({ url: payload.url, windowId: payload.windowId, active: true })
				.then((newTab) => {
					debug('open_new_tab: success', newTab)
					sendResponse({ success: true, tabId: newTab.id })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'create_tab_group': {
			debug('create_tab_group', payload)
			chrome.tabs
				.group({ tabIds: payload.tabIds, createProperties: { windowId: payload.windowId } })
				.then((groupId) => {
					debug('create_tab_group: success', groupId)
					sendResponse({ success: true, groupId })
				})
				.catch((error) => {
					console.error(PREFIX, 'Failed to create tab group', error)
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'update_tab_group': {
			debug('update_tab_group', payload)
			chrome.tabGroups
				.update(payload.groupId, payload.properties)
				.then(() => {
					sendResponse({ success: true })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'add_tab_to_group': {
			debug('add_tab_to_group', payload)
			chrome.tabs
				.group({ tabIds: payload.tabId, groupId: payload.groupId })
				.then(() => {
					sendResponse({ success: true })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'activate_tab': {
			debug('activate_tab', payload)
			chrome.tabs
				.update(payload.tabId, { active: true })
				.then(() => {
					sendResponse({ success: true })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true
		}

		case 'close_tab': {
			debug('close_tab', payload)
			chrome.tabs
				.remove(payload.tabId)
				.then(() => {
					sendResponse({ success: true })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true // async response
		}

		case 'get_window_tabs': {
			chrome.tabs
				.query({ windowId: payload.windowId })
				.then((tabs) => {
					sendResponse({ success: true, tabs })
				})
				.catch((error) => {
					sendResponse({ error: error instanceof Error ? error.message : String(error) })
				})
			return true
		}

		default:
			sendResponse({ error: `Unknown action: ${action}` })
			return
	}
}
