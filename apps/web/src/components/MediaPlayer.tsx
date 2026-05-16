import { useEffect, useRef, useState } from 'react'
import { Play, Pause, Volume2, VolumeX, Maximize2 } from 'lucide-react'

type Props = {
  src: string
  /** Optional poster image (videos only). */
  poster?: string
  /** Display filename — shown on the audio player so the user knows
   *  what they're listening to without scrolling up. */
  filename?: string
  kind: 'audio' | 'video'
}

/**
 * Minimal custom-chrome audio/video player. Replaces the native
 * `controls` attribute so the player matches the rest of the app's
 * look (rounded chips, accent color, dark-mode-aware). Just enough
 * surface for a vault viewer: play/pause, seek, time, mute,
 * fullscreen (video only).
 */
export function MediaPlayer({ src, poster, filename, kind }: Props) {
  const ref = useRef<HTMLMediaElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [buffering, setBuffering] = useState(false)

  // Wire HTMLMediaElement events to React state.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onTime = () => setCurrentTime(el.currentTime || 0)
    const onMeta = () => setDuration(el.duration || 0)
    const onVol = () => {
      setMuted(el.muted)
      setVolume(el.volume)
    }
    const onWait = () => setBuffering(true)
    const onPlaying = () => setBuffering(false)
    const onEnd = () => setPlaying(false)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('volumechange', onVol)
    el.addEventListener('waiting', onWait)
    el.addEventListener('playing', onPlaying)
    el.addEventListener('ended', onEnd)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('volumechange', onVol)
      el.removeEventListener('waiting', onWait)
      el.removeEventListener('playing', onPlaying)
      el.removeEventListener('ended', onEnd)
    }
  }, [src])

  const togglePlay = () => {
    const el = ref.current
    if (!el) return
    if (el.paused) el.play().catch(() => undefined)
    else el.pause()
  }

  const toggleMute = () => {
    const el = ref.current
    if (!el) return
    el.muted = !el.muted
  }

  const seekTo = (t: number) => {
    const el = ref.current
    if (!el) return
    el.currentTime = Math.max(0, Math.min(t, duration))
  }

  const enterFullscreen = () => {
    const el = ref.current
    if (!el) return
    // `requestFullscreen` is on HTMLElement, not the media interface,
    // so cast — and ignore failures (Safari iframe etc.).
    ;(el as HTMLElement).requestFullscreen?.().catch(() => undefined)
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className="h-full flex flex-col items-center justify-center p-6 gap-4" style={{ background: 'var(--panel)' }}>
      {kind === 'video' ? (
        <video
          ref={ref as React.RefObject<HTMLVideoElement>}
          src={src}
          poster={poster}
          playsInline
          preload="metadata"
          onClick={togglePlay}
          className="max-w-full max-h-[calc(100vh-220px)] rounded shadow-card cursor-pointer"
          style={{ background: 'black' }}
        />
      ) : (
        <>
          <audio
            ref={ref as React.RefObject<HTMLAudioElement>}
            src={src}
            preload="metadata"
            className="hidden"
          />
          <div
            className="flex flex-col items-center justify-center rounded-2xl"
            style={{
              width: 220,
              height: 220,
              background:
                'linear-gradient(135deg, rgba(76,110,245,0.18), rgba(132,94,247,0.18))',
              border: '1px solid var(--border-soft)',
            }}
          >
            <button
              onClick={togglePlay}
              className="w-20 h-20 rounded-full inline-flex items-center justify-center text-white shadow-card transition-transform hover:scale-105"
              style={{ background: 'var(--accent)' }}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause size={32} /> : <Play size={32} style={{ marginLeft: 4 }} />}
            </button>
            {filename && (
              <div className="mt-4 text-[12.5px] text-fg text-center truncate max-w-[200px] px-3" title={filename}>
                {filename}
              </div>
            )}
          </div>
        </>
      )}

      {/* Controls bar — same shape for audio + video. */}
      <div
        className="w-full max-w-[640px] rounded-lg px-3 py-2.5 flex items-center gap-3"
        style={{ background: 'var(--bg)', border: '1px solid var(--border-soft)' }}
      >
        <button
          onClick={togglePlay}
          className="w-8 h-8 rounded-full inline-flex items-center justify-center shrink-0 hover:bg-hover"
          style={{ color: 'var(--accent)' }}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {buffering ? (
            <span
              className="inline-block w-3 h-3 rounded-full animate-pulse"
              style={{ background: 'var(--accent)' }}
            />
          ) : playing ? (
            <Pause size={16} />
          ) : (
            <Play size={16} style={{ marginLeft: 2 }} />
          )}
        </button>

        <span className="text-[11.5px] text-subtle tabular-nums shrink-0">
          {fmtTime(currentTime)}
        </span>

        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={currentTime}
          onChange={(e) => seekTo(Number(e.target.value))}
          className="flex-1 media-range"
          style={{
            // Custom progress fill via accent-color (browser native).
            accentColor: 'var(--accent)',
          }}
          aria-label="Seek"
        />

        <span className="text-[11.5px] text-subtle tabular-nums shrink-0">
          {fmtTime(duration)}
        </span>

        <button
          onClick={toggleMute}
          className="w-7 h-7 rounded inline-flex items-center justify-center shrink-0 hover:bg-hover text-subtle"
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>

        {kind === 'video' && (
          <button
            onClick={enterFullscreen}
            className="w-7 h-7 rounded inline-flex items-center justify-center shrink-0 hover:bg-hover text-subtle"
            aria-label="Fullscreen"
            title="Fullscreen"
          >
            <Maximize2 size={13} />
          </button>
        )}
      </div>
      {/* progress is unused but keeps the seek bar in sync visually
          via the input's value above; expose the % to assistive tech */}
      <span className="sr-only" aria-live="off">
        {Math.round(progress)}%
      </span>
    </div>
  )
}

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}
