import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

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
  plugins: [
    react(),
    docsContentNegotiation(),
    // Progressive Web App support: generates a service worker that
    // caches the SPA shell + static assets at install, and falls
    // back to cached responses for known-safe GET requests when
    // the server is unreachable. The "shell" alone unlocks "open
    // the app on a plane and see the last viewed doc"; doc bodies
    // pile into the runtime cache as the user views them, so the
    // last-opened set survives an outage.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // Precache the SPA shell + bundles. Workbox auto-collects the
      // chunks emitted by `vite build`; we add the static favicons
      // + Inter web font (loaded from a CDN, but its CSS comes from
      // rsms.me — that CSS is small enough to cache directly).
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Single-route navigation fallback — every SPA route serves
        // the same index.html, so any nav within Reader works offline
        // even though the URL is dynamic.
        navigateFallback: '/index.html',
        // Don't intercept /api or /mcp — those need to hit the
        // server. The runtimeCaching below handles the GET subset.
        navigateFallbackDenylist: [/^\/api\//, /^\/mcp(\/|$)/],
        // Workbox runtime cache for doc reads. Network-first so an
        // ONLINE user always sees fresh content; when the network
        // fails we fall through to the cache copy.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname === '/api/file/text',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'reader-file-text',
              expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60 },
              networkTimeoutSeconds: 4,
            },
          },
          {
            urlPattern: ({ url }) => url.pathname === '/api/file/meta',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'reader-file-meta',
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 },
              networkTimeoutSeconds: 3,
            },
          },
          {
            urlPattern: ({ url }) => url.pathname === '/api/file/raw',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'reader-file-raw',
              expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 },
              networkTimeoutSeconds: 5,
            },
          },
          {
            urlPattern: ({ url }) => url.pathname === '/api/vault-tree',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'reader-vault-tree' },
          },
          {
            urlPattern: ({ url }) => url.pathname === '/api/list',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'reader-list' },
          },
        ],
      },
      manifest: {
        name: 'Reader',
        short_name: 'Reader',
        description: 'Self-hosted document vault with AI chat per document.',
        theme_color: '#0B1424',
        background_color: '#0B1424',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      devOptions: {
        // Disabled in dev because the dev server's content-
        // negotiation middleware already handles cache headers
        // and a service worker on top of it is noisy. Run
        // `npm run preview` to test PWA behavior locally.
        enabled: false,
      },
    }),
  ],
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
