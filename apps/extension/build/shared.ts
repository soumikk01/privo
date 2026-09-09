import { fileURLToPath } from 'node:url'

/** Map upstream package names onto the vendored sources (kept unmodified). */
export const engineAliases = {
    '@page-agent/core': fileURLToPath(new URL('../src/vendor/core/PageAgentCore.ts', import.meta.url)),
    '@page-agent/page-controller': fileURLToPath(
        new URL('../src/vendor/page-controller/PageController.ts', import.meta.url)
    ),
    '@page-agent/llms': fileURLToPath(new URL('../src/vendor/llms/index.ts', import.meta.url)),
}
