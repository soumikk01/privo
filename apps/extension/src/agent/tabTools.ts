import type { ToolContext } from '@page-agent/core'
import * as z from 'zod/v4'

import type { TabsController } from './TabsController'

interface TabTool {
	description: string
	inputSchema: z.ZodType
	execute: (input: unknown, ctx: ToolContext) => Promise<string>
}

// Prompt injection defence: a malicious page could tell the agent to open
// http://localhost:8787/captures. This blocks loopback, RFC-1918, and link-local.
export function isSafeUrl(raw: string): { ok: true } | { ok: false; reason: string } {
	let u: URL
	try {
		u = new URL(raw)
	} catch {
		return { ok: false, reason: 'URL is not valid' }
	}

	if (!['http:', 'https:'].includes(u.protocol)) {
		return { ok: false, reason: `Scheme '${u.protocol}' is not allowed (only http and https)` }
	}

	const host = u.hostname.toLowerCase()

	// Full 127.0.0.0/8 block — not just 127.0.0.1. Also covers IPv4-mapped IPv6 loopback.
	if (
		host === 'localhost' ||
		/^127\./.test(host) ||         // entire 127.0.0.0/8 block
		host === '0.0.0.0' ||
		host === '::1' ||
		host === '[::1]' ||
		host === '0:0:0:0:0:0:0:0' ||
		host === '[0:0:0:0:0:0:0:0]' ||
		/^\[?::ffff:/i.test(host)      // IPv4-mapped IPv6 (e.g. [::ffff:7f00:1])
	) {
		return { ok: false, reason: 'Loopback addresses are not allowed' }
	}

	// RFC-1918 private ranges
	if (
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host)
	) {
		return { ok: false, reason: 'Private IP ranges are not allowed' }
	}

	// Link-local (includes AWS EC2 metadata service)
	if (/^169\.254\./.test(host)) {
		return { ok: false, reason: 'Link-local addresses are not allowed' }
	}

	return { ok: true }
}

export function createTabTools(tabsController: TabsController): Record<string, TabTool> {
	return {
		open_new_tab: {
			description:
				'Open a new browser tab with the specified URL. The new tab becomes the current tab for all subsequent page operations.',
			inputSchema: z.object({
				url: z.string().describe('The URL to open in the new tab'),
			}),
			execute: async (input: unknown, { signal }: ToolContext) => {
				const { url } = input as { url: string }
				const check = isSafeUrl(url)
				if (!check.ok) return `❌ Refused: ${check.reason}`
				try {
					return await tabsController.openNewTab(url, { signal })
				} catch (error) {
					// Let cancellation propagate instead of masking it as a tool failure.
					if (signal.aborted) throw error
					return `❌ Failed: ${error instanceof Error ? error.message : String(error)}`
				}
			},
		},

		switch_to_tab: {
			description:
				'Switch to an existing tab by its ID. After switching, all page operations will target the new current tab. You can only switch to tabs in the tab list shown in browser state.',
			inputSchema: z.object({
				tab_id: z.number().int().describe('The tab ID to switch to'),
			}),
			execute: async (input: unknown) => {
				const { tab_id } = input as { tab_id: number }
				try {
					return await tabsController.switchToTab(tab_id)
				} catch (error) {
					return `❌ Failed: ${error instanceof Error ? error.message : String(error)}`
				}
			},
		},

		close_tab: {
			description:
				'Close a tab by its ID. Cannot close the initial tab. Optionally specify which tab to switch to after closing.',
			inputSchema: z.object({
				tab_id: z.number().int().describe('The tab ID to close'),
			}),
			execute: async (input: unknown) => {
				const { tab_id } = input as { tab_id: number }
				try {
					return await tabsController.closeTab(tab_id)
				} catch (error) {
					return `❌ Failed: ${error instanceof Error ? error.message : String(error)}`
				}
			},
		},
	}
}
