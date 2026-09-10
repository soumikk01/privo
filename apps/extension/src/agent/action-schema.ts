// ─── Privo — Structured Agent Action Schema ───────────────────────────────────
//
// Zod schema for ALL permitted browser actions returned by the cloud model.
//
// The cloud model MUST return one of these structured actions.
// The action-validator will reject:
//   - Unknown action types
//   - Malformed action structures
//   - Actions outside this schema
//
// Arbitrary JavaScript execution is NOT permitted.
// The model cannot add new action types at runtime.

import * as z from 'zod/v4'

// ── Individual action schemas ─────────────────────────────────────────────────

const ClickAction = z.object({
	action: z.literal('click'),
	/** The [N] element ID from the PageController element tree */
	targetId: z.string().min(1),
	reason: z.string().optional(),
})

const TypeAction = z.object({
	action: z.literal('type'),
	targetId: z.string().min(1),
	/** The text to type. Must NOT contain raw passwords/OTPs — use request_credential_fill instead. */
	value: z.string(),
	reason: z.string().optional(),
})

const ScrollAction = z.object({
	action: z.literal('scroll'),
	direction: z.enum(['up', 'down', 'left', 'right']),
	/** Amount in pixels */
	amount: z.number().int().min(1).max(10000).default(300),
	reason: z.string().optional(),
})

const SelectAction = z.object({
	action: z.literal('select'),
	targetId: z.string().min(1),
	value: z.string(),
	reason: z.string().optional(),
})

const WaitAction = z.object({
	action: z.literal('wait'),
	/** Milliseconds to wait (capped at 10s) */
	ms: z.number().int().min(100).max(10000).default(1000),
	reason: z.string().optional(),
})

const RequestLoginAction = z.object({
	action: z.literal('request_login'),
	/** Human-readable description of why login is needed */
	message: z.string().optional(),
})

const RequestCredentialFillAction = z.object({
	action: z.literal('request_credential_fill'),
	/** Element ID of the username/email field */
	usernameFieldId: z.string().optional(),
	/** Element ID of the password field */
	passwordFieldId: z.string().optional(),
	/** Human-readable context */
	message: z.string().optional(),
})

const RequestConfirmationAction = z.object({
	action: z.literal('request_confirmation'),
	/** What the agent wants to do — shown to the user */
	message: z.string().min(1),
	riskLevel: z.enum(['low', 'medium', 'high']).default('medium'),
})

const DoneAction = z.object({
	action: z.literal('done'),
	/** Final result text shown to user */
	result: z.string().optional(),
})

// ── Union discriminated on 'action' field ─────────────────────────────────────

export const AgentActionSchema = z.discriminatedUnion('action', [
	ClickAction,
	TypeAction,
	ScrollAction,
	SelectAction,
	WaitAction,
	RequestLoginAction,
	RequestCredentialFillAction,
	RequestConfirmationAction,
	DoneAction,
])

export type AgentAction = z.infer<typeof AgentActionSchema>

// ── High-risk action set ──────────────────────────────────────────────────────

/** Actions that ALWAYS require user confirmation before execution */
export const HIGH_RISK_ACTIONS = new Set<AgentAction['action']>([
	'request_confirmation',  // explicit confirmation request from the model
])

/** Actions that require confirmation based on context (form submit, purchase, delete) */
export const CONSEQUENTIAL_KEYWORDS = [
	/\b(submit|buy|purchase|order|checkout|pay|delete|remove|cancel|close\s+account|sign\s+out)\b/i,
]

export function isConsequentialAction(action: AgentAction): boolean {
	if (HIGH_RISK_ACTIONS.has(action.action)) return true
	if ('reason' in action && action.reason) {
		return CONSEQUENTIAL_KEYWORDS.some((re) => re.test(action.reason!))
	}
	return false
}

/** Actions permitted during an active task (anything except done is permitted) */
export const PERMITTED_ACTIONS: Set<AgentAction['action']> = new Set([
	'click',
	'type',
	'scroll',
	'select',
	'wait',
	'request_login',
	'request_credential_fill',
	'request_confirmation',
	'done',
])
