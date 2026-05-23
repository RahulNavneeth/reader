import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { copyFileSync } from 'node:fs'

/**
 * Vanilla Vite build for the extension. We don't pull in
 * `@crxjs/vite-plugin` here because the extension's surface is
 * small (3 entry points + a static manifest); rolling our own
 * keeps the dep footprint tiny and the build deterministic.
 *
 * Output layout under dist/:
 *   manifest.json      — copied from src/ (post-build hook)
 *   popup.html         — entry, transformed
 *   popup.js           — popup script bundle
 *   background.js      — service-worker bundle
 *   content.js         — page content-script bundle
 */
// `root: 'src'` so Vite's HTML entry detection puts `popup.html`
// at dist/popup.html (instead of dist/src/popup.html). The post-
// build hook copies the manifest into the same flat dist/ layout
// that Chrome expects when you Load Unpacked.
export default defineConfig({
  root: resolve(__dirname, 'src'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup.html'),
        background: resolve(__dirname, 'src/background.ts'),
        content: resolve(__dirname, 'src/content.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
  plugins: [
    {
      name: 'reader-copy-manifest',
      closeBundle() {
        copyFileSync(
          resolve(__dirname, 'src/manifest.json'),
          resolve(__dirname, 'dist/manifest.json'),
        )
      },
    },
  ],
})
