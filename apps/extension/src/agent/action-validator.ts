// ─── Privo — Action Validator ─────────────────────────────────────────────────
//
// Every model-generated action passes through this validator before execution.
// Rejection at any stage prevents execution. Stages are:
//
//   1. Schema validation    — action matches AgentActionSchema
//   2. Permitted-action     — action type is in the allowlist
//   3. Tab binding          — action targets the correct tab
//   4. Target existence     — targetId element still exists in DOM
//   5. Snapshot freshness   — DOM has not changed significantly since last observation
//   6. Risk check           — high-risk/consequential actions require confirmation
//
// The validator does NOT modify the action. It returns a ValidationResult.
// Execution is the caller's responsibility.

import { AgentActionSchema, PERMITTED_ACTIONS, isConsequentialAction } from './action-schema'
import type { AgentAction } from './action-schema'

// ── Validation result ─────────────────────────────────────────────────────────

export type ValidationResult =
	| { valid: true; action: AgentAction }
	| { valid: false; reason: string; stage: ValidationStage }

export type ValidationStage =
	| 'schema'
	| 'permitted'
	| 'tab_binding'
	| 'target_existence'
	| 'snapshot_freshness'
	| 'risk_confirmation'

// ── Validator context ─────────────────────────────────────────────────────────

export interface ValidatorContext {
	/** ID of the tab the agent is currently working in */
	currentTabId: number | null
	/** Tab ID the action targets (if the action carries one) */
	actionTabId?: number
	/** Check if a DOM element still exists in the current page */
	doesElementExist?: (elementId: string) => Promise<boolean>
	/** Last DOM hash captured during observation */
	lastDomHash?: string
	/** Current DOM hash (for freshness check) */
	currentDomHash?: string
	/** DOM hash change tolerance (ratio 0.0–1.0; 0.3 = up to 30% change is OK) */
	domChangeTolerance?: number
	/** Whether user has already confirmed this action */
	userConfirmed?: boolean
	/** Callback to request user confirmation before executing */
	requestConfirmation?: (message: string, riskLevel: 'low' | 'medium' | 'high') => Promise<boolean>
}

// ── Core validator ────────────────────────────────────────────────────────────

/**
 * Validate a raw action object before execution.
 *
 * @param rawAction - Untyped action from the model
 * @param ctx       - Validator context (tab binding, DOM state, confirmation)
 * @returns ValidationResult — check `valid` before executing
 */
export async function validateAction(
	rawAction: unknown,
	ctx: ValidatorContext,
): Promise<ValidationResult> {

	// ── Stage 1: Schema validation ─────────────────────────────────────────

	const parsed = AgentActionSchema.safeParse(rawAction)
	if (!parsed.success) {
		return {
			valid: false,
			stage: 'schema',
			reason: `Action failed schema validation: ${parsed.error.message}`,
		}
	}

	const action = parsed.data

	// ── Stage 2: Permitted-action check ───────────────────────────────────

	if (!PERMITTED_ACTIONS.has(action.action)) {
		return {
			valid: false,
			stage: 'permitted',
			reason: `Action type '${action.action}' is not in the permitted action list`,
		}
	}

	// ── Stage 3: Tab binding ───────────────────────────────────────────────
	// If the action carries a tabId, it must match the active tab.

	if (ctx.actionTabId !== undefined && ctx.currentTabId !== null) {
		if (ctx.actionTabId !== ctx.currentTabId) {
			return {
				valid: false,
				stage: 'tab_binding',
				reason: `Action targets tab ${ctx.actionTabId} but agent is bound to tab ${ctx.currentTabId}`,
			}
		}
	}

	// ── Stage 4: Target element existence ─────────────────────────────────
	// Only for actions that reference a DOM element

	if ('targetId' in action && action.targetId && ctx.doesElementExist) {
		try {
			const exists = await ctx.doesElementExist(action.targetId)
			if (!exists) {
				return {
					valid: false,
					stage: 'target_existence',
					reason: `Target element [${action.targetId}] no longer exists in DOM`,
				}
			}
		} catch {
			// If we cannot check existence, err on the side of caution
			return {
				valid: false,
				stage: 'target_existence',
				reason: `Could not verify element [${action.targetId}] existence — DOM check failed`,
			}
		}
	}

	// ── Stage 5: DOM snapshot freshness ───────────────────────────────────
	// Reject actions against a stale page state.

	if (ctx.lastDomHash && ctx.currentDomHash) {
		if (ctx.lastDomHash !== ctx.currentDomHash) {
			// The DOM changed since the model last observed it.
			// For non-consequential actions we warn but allow; for high-risk we block.
			if (isConsequentialAction(action)) {
				return {
					valid: false,
					stage: 'snapshot_freshness',
					reason: 'Page DOM changed since last observation — cannot execute consequential action against stale state',
				}
			}
		}
	}

	// ── Stage 6: Risk confirmation ─────────────────────────────────────────
	// Consequential actions require user confirmation unless already obtained.

	if (isConsequentialAction(action) && !ctx.userConfirmed) {
		if (ctx.requestConfirmation) {
			const message = 'message' in action
				? (action.message ?? `Execute: ${action.action}?`)
				: `Execute: ${action.action}?`
			const riskLevel = 'riskLevel' in action ? action.riskLevel : 'medium'

			const confirmed = await ctx.requestConfirmation(message, riskLevel)
			if (!confirmed) {
				return {
					valid: false,
					stage: 'risk_confirmation',
					reason: 'User declined to confirm consequential action',
				}
			}
		}
		// If no requestConfirmation provided, consequential actions are blocked
		else {
			return {
				valid: false,
				stage: 'risk_confirmation',
				reason: 'Consequential action requires confirmation but no confirmation handler is available',
			}
		}
	}

	return { valid: true, action }
}

/**
 * Convenience: validate and throw if invalid.
 * @throws Error with reason if action is invalid
 */
export async function assertValidAction(
	rawAction: unknown,
	ctx: ValidatorContext,
): Promise<AgentAction> {
	const result = await validateAction(rawAction, ctx)
	if (!result.valid) {
		throw new Error(`[ActionValidator] ${result.stage}: ${result.reason}`)
	}
	return result.action
}
