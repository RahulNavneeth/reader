import { useEffect, useState } from 'react'

/**
 * Cheap online/offline detector. `navigator.onLine` is widely
 * available + accurate enough for the "should I attempt the network
 * request" decision. The browser fires `online`/`offline` events
 * when the OS-level connection flips, so we don't need to poll.
 *
 * Caveat: `navigator.onLine === true` doesn't guarantee the
 * server is reachable (captive portal, server down, etc.). The
 * replay loop layers a real `fetch` attempt on top; this is just
 * the "should I even try" hint.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])
  return online
}
