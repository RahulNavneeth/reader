import { useEffect, useState } from 'react'

/**
 * Tracks whether the browser thinks we have network. Off-by-default
 * for SSR safety (`navigator` is undefined). The "online" event
 * fires when a real connection comes back; we trust it. The "offline"
 * event fires before some fetch failures, so we use it to flip the
 * banner immediately rather than waiting for the next fetch to 5xx.
 *
 * Note: `navigator.onLine` is a HINT, not ground truth — it tells
 * us whether the OS reports an interface up, not whether the Reader
 * server is reachable. A LAN-disconnected machine reads `onLine =
 * false`; a connected-but-server-down machine reads `onLine = true`
 * but every fetch fails. The service-worker runtime cache handles
 * the second case by serving cached responses.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}
