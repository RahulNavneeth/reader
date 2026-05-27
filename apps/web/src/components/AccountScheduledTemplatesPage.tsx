import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  CalendarClock,
  Play,
} from 'lucide-react'
import { ApiError, api } from '../lib/api'
import {
  MetaDot,
  SettingsListCard,
  SettingsListEmpty,
  SettingsListRow,
} from './SettingsList'

/**
 * Per-user "Scheduled templates" page at /account/scheduled-templates.
 *
 * Lists every schedule the caller has declared in their templates'
 * frontmatter. Grouped by template file (one Section per file) so
 * a template with three crons surfaces as one section + three rows,
 * matching the design language of the API tokens / Webhooks pages.
 *
 * Source of truth for scheduling is the template file itself —
 * disable by removing the cron line. Run-now is a verification
 * action.
 */

type Item = {
  owner: string
  template: string
  cron: string
  label?: string
  nextFireAt: number | null
  lastFiredAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  lastTarget: string | null
  vars: Record<string, string>
  pathPreview: string
}

function fmtTimestamp(ms: number | null): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

function relativeFromNow(ms: number | null): string {
  if (!ms) return ''
  const diff = ms - Date.now()
  if (Math.abs(diff) < 60_000) return diff < 0 ? 'just now' : 'in <1 min'
  const sign = diff < 0 ? '' : 'in '
  const ago = diff < 0 ? ' ago' : ''
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60_000)
  if (mins < 60) return `${sign}${mins} min${ago}`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${sign}${hours}h${ago}`
  const days = Math.round(hours / 24)
  return `${sign}${days}d${ago}`
}

type ParseError = { owner: string; template: string; error: string }

export function AccountScheduledTemplatesPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Item[] | null>(null)
  const [parseErrors, setParseErrors] = useState<ParseError[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const r = await api.accountScheduledTemplates()
      setItems(r.items)
      setParseErrors(r.errors)
      setErr(null)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  // Group entries by template file. One Section per file.
  const grouped = useMemo(() => {
    const map = new Map<string, Item[]>()
    for (const it of items ?? []) {
      const arr = map.get(it.template) ?? []
      arr.push(it)
      map.set(it.template, arr)
    }
    return Array.from(map.entries()).map(([template, entries]) => ({
      template,
      entries: entries.slice().sort((a, b) => a.cron.localeCompare(b.cron)),
    }))
  }, [items])

  const runOne = async (template: string, cron: string) => {
    const key = `${template}::${cron}`
    setRunning(key)
    try {
      await api.accountRunScheduledTemplate(template, cron)
      await refresh()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setRunning(null)
    }
  }

  const totalFires = items?.length ?? 0

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden"
      style={{ background: 'var(--surface-3)' }}
    >
      <header
        className="h-11 px-3 flex items-center gap-2 border-b border-app shrink-0"
        style={{ background: 'var(--surface-2)' }}
      >
        <button
          className="btn-ghost h-7 w-7 px-0 shrink-0"
          onClick={() => navigate('/')}
          title="Back to vault"
          aria-label="Back to vault"
        >
          <ArrowLeft size={14} />
        </button>
        <CalendarClock size={13} className="text-accent shrink-0" />
        <div className="text-[13.5px] font-semibold text-fg">
          Scheduled templates
        </div>
        {totalFires > 0 && (
          <span className="text-[11.5px] text-subtle ml-1.5">
            {totalFires} {totalFires === 1 ? 'fire' : 'fires'}
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1080px] mx-auto px-8 py-6 space-y-10">
          {err && (
            <div
              className="px-3 py-2 rounded text-[12.5px] inline-flex items-start gap-2"
              style={{
                background: 'var(--danger-bg)',
                color: 'var(--danger-fg)',
                border:
                  '1px solid color-mix(in srgb, var(--danger-fg) 25%, transparent)',
              }}
            >
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>{err}</span>
            </div>
          )}

          {parseErrors.length > 0 && (
            <section className="space-y-2">
              <div
                className="text-[14px] font-semibold pb-2"
                style={{
                  borderBottom: '1px solid var(--border)',
                  color: 'var(--danger-fg)',
                }}
              >
                Templates with invalid YAML
              </div>
              <div className="space-y-1.5">
                {parseErrors.map((e) => (
                  <div
                    key={`${e.owner}::${e.template}`}
                    className="rounded-md px-3 py-2"
                    style={{
                      background: 'var(--danger-bg)',
                      border:
                        '1px solid color-mix(in srgb, var(--danger-fg) 25%, transparent)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <AlertCircle
                        size={12}
                        className="shrink-0"
                        style={{ color: 'var(--danger-fg)' }}
                      />
                      <button
                        className="text-[13px] font-medium text-left hover:underline truncate"
                        style={{ color: 'var(--danger-fg)' }}
                        onClick={() => navigate(`/${e.template}`)}
                        title={`Open ${e.template}`}
                      >
                        {e.template}
                      </button>
                    </div>
                    <div
                      className="text-[11.5px] mt-1 ml-5"
                      style={{ color: 'var(--danger-fg)' }}
                    >
                      {e.error}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {items === null ? (
            <div className="text-[12.5px] text-subtle inline-flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" />
              Loading…
            </div>
          ) : grouped.length === 0 ? (
            <SettingsListEmpty
              title="No scheduled templates"
              hint={
                <>
                  Add <code>schedule: &quot;0 6 * * *&quot;</code> (or a{' '}
                  <code>schedules:</code> array) to the frontmatter of any
                  file under <code>_templates/</code> and it shows up here
                  within a minute.
                </>
              }
            />
          ) : (
            grouped.map(({ template, entries }) => (
              <Section
                key={template}
                title={template}
                onTitleClick={() => navigate(`/${template}`)}
                count={entries.length}
              >
                <SettingsListCard>
                  {entries.map((it) => {
                    const key = `${template}::${it.cron}`
                    const isRunning = running === key
                    return (
                      <SettingsListRow
                        key={key}
                        icon={
                          <CalendarClock size={14} className="text-subtle" />
                        }
                        title={it.label ?? it.cron}
                        meta={
                          <>
                            <span>{it.cron}</span>
                            {Object.entries(it.vars).map(([k, v]) => (
                              <span key={k}>
                                <MetaDot />
                                {k}={v}
                              </span>
                            ))}
                            <MetaDot />
                            <span>
                              next {fmtTimestamp(it.nextFireAt)}
                              {it.nextFireAt
                                ? ` · ${relativeFromNow(it.nextFireAt)}`
                                : ''}
                            </span>
                            <MetaDot />
                            <span>last {fmtTimestamp(it.lastFiredAt)}</span>
                            {it.lastError && (
                              <span style={{ color: 'var(--danger-fg)' }}>
                                <MetaDot />
                                error: {it.lastError}
                              </span>
                            )}
                          </>
                        }
                        actions={
                          <button
                            className="btn-ghost"
                            onClick={() => runOne(template, it.cron)}
                            disabled={isRunning}
                            title="Fire this schedule once now"
                          >
                            {isRunning ? (
                              <>
                                <Loader2 size={12} className="animate-spin" />
                                Running
                              </>
                            ) : (
                              <>
                                <Play size={12} />
                                Run now
                              </>
                            )}
                          </button>
                        }
                      />
                    )
                  })}
                </SettingsListCard>
              </Section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  count,
  onTitleClick,
  children,
}: {
  title: string
  count?: number
  onTitleClick?: () => void
  children: ReactNode
}) {
  return (
    <section className="space-y-4">
      <div
        className="text-[14px] font-semibold text-fg pb-2 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {onTitleClick ? (
          <button
            className="hover:underline text-left"
            onClick={onTitleClick}
            title={`Open ${title}`}
          >
            {title}
          </button>
        ) : (
          <span>{title}</span>
        )}
        {count != null && count > 0 && (
          <span className="text-[11.5px] text-subtle font-normal">
            · {count} {count === 1 ? 'fire' : 'fires'}
          </span>
        )}
      </div>
      <div className="pl-0.5">{children}</div>
    </section>
  )
}
