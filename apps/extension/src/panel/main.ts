// Stage layout: exactly one of composer / now / ask / result is visible at a time.
import type { AgentActivity, AgentStatus } from '@page-agent/core'

import { MultiPageAgent } from '../agent/MultiPageAgent'
import { BACKEND_URL, DEFAULT_LLM_CONFIG, llmFetch } from '../config'
import { sealCapture, type SealedCapture } from '../seal'
import { createScreenshotTool } from '../tools/screenshot'

// ---------- elements ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const statusEl = $('status')
const statusLabelEl = $('status-label')
const restartBtn = $('restart')

const composerEl = $('composer')
const taskEl = $<HTMLTextAreaElement>('task')

const nowEl = $('now')
const nowActionEl = $('now-action')
const nowMetaEl = $('now-meta')
const runningTaskEl = $('running-task')

const askEl = $('askuser')
const askQEl = $('askuser-q')
const askOptionsEl = $('askuser-options')
const askAEl = $<HTMLInputElement>('askuser-a')

// Login gate elements
const askStandardEl = $('ask-standard')
const askLoginEl = $('ask-login')
const loginGateMsgEl = $('login-gate-msg')
const loginOptionsEl = $('login-options')
const loginSigninBtn = $<HTMLButtonElement>('login-signin-btn')
const loginSkipBtn = $<HTMLButtonElement>('login-skip-btn')
const loginInputZoneEl = $('login-input-zone')
const loginFieldAEl = $<HTMLInputElement>('login-field-a')
const loginFieldSendEl = $<HTMLButtonElement>('login-field-send')
const sorryBodyEl = $('sorry-body')

// Multi-choice login gate elements
const loginActionChoicesEl = $('login-action-choices')
const loginChoiceAutofillBtn = $<HTMLButtonElement>('login-choice-autofill')
const loginChoiceManualBtn = $<HTMLButtonElement>('login-choice-manual')
const loginChoiceAgentfillBtn = $<HTMLButtonElement>('login-choice-agentfill')

const loginManualViewEl = $('login-manual-view')
const loginManualDoneBtn = $<HTMLButtonElement>('login-manual-done-btn')
const loginManualCancelBtn = $<HTMLButtonElement>('login-manual-cancel-btn')
const manualCountdownEl = $('manual-countdown')

const loginAgentfillViewEl = $('login-agentfill-view')
const agentfillDomainEl = $('agentfill-domain')
const agentfillDetectedBadgeEl = $('agentfill-detected-badge')
const agentfillUserWrapEl = $('agentfill-user-wrap')
const agentfillPassWrapEl = $('agentfill-pass-wrap')
const agentfillUserEl = $<HTMLInputElement>('agentfill-user')
const agentfillPassEl = $<HTMLInputElement>('agentfill-pass')
const agentfillRememberEl = $<HTMLInputElement>('agentfill-remember')
const agentfillSubmitBtn = $<HTMLButtonElement>('agentfill-submit-btn')
const agentfillCancelBtn = $<HTMLButtonElement>('agentfill-cancel-btn')

const resultEl = $('result')
const resultTitleEl = $('result-title')
const resultBodyEl = $('result-body')
const resultImgEl = $<HTMLImageElement>('result-img')
const resultDownloadBtn = $<HTMLButtonElement>('result-download')
const resultRetryBtn = $<HTMLButtonElement>('result-retry')

const activitySection = $('activity-section')
const feedEl = $('feed')
const todoListCard = $('todo-list-card')
const stepsToggleBtn = $<HTMLButtonElement>('steps-toggle-btn')
const stepsCounter = $('steps-counter')
const todoHeaderIconTodo = document.querySelector<SVGElement>('.todo-header-icon--todo')
const todoHeaderIconComplete = document.querySelector<SVGElement>('.todo-header-icon--complete')

let totalSteps = 0
let completedSteps = 0

stepsToggleBtn?.addEventListener('click', () => {
	const isCollapsed = todoListCard?.classList.toggle('is-collapsed')
	stepsToggleBtn.setAttribute('aria-expanded', String(!isCollapsed))
})

function updateStepsCounter(): void {
	if (stepsCounter) {
		stepsCounter.textContent = `${completedSteps}/${totalSteps}`
		const allDone = totalSteps > 0 && completedSteps === totalSteps
		stepsCounter.classList.toggle('is-completed', allDone)
		if (todoHeaderIconTodo && todoHeaderIconComplete) {
			if (allDone) {
				todoHeaderIconTodo.classList.add('hidden')
				todoHeaderIconComplete.classList.remove('hidden')
			} else {
				todoHeaderIconTodo.classList.remove('hidden')
				todoHeaderIconComplete.classList.add('hidden')
			}
		}
	}
}

function resetStepsPlan(): void {
	totalSteps = 0
	completedSteps = 0
	feedEl.replaceChildren()
	todoListCard?.classList.remove('is-collapsed')
	stepsToggleBtn?.setAttribute('aria-expanded', 'true')
	updateStepsCounter()
}
const shotsEl = $('shots')
const shotsCountEl = $('shots-count')
const shotsClearBtn = $('shots-clear')
const backendDot = $('backend-dot')

;($('validator-link') as HTMLAnchorElement).href = `${BACKEND_URL}/validate`

// ---------- privacy panel element refs ----------

const privacySectionEl = $('privacy-section')
const privacyStatusBadgeEl = $('privacy-status-badge')
const privacyDetectedListEl = $('privacy-detected-list')
const privacyPreviewBodyEl = $('privacy-preview-body')

const BADGE_ICONS = {
	lock: '<svg class="privacy-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2.5" ry="2.5"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16.5" r="1.2" fill="currentColor"/></svg>',
	shieldCheck: '<svg class="privacy-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
	scan: '<svg class="privacy-badge-icon privacy-badge-icon--spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
	blocked: '<svg class="privacy-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
}

// ---------- sidebar + drawer element refs ----------

const sidebarRecentBtn = $<HTMLButtonElement>('sidebar-recent')
const sidebarSettingsBtn = $<HTMLButtonElement>('sidebar-settings')
const drawerBackdrop = $('drawer-backdrop')
const drawerEl = $('drawer')
const drawerTitleEl = $('drawer-title')
const drawerCloseBtn = $('drawer-close')
const recentPanel = $('recent-panel')
const settingsPanel = $('settings-panel')
const recentEmptyEl = $('recent-empty')
const recentListEl = $('recent-list')
const maxStepsInput = $<HTMLInputElement>('setting-maxsteps')
const maxStepsVal = $('setting-maxsteps-val')
const stepDelayInput = $<HTMLInputElement>('setting-stepdelay')
const stepDelayVal = $('setting-stepdelay-val')
const settingsSavedEl = $('settings-saved')
const settingsClearHistoryBtn = $<HTMLButtonElement>('settings-clear-history')

// ================================================================
// IndexedDB — Recent activities & Local Credential Vault
// ================================================================

interface ActivityRecord {
	id: string
	taskText: string
	url: string
	status: 'ok' | 'err' | 'stopped'
	stepCount: number
	timestamp: number
}

interface CredentialRecord {
	domain: string
	username: string
	password: string
	updatedAt: number
}

const DB_NAME = 'privo-history'
const DB_STORE = 'activities'
const DB_CRED_STORE = 'credentials'
const DB_VERSION = 2

function openHistoryDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION)
		req.onupgradeneeded = () => {
			const db = req.result
			if (!db.objectStoreNames.contains(DB_STORE)) {
				const store = db.createObjectStore(DB_STORE, { keyPath: 'id' })
				store.createIndex('timestamp', 'timestamp')
			}
			if (!db.objectStoreNames.contains(DB_CRED_STORE)) {
				const credStore = db.createObjectStore(DB_CRED_STORE, { keyPath: 'domain' })
				credStore.createIndex('updatedAt', 'updatedAt')
			}
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
}

async function saveCredential(domain: string, username: string, password: string): Promise<void> {
	if (!domain) return
	try {
		const db = await openHistoryDB()
		const tx = db.transaction(DB_CRED_STORE, 'readwrite')
		tx.objectStore(DB_CRED_STORE).put({
			domain: domain.toLowerCase().replace(/^www\./, ''),
			username,
			password,
			updatedAt: Date.now(),
		} satisfies CredentialRecord)
		tx.oncomplete = () => db.close()
	} catch (e) {
		console.warn('[PRIVO] Failed to save credential to vault', e)
	}
}

async function getCredential(domain: string): Promise<CredentialRecord | null> {
	if (!domain) return null
	const cleanDomain = domain.toLowerCase().replace(/^www\./, '')
	try {
		const db = await openHistoryDB()
		return new Promise((resolve) => {
			const tx = db.transaction(DB_CRED_STORE, 'readonly')
			const req = tx.objectStore(DB_CRED_STORE).get(cleanDomain)
			req.onsuccess = () => {
				db.close()
				resolve((req.result as CredentialRecord) ?? null)
			}
			req.onerror = () => {
				db.close()
				resolve(null)
			}
		})
	} catch {
		return null
	}
}

