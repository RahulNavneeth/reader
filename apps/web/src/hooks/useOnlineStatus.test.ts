import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOnlineStatus } from './useOnlineStatus'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Hook smoke tests. We can't reliably toggle `navigator.onLine` in
 * jsdom (it's a getter), but we CAN fire the `online` / `offline`
 * events the hook subscribes to and verify the returned state
 * flips. That's the contract the App banner depends on.
 */
describe('useOnlineStatus', () => {
  it('returns navigator.onLine on first render', () => {
    const { result } = renderHook(() => useOnlineStatus())
    expect(typeof result.current).toBe('boolean')
    expect(result.current).toBe(navigator.onLine)
  })

  it('flips to false on a window "offline" event', () => {
    const { result } = renderHook(() => useOnlineStatus())
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(result.current).toBe(false)
  })

  it('flips back to true on a window "online" event', () => {
    const { result } = renderHook(() => useOnlineStatus())
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(result.current).toBe(false)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(result.current).toBe(true)
  })

  it('removes its listeners on unmount', () => {
    const removed: string[] = []
    const orig = window.removeEventListener
    vi.spyOn(window, 'removeEventListener').mockImplementation(
      (type: string, ...rest: unknown[]) => {
        removed.push(type)
        return (orig as unknown as (...a: unknown[]) => unknown).apply(
          window,
          [type, ...rest],
        )
      },
    )
    const { unmount } = renderHook(() => useOnlineStatus())
    unmount()
    expect(removed).toEqual(expect.arrayContaining(['online', 'offline']))
  })
})
