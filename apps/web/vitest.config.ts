import { defineConfig } from 'vitest/config'

// Separate config from vite.config.ts so the SPA-only docs
// content-negotiation plugin doesn't run inside the test harness.
// jsdom gives us a synthetic DOM for React Testing Library; the
// setup file wires @testing-library/jest-dom matchers and stubs
// browser APIs (matchMedia, scrollIntoView, IntersectionObserver)
// that the components touch on mount.
//
// We DON'T include @vitejs/plugin-react here: Vitest 4 ships
// its own oxc-based JSX transform, and loading the react plugin
// alongside triggers "Both esbuild and oxc options were set"
// because the plugin sets esbuild jsx options that conflict with
// oxc's defaults. Vitest's built-in transform handles our JSX
// fine (we only need the runtime form, not Fast Refresh).
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: true,
  },
})
