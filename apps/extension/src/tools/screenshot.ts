import * as z from 'zod/v4'

import { sealCapture } from '../seal'

interface ScreenshotToolShape {
	description: string
	inputSchema: z.ZodType
	execute: (input: unknown, ctx: { signal: AbortSignal }) => Promise<string>
}

export function createScreenshotTool(): Record<string, ScreenshotToolShape> {
	return {
		capture_screenshot: {
			description:
				'Capture a VERIFIED screenshot of the current tab (visible viewport). ' +
				'The image is watermarked and its fingerprint is registered for later validation. ' +
				'Use when the user asks to capture/screenshot a page or section. ' +
				'Make sure the right content is visible (scroll to it) BEFORE calling this. ' +
				'Returns the capture ID — include it in your final answer.',
			inputSchema: z.object({
				reason: z.string().optional().describe('What this capture shows'),
			}),
			execute: async () => {
				try {
					const c = await sealCapture()
					return (
						`✅ Verified capture ${c.id} saved (${c.sealed ? 'sealed & registered' : 'watermarked, backend offline — NOT registered'}). ` +
						`Page: "${c.title}". It is in the panel gallery.`
					)
				} catch (err) {
					return `❌ Capture failed: ${err instanceof Error ? err.message : String(err)}`
				}
			},
		},
	}
}
