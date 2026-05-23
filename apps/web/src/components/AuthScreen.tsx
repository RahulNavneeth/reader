import { useEffect, useState } from 'react'
import { AlertCircle, ArrowRight, FileText, Lock, ShieldOff } from 'lucide-react'
import { api, ApiError, type PublicUser } from '../lib/api'

type Mode = 'signup' | 'login'

type Props = {
  onAuthed: (user: PublicUser) => void
}

export function AuthScreen({ onAuthed }: Props) {
  const [mode, setMode] = useState<Mode>('login')
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null)
  const [allowSignup, setAllowSignup] = useState<boolean>(true)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api
      .bootstrap()
      .then((r) => {
        setHasAdmin(r.hasAdmin)
        setAllowSignup(r.allowOpenSignup)
        // No admin yet → first run, default to signup.
        if (!r.hasAdmin) setMode('signup')
      })
      .catch(() => setHasAdmin(true))
  }, [])

  // If sign-ups are off and an admin already exists, you cannot create an account.
  // The very first sign-up is always allowed (it makes the admin).
  const signupBlocked = mode === 'signup' && hasAdmin === true && !allowSignup

  const submit = async () => {
    // Don't pre-clear the error here. If the new error message is
    // identical to the current one, React skips the re-render and
    // the alert box stays mounted (no flicker). If it differs, the
    // box just updates its text in place. Clearing first creates a
    // visible gap between the unmount and the re-mount.
    const userTooShort = username.length < 2
    const passTooShort = password.length < 8
    if (userTooShort || passTooShort) {
      if (userTooShort && passTooShort) {
        setError('Username must be at least 2 characters and password at least 8.')
      } else if (userTooShort) {
        setError('Username must be at least 2 characters.')
      } else {
        setError('Password must be at least 8 characters.')
      }
      return
    }
    setBusy(true)
    try {
      const r =
        mode === 'signup'
          ? await api.signup(username, password)
          : await api.login(username, password)
      setError(null)
      onAuthed(r.user)
    } catch (e) {
      if (e instanceof ApiError) setError(e.message)
      else setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (signupBlocked) {
    return (
      <div className="h-full flex items-center justify-center surface">
        <div className="w-full max-w-sm p-8">
          <div className="flex items-center gap-2 mb-6">
            <FileText size={20} className="text-accent" />
            <span className="text-[15px] font-semibold tracking-tight">Reader</span>
          </div>

          <div className="flex items-center gap-2 mb-3">
            <ShieldOff size={18} className="text-muted" />
            <h1 className="text-xl font-semibold tracking-tight">Sign-ups are closed</h1>
          </div>
          <p className="text-[13.5px] text-muted mb-5">
            The admin of this workspace has disabled open sign-ups. Ask them to create an account
            for you, then sign in below.
          </p>

          <button
            className="btn-primary w-full"
            onClick={() => {
              setMode('login')
              setError(null)
            }}
          >
            <Lock size={14} />
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex items-center justify-center surface">
      <div className="w-full max-w-sm p-8">
        <div className="flex items-center gap-2 mb-6">
          <FileText size={20} className="text-accent" />
          <span className="text-[15px] font-semibold tracking-tight">Reader</span>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight mb-1">
          {mode === 'signup'
            ? hasAdmin === false
              ? 'Create the admin account'
              : 'Create your account'
            : 'Sign in'}
        </h1>
        <p className="text-[13.5px] text-muted mb-5">
          {mode === 'signup'
            ? hasAdmin === false
              ? 'You are the first user — you become the admin.'
              : 'Pick a username and a password ≥ 8 characters.'
            : 'Your vault, searchable by you and your agents.'}
        </p>

        <label className="block text-[12px] font-medium text-muted mb-1.5">Username</label>
        <input
          className="input mb-3"
          value={username}
          autoFocus
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Enter your username"
        />

        <label className="block text-[12px] font-medium text-muted mb-1.5">Password</label>
        <input
          className="input mb-3"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="••••••••"
        />

        {error && (
          <div
            className="text-[12.5px] mb-3 px-2.5 py-2 rounded flex items-start gap-1.5"
            style={{
              background: 'var(--danger-bg)',
              color: 'var(--danger-fg)',
              border: '1px solid color-mix(in srgb, var(--danger-fg) 20%, transparent)',
            }}
            role="alert"
          >
            <AlertCircle size={12} className="shrink-0 mt-0.5" />
            <span className="leading-snug">{error}</span>
          </div>
        )}

        <button className="btn-primary w-full mb-3" onClick={submit} disabled={busy}>
          {mode === 'signup' ? <ArrowRight size={14} /> : <Lock size={14} />}
          {mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>

        {hasAdmin && (
          <div className="text-[12.5px] text-muted text-center">
            {mode === 'login' ? (
              allowSignup && (
                <button className="text-accent hover:underline" onClick={() => setMode('signup')}>
                  Need an account? Sign up
                </button>
              )
            ) : (
              <button className="text-accent hover:underline" onClick={() => setMode('login')}>
                Already have an account? Sign in
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