async function resolveCurrentTab(): Promise<chrome.tabs.Tab | null> {
	// 1. Agent's currentTabId if agent is running
	try {
		if (agent?.tabsController?.currentTabId) {
			const t = await chrome.tabs.get(agent.tabsController.currentTabId)
			if (t?.id) return t
		}
	} catch {}

	// 2. Storage currentTabId tracked by TabsController
	try {
		const { currentTabId } = (await chrome.storage.local.get('currentTabId')) as { currentTabId?: number }
		if (typeof currentTabId === 'number') {
			const t = await chrome.tabs.get(currentTabId)
			if (t?.id) return t
		}
	} catch {}

	// 3. Active tab in lastFocusedWindow (standard for Chrome side panel)
	try {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
		if (tab?.id) return tab
	} catch {}

	// 4. Fallback to currentWindow
	try {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
		if (tab?.id) return tab
	} catch {}

	return null
}

async function getCurrentDomain(): Promise<string> {
	try {
		const tab = await resolveCurrentTab()
		if (tab?.url) {
			const u = new URL(tab.url)
			return u.hostname.toLowerCase().replace(/^www\./, '')
		}
	} catch {}
	return ''
}

interface PageLoginFields {
	hasPassword: boolean
	isPasswordFilled: boolean
	hasUsername: boolean
	isUsernameFilled: boolean
	usernameVal: string
	hasOtp: boolean
	isOtpFilled?: boolean
	onlyFieldNeeded?: 'password' | 'username' | 'otp' | 'both'
}

/**
 * Direct DOM inspection executed via chrome.scripting.executeScript
 */
function inspectDomLoginFields() {
	const inputs = Array.from(
		document.querySelectorAll(
			'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"])'
		)
	) as HTMLInputElement[]

	const iframeInputs: HTMLInputElement[] = []
	try {
		const iframes = Array.from(document.querySelectorAll('iframe'))
		for (const iframe of iframes) {
			try {
				const doc = iframe.contentDocument || iframe.contentWindow?.document
				if (doc) {
					iframeInputs.push(
						...(Array.from(
							doc.querySelectorAll(
								'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"])'
							)
						) as HTMLInputElement[])
					)
				}
			} catch {}
		}
	} catch {}

	const allInputs = [...inputs, ...iframeInputs]

	const passwordInput = allInputs.find(
		(i) => i.type === 'password' || /password|passwd|pwd/i.test(i.name || i.id || i.placeholder || '')
	)

	const otpInput = allInputs.find(
		(i) => /otp|2fa|verification|code|pin|token/i.test(i.name || i.id || i.placeholder || i.autocomplete || '')
	)

	const userInputs = allInputs.filter((i) => i !== passwordInput && i !== otpInput)

	// Priority 1: User input that already has a non-empty value (e.g. prefilled JIS ID)
	const filledUserInput = userInputs.find(
		(i) =>
			(i.value?.trim().length ?? 0) > 0 &&
			!/search|query|filter|date|captcha|csrf|token|session/i.test(i.name || i.id || i.placeholder || '')
	)

	// Priority 2: Input matching user/login/email/id/student/roll regex
	const namedUserInput = userInputs.find((i) =>
		/user|email|login|account|enroll|roll|id|phone|student|reg|member/i.test(
			i.name || i.id || i.placeholder || i.autocomplete || ''
		)
	)

	const userInput = filledUserInput || namedUserInput || userInputs[0]

	const hasUsername = Boolean(userInput)
	const usernameVal = (userInput?.value || filledUserInput?.value || '').trim()
	const isUsernameFilled = usernameVal.length > 0

	const hasPassword = Boolean(passwordInput)
	const isPasswordFilled = Boolean(passwordInput && passwordInput.value.length > 0)

	const hasOtp = Boolean(otpInput)
	const isOtpFilled = Boolean(otpInput && otpInput.value.length > 0)

	let onlyFieldNeeded: 'password' | 'username' | 'otp' | 'both' = 'both'
	if (hasOtp && !isOtpFilled && !hasPassword) {
		onlyFieldNeeded = 'otp'
	} else if (hasPassword && !isPasswordFilled) {
		if (isUsernameFilled || !hasUsername) {
			onlyFieldNeeded = 'password'
		} else {
			onlyFieldNeeded = 'both'
		}
	} else if (hasUsername && !isUsernameFilled && (isPasswordFilled || !hasPassword)) {
		onlyFieldNeeded = 'username'
	}

	return {
		hasPassword,
		isPasswordFilled,
		hasUsername,
		isUsernameFilled,
		usernameVal,
		hasOtp,
		isOtpFilled,
		onlyFieldNeeded,
	}
}

async function detectPageLoginFields(): Promise<PageLoginFields | null> {
	try {
		const tab = await resolveCurrentTab()
		if (!tab?.id) return null

		// Method 1: Ask content script via tabs.sendMessage
		try {
			const res = (await chrome.tabs.sendMessage(tab.id, {
				type: 'PAGE_CONTROL',
				action: 'detect_login_fields',
				payload: {},
			})) as { success: boolean; data?: PageLoginFields }
			if (res?.success && res.data) {
				return res.data
			}
		} catch {}

		// Method 2: Via agent remotePageController if running
		if (agent?.remotePageController) {
			try {
				const res = await agent.remotePageController.detectLoginFields()
				if (res?.success && res.data) {
					return res.data
				}
			} catch {}
		}

		// Method 3: Fallback direct execution via chrome.scripting.executeScript
		if (chrome.scripting?.executeScript) {
			try {
				const results = await chrome.scripting.executeScript({
					target: { tabId: tab.id },
					func: inspectDomLoginFields,
				})
				if (results?.[0]?.result) {
					return results[0].result as PageLoginFields
				}
			} catch {}
		}
	} catch {
		// Fallback
	}
	return null
}

async function saveActivity(record: Omit<ActivityRecord, 'id'>) {
	try {
		const db = await openHistoryDB()
		const tx = db.transaction(DB_STORE, 'readwrite')
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
		tx.objectStore(DB_STORE).put({ id, ...record })
		tx.oncomplete = () => db.close()
	} catch (e) {
		console.warn('[PRIVO] Failed to save activity', e)
	}
}

async function loadActivities(limit = 40): Promise<ActivityRecord[]> {
	try {
		const db = await openHistoryDB()
		return new Promise((resolve, reject) => {
			const tx = db.transaction(DB_STORE, 'readonly')
			const index = tx.objectStore(DB_STORE).index('timestamp')
			const results: ActivityRecord[] = []
			const req = index.openCursor(null, 'prev')
			req.onsuccess = () => {
				const cursor = req.result
				if (cursor && results.length < limit) {
					results.push(cursor.value as ActivityRecord)
					cursor.continue()
				} else {
					db.close()
					resolve(results)
				}
			}
			req.onerror = () => { db.close(); reject(req.error) }
		})
	} catch {
		return []
	}
}

async function clearAllActivities() {
	try {
		const db = await openHistoryDB()
		const tx = db.transaction(DB_STORE, 'readwrite')
		tx.objectStore(DB_STORE).clear()
		tx.oncomplete = () => db.close()
	} catch (e) {
		console.warn('[PRIVO] Failed to clear history', e)
	}
}

// ================================================================
// Settings storage (chrome.storage.local)
// ================================================================

interface PrivoSettings {
	maxSteps: number
	stepDelay: number
}

const DEFAULT_SETTINGS: PrivoSettings = { maxSteps: 40, stepDelay: 0 }
let _settings: PrivoSettings = { ...DEFAULT_SETTINGS }

async function loadSettings() {
	try {
		const stored = (await chrome.storage.local.get('privo-settings')) as { 'privo-settings'?: PrivoSettings }
		if (stored['privo-settings']) _settings = { ...DEFAULT_SETTINGS, ...stored['privo-settings'] }
	} catch { /* ignore */ }
	// Apply to UI
	maxStepsInput.value = String(_settings.maxSteps)
	maxStepsVal.textContent = String(_settings.maxSteps)
	stepDelayInput.value = String(_settings.stepDelay)
	stepDelayVal.textContent = _settings.stepDelay === 0 ? '0 ms' : `${_settings.stepDelay} ms`
}

async function saveSettings() {
	_settings.maxSteps = Number(maxStepsInput.value)
	_settings.stepDelay = Number(stepDelayInput.value)
	try {
		await chrome.storage.local.set({ 'privo-settings': _settings })
	} catch { /* ignore */ }
}

void loadSettings()

// ================================================================
// Sidebar / Drawer UI
// ================================================================

type DrawerPanel = 'recent' | 'settings'
let _activeDrawer: DrawerPanel | null = null

function openDrawer(panel: DrawerPanel) {
	_activeDrawer = panel
	drawerTitleEl.textContent = panel === 'recent' ? 'Recent Activity' : 'Settings'
	recentPanel.classList.toggle('hidden', panel !== 'recent')
	settingsPanel.classList.toggle('hidden', panel !== 'settings')
	drawerEl.classList.add('open')
	drawerEl.setAttribute('aria-hidden', 'false')
	drawerBackdrop.classList.remove('hidden')
	sidebarRecentBtn.classList.toggle('active', panel === 'recent')
	sidebarSettingsBtn.classList.toggle('active', panel === 'settings')
	if (panel === 'recent') void renderRecentList()
}

