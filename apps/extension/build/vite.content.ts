import { defineConfig } from 'vite'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'
import { engineAliases } from './shared'

// Content script: must be a single IIFE file; CSS (simulator mask) is injected from JS.
export default defineConfig({
    publicDir: false,
    resolve: { alias: engineAliases },
    plugins: [cssInjectedByJsPlugin()],
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        minify: false,
        assetsInlineLimit: 16384,
        lib: {
            entry: 'src/entrypoints/content.ts',
            formats: ['iife'],
            name: 'DeccanPageAgentContent',
            fileName: () => 'content.js',
        },
    },
})
