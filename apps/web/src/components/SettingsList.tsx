import type { ReactNode } from 'react'

/**
 * Shared visual atoms for the "list of items" surfaces in
 * Settings — API tokens, Connected apps, Webhooks (user + admin),
 * OAuth clients. The Trash page set the pattern (rounded viewer-
 * surface card, divide-y rows, two-line entry: bold title + dot-
 * separated subtle meta, inline action buttons on the right).
 * Pulling it into a tiny shared atom keeps every Settings list
 * reading the same way — and any future tweak applies in one place
 * instead of hunting through six components.
 *
 * Intentionally minimal API. Each row is composed from primitives
 * the caller controls (icon, title, meta, actions) so the existing
 * per-page formatting logic stays in place — this only owns the
 * wrapper chrome + row layout.
 */

export function SettingsListCard({ children }: { children: ReactNode }) {
  // Bordered card on the surface-3 page body. The viewer surface
  // gives most of the framing, the 1px border tightens the edge
  // without reading as a hard saturated line — works in both
  // themes now that the body sits a tier below the card.
  return (
    <div
      className="rounded-md overflow-hidden settings-list-card"
      style={{
        background: 'var(--viewer)',
        border: '1px solid var(--border)',
      }}
    >
      {children}
    </div>
  )
}

export function SettingsListEmpty({
  title,
  hint,
}: {
  title: string
  hint: ReactNode
}) {
  return (
    <div
      className="rounded-md p-8 text-center"
      style={{ background: 'var(--viewer)', border: '1px dashed var(--border)' }}
    >
      <div className="text-[14px] text-fg font-medium">{title}</div>
      <div className="text-[12px] text-subtle mt-1.5">{hint}</div>
    </div>
  )
}

export function SettingsListRow({
  icon,
  title,
  meta,
  actions,
}: {
  icon?: ReactNode
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      {icon && <div className="shrink-0">{icon}</div>}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-fg truncate">{title}</div>
        {meta && <div className="text-[11.5px] text-subtle truncate mt-0.5">{meta}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

/** Dot separator used inside meta lines. Centralised so the colour
 *  and spacing are pinned in one place. */
export function MetaDot() {
  return <span className="mx-1.5 opacity-60">·</span>
}
