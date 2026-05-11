import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const SERVER_PORT = process.env.SERVER_PORT || '3001'

/**
 * Content-negotiate /docs/<path> so the same URL works for both the SPA viewer
 * and CLI tools. Top-level navigations (Sec-Fetch-Dest: document) get the SPA
 * shell. Every other fetch (img/iframe/wget/curl) is internally rewritten to
 * the raw file endpoint — no 302, no leaked /api/file/raw URL.
 */
function docsContentNegotiation(): Plugin {
  return {
    name: 'reader-docs-content-negotiation',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (!req.url) return next()
        const [pathname] = req.url.split('?')
        if (!pathname.startsWith('/docs/')) return next()
        const rel = pathname.slice('/docs/'.length)
        const dest = (req.headers['sec-fetch-dest'] as string | undefined) || ''
        const accept = (req.headers.accept || '').toLowerCase()
        const wantsSpa = dest === 'document' || (!dest && accept.includes('text/html'))
        if (wantsSpa) return next()
        // Internal rewrite — the URL the user sees stays /docs/<path>; Vite's /api
        // proxy serves the bytes from the backend's raw endpoint behind the scenes.
        req.url = `/api/file/raw?path=${rel}`
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), docsContentNegotiation()],
  server: {
    port: 5174,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
      },
      '/mcp': {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
})
