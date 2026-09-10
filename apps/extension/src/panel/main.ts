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

const resultEl = $('result')
const resultTitleEl = $('result-title')
const resultBodyEl = $('result-body')
const resultImgEl = $<HTMLImageElement>('result-img')
const resultDownloadBtn = $<HTMLButtonElement>('result-download')
const resultRetryBtn = $<HTMLButtonElement>('result-retry')

const activitySection = $('activity-section')
const feedEl = $('feed')
const shotsEl = $('shots')
const shotsCountEl = $('shots-count')
const shotsClearBtn = $('shots-clear')
const backendDot = $('backend-dot')

;($('validator-link') as HTMLAnchorElement).href = `${BACKEND_URL}/validate`

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
// IndexedDB — Recent activities
// ================================================================

interface ActivityRecord {
	id: string
	taskText: string
	url: string
	status: 'ok' | 'err' | 'stopped'
	stepCount: number
	timestamp: number
}

const DB_NAME = 'privo-history'
const DB_STORE = 'activities'
const DB_VERSION = 1

function openHistoryDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION)
		req.onupgradeneeded = () => {
			const db = req.result
			if (!db.objectStoreNames.contains(DB_STORE)) {
				const store = db.createObjectStore(DB_STORE, { keyPath: 'id' })
				store.createIndex('timestamp', 'timestamp')
			}
		}
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
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
	// Always offer "Use browser autofill" first
	const autofillChip = document.createElement('button')
	autofillChip.className = 'ask-chip'
	autofillChip.textContent = 'Browser autofill'
	autofillChip.style.animationDelay = '0ms'
	autofillChip.addEventListener('click', () => {
		autofillChip.classList.add('selected')
		setTimeout(() => askResolve?.('Use browser autofill to fill in the credentials, then submit'), 160)
	})
	loginOptionsEl.appendChild(autofillChip)

	// Add any methods detected from the question
	methods.forEach((m, i) => {
		const chip = document.createElement('button')
		chip.className = 'ask-chip'
		chip.textContent = m
		chip.style.animationDelay = `${(i + 1) * 55}ms`
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
		loginGateMsgEl.textContent = 'This page requires login to continue. How would you like to proceed?'
		// Reset chips — will be shown only after "Sign In" is clicked
		loginOptionsEl.replaceChildren()
		loginOptionsEl.classList.remove('login-options-visible')
		loginOptionsEl.classList.add('login-options-hidden')
		loginInputZoneEl.classList.add('hidden')
		loginSigninBtn.textContent = 'Sign In'
		loginSigninBtn.disabled = false

		showAskMode('login')
		showStage('ask')
		setStatus('waiting')

		return new Promise<string>((resolve, reject) => {
			askResolve = (answer: string) => {
				askResolve = null
				showStage('now')
				setNowAction('Continuing…', 'swap')
				setStatus('running')
				resolve(answer)
			}

			// Sign In button → reveal method chips
			loginSigninBtn.onclick = () => {
				_skippedLogin = false
				loginSigninBtn.textContent = 'Signing in…'
				loginSigninBtn.disabled = true
				const methods = parseLoginMethods(question)
				renderLoginMethodChips(methods)
				// Hide the Sign In / Not Now buttons row, show chips
				loginSigninBtn.closest('.login-gate-btns')!.classList.add('hidden')
			}

			// Not now → try without login
			loginSkipBtn.onclick = () => {
				_skippedLogin = true
				askResolve?.('No, proceed without login and try to access the page anyway')
			}

			options?.signal.addEventListener('abort', () => {
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
	// Re-open the login gate for the last login question
	showAskMode('login')
	showStage('ask')
	loginSigninBtn.textContent = 'Sign In'
	loginSigninBtn.disabled = false
	loginSigninBtn.closest('.login-gate-btns')?.classList.remove('hidden')
	loginOptionsEl.replaceChildren()
	loginOptionsEl.classList.remove('login-options-visible')
	loginOptionsEl.classList.add('login-options-hidden')
	_skippedLogin = false

	loginSigninBtn.onclick = () => {
		loginSigninBtn.textContent = 'Signing in…'
		loginSigninBtn.disabled = true
		renderLoginMethodChips(parseLoginMethods(_lastLoginQuestion))
		loginSigninBtn.closest('.login-gate-btns')!.classList.add('hidden')
	}
	loginSkipBtn.onclick = () => {
		_skippedLogin = true
		askResolve?.('No, proceed without login and try to access the page anyway')
	}
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
		stepDelay: _settings.stepDelay,
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

	feedEl.replaceChildren()
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
	feedEl.replaceChildren()
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

function makeEntry(icon: string, title: string, cls = ''): HTMLElement {
	const entry = document.createElement('div')
	entry.className = `entry ${cls}`
	const iconWrap = document.createElement('span')
	iconWrap.className = 'entry-icon'
	iconWrap.innerHTML = ICONS[icon] ?? ICONS.bolt
	const body = document.createElement('div')
	body.className = 'entry-body'
	const titleRow = document.createElement('div')
	titleRow.className = 'entry-title'
	const b = document.createElement('b')
	b.textContent = title
	titleRow.appendChild(b)
	body.appendChild(titleRow)
	entry.append(iconWrap, body)
	feedEl.appendChild(entry)
	feedEl.scrollTop = feedEl.scrollHeight
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
}

function onActivity(a: AgentActivity) {
	if (a.type === 'thinking') {
		// While thinking we don't yet know if this will be a task or question.
		// Show quiet shimmer in question mode; if already upgraded, show scramble.
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

		// Auto-detect: if the agent is executing a real action tool (not just 'done'),
		// upgrade from question → task mode right now, mid-run.
		if (!QUESTION_TOOLS.has(a.tool)) {
			_upgradeToTaskMode()
		}

		// Task mode → cascade; question mode (e.g. only 'done' fired) → swap
		setNowAction(meta.now, runMode === 'task' ? 'cascade' : 'swap')
		lastExecEl = makeEntry(meta.icon, meta.label, a.tool === 'ask_user' ? 'is-warn' : '')
		lastExecEl.dataset.tool = a.tool
	} else if (a.type === 'executed') {
		clearThinking()
		if (lastExecEl?.dataset.tool === a.tool) {
			lastExecEl.classList.add(a.output.startsWith('❌') ? 'is-err' : 'is-ok')
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
