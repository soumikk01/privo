// ─── Privo — Placeholder Registry ────────────────────────────────────────────
//
// In-memory only. Never persisted. Never serialized to model context.
// One instance per task session, cleared on agent.dispose().
//
// Usage:
//   const registry = new PlaceholderRegistry()
//   const placeholder = registry.allocate('EMAIL', 'user@example.com')
//   // → "EMAIL_1"
//   registry.getRawValue('EMAIL_1')  // → "user@example.com"  (local only)
//   registry.clear()                 // called when task ends

import type { PiiCategory } from './privacy-types'

export class PlaceholderRegistry {
	// placeholder → raw value  (e.g. "EMAIL_1" → "user@example.com")
	private readonly _map = new Map<string, string>()
	// raw value → placeholder  (for deduplication)
	private readonly _reverse = new Map<string, string>()
	// category → current counter
	private readonly _counters = new Map<PiiCategory, number>()

	/**
	 * Allocate or retrieve a placeholder for a given raw value.
	 * If the same raw value has already been registered, returns the existing placeholder.
	 * Otherwise creates a new one like "EMAIL_1", "EMAIL_2", etc.
	 *
	 * SECURITY: rawValue is stored ONLY in this in-memory map.
	 * It must never be included in any structure sent to the model.
	 */
	allocate(category: PiiCategory, rawValue: string): string {
		const existing = this._reverse.get(rawValue)
		if (existing) return existing

		const n = (this._counters.get(category) ?? 0) + 1
		this._counters.set(category, n)
		const placeholder = `${category}_${n}`
		this._map.set(placeholder, rawValue)
		this._reverse.set(rawValue, placeholder)
		return placeholder
	}

	/**
	 * Get the raw value for a placeholder.
	 * Used ONLY locally (e.g. credential fill).
	 * Must never be called in a context where the result could reach model context.
	 */
	getRawValue(placeholder: string): string | undefined {
		return this._map.get(placeholder)
	}

	/** True if the registry is empty (no items registered) */
	isEmpty(): boolean {
		return this._map.size === 0
	}

	/** Number of registered items */
	size(): number {
		return this._map.size
	}

	/** All allocated placeholders (labels only, no raw values) */
	getPlaceholders(): string[] {
		return [...this._map.keys()]
	}

	/**
	 * Clear all mappings.
	 * Called automatically when a task session ends (agent.dispose()).
	 * SECURITY: ensures raw values do not linger in memory after task completion.
	 */
	clear(): void {
		this._map.clear()
		this._reverse.clear()
		this._counters.clear()
	}
}

/**
 * Singleton registry for the current task session.
 * The caller (privacy gateway) must call registry.clear() when the task ends.
 */
export const taskRegistry = new PlaceholderRegistry()
