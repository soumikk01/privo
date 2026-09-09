import { handlePageControlMessage } from '../agent/RemotePageController.background'
import { handleTabControlMessage } from '../agent/TabsController.background'
import { handleScreenshotMessage } from '../tools/screenshot.background'

console.log('[Background] PRIVO Page Agent service worker started')

chrome.runtime.onMessage.addListener((message, sender, sendResponse): true | undefined => {
	// Reject messages from outside this extension before dispatching.
	if (sender.id !== chrome.runtime.id) {
		sendResponse({ error: 'Unauthorized sender' })
		return
	}

	if (message?.type === 'TAB_CONTROL') {
		return handleTabControlMessage(message, sender, sendResponse)
	} else if (message?.type === 'PAGE_CONTROL') {
		return handlePageControlMessage(message, sender, sendResponse)
	} else if (message?.type === 'SCREENSHOT_CONTROL') {
		return handleScreenshotMessage(message, sender, sendResponse)
	} else {
		sendResponse({ error: 'Unknown message type' })
		return
	}
})

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
