import { defineConfig } from 'vite'
import { engineAliases } from './shared'

// Background service worker (ES module). publicDir copies manifest.json + icons to dist/.
export default defineConfig({
    publicDir: 'public',
    resolve: { alias: engineAliases },
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        minify: false,
        lib: {
            entry: 'src/entrypoints/background.ts',
            formats: ['es'],
            fileName: () => 'background.js',
        },
    },
})
