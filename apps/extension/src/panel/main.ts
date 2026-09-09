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
const askAEl = $<HTMLInputElement>('askuser-a')

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

// ---------- the stage: one card at a time ----------

type Stage = 'composer' | 'now' | 'ask' | 'result'
const STAGE_ELS: Record<Stage, HTMLElement> = {
	composer: composerEl,
	now: nowEl,
	ask: askEl,
	result: resultEl,
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
You are PRIVO Verified Capture: you complete web tasks INCLUDING logins, pausing for the user whenever their input is needed.

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

function askUser(question: string, options?: { signal: AbortSignal }): Promise<string> {
	askQEl.innerHTML = renderMarkdown(question)
	showStage('ask')
	askAEl.value = ''
	setStatus('waiting')

	return new Promise<string>((resolve, reject) => {
		askResolve = (answer: string) => {
			askResolve = null
			showStage('now')
			nowActionEl.textContent = 'Continuing…'
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

// ---------- run / stop / restart ----------

let agent: MultiPageAgent | null = null

async function runTask() {
	const task = taskEl.value.trim()
	if (!task) return taskEl.focus()

	agent?.dispose()
	agent = new MultiPageAgent({
		baseURL: DEFAULT_LLM_CONFIG.baseURL,
		model: DEFAULT_LLM_CONFIG.model,
		maxSteps: 40,  // stay within model context windows; increase only if history truncation is implemented
		stepDelay: 0,
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
	nowActionEl.textContent = 'Starting…'
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
		stopRunMeta()
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
	showStage('result')
}

async function resetToComposer() {
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
	taskEl.focus()
}

$('run').addEventListener('click', () => void runTask())
$('stop').addEventListener('click', () => agent?.stop())
restartBtn.addEventListener('click', () => void resetToComposer())
$('result-new').addEventListener('click', () => void resetToComposer())
$('result-retry').addEventListener('click', () => void runTask())

taskEl.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
		e.preventDefault()
		void runTask()
	}
})
taskEl.addEventListener('input', () => {
	taskEl.style.height = 'auto'
	taskEl.style.height = `${Math.min(taskEl.scrollHeight, 180)}px`
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
		nowActionEl.textContent = 'Thinking…'
		if (!thinkingEl) thinkingEl = makeEntry('sparkle', 'Thinking…', 'thinking')
	} else if (a.type === 'executing') {
		clearThinking()
		stepCount++
		updateRunMeta()
		const meta = TOOL_META[a.tool] ?? { icon: 'bolt', label: a.tool.replaceAll('_', ' '), now: 'Working…' }
		nowActionEl.textContent = meta.now
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
