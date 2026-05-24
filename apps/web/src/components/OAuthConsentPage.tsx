/**
 * OAuth 2.1 consent page. Rendered at /oauth/consent after the
 * dispatch from GET /oauth/authorize. URL params carry the request
 * (client_id, redirect_uri, state, code_challenge, scope) so the page
 * can re-fetch the catalog via /oauth/consent-context and then POST
 * the user's decision to /oauth/authorize/decide.
 *
 * If the user isn't signed in we render the AuthScreen first; on
 * success we re-mount the consent flow with the URL params intact.
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, AlertCircle, FileText } from 'lucide-react'
import { ApiError, api, type PublicUser } from '../lib/api'
import { AuthScreen } from './AuthScreen'

type Catalog = Array<{ scope: string; label: string; description: string; write: boolean }>

/** Threshold below which a client's registration is treated as
 *  "freshly registered" and the consent screen surfaces a phishing
 *  warning. 24h is a deliberately loose window — a long-lived
 *  Claude Desktop install won't be flagged, but a registration that
 *  happened during the same session as the consent click will be. */
const FRESH_CLIENT_WINDOW_MS = 24 * 60 * 60 * 1000

export function OAuthConsentPage({
  onAuthed,
}: {
  onAuthed: (user: PublicUser) => void
}): JSX.Element {
  const params = useMemo(() => {
    const url = new URL(window.location.href)
    return {
      client_id: url.searchParams.get('client_id') ?? '',
      redirect_uri: url.searchParams.get('redirect_uri') ?? '',
      state: url.searchParams.get('state') ?? '',
      code_challenge: url.searchParams.get('code_challenge') ?? '',
      code_challenge_method:
        (url.searchParams.get('code_challenge_method') as 'S256') ?? 'S256',
      scope: url.searchParams.get('scope') ?? 'mcp',
      // HMAC stamped onto the URL by GET /oauth/authorize. Round-tripped
      // to /decide so the server can verify this POST originated from a
      // real authorize round-trip (CSRF defense + scope-upgrade defense).
      req: url.searchParams.get('req') ?? '',
    }
  }, [])
  const [needsAuth, setNeedsAuth] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [client, setClient] = useState<{
    clientId: string
    clientName: string
    softwareId?: string
    createdAt: number
  } | null>(null)
  const [redirect, setRedirect] = useState<{ host: string; isLoopback: boolean } | null>(null)
  const [requested, setRequested] = useState<string[]>([])
  const [catalog, setCatalog] = useState<Catalog>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  const fetchContext = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.oauthConsentContext({
        client_id: params.client_id,
        scope: params.scope,
        redirect_uri: params.redirect_uri,
      })
      setClient(r.client)
      setRedirect(r.redirect)
      setRequested(r.requested)
      setCatalog(r.catalog)
      // Default selection mirrors what the client requested. Writes
      // stay checked too — the user explicitly chose the client, and
      // pre-unchecking destructive scopes leads to silent breakage
      // ("why isn't upload working") more often than misuse.
      setSelected(new Set(r.requested))
      setNeedsAuth(false)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setNeedsAuth(true)
      } else {
        setError(e instanceof ApiError ? e.message : String(e))
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (
      !params.client_id ||
      !params.redirect_uri ||
      !params.state ||
      !params.code_challenge ||
      !params.req
    ) {
      setError('Missing required OAuth parameters. The link is incomplete.')
      setLoading(false)
      return
    }
    void fetchContext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (scope: string) => {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      return next
    })
  }

  const decide = async (approve: boolean) => {
    setSubmitting(true)
    try {
      const r = await api.oauthDecide({
        client_id: params.client_id,
        redirect_uri: params.redirect_uri,
        state: params.state,
        code_challenge: params.code_challenge,
        code_challenge_method: params.code_challenge_method,
        scope: params.scope,
        req: params.req,
        scopes: approve ? Array.from(selected) : [],
        approve,
      })
      // Hand control back to the requesting client. The redirect URL
      // already carries either the code (on approve) or
      // error=access_denied (on deny).
      window.location.href = r.redirect
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      setSubmitting(false)
    }
  }

  if (needsAuth) {
    return (
      <AuthScreen
        onAuthed={(user) => {
          onAuthed(user)
          // After sign-in, re-fetch — the session cookie is now in
          // place and /oauth/consent-context will succeed.
          void fetchContext()
        }}
      />
    )
  }

  // Parse parenthesized suffix off the client name. Many MCP clients
  // (Claude Code, Cursor) submit names like `"Claude Code (reader)"`
  // where the suffix is the MCP-server slug — useful info but adds
  // visual noise next to the app name. We split it out as a subtitle
  // so the dominant glance is still on "who's connecting".
  const nameParts = parseClientName(client?.clientName ?? params.client_id)
  const visiblePerms = catalog.filter((c) => requested.includes(c.scope))
  const readPerms = visiblePerms.filter((c) => !c.write)
  const writePerms = visiblePerms.filter((c) => c.write)
  const isFresh = client && Date.now() - client.createdAt < FRESH_CLIENT_WINDOW_MS

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--rail)' }}>
      {loading ? (
        <div className="flex-1 grid place-items-center">
          <Loader2 size={20} className="animate-spin text-subtle" />
        </div>
      ) : error ? (
        <div className="flex-1 grid place-items-center p-4">
          <div
            className="w-full max-w-md p-6 rounded-xl space-y-3"
            style={{ background: 'var(--viewer)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2" style={{ color: '#BF2600' }}>
              <AlertCircle size={16} />
              <span className="text-[14px] font-semibold">Authorization failed</span>
            </div>
            <div className="text-[13px] text-subtle">{error}</div>
          </div>
        </div>
      ) : (
        <div className="flex-1 grid place-items-center p-4">
          <div
            className="w-full max-w-md rounded-lg overflow-hidden"
            style={{ background: 'var(--viewer)', border: '1px solid var(--border)' }}
          >
            {/* Title bar = Reader branding */}
            <div
              className="px-4 h-11 flex items-center gap-1.5"
              style={{
                background: 'var(--panel-2)',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <FileText size={14} className="text-accent" />
              <span className="text-[13px] font-semibold tracking-tight text-fg">
                Reader
              </span>
              <span className="ml-auto text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
                Authorize
              </span>
            </div>

            {/* Meta block — key/value rows for App + Redirect.
                No borderBottom: the next section's borderTop draws it
                (avoids a doubled line). */}
            <div className="px-4 py-3 text-[12px]">
              <div className="grid gap-y-1.5" style={{ gridTemplateColumns: 'max-content 1fr' }}>
                <span className="text-subtle pr-4">App</span>
                <span className="min-w-0 truncate" title={client?.clientName}>
                  <span className="text-fg font-medium">{nameParts.name}</span>
                  {nameParts.suffix && (
                    <span className="text-subtle ml-1.5">{nameParts.suffix}</span>
                  )}
                </span>

                <span className="text-subtle pr-4">Redirects to</span>
                <span className="text-fg min-w-0 truncate" title={redirect?.host}>
                  {redirect?.host ?? '—'}
                </span>
              </div>

              {isFresh && (
                <div
                  className="mt-2.5 pt-2.5 flex items-start gap-1.5 text-[11px]"
                  style={{
                    borderTop: '1px solid var(--border)',
                    color: '#BF6900',
                  }}
                >
                  <AlertCircle size={11} className="mt-px shrink-0" />
                  <span>Registered in the last 24 hours.</span>
                </div>
              )}
            </div>

              {/* Permissions */}
              <div className="max-h-[55vh] overflow-y-auto">
                {readPerms.length > 0 && (
                  <PermissionSection
                    title="Read"
                    perms={readPerms}
                    selected={selected}
                    onToggle={toggle}
                  />
                )}
                {writePerms.length > 0 && (
                  <PermissionSection
                    title="Write"
                    perms={writePerms}
                    selected={selected}
                    onToggle={toggle}
                  />
                )}
              </div>

              {/* Footer — panel-2 so it brackets the body symmetrically */}
              <div
                className="px-3 h-11 flex items-center justify-between gap-2"
                style={{
                  background: 'var(--panel-2)',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <button
                  className="btn-ghost h-7 px-2.5 text-[12px]"
                  onClick={() => decide(false)}
                  disabled={submitting}
                >
                  Deny
                </button>
                <button
                  className="btn-primary h-7 px-3 text-[12px] inline-flex items-center gap-1.5"
                  onClick={() => decide(true)}
                  disabled={submitting || selected.size === 0}
                >
                  {submitting && <Loader2 size={11} className="animate-spin" />}
                  {selected.size === requested.length
                    ? 'Allow'
                    : `Allow ${selected.size}`}
                </button>
              </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PermissionSection({
  title,
  perms,
  selected,
  onToggle,
}: {
  title: string
  perms: Catalog
  selected: Set<string>
  onToggle: (s: string) => void
}): JSX.Element {
  const on = perms.filter((p) => selected.has(p.scope)).length
  const allOn = on === perms.length
  const toggleAll = () => {
    if (allOn) perms.forEach((p) => selected.has(p.scope) && onToggle(p.scope))
    else perms.forEach((p) => selected.has(p.scope) || onToggle(p.scope))
  }
  return (
    <>
      <div
        className="px-4 h-7 flex items-center justify-between"
        style={{
          background: 'var(--panel-2)',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="text-[10.5px] uppercase tracking-wider font-semibold text-subtle">
          {title}
        </div>
        <button
          onClick={toggleAll}
          className="text-[10.5px] text-accent hover:underline"
        >
          {allOn ? 'none' : 'all'} · {on}/{perms.length}
        </button>
      </div>
      <ul>
        {perms.map((c) => {
          const checked = selected.has(c.scope)
          return (
            <li key={c.scope}>
              <label className="flex items-center gap-2.5 px-4 h-8 cursor-pointer hover:bg-hover">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(c.scope)}
                  className="shrink-0"
                />
                <span className="text-[12.5px] text-fg truncate" title={c.description}>
                  {c.label}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </>
  )
}

/** Split `"Claude Code (reader)"` → `{ name: "Claude Code", suffix: "(reader)" }`.
 *  When there's no trailing parenthetical we return the raw string in
 *  `name` so the layout has nothing to render as subtitle. */
function parseClientName(raw: string): { name: string; suffix?: string } {
  const m = raw.match(/^(.+?)\s*(\([^()]+\))\s*$/)
  if (m) return { name: m[1].trim(), suffix: m[2] }
  return { name: raw }
}
