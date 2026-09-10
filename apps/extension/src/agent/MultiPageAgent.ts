import { type AgentConfig, PageAgentCore } from '@page-agent/core'

import { createPrivacyTransformHook } from '../privacy/pipeline'
import { RemotePageController } from './RemotePageController'
import { TabsController } from './TabsController'
import SYSTEM_PROMPT from './system_prompt.md?raw'
import { createTabTools } from './tabTools'

function detectLanguage(): 'en-US' | 'zh-CN' {
	const lang = navigator.language || navigator.languages?.[0] || 'en-US'
	return lang.startsWith('zh') ? 'zh-CN' : 'en-US'
}

interface MultiPageAgentConfig extends AgentConfig {
	includeInitialTab?: boolean
	experimentalIncludeAllTabs?: boolean
}

export class MultiPageAgent extends PageAgentCore {
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
			transformPageContent: config.transformPageContent ?? createPrivacyTransformHook({ enabled: true }),
			// [PRIVO] modified: merge caller-provided customTools (e.g. capture_screenshot)
			// instead of overwriting them with the tab tools.
			customTools: { ...customTools, ...config.customTools },
			customSystemPrompt: systemPrompt,

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

				tabsController.dispose()
			},
		})

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