function closeDrawer() {
	_activeDrawer = null
	drawerEl.classList.remove('open')
	drawerEl.setAttribute('aria-hidden', 'true')
	drawerBackdrop.classList.add('hidden')
	sidebarRecentBtn.classList.remove('active')
	sidebarSettingsBtn.classList.remove('active')
}

sidebarRecentBtn.addEventListener('click', () => {
	if (_activeDrawer === 'recent') { closeDrawer(); return }
	openDrawer('recent')
})
sidebarSettingsBtn.addEventListener('click', () => {
	if (_activeDrawer === 'settings') { closeDrawer(); return }
	openDrawer('settings')
})
drawerCloseBtn.addEventListener('click', closeDrawer)
drawerBackdrop.addEventListener('click', closeDrawer)

// Keyboard: Escape closes drawer
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && _activeDrawer) closeDrawer()
})

// ── Render recent list ──
function formatRelativeTime(ts: number): string {
	const diff = Date.now() - ts
	const m = Math.floor(diff / 60000)
	if (m < 1) return 'Just now'
	if (m < 60) return `${m}m ago`
	const h = Math.floor(m / 60)
	if (h < 24) return `${h}h ago`
	return `${Math.floor(h / 24)}d ago`
}

function truncateTask(text: string, max = 60): string {
	return text.length > max ? text.slice(0, max).trimEnd() + '…' : text
}

async function renderRecentList() {
	const items = await loadActivities()
	if (items.length === 0) {
		recentEmptyEl.classList.remove('hidden')
		recentListEl.classList.add('hidden')
		return
	}
	recentEmptyEl.classList.add('hidden')
	recentListEl.classList.remove('hidden')
	recentListEl.replaceChildren(
		...items.map((item) => {
			const li = document.createElement('li')
			li.className = 'recent-item'
			const statusClass = item.status === 'ok' ? 'ok' : item.status === 'err' ? 'err' : 'stopped'
			const statusText = item.status === 'ok' ? 'Done' : item.status === 'err' ? 'Failed' : 'Stopped'
			const hostname = (() => { try { return new URL(item.url).hostname.replace(/^www\./, '') } catch { return item.url } })()
			li.innerHTML = `
				<div class="recent-item-head">
					<span class="recent-item-task">${truncateTask(item.taskText)}</span>
					<span class="recent-item-status ${statusClass}">${statusText}</span>
				</div>
				<div class="recent-item-meta">
					<span>${formatRelativeTime(item.timestamp)}</span>
					<span class="recent-item-sep">·</span>
					<span class="recent-item-url" title="${item.url}">${hostname}</span>
					<span class="recent-item-sep">·</span>
					<span>${item.stepCount} step${item.stepCount !== 1 ? 's' : ''}</span>
				</div>
			`
			return li
		})
	)
}

// ── Settings sliders ──
maxStepsInput.addEventListener('input', () => {
	maxStepsVal.textContent = maxStepsInput.value
	void saveSettings()
	showSettingsSaved()
})
stepDelayInput.addEventListener('input', () => {
	const v = Number(stepDelayInput.value)
	stepDelayVal.textContent = v === 0 ? '0 ms' : `${v} ms`
	void saveSettings()
	showSettingsSaved()
})

let _savedTimeout: number | undefined
function showSettingsSaved() {
	settingsSavedEl.textContent = '✓ Saved'
	clearTimeout(_savedTimeout)
	_savedTimeout = window.setTimeout(() => { settingsSavedEl.textContent = '' }, 1800)
}

// ── Clear history button ──
settingsClearHistoryBtn.addEventListener('click', async () => {
	settingsClearHistoryBtn.textContent = 'Clearing…'
	settingsClearHistoryBtn.setAttribute('disabled', '')
	await clearAllActivities()
	settingsClearHistoryBtn.textContent = 'All history cleared'
	setTimeout(() => {
		settingsClearHistoryBtn.textContent = 'Clear all history'
		settingsClearHistoryBtn.removeAttribute('disabled')
	}, 1800)
})

$('settings-github-link')?.addEventListener('click', (e) => {
	e.preventDefault()
	chrome.tabs.create({ url: 'https://github.com/soumikk01/privo' })
})


// ---------- the stage: one card at a time ----------

type Stage = 'composer' | 'now' | 'ask' | 'result' | 'login-sorry'
const loginSorryEl = $('login-sorry')
const STAGE_ELS: Record<Stage, HTMLElement> = {
	composer: composerEl,
	now: nowEl,
	ask: askEl,
	result: resultEl,
	'login-sorry': loginSorryEl,
}

function showStage(stage: Stage) {
	for (const [name, el] of Object.entries(STAGE_ELS)) {
		el.classList.toggle('hidden', name !== stage)
	}
	restartBtn.classList.toggle('hidden', stage === 'composer')
	if (stage === 'ask') {
		askEl.classList.remove('pulse')
		void askEl.offsetWidth
		askEl.classList.add('pulse')
		askAEl.focus()
	}
}

// ---------- status + run meta ----------

function setStatus(status: AgentStatus | 'waiting') {
	const labels: Record<string, string> = {
		idle: 'Ready',
		running: 'Working',
		waiting: 'Your turn',
		completed: 'Done',
		error: 'Failed',
		stopped: 'Stopped',
	}
	statusEl.className = `status status-${status}`
	statusLabelEl.textContent = labels[status] ?? status
}

let timerId: number | null = null
let startedAt = 0
let stepCount = 0

// ---------- Animation mode: auto-detected from agent behaviour ----------
//
// Every run starts in 'question' mode (quiet shimmer).
// The FIRST time the agent fires a real tool call (anything except 'done'),
// we automatically upgrade to 'task' mode — full scramble + cascade.
// This way we never mis-classify: only the agent knows what it's doing.
//
//  question mode: shimmer sweep only, dimmer indicator, soft border
//  task mode:     scramble cycling → cascade per verb → swap on transitions

type RunMode = 'question' | 'task'
let runMode: RunMode = 'question'

// Tools that are purely informational — keep us in question mode
const QUESTION_TOOLS = new Set(['done'])

const QUESTION_PHRASES = [
	'Analyzing…',
	'Reading the page…',
	'Checking details…',
]

const TASK_PHRASES = [
	'Thinking…',
	'Reading the page…',
	'Working through it…',
	'Forming a plan…',
]

/** Switch to task mode mid-run and immediately update the UI. */
function _upgradeToTaskMode() {
	if (runMode === 'task') return
	runMode = 'task'
	nowEl.classList.replace('mode-question', 'mode-task')
}

let _phraseTimer: number | null = null
let _phraseIdx = 0

function _clearAnimation() {
	if (_phraseTimer) { clearInterval(_phraseTimer); _phraseTimer = null }
	nowActionEl.classList.remove('shimmer', 'cascade', 'swap')
	nowActionEl.textContent = ''
}

/** Restart the CSS animation by removing and re-adding the class. */
function _reflow(el: HTMLElement, cls: string) {
	el.classList.remove(cls)
	void el.offsetWidth          // force reflow
	el.classList.add(cls)
}

/** Render text as individual letter-spans so each can animate in. */
function _scrambleTo(text: string) {
	nowActionEl.classList.remove('shimmer', 'cascade', 'swap')
	nowActionEl.innerHTML = [...text]
		.map((ch, i) => `<span class="scramble-char" style="animation-delay:${i * 28}ms">${ch === ' ' ? '&nbsp;' : ch}</span>`)
		.join('')
}

/**
 * Set the #now-action text with one of three animation variants:
 *  - "shimmer"  → quiet shimmer sweep (question mode)
 *  - "scramble" → per-letter scramble + cycling phrases (task thinking)
 *  - "cascade"  → slide-in from below (task action verbs)
 *  - "swap"     → scale-fade (transitions / question mode actions)
 */
function setNowAction(text: string, variant: 'shimmer' | 'cascade' | 'swap' | 'scramble' = 'cascade') {
	_clearAnimation()
	if (variant === 'shimmer') {
		nowActionEl.textContent = text
		nowActionEl.classList.add('shimmer')
	} else if (variant === 'scramble') {
		const phrases = runMode === 'question' ? QUESTION_PHRASES : TASK_PHRASES
		_phraseIdx = 0
		_scrambleTo(phrases[0])
		_phraseTimer = window.setInterval(() => {
			_phraseIdx = (_phraseIdx + 1) % phrases.length
			_scrambleTo(phrases[_phraseIdx])
		}, runMode === 'question' ? 1200 : 1800)
	} else if (variant === 'swap') {
		nowActionEl.textContent = text
		_reflow(nowActionEl, 'swap')
	} else {
		nowActionEl.textContent = text
		_reflow(nowActionEl, 'cascade')
	}
}

