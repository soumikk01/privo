import { type AgentConfig, PageAgentCore } from '@page-agent/core'

import { RemotePageController } from './RemotePageController'
import { TabsController } from './TabsController'
import SYSTEM_PROMPT from './system_prompt.md?raw'
import { createTabTools } from './tabTools'
import { prepareModelContext, clearPrivacySession } from '../privacy/privacy-gateway'

function detectLanguage(): 'en-US' | 'zh-CN' {
	const lang = navigator.language || navigator.languages?.[0] || 'en-US'
	return lang.startsWith('zh') ? 'zh-CN' : 'en-US'
}

interface MultiPageAgentConfig extends AgentConfig {
	includeInitialTab?: boolean
	experimentalIncludeAllTabs?: boolean
}

export class MultiPageAgent extends PageAgentCore {
	public tabsController: TabsController
	public remotePageController: RemotePageController

	constructor(config: MultiPageAgentConfig) {
		const tabsController = new TabsController()
		const pageController = new RemotePageController(tabsController)
		const customTools = createTabTools(tabsController)

		const language = config.language ?? detectLanguage()
		const targetLanguage = language === 'zh-CN' ? '中文' : 'English'
		const systemPrompt = SYSTEM_PROMPT.replace(
			/Default working language: \*\*.*?\*\*/,
			`Default working language: **${targetLanguage}**`
		)

		const includeInitialTab = config.includeInitialTab ?? true
		const experimentalIncludeAllTabs = config.experimentalIncludeAllTabs ?? false

		// unload doesn't fire reliably in a side panel, so we pulse a heartbeat.
		// The content script uses it to decide whether the agent is still alive.
		let heartBeatInterval: number | null = null

		super({
			...config,
			// Disabled: AbortSignal cannot cross contexts
			experimentalScriptExecutionTool: false,
			pageController: pageController as any,
			// [PRIVO] modified: merge caller-provided customTools (e.g. capture_screenshot)
			// instead of overwriting them with the tab tools.
			customTools: { ...customTools, ...config.customTools },
			customSystemPrompt: systemPrompt,

			// [PRIVO PRIVACY] — run the local privacy gateway before any DOM content
			// reaches the LLM. If the gateway returns BLOCKED, replace the content
			// with a safe error notice. This is the single transformation point.
			transformPageContent: config.transformPageContent ?? (async (content: string) => {
				try {
					const ctx = await prepareModelContext({
						task: '',           // task text sanitized separately in main.ts
						domContent: content,
						url: tabsController.currentTabId
							? (await chrome.tabs.get(tabsController.currentTabId).catch(() => null))?.url ?? ''
							: '',
						title: tabsController.currentTabId
							? (await chrome.tabs.get(tabsController.currentTabId).catch(() => null))?.title ?? ''
							: '',
					})
					// Dispatch privacy status event so the panel UI can update
					window.dispatchEvent(new CustomEvent('privo:privacy-update', { detail: ctx.redactionReport }))
					return ctx.sanitizedDom
				} catch (err) {
					// FAIL-CLOSED: if the gateway is blocked or fails, return a safe
					// error string that tells the model it cannot see the page.
					// The task will fail cleanly instead of leaking PII.
					const reason = err instanceof Error ? err.message : String(err)
					console.warn('[PRIVO] Privacy gateway blocked page content:', reason)
					window.dispatchEvent(new CustomEvent('privo:privacy-blocked', { detail: { reason } }))
					return `[PRIVO PRIVACY BLOCK] Page content is not available: ${reason}`
				}
			}),

			onBeforeTask: async (agent) => {
				await tabsController.init(agent.task, { includeInitialTab, experimentalIncludeAllTabs })
			},

			onBeforeStep: async (agent) => {
				await tabsController.syncTabs()
				if (!tabsController.currentTabId) return
				await tabsController.waitUntilTabLoaded(tabsController.currentTabId, { signal: agent.signal })
			},

			onDispose: () => {
				if (heartBeatInterval) {
					clearInterval(heartBeatInterval)
					heartBeatInterval = null
				}
				chrome.storage.local.set({ isAgentRunning: false }).catch(console.error)

				// [PRIVO PRIVACY] Clear the task-scoped placeholder registry.
				// Raw PII values are wiped from memory when the task ends.
				try {
					clearPrivacySession()
				} catch {
					// ignore
				}

				tabsController.dispose()
			},
		})

		this.tabsController = tabsController
		this.remotePageController = pageController

		this.addEventListener('statuschange', () => {
			const running = this.status === 'running'

			if (running && !heartBeatInterval) {
				heartBeatInterval = window.setInterval(() => {
					void chrome.storage.local.set({ agentHeartbeat: Date.now() })
				}, 1_000)
			} else if (!running && heartBeatInterval) {
				clearInterval(heartBeatInterval)
				heartBeatInterval = null
			}

			chrome.storage.local.set({ isAgentRunning: running }).catch(console.error)
		})
	}
}
