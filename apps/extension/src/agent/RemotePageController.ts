import type { BrowserState } from '@page-agent/page-controller'

import type { TabsController } from './TabsController'

const PREFIX = '[RemotePageController]'

const debug = console.debug.bind(console, `\x1b[90m${PREFIX}\x1b[0m`)

function sendMessage(message: {
	type: 'PAGE_CONTROL'
	action: string
	targetTabId: number
	payload?: any
}): Promise<any> {
	return chrome.runtime.sendMessage(message).catch((error) => {
		console.error(PREFIX, message.action, error)
		return null
	})
}

export class RemotePageController {
	tabsController: TabsController

	constructor(tabsController: TabsController) {
		this.tabsController = tabsController
	}

	get currentTabId(): number | null {
		return this.tabsController.currentTabId
	}

	private async getCurrentUrl(): Promise<string> {
		if (!this.currentTabId) return ''
		const { url } = await this.tabsController.getTabInfo(this.currentTabId)
		return url || ''
	}

	private async getCurrentTitle(): Promise<string> {
		if (!this.currentTabId) return ''
		const { title } = await this.tabsController.getTabInfo(this.currentTabId)
		return title || ''
	}

	async getLastUpdateTime(): Promise<number> {
		if (!this.currentTabId) throw new Error('tabsController not initialized.')
		return sendMessage({
			type: 'PAGE_CONTROL',
			action: 'get_last_update_time',
			targetTabId: this.currentTabId,
		})
	}

	async getBrowserState(): Promise<BrowserState> {
		let browserState: BrowserState
		debug('getBrowserState', this.currentTabId)

		const currentUrl = await this.getCurrentUrl()
		const currentTitle = await this.getCurrentTitle()

		if (!this.currentTabId || !isContentScriptAllowed(currentUrl)) {
			browserState = {
				url: currentUrl,
				title: currentTitle,
				header: '',
				content: '(empty page. either current page is not readable or not loaded yet.)',
				footer: '',
			}
		} else {
			const raw = await sendMessage({
				type: 'PAGE_CONTROL',
				action: 'get_browser_state',
				targetTabId: this.currentTabId,
			})
			// null = background unreachable; missing .content = error response from background
			if (!raw || typeof raw.content !== 'string') {
				const reason = raw?.error ?? 'content script unavailable'
				browserState = {
					url: currentUrl,
					title: currentTitle,
					header: '',
					content: `(page not readable — ${reason}. Refresh the page and try again.)`,
					footer: '',
				}
			} else {
				browserState = raw
			}
		}

		const sum = await this.tabsController.summarizeTabs()
		browserState.header = sum + '\n\n' + (browserState.header || '')

		debug('getBrowserState: success', this.currentTabId, browserState)

		return browserState
	}

	async updateTree(): Promise<void> {
		if (!this.currentTabId || !isContentScriptAllowed(await this.getCurrentUrl())) {
			return
		}

		await sendMessage({
			type: 'PAGE_CONTROL',
			action: 'update_tree',
			targetTabId: this.currentTabId,
		})
	}

	async cleanUpHighlights(): Promise<void> {
		if (!this.currentTabId || !isContentScriptAllowed(await this.getCurrentUrl())) {
			return
		}

		await sendMessage({
			type: 'PAGE_CONTROL',
			action: 'clean_up_highlights',
			targetTabId: this.currentTabId,
		})
	}

	async clickElement(...args: any[]): Promise<DomActionReturn> {
		const res = await this.remoteCallDomAction('click_element', args)
		// Give the browser time to start any navigation triggered by the click.
		await new Promise((resolve) => setTimeout(resolve, 200))
		return res
	}

	async inputText(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('input_text', args)
	}

	async selectOption(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('select_option', args)
	}

	async scroll(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('scroll', args)
	}

	async scrollHorizontally(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('scroll_horizontally', args)
	}

	// `execute_javascript` is intentionally not implemented: AbortSignal cannot cross context

	/** @note Managed by content script via storage polling. */
	async showMask(): Promise<void> {}
	/** @note Managed by content script via storage polling. */
	async hideMask(): Promise<void> {}
	/** @note Managed by content script via storage polling. */
	dispose(): void {}

	private async remoteCallDomAction(action: string, payload: any[]): Promise<DomActionReturn> {
		if (!this.currentTabId) {
			return { success: false, message: 'RemotePageController not initialized.' }
		}

		if (!isContentScriptAllowed(await this.getCurrentUrl())) {
			return {
				success: false,
				message:
					'Operation not allowed on this page. Use open_new_tab to navigate to a web page first.',
			}
		}

		const result = await sendMessage({
			type: 'PAGE_CONTROL',
			action: action,
			targetTabId: this.currentTabId!,
			payload,
		})
		if (!result) {
			return { success: false, message: 'Content script unavailable. Refresh the page and try again.' }
		}
		return result
	}

	async detectLoginFields(): Promise<any> {
		if (!this.currentTabId) return null
		return sendMessage({
			type: 'PAGE_CONTROL',
			action: 'detect_login_fields',
			targetTabId: this.currentTabId,
			payload: {},
		})
	}
}

interface DomActionReturn {
	success: boolean
	message: string
}

export function isContentScriptAllowed(url: string | undefined): boolean {
	if (!url) return false

	const restrictedPatterns = [
		/^chrome:\/\//,
		/^chrome-extension:\/\//,
		/^about:/,
		/^edge:\/\//,
		/^brave:\/\//,
		/^opera:\/\//,
		/^vivaldi:\/\//,
		/^file:\/\//,
		/^view-source:/,
		/^devtools:\/\//,
	]

	return !restrictedPatterns.some((pattern) => pattern.test(url))
}