function startRunMeta() {
	startedAt = Date.now()
	stepCount = 0
	updateRunMeta()
	timerId = window.setInterval(updateRunMeta, 1000)
}
function stopRunMeta() {
	if (timerId) clearInterval(timerId)
	timerId = null
}
function updateRunMeta() {
	const s = Math.floor((Date.now() - startedAt) / 1000)
	nowMetaEl.textContent = `step ${stepCount} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---------- backend health (footer dot) ----------

async function pollBackend() {
	try {
		const r = await fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(2500) })
		backendDot.className = `backend-dot ${r.ok ? 'ok' : 'bad'}`
		backendDot.title = r.ok ? 'Backend online — captures are registered' : 'Backend error'
	} catch {
		backendDot.className = 'backend-dot bad'
		backendDot.title = 'Backend offline — captures will be watermarked but not registered. Run: npm run dev (in PRIVO-page-agent-ext-be)'
	}
}
void pollBackend()
setInterval(() => void pollBackend(), 15000)

// ---------- agent instructions ----------

const FLOW_INSTRUCTIONS = `
You are PRIVO Secure Browser Assistant: you complete web tasks with privacy-first assistance and verified capture, pausing for the user whenever their input is needed.

RULES FOR USER INPUT (critical):
- Whenever the task needs something only the user knows (email, username, OTP code, verification code, a choice between options), PAUSE and call ask_user with ONE short, specific question. Continue with the answer.
- PASSWORDS: never ask the user to send a password in chat. Instead: click the password field first, then call ask_user saying exactly: "Please type your password directly into the password field on the page, then reply done." Wait, then continue (do NOT re-type or read the password).
- Steps you cannot perform — Google/SSO account choosers, captchas, authenticator-app approvals, biometric prompts — call ask_user asking the user to complete that step in the page and reply "done".
- After a login step, verify it worked (page changed / user menu visible) before moving on.

CAPTURES:
- When the user wants a screenshot/capture/proof, scroll the target section fully into view first, then call capture_screenshot ONCE on the final target page. Do NOT capture intermediate pages or navigation steps — only the final destination the user asked to see.

SCOPE:
- Your scope is the CURRENT tab — the page the user already has open next to this panel. Work there.
- Do NOT open new tabs unless the task is impossible without one (e.g. an OAuth popup opened by the site itself).
- Stay on this website; don't wander to other sites.
`.trim()

// ---------- ask_user ----------

let askResolve: ((answer: string) => void) | null = null

// ---------- Option chip parser ----------
// Multi-pass extractor — tries formats from most to least specific.
// Pass 1: any parenthesised comma list: (PS5, Xbox, PC, etc.)
//         also (e.g., Google, Facebook, email)
// Pass 2: numbered list  1. A  2. B  3. C
// Pass 3: bullet list    - A  - B  - C
// Pass 4: "for example, A, B or C" inline
// Pass 5: broad  "A, B, or C" anywhere in sentence

const SKIP_WORDS = /^(e\.?g\.?|etc\.?|and|or|the|a|an|any|other|details?|more|full|title|platform|name)$/i

function parseOptions(question: string): string[] {
	// Pass 1 — ALL parenthesised lists (greedy: pick the one with most items)
	let bestFromParens: string[] = []
	for (const m of question.matchAll(/\(([^)]{2,120})\)/g)) {
		const items = m[1]
			.split(/,|;/)
			.map(s => s.trim().replace(/^e\.?g\.?,?\s*/i, ''))
			.filter(s => s && !SKIP_WORDS.test(s) && s.length >= 2 && s.length < 55)
		if (items.length >= 2 && items.length > bestFromParens.length) {
			bestFromParens = items
		}
	}
	if (bestFromParens.length >= 2) return bestFromParens

	// Pass 2 — Numbered list: "1. A\n2. B"
	const numbered = [...question.matchAll(/^\s*\d+[.)]\s*(.+)$/gm)]
		.map(m => m[1].trim()).filter(s => s.length >= 2 && s.length < 60)
	if (numbered.length >= 2) return numbered

	// Pass 3 — Bullet list: "- A\n- B" or "• A"
	const bullets = [...question.matchAll(/^[-•*]\s+(.+)$/gm)]
		.map(m => m[1].trim()).filter(s => s.length >= 2 && s.length < 60)
	if (bullets.length >= 2) return bullets

	// Pass 4 — "for example, A, B, or C" / "such as A, B, C"
	const egInline = question.match(
		/(?:for\s+example|such\s+as|like|including)[,:]?\s+([^.?!()]{4,120})/i
	)
	if (egInline) {
		const items = egInline[1].split(/,|\bor\b/i)
			.map(s => s.trim())
			.filter(s => s && !SKIP_WORDS.test(s) && s.length >= 2 && s.length < 55)
		if (items.length >= 2) return items
	}

	// Pass 5 — broad "A, B, or C" anywhere (last resort)
	const orSentence = question.match(/\b(\w[\w\s-]{1,30}),\s+(\w[\w\s-]{1,30}),?\s+or\s+(\w[\w\s-]{1,30})\b/)
	if (orSentence) {
		return [orSentence[1], orSentence[2], orSentence[3]]
			.map(s => s.trim())
			.filter(s => s && !SKIP_WORDS.test(s) && s.length >= 2)
	}

	return []
}

/** Render option chips and wire click→send. */
function renderOptions(options: string[]) {
	askOptionsEl.replaceChildren()
	if (!options.length) return

	options.forEach((opt, i) => {
		const chip = document.createElement('button')
		chip.className = 'ask-chip'
		chip.textContent = opt
		chip.style.animationDelay = `${i * 55}ms`
		chip.addEventListener('click', () => {
			// Mark selected, then send after a brief visual beat
			document.querySelectorAll('.ask-chip').forEach(c => c.classList.remove('selected'))
			chip.classList.add('selected')
			setTimeout(() => askResolve?.(opt), 160)
		})
		askOptionsEl.appendChild(chip)
	})
}

// ---------- Login flow detection ----------

/** True when the agent is asking about logging in / credentials */
const LOGIN_Q_RE = /\b(sign[\s-]?in|log[\s-]?in|log\s+in|login|authenticate|credentials?|password\s+field|account\s+required|need\s+to\s+(sign|log)|click\s+(sign|log)|complete\s+the\s+login|please\s+(sign|log))\b/i

/** True when the agent says it can't proceed without logging in */
const BLOCKED_RE = /\b(can'?t|cannot|unable|blocked|access\s+denied|requires?\s+(a\s+)?login|must\s+(sign|log)\s+in|only\s+available\s+(to\s+)?logged?\s*in|please\s+(sign|log)\s+in\s+first|not\s+accessible\s+without)\b/i

function isLoginQuestion(q: string) { return LOGIN_Q_RE.test(q) }
function isBlockedByLogin(q: string) { return BLOCKED_RE.test(q) }

// Track whether the user previously chose "Not now" so we can show the sorry
// screen if the agent comes back saying it's blocked.
let _skippedLogin = false
// Store the last login question so "Sign In & Continue" can re-use it
let _lastLoginQuestion = ''

/** Switch between standard ask UI and login gate UI */
function showAskMode(mode: 'standard' | 'login') {
	askStandardEl.classList.toggle('hidden', mode !== 'standard')
	askLoginEl.classList.toggle('hidden', mode !== 'login')
}

/** Render login method chips inside the login options area */
function renderLoginMethodChips(methods: string[]) {
	loginOptionsEl.replaceChildren()
	if (methods.length === 0) {
		loginOptionsEl.classList.remove('login-options-visible')
		loginOptionsEl.classList.add('login-options-hidden')
		return
	}
	// Add any methods detected from the question (e.g. Google, Apple, SSO)
	methods.forEach((m, i) => {
		const chip = document.createElement('button')
		chip.className = 'ask-chip'
		chip.textContent = m
		chip.style.animationDelay = `${i * 55}ms`
		chip.addEventListener('click', () => {
			document.querySelectorAll('#login-options .ask-chip').forEach(c => c.classList.remove('selected'))
			chip.classList.add('selected')
			setTimeout(() => askResolve?.(`Sign in using ${m}`), 160)
		})
		loginOptionsEl.appendChild(chip)
	})

	// Show the chips container
	loginOptionsEl.classList.remove('login-options-hidden')
	loginOptionsEl.classList.add('login-options-visible', 'ask-options')
}

/** Extract sign-in method names from the agent question */
function parseLoginMethods(q: string): string[] {
	// Try e.g. list
	const egMatch = q.match(/\(e\.?g\.?,?\s*([^)]+)\)/i)
	if (egMatch) {
		return egMatch[1].split(/,|;/).map(s => s.trim())
			.filter(s => s && !/^etc\.?$/i.test(s) && s.length < 50)
	}
	// Try "with Google, Facebook, or email" patterns
	const withMatch = q.match(/(?:with|using|via)\s+([\w\s,]+(?:,?\s*or\s+[\w\s]+)?)/i)
	if (withMatch) {
		return withMatch[1].split(/,|\bor\b/i).map(s => s.trim())
			.filter(s => s && s.length < 40)
	}
	return []
}

/** Show the sorry / blocked screen */
function showSorryScreen(customMsg?: string) {
	if (customMsg) sorryBodyEl.textContent = customMsg
	showStage('login-sorry')
}

function askUser(question: string, options?: { signal: AbortSignal }): Promise<string> {
	// ── Blocked case: agent came back saying it can't proceed without login ──
	if (_skippedLogin && isBlockedByLogin(question)) {
		showSorryScreen()
		setStatus('waiting')
		return new Promise<string>((resolve, reject) => {
			askResolve = (answer: string) => {
				askResolve = null
				_skippedLogin = false
				showStage('now')
				setNowAction('Continuing…', 'swap')
				setStatus('running')
				resolve(answer)
			}
			options?.signal.addEventListener('abort', () => {
				askResolve = null
				reject(new DOMException('Task stopped', 'AbortError'))
			})
		})
	}

	// ── Login gate case: agent is asking user to sign in ──
	if (isLoginQuestion(question)) {
		_lastLoginQuestion = question
		_skippedLogin = false

		// Reset views and fields
		loginActionChoicesEl.classList.remove('hidden')
		loginManualViewEl.classList.add('hidden')
		loginAgentfillViewEl.classList.add('hidden')
		loginInputZoneEl.classList.add('hidden')
		loginFieldAEl.value = ''
		loginOptionsEl.replaceChildren()
		loginOptionsEl.classList.add('login-options-hidden')
		loginGateMsgEl.textContent = 'This page requires login to continue. Choose how to proceed:'

		showAskMode('login')
		showStage('ask')
		setStatus('waiting')

		let manualTimerId: number | null = null

		const clearManualMode = () => {
			if (manualTimerId) {
				clearInterval(manualTimerId)
				manualTimerId = null
			}
			void chrome.storage.local.set({ maskSuppressed: false, manualLoginActive: false })
		}

		return new Promise<string>(async (resolve, reject) => {
			askResolve = (answer: string) => {
				clearManualMode()
				askResolve = null
				showStage('now')
				setNowAction('Continuing…', 'swap')
				setStatus('running')
				resolve(answer)
			}

			// Pre-fetch page login fields immediately in background so it's ready without latency
			const pageFieldsPromise = detectPageLoginFields()

			// 1. Detect current domain & check IndexedDB vault
			const domain = await getCurrentDomain()
			const savedCred = domain ? await getCredential(domain) : null

			if (savedCred) {
				loginChoiceAutofillBtn.textContent = `Autofill (${savedCred.username})`
			} else {
				loginChoiceAutofillBtn.textContent = 'Browser autofill'
			}

			// Render any other detected methods (Google, Apple, etc.) below the choices
			const methods = parseLoginMethods(question)
			if (methods.length > 0) {
				renderLoginMethodChips(methods)
			}

			// ── Option 1: Autofill ──
			loginChoiceAutofillBtn.onclick = () => {
				if (savedCred) {
					askResolve?.(`Fill username "${savedCred.username}" and password "${savedCred.password}" into the login form and submit.`)
				} else {
					askResolve?.('Use browser autofill to fill in the credentials, then submit')
				}
			}

			// ── Option 2: Manual Login ──
			loginChoiceManualBtn.onclick = async () => {
				loginActionChoicesEl.classList.add('hidden')
				loginManualViewEl.classList.remove('hidden')
				loginOptionsEl.classList.add('login-options-hidden')

				// Stop agent screen access and hide overlay mask immediately
				await chrome.storage.local.set({ maskSuppressed: true, manualLoginActive: true })

				// 45s countdown timer with auto-resume
				let secondsLeft = 45
				manualCountdownEl.textContent = `Auto-resumes in ${secondsLeft}s`
				if (manualTimerId) clearInterval(manualTimerId)
				manualTimerId = window.setInterval(() => {
					secondsLeft--
					if (secondsLeft > 0) {
						manualCountdownEl.textContent = `Auto-resumes in ${secondsLeft}s`
					} else {
						clearInterval(manualTimerId!)
						manualTimerId = null
						manualCountdownEl.textContent = 'Resuming now…'
						askResolve?.('I have completed the login manually on the webpage. Please continue the task.')
					}
				}, 1000)
			}

			loginManualDoneBtn.onclick = () => {
				askResolve?.('I have completed the login manually on the webpage. Please continue the task.')
			}

			loginManualCancelBtn.onclick = async () => {
				clearManualMode()
				loginManualViewEl.classList.add('hidden')
				loginActionChoicesEl.classList.remove('hidden')
				if (methods.length > 0) loginOptionsEl.classList.remove('login-options-hidden')
			}

			// ── Option 3: Agent Fill & Save ──
			loginChoiceAgentfillBtn.onclick = async () => {
				loginActionChoicesEl.classList.add('hidden')
				loginOptionsEl.classList.add('login-options-hidden')
				agentfillDomainEl.textContent = domain || 'this site'

				// Inspect active tab DOM (using pre-fetched promise or fresh call)
				const pageFields = (await pageFieldsPromise) || (await detectPageLoginFields())
				const isPasswordOnlyQuestion =
					/password/i.test(question) && !/(username|email|user\s+id|account|roll|enroll)/i.test(question)
				const usernameAlreadyFilled = Boolean(pageFields?.isUsernameFilled && pageFields.usernameVal)
				const onlyPasswordNeeded =
					pageFields?.onlyFieldNeeded === 'password' ||
					usernameAlreadyFilled ||
					isPasswordOnlyQuestion ||
					Boolean(pageFields?.hasPassword && !pageFields.hasUsername)
				const onlyOtpNeeded =
					pageFields?.onlyFieldNeeded === 'otp' || Boolean(pageFields?.hasOtp && !pageFields.hasPassword)

				if (onlyOtpNeeded) {
					agentfillUserWrapEl?.classList.add('hidden')
					agentfillPassWrapEl?.classList.remove('hidden')
					agentfillPassEl.placeholder = 'Enter OTP or verification code'
					agentfillPassEl.type = 'text'
					agentfillPassEl.value = ''
					agentfillDetectedBadgeEl.innerHTML = `${BADGE_ICONS.lock}<span>Enter OTP / verification code sent to you</span>`
					agentfillDetectedBadgeEl.classList.remove('hidden')
					agentfillSubmitBtn.textContent = 'Submit OTP'
					loginAgentfillViewEl.classList.remove('hidden')
					agentfillPassEl.focus()
				} else if (onlyPasswordNeeded) {
					// Hide username box — only show password input!
					agentfillUserWrapEl?.classList.add('hidden')
					agentfillPassWrapEl?.classList.remove('hidden')
					agentfillPassEl.placeholder = 'Password'
					agentfillPassEl.type = 'password'
					agentfillSubmitBtn.textContent = 'Fill & Login'

					const detectedUser = pageFields?.usernameVal || savedCred?.username || ''
					if (detectedUser) {
						agentfillDetectedBadgeEl.innerHTML = `<span>✓ Username: <strong>${detectedUser}</strong> (already filled)</span><button id="agentfill-edit-user-btn" type="button" class="agentfill-badge-edit-btn">Edit</button>`
						agentfillDetectedBadgeEl.classList.remove('hidden')
						const editBtn = document.getElementById('agentfill-edit-user-btn')
						if (editBtn) {
							editBtn.onclick = () => {
								agentfillUserWrapEl?.classList.toggle('hidden')
								if (!agentfillUserWrapEl?.classList.contains('hidden')) {
									agentfillUserEl.value = detectedUser
									agentfillUserEl.focus()
								}
							}
						}
					} else {
						agentfillDetectedBadgeEl.classList.add('hidden')
					}
					agentfillPassEl.value = savedCred?.password || ''
					loginAgentfillViewEl.classList.remove('hidden')
					agentfillPassEl.focus()
				} else {
					// Both username and password needed
					agentfillUserWrapEl?.classList.remove('hidden')
					agentfillPassWrapEl?.classList.remove('hidden')
					agentfillPassEl.placeholder = 'Password'
					agentfillPassEl.type = 'password'
					agentfillSubmitBtn.textContent = 'Fill & Login'
					agentfillDetectedBadgeEl.classList.add('hidden')
					if (savedCred) {
						agentfillUserEl.value = savedCred.username
						agentfillPassEl.value = savedCred.password
					} else {
						agentfillUserEl.value = ''
						agentfillPassEl.value = ''
					}
					loginAgentfillViewEl.classList.remove('hidden')
					agentfillUserEl.focus()
				}
			}

			// Enter key shortcuts for fast input submission
			agentfillPassEl.onkeydown = (e) => {
				if (e.key === 'Enter') {
					e.preventDefault()
					agentfillSubmitBtn.click()
				}
			}
			agentfillUserEl.onkeydown = (e) => {
				if (e.key === 'Enter') {
					e.preventDefault()
					if (!agentfillPassWrapEl?.classList.contains('hidden')) {
						agentfillPassEl.focus()
					} else {
						agentfillSubmitBtn.click()
					}
				}
			}

			agentfillSubmitBtn.onclick = async () => {
				const pageFields = (await pageFieldsPromise) || (await detectPageLoginFields())
				const usernameAlreadyFilled = Boolean(pageFields?.isUsernameFilled && pageFields.usernameVal)
				const password = agentfillPassEl.value.trim()
				const username = agentfillUserEl.value.trim() || pageFields?.usernameVal || savedCred?.username || ''

				if (!password && !username) {
					agentfillPassEl.focus()
					return
				}

				if (agentfillRememberEl.checked && domain && (username || password)) {
					await saveCredential(domain, username, password)
				}

				const isPasswordOnly =
					usernameAlreadyFilled ||
					(agentfillUserWrapEl?.classList.contains('hidden') && password)
				if (isPasswordOnly) {
					askResolve?.(`Fill in password "${password}" into the password field and submit.`)
				} else {
					askResolve?.(`Fill in username "${username}" and password "${password}" into the login form and submit.`)
				}
			}

			agentfillCancelBtn.onclick = () => {
				loginAgentfillViewEl.classList.add('hidden')
				loginActionChoicesEl.classList.remove('hidden')
				if (methods.length > 0) loginOptionsEl.classList.remove('login-options-hidden')
			}

			// ── Skip ──
			loginSkipBtn.onclick = () => {
				_skippedLogin = true
				askResolve?.('No, proceed without login and try to access the page anyway')
			}

			options?.signal.addEventListener('abort', () => {
				clearManualMode()
				askResolve = null
				reject(new DOMException('Task stopped', 'AbortError'))
			})
		})
	}

	// ── Standard ask: render question + option chips + text input ──
	showAskMode('standard')
	askQEl.innerHTML = renderMarkdown(question)
	renderOptions(parseOptions(question))

	showStage('ask')
	askAEl.value = ''
	setStatus('waiting')

	return new Promise<string>((resolve, reject) => {
		askResolve = (answer: string) => {
			askResolve = null
			showStage('now')
			setNowAction('Continuing…', 'swap')
			setStatus('running')
			resolve(answer)
		}
		options?.signal.addEventListener('abort', () => {
			askResolve = null
			reject(new DOMException('Task stopped', 'AbortError'))
		})
	})
}

$('askuser-send').addEventListener('click', () => askResolve?.(askAEl.value))
$('askuser-done').addEventListener('click', () => askResolve?.('done'))
askAEl.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') askResolve?.(askAEl.value)
})
loginFieldSendEl.addEventListener('click', () => askResolve?.(loginFieldAEl.value))
loginFieldAEl.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') askResolve?.(loginFieldAEl.value)
})

// Sorry screen buttons
$('sorry-signin').addEventListener('click', () => {
	_skippedLogin = false
	void askUser(_lastLoginQuestion || 'Please log in to continue')
})
$('sorry-newtask').addEventListener('click', () => void resetToComposer())

// ---------- run / stop / restart ----------

let agent: MultiPageAgent | null = null

async function runTask() {
	const task = taskEl.value.trim()
	if (!task) return taskEl.focus()

	agent?.dispose()
	agent = new MultiPageAgent({
		baseURL: DEFAULT_LLM_CONFIG.baseURL,
		model: DEFAULT_LLM_CONFIG.model,
		maxSteps: _settings.maxSteps,
		// [PRIVO BUG-1 FIX] UI stores milliseconds; PageAgentCore expects seconds.
		// 500 ms → 0.5 s, 1000 ms → 1 s, 2000 ms → 2 s. Conversion done exactly once here.
		stepDelay: _settings.stepDelay / 1000,
		disableNamedToolChoice: DEFAULT_LLM_CONFIG.disableNamedToolChoice,
		transformRequestBody: DEFAULT_LLM_CONFIG.transformRequestBody,
		customFetch: llmFetch,
		customTools: createScreenshotTool(),
		instructions: { system: FLOW_INSTRUCTIONS },
	})
	agent.onAskUser = askUser
	agent.addEventListener('statuschange', () => {
		if (agent && !askResolve) setStatus(agent.status)
	})
	agent.addEventListener('activity', (e) => onActivity((e as CustomEvent<AgentActivity>).detail))

	runningTaskEl.textContent = task

	// Reset login flow state for fresh task
	_skippedLogin = false
	_lastLoginQuestion = ''
	showAskMode('standard')

	// Always start in question mode (quiet shimmer).
	// onActivity will automatically upgrade to task mode if the agent
	// fires any real tool call (click, type, scroll, etc.).
	runMode = 'question'
	nowEl.classList.remove('mode-task')
	nowEl.classList.add('mode-question')
	setNowAction('Analyzing…', 'shimmer')

	// 1. Launch arrow animation and morph send button to red stop button
	runBtnActivate()
	// Allow the morph & arrow launch animation to play visibly before stage switch
	await new Promise((r) => setTimeout(r, 260))

	resetStepsPlan()
	activitySection.classList.remove('hidden')
	showStage('now')
	startRunMeta()

	// Clear previous captures so the gallery only shows captures from this task.
	void chrome.storage.local.set({ captures: [] })

	try {
		const result = await agent.execute(task)
		await showAgentResult(result.success, result.data)
		if (result.success) taskEl.value = ''
	} catch (err) {
		await showAgentResult(false, err instanceof Error ? err.message : String(err))
		setStatus('error')
	} finally {
		clearThinking()
		_clearAnimation()
		stopRunMeta()
		stopBtn.classList.remove('stopping')
		runBtnRevert()      // ← stop square flies off, arrow returns
	}
}

async function showAgentResult(success: boolean, text: string) {
	if (success && totalSteps > 0) {
		completedSteps = totalSteps
		updateStepsCounter()
	}
	resultEl.classList.toggle('is-fail', !success)
	resultTitleEl.textContent = success ? '✔ Task completed' : '✕ Task failed'
	resultBodyEl.innerHTML = renderMarkdown(text)
	resultRetryBtn.classList.toggle('hidden', success)
	const { captures = [] } = (await chrome.storage.local.get('captures')) as { captures?: SealedCapture[] }
	const latest = captures[0]
	const capturedThisRun = !!latest && Date.now() - latest.capturedAt < 10 * 60 * 1000 && text.includes(latest.id)
	resultImgEl.classList.toggle('hidden', !capturedThisRun)
	resultDownloadBtn.classList.toggle('hidden', !capturedThisRun)
	if (capturedThisRun && latest) {
		resultImgEl.src = latest.dataUrl
		resultDownloadBtn.onclick = () => downloadCapture(latest)
	}
	// Save to recent history
	let currentUrl = ''
	try { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); currentUrl = tab?.url ?? '' } catch { /* ignore */ }
	void saveActivity({
		taskText: taskEl.value.trim() || runningTaskEl.textContent?.trim() || '—',
		url: currentUrl,
		status: success ? 'ok' : agent?.status === 'stopped' ? 'stopped' : 'err',
		stepCount,
		timestamp: Date.now(),
	})
	showStage('result')
}

async function resetToComposer() {
	stopBtn.classList.remove('stopping')
	try {
		await agent?.stop()
	} catch {
		/* already stopped */
	}
	agent?.dispose()
	agent = null
	askResolve = null
	stopRunMeta()
	resetStepsPlan()
	activitySection.classList.add('hidden')
	showStage('composer')
	setStatus('idle')
	runBtnRevert()          // ← morph back to arrow
	taskEl.focus()
}

// ---------- unified run ↔ stop button ----------

const runBtn = $<HTMLButtonElement>('run')
const stopBtn = $<HTMLButtonElement>('stop')

/** Morph arrow → stop square with a brief animation burst. */
function runBtnActivate() {
	runBtn.setAttribute('aria-label', 'Stop task')
	runBtn.title = 'Stop'
	runBtn.classList.add('running', 'launching')
	setTimeout(() => runBtn.classList.remove('launching'), 320)
}

/** Revert stop → arrow. */
function runBtnRevert() {
	runBtn.setAttribute('aria-label', 'Run task')
	runBtn.title = 'Run'
	runBtn.classList.remove('running', 'launching')
	stopBtn.classList.remove('stopping')
	// Re-evaluate enabled state from textarea
	runBtn.disabled = !taskEl.value.trim()
}

// Enable the button only when the textarea has content
taskEl.addEventListener('input', () => {
	taskEl.style.height = 'auto'
	taskEl.style.height = `${Math.min(taskEl.scrollHeight, 180)}px`
	// Only toggle enabled when idle (not while running)
	if (!runBtn.classList.contains('running')) {
		runBtn.disabled = !taskEl.value.trim()
	}
})

// Unified click handler on runBtn: run when idle, stop when running
runBtn.addEventListener('click', () => {
	if (runBtn.classList.contains('running')) {
		stopBtn.classList.add('stopping')
		setNowAction('Stopping…', 'shimmer')
		setStatus('stopped')
		void agent?.stop()
	} else {
		void runTask()
	}
})

// Stop button in the running (#now) card
stopBtn.addEventListener('click', () => {
	stopBtn.classList.add('stopping')
	setNowAction('Stopping…', 'shimmer')
	setStatus('stopped')
	void agent?.stop()
})

restartBtn.addEventListener('click', () => void resetToComposer())
$('result-new').addEventListener('click', () => void resetToComposer())
$('result-retry').addEventListener('click', () => void runTask())

taskEl.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
		e.preventDefault()
		if (!runBtn.disabled && !runBtn.classList.contains('running')) {
			void runTask()
		}
	}
})

// manual capture of the current tab
$('capture-now').addEventListener('click', async () => {
	const btn = $<HTMLButtonElement>('capture-now')
	btn.textContent = 'Sealing…'
	btn.setAttribute('disabled', '')
	try {
		await sealCapture()
	} catch (err) {
		note(err instanceof Error ? err.message : String(err), 'err')
	} finally {
		btn.textContent = '+ Capture now'
		btn.removeAttribute('disabled')
	}
})

// ---------- gallery ----------

function downloadCapture(c: SealedCapture) {
	const a = document.createElement('a')
	a.href = c.dataUrl
	a.download = `PRIVO-capture-${c.id}.png`
	a.click()
}

async function renderShots() {
	const { captures = [] } = (await chrome.storage.local.get('captures')) as { captures?: SealedCapture[] }
	shotsCountEl.textContent = String(captures.length)
	shotsCountEl.classList.toggle('hidden', captures.length === 0)
	shotsClearBtn.classList.toggle('hidden', captures.length === 0)
	shotsEl.replaceChildren(
		...captures.map((c) => {
			const fig = document.createElement('figure')
			fig.className = 'shot'
			const img = document.createElement('img')
			img.src = c.dataUrl
			img.alt = c.title || 'Sealed capture'
			img.title = 'Download PNG'
			img.addEventListener('click', () => downloadCapture(c))
			const cap = document.createElement('figcaption')
			const badge = document.createElement('span')
			badge.className = `badge ${c.sealed ? 'sealed' : 'unsealed'}`
			badge.textContent = c.sealed ? 'SEALED' : 'LOCAL'
			cap.append(badge, document.createTextNode(` ${c.id}`))
			fig.append(img, cap)
			return fig
		})
	)
}
shotsClearBtn.addEventListener('click', () => void chrome.storage.local.set({ captures: [] }))
chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'local' && changes.captures) void renderShots()
})
void renderShots()

// ---------- steps feed (human wording, no element codes) ----------

const ICONS: Record<string, string> = {
	pointer:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l7 17 2.5-7.5L21 11z"/></svg>',
	keyboard:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 15h10"/></svg>',
	arrows:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/></svg>',
	tab: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>',
	camera:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a2 2 0 012-2h2l1.5-2h7L17 6h2a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>',
	clock:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
	question:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 9a3 3 0 115 2.2c-.9.8-2 1.3-2 2.8"/><path d="M12 18h.01"/></svg>',
	check:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
	sparkle:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>',
	alert:
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v8M12 17h.01"/><circle cx="12" cy="12" r="9.5"/></svg>',
	bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h6l-1 8 9-12h-6z"/></svg>',
}

/** Human wording — element indexes are dev noise, keep them out of the UI. */
const TOOL_META: Record<string, { icon: string; label: string; now: string }> = {
	click_element_by_index: { icon: 'pointer', label: 'Clicked an element', now: 'Clicking…' },
	input_text: { icon: 'keyboard', label: 'Typed text', now: 'Typing…' },
	select_dropdown_option: { icon: 'pointer', label: 'Chose an option', now: 'Choosing an option…' },
	scroll: { icon: 'arrows', label: 'Scrolled the page', now: 'Scrolling…' },
	scroll_horizontally: { icon: 'arrows', label: 'Scrolled sideways', now: 'Scrolling…' },
	open_new_tab: { icon: 'tab', label: 'Opened a tab', now: 'Opening a tab…' },
	switch_to_tab: { icon: 'tab', label: 'Switched tab', now: 'Switching tab…' },
	close_tab: { icon: 'tab', label: 'Closed a tab', now: 'Closing a tab…' },
	capture_screenshot: { icon: 'camera', label: 'Took a sealed capture', now: 'Capturing…' },
	wait: { icon: 'clock', label: 'Waited for the page', now: 'Waiting for the page…' },
	ask_user: { icon: 'question', label: 'Asked for your input', now: 'Waiting for you…' },
	done: { icon: 'check', label: 'Finished', now: 'Wrapping up…' },
}

let thinkingEl: HTMLElement | null = null
let lastExecEl: HTMLElement | null = null

const STATUS_SVGS = {
	inProgress:
		'<svg class="step-status-icon step-status-icon--progress" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" opacity="0.25"/><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="24 60" class="step-spin-ring"/></svg>',
	completed:
		'<svg class="step-status-icon step-status-icon--ok" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="hsla(145, 65%, 45%, 0.12)" stroke="hsl(145, 65%, 45%)" stroke-width="1.5"/><path d="M7.5 12.25 10.5 15.25 16.75 8.75" stroke="hsl(145, 65%, 45%)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="step-check-path"/></svg>',
	error:
		'<svg class="step-status-icon step-status-icon--err" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="hsla(4, 80%, 55%, 0.12)" stroke="hsl(4, 80%, 55%)" stroke-width="1.5"/><path d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5" stroke="hsl(4, 80%, 55%)" stroke-width="2" stroke-linecap="round"/></svg>',
	pending:
		'<svg class="step-status-icon step-status-icon--pending" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3"/></svg>',
}

function makeEntry(icon: string, title: string, cls = ''): HTMLElement {
	const isThinking = cls.includes('thinking')
	if (!isThinking) {
		totalSteps++
	}

	const entry = document.createElement('div')
	entry.className = `entry ${cls}`

	// 1. Morphing status mark (beui style)
	const statusWrap = document.createElement('span')
	statusWrap.className = 'step-status-wrap'
	if (isThinking) {
		statusWrap.innerHTML = STATUS_SVGS.pending
	} else if (cls.includes('is-ok')) {
		statusWrap.innerHTML = STATUS_SVGS.completed
	} else if (cls.includes('is-err')) {
		statusWrap.innerHTML = STATUS_SVGS.error
	} else {
		statusWrap.innerHTML = STATUS_SVGS.inProgress
	}

	// 2. Existing action tool icon (user: "but aslo old exgist icon create also add")
	const toolBadge = document.createElement('span')
	toolBadge.className = 'step-tool-badge'
	toolBadge.innerHTML = ICONS[icon] ?? ICONS.bolt

	// 3. Body with title and morphing strike-through line
	const body = document.createElement('div')
	body.className = 'entry-body'

	const titleRow = document.createElement('div')
	titleRow.className = 'entry-title'

	const titleWrap = document.createElement('span')
	titleWrap.className = 'step-title-wrap'

	const titleText = document.createElement('span')
	titleText.className = 'step-title-text'
	titleText.textContent = title

	const strikeLine = document.createElement('span')
	strikeLine.className = 'step-strike-line'

	titleWrap.append(titleText, strikeLine)
	titleRow.appendChild(titleWrap)

	// 4. Compact metadata/detail on the right
	const meta = document.createElement('span')
	meta.className = 'step-meta'
	if (isThinking) {
		meta.textContent = 'Analyzing'
		meta.classList.add('is-pending')
	} else if (cls.includes('is-ok')) {
		meta.textContent = 'Done'
		meta.classList.add('is-ok')
	} else if (cls.includes('is-err')) {
		meta.textContent = 'Failed'
		meta.classList.add('is-err')
	} else {
		meta.textContent = 'Active'
		meta.classList.add('is-active')
	}
	titleRow.appendChild(meta)

	body.appendChild(titleRow)
	entry.append(statusWrap, toolBadge, body)

	feedEl.appendChild(entry)
	feedEl.scrollTop = feedEl.scrollHeight

	if (!isThinking) {
		updateStepsCounter()
	}
	return entry
}

function clearThinking() {
	thinkingEl?.remove()
	thinkingEl = null
}

function note(text: string, kind: 'ok' | 'err' | '' = '') {
	activitySection.classList.remove('hidden')
	clearThinking()
	makeEntry(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'sparkle', text, kind ? `is-${kind}` : '')
	if (kind) {
		completedSteps++
		updateStepsCounter()
	}
}

function onActivity(a: AgentActivity) {
	if (a.type === 'thinking') {
		if (runMode === 'question') {
			setNowAction('Analyzing…', 'shimmer')
		} else {
			setNowAction('Thinking…', 'scramble')
		}
		if (!thinkingEl) thinkingEl = makeEntry('sparkle', runMode === 'question' ? 'Analyzing…' : 'Thinking…', 'thinking')
	} else if (a.type === 'executing') {
		clearThinking()
		stepCount++
		updateRunMeta()
		const meta = TOOL_META[a.tool] ?? { icon: 'bolt', label: a.tool.replaceAll('_', ' '), now: 'Working…' }

		if (!QUESTION_TOOLS.has(a.tool)) {
			_upgradeToTaskMode()
		}

		setNowAction(meta.now, runMode === 'task' ? 'cascade' : 'swap')
		lastExecEl = makeEntry(meta.icon, meta.label, a.tool === 'ask_user' ? 'is-warn' : '')
		lastExecEl.dataset.tool = a.tool
	} else if (a.type === 'executed') {
		clearThinking()
		if (lastExecEl?.dataset.tool === a.tool) {
			const isErr = a.output.startsWith('❌')
			lastExecEl.classList.remove('is-warn')
			lastExecEl.classList.add(isErr ? 'is-err' : 'is-ok')

			const statusWrap = lastExecEl.querySelector('.step-status-wrap')
			if (statusWrap) {
				statusWrap.innerHTML = isErr ? STATUS_SVGS.error : STATUS_SVGS.completed
			}

			const meta = lastExecEl.querySelector('.step-meta')
			if (meta) {
				meta.textContent = isErr ? 'Failed' : 'Done'
				meta.className = `step-meta ${isErr ? 'is-err' : 'is-ok'}`
			}

			if (isErr && a.output.length > 2) {
				const out = document.createElement('div')
				out.className = 'entry-out'
				out.textContent = a.output
				lastExecEl.querySelector('.entry-body')?.appendChild(out)
			}

			completedSteps++
			updateStepsCounter()
		}
		lastExecEl = null
	} else if (a.type === 'error') {
		note(truncate(a.message, 250), 'err')
	}
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + '…' : s
}

function renderMarkdown(raw: string): string {
	// Escape HTML first to prevent injection
	let s = raw
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
	// Inline code (before bold so asterisks inside backticks are preserved)
	s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
	// Bold and italic
	s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
	s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
	// Block: collect list items, wrap in <ul>
	const segments: string[] = []
	let listBuf: string[] = []
	for (const line of s.split('\n')) {
		const m = line.match(/^[-•]\s+(.+)$/)
		if (m) {
			listBuf.push(`<li>${m[1]}</li>`)
		} else {
			if (listBuf.length) { segments.push(`<ul>${listBuf.join('')}</ul>`); listBuf = [] }
			segments.push(line)
		}
	}
	if (listBuf.length) segments.push(`<ul>${listBuf.join('')}</ul>`)
	// Rejoin and convert to paragraphs
	return segments.join('\n\n').split(/\n{2,}/).map((p) => {
		if (p.startsWith('<ul>')) return p
		const inner = p.replace(/\n/g, '<br>')
		return inner ? `<p>${inner}</p>` : ''
	}).join('')
}

showStage('composer')

// ================================================================
// Privacy Panel — "What Leaves My Device"
// ================================================================

import type { RedactionReport, PrivacyStatus } from '../privacy/privacy-types'

function renderPrivacyPanel(report: RedactionReport, status: PrivacyStatus): void {
	if (!privacySectionEl) return

	privacySectionEl.classList.remove('hidden')

	// Update status badge
	const badgeClass: Record<PrivacyStatus, string> = {
		SCANNING: 'privacy-badge--scanning',
		NO_SENSITIVE_DATA: 'privacy-badge--safe',
		REDACTED: 'privacy-badge--redacted',
		BLOCKED: 'privacy-badge--blocked',
	}
	const badgeContent: Record<PrivacyStatus, string> = {
		SCANNING: `${BADGE_ICONS.scan}<span>Scanning…</span>`,
		NO_SENSITIVE_DATA: `${BADGE_ICONS.shieldCheck}<span>No sensitive data detected</span>`,
		REDACTED: `${BADGE_ICONS.lock}<span>Sanitized · ${report.detectedItems.length} item${report.detectedItems.length !== 1 ? 's' : ''}</span>`,
		BLOCKED: `${BADGE_ICONS.blocked}<span>Blocked — see details</span>`,
	}

	privacyStatusBadgeEl.className = `privacy-badge ${badgeClass[status]}`
	privacyStatusBadgeEl.innerHTML = badgeContent[status]

	// Render detected category pills — no raw values, only placeholders
	privacyDetectedListEl.replaceChildren()
	for (const item of report.detectedItems) {
		const pill = document.createElement('span')
		pill.className = 'privacy-pill'
		pill.textContent = `${item.placeholder}  ·  ${item.category}`
		privacyDetectedListEl.appendChild(pill)
	}

	// Render "What leaves this device" preview
	const leaving: string[] = []
	const staying: string[] = []

	if (report.sanitizedSources.includes('task')) leaving.push('✓ Sanitized task')
	else leaving.push('✓ Task')

	if (report.sanitizedSources.includes('dom')) leaving.push('✓ Sanitized page text')
	else leaving.push('✓ Page text')

	if (report.sanitizedSources.includes('url')) leaving.push('✓ Sanitized URL')
	else leaving.push('✓ Navigation URL')

	if (report.sanitizedSources.some((s) => s.startsWith('screenshot'))) {
		leaving.push('✓ Redacted screenshot')
	}

	for (const item of report.detectedItems) {
		staying.push(`${item.placeholder} → [redacted]`)
	}

	const preventedSensitiveFields = report.redactedCategories.filter(
		(c) => c === 'PASSWORD' || c === 'OTP'
	)
	if (preventedSensitiveFields.length > 0) {
		staying.push(`${preventedSensitiveFields.join(', ')} field(s) detected (never sent)`)
	}

	if (report.blockedReasons.length > 0) {
		staying.push(...report.blockedReasons.map((r) => `⛔ ${r}`))
	}

	privacyPreviewBodyEl.innerHTML = [
		leaving.length ? `<div class="privacy-preview-group"><strong>Leaving device (sanitized):</strong>${leaving.map((l) => `<div class="privacy-preview-item">${l}</div>`).join('')}</div>` : '',
		staying.length ? `<div class="privacy-preview-group"><strong>Staying local:</strong>${staying.map((s) => `<div class="privacy-preview-item privacy-preview-item--local">${s}</div>`).join('')}</div>` : '',
	].join('')
}

function showPrivacyBlocked(reason: string): void {
	if (!privacySectionEl) return
	privacySectionEl.classList.remove('hidden')
	privacyStatusBadgeEl.className = 'privacy-badge privacy-badge--blocked'
	privacyStatusBadgeEl.innerHTML = `${BADGE_ICONS.blocked}<span>Blocked — see details</span>`
	privacyDetectedListEl.replaceChildren()
	privacyPreviewBodyEl.innerHTML = `<div class="privacy-blocked-reason">Privacy scan blocked: ${reason}</div>`
}

function clearPrivacyPanel(): void {
	if (!privacySectionEl) return
	privacySectionEl.classList.add('hidden')
	privacyStatusBadgeEl.className = 'privacy-badge privacy-badge--scanning'
	privacyStatusBadgeEl.innerHTML = `${BADGE_ICONS.scan}<span>Scanning…</span>`
	privacyDetectedListEl.replaceChildren()
	privacyPreviewBodyEl.textContent = ''
}

// Listen for privacy events dispatched by MultiPageAgent
window.addEventListener('privo:privacy-update', (e: Event) => {
	const report = (e as CustomEvent<RedactionReport>).detail
	if (!report) return
	const status: PrivacyStatus = report.detectedItems.length > 0 ? 'REDACTED' : 'NO_SENSITIVE_DATA'
	renderPrivacyPanel(report, status)
})

window.addEventListener('privo:privacy-blocked', (e: Event) => {
	const { reason } = (e as CustomEvent<{ reason: string }>).detail ?? {}
	showPrivacyBlocked(reason ?? 'Unknown error')
})

// Clear privacy panel at the start of each new task
const _origRunTask = runTask
// runTask is defined earlier in the file — we hook the clear call into showStage
const _origShowStageForPrivacy = showStage
;(window as any).__privoPrivacyClearOnNewTask = clearPrivacyPanel

// ================================================================
// Footer Tagline Typing Animation: "✦ Think freely. Browse privately."
// ================================================================

function initTaglineAnimation(): void {
	const textEl = document.getElementById('tagline-text')
	const cursorEl = document.getElementById('tagline-cursor')
	const footTaglineEl = document.getElementById('foot-tagline')
	if (!textEl) return

	const fullText = 'Think freely. Browse privately.'
	textEl.textContent = ''
	if (cursorEl) {
		cursorEl.style.opacity = '1'
		cursorEl.style.transition = 'none'
	}

	let i = 0
	let timer: any = null

	function typeChar(): void {
		if (i < fullText.length) {
			textEl!.textContent = fullText.slice(0, i + 1)
			const char = fullText[i]
			i++
			const delay = char === '.' ? 140 : char === ' ' ? 60 : 38
			timer = setTimeout(typeChar, delay)
		} else {
			// Finished typing: let cursor blink for 2.5s, then gently fade out
			setTimeout(() => {
				if (cursorEl) {
					cursorEl.style.transition = 'opacity 0.6s ease'
					cursorEl.style.opacity = '0'
				}
			}, 2500)
		}
	}

	// Small initial delay so UI paints first
	timer = setTimeout(typeChar, 250)

	// Allow clicking the tagline to replay the typewriter effect
	footTaglineEl?.addEventListener('click', () => {
		if (timer) clearTimeout(timer)
		textEl.textContent = ''
		if (cursorEl) {
			cursorEl.style.opacity = '1'
			cursorEl.style.transition = 'none'
		}
		i = 0
		timer = setTimeout(typeChar, 80)
	})
}

initTaglineAnimation()


