import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineAliases } from './shared'

const buildDir = fileURLToPath(new URL('.', import.meta.url))
const extensionRoot = resolve(buildDir, '..')

export default defineConfig({
    root: resolve(extensionRoot, 'src/panel'),
    base: './',
    envDir: extensionRoot,
    publicDir: false,
    resolve: { alias: engineAliases },
    build: {
        outDir: resolve(extensionRoot, 'dist/panel'),
        emptyOutDir: true,
        minify: false,
        assetsInlineLimit: 16384,
    },
})