// jest-dom ships a vitest entrypoint (`./vitest`) that wires up
// the custom DOM matchers (toBeInTheDocument, etc.) into Vitest's
// expect. The package's default export targets Jest only and won't
// register the matchers here.
import * as jestDomMatchers from '@testing-library/jest-dom/matchers'
import { expect } from 'vitest'
expect.extend(jestDomMatchers)
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

/**
 * Web-test bootstrap. Runs once per worker before any tests; the
 * after-each `cleanup()` keeps each test's mounted DOM scoped so
 * earlier renders don't leak into later assertions.
 *
 * jsdom doesn't ship implementations for some of the browser
 * APIs our components touch on first render — scroll, match
 * media, requestAnimationFrame timing — so we install minimal
 * stubs here. They throw on `set` so any test that genuinely
 * needs custom behavior has to override explicitly.
 */
afterEach(() => {
  cleanup()
})

// matchMedia: theme-detection components query this on mount.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

// scrollIntoView: ChatDock auto-scrolls to the latest message.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// IntersectionObserver: DocRail uses it for heading-in-view tracking.
if (typeof window !== 'undefined' && !window.IntersectionObserver) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  }
}

// ResizeObserver: some components observe their container.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
