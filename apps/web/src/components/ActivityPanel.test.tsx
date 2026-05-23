import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ActivityPanel } from './ActivityPanel'
import * as apiModule from '../lib/api'

type Entry = {
  ts: number
  actor: string
  action: string
  target?: string
  meta?: Record<string, unknown>
}

// We can't useFakeTimers here — @testing-library/react's `waitFor`
// polls via setTimeout, and a frozen clock would make it never
// resolve. Instead, anchor test data to real `Date.now()` so the
// "Today" label is deterministic regardless of when the suite runs.
const baseTs = Date.now()

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function stubFileActivity(entries: Entry[]) {
  return vi
    .spyOn(apiModule.api, 'fileActivity')
    .mockResolvedValue({ entries })
}

describe('<ActivityPanel />', () => {
  it('renders a loading indicator before the fetch resolves', async () => {
    // Resolve far in the future so we can see the loading state.
    vi.spyOn(apiModule.api, 'fileActivity').mockReturnValue(
      new Promise(() => {}) as unknown as ReturnType<typeof apiModule.api.fileActivity>,
    )
    render(<ActivityPanel path="doc.md" />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('renders the empty-state when there are no audit entries', async () => {
    stubFileActivity([])
    render(<ActivityPanel path="doc.md" />)
    await waitFor(() =>
      expect(
        screen.getByText(/no recorded activity for this file yet/i),
      ).toBeInTheDocument(),
    )
  })

  it('renders the empty-state with folder wording when kind="folder"', async () => {
    stubFileActivity([])
    vi.spyOn(apiModule.api, 'folderActivity').mockResolvedValue({ entries: [] })
    render(<ActivityPanel path="folder/" kind="folder" />)
    await waitFor(() =>
      expect(
        screen.getByText(/no recorded activity for this folder yet/i),
      ).toBeInTheDocument(),
    )
  })

  it('renders an entry with actor + verb + clock time', async () => {
    stubFileActivity([
      {
        ts: baseTs,
        actor: 'alice',
        action: 'vault.upload',
        target: 'doc.md',
        meta: { bytes: 2048 },
      },
    ])
    render(<ActivityPanel path="doc.md" />)
    await waitFor(() => expect(screen.getByText(/alice/)).toBeInTheDocument())
    expect(screen.getByText(/uploaded this/)).toBeInTheDocument()
    // formatBytes(2048) → "2.0 KB"; rendered as the detail row.
    expect(screen.getByText(/2\.0\s*KB/i)).toBeInTheDocument()
  })

  it('coalesces rapid same-actor-same-action events into one row with ×N', async () => {
    // Three visibility toggles within 30s — the dedup window for
    // "noisy" actions is 60 min, so they collapse into one row.
    stubFileActivity([
      { ts: baseTs + 20_000, actor: 'alice', action: 'vault.visibility', target: 'doc.md', meta: { public: false } },
      { ts: baseTs + 10_000, actor: 'alice', action: 'vault.visibility', target: 'doc.md', meta: { public: true } },
      { ts: baseTs,          actor: 'alice', action: 'vault.visibility', target: 'doc.md', meta: { public: false } },
    ])
    render(<ActivityPanel path="doc.md" />)
    // Wait for entries to land, then assert there's only ONE row
    // even though there were three events.
    await waitFor(() => expect(screen.getByText(/×3/)).toBeInTheDocument())
    const verbRow = screen.getAllByText(/toggled visibility|made this/i)
    // Just one cluster, one row.
    expect(verbRow).toHaveLength(1)
  })

  it('drops the actor leadin for watcher-attributed external edits', async () => {
    stubFileActivity([
      {
        ts: baseTs,
        actor: 'system',
        action: 'vault.edit',
        target: 'doc.md',
        meta: { source: 'watcher' },
      },
    ])
    render(<ActivityPanel path="doc.md" />)
    await waitFor(() =>
      expect(
        screen.getByText(/edited on disk by an external tool/i),
      ).toBeInTheDocument(),
    )
    // No "system" leader text — the sentence stands on its own.
    expect(screen.queryByText(/^system$/i)).toBeNull()
    // Source pill: "disk".
    expect(screen.getByText(/^disk$/i)).toBeInTheDocument()
  })

  it('renders the Reader AI source pill on chat.apply_edit_op', async () => {
    stubFileActivity([
      {
        ts: baseTs,
        actor: 'alice',
        action: 'chat.apply_edit_op',
        target: 'doc.md',
        meta: { op: 'replace_section', opIndex: 0, messageId: 'm-1' },
      },
    ])
    render(<ActivityPanel path="doc.md" />)
    await waitFor(() =>
      expect(screen.getByText(/applied a Reader AI edit/i)).toBeInTheDocument(),
    )
    // The "Reader AI" string appears in both the verb text and
    // the source pill — getAllByText is the explicit choice.
    expect(screen.getAllByText(/Reader AI/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/replaced a section/i)).toBeInTheDocument()
  })

  it('filter chips narrow the visible rows', async () => {
    stubFileActivity([
      { ts: baseTs, actor: 'alice', action: 'vault.tags', target: 'doc.md', meta: { tags: ['urgent'] } },
      { ts: baseTs - 1000, actor: 'alice', action: 'vault.visibility', target: 'doc.md', meta: { public: true } },
      { ts: baseTs - 2000, actor: 'alice', action: 'vault.upload', target: 'doc.md', meta: { bytes: 100 } },
    ])
    render(<ActivityPanel path="doc.md" />)
    await waitFor(() => expect(screen.getByText(/made this public/i)).toBeInTheDocument())

    // Click "Visibility" filter — only the toggle row should remain.
    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole('button', { name: /^Visibility/ }))
    await waitFor(() =>
      expect(screen.queryByText(/uploaded this/i)).not.toBeInTheDocument(),
    )
    expect(screen.getByText(/made this public/i)).toBeInTheDocument()
    expect(screen.queryByText(/cleared all tags|tags/i)).not.toBeNull()
  })

  it('surfaces the friendly day header (Today)', async () => {
    stubFileActivity([
      { ts: baseTs + 50_000, actor: 'alice', action: 'vault.upload', target: 'doc.md' },
    ])
    render(<ActivityPanel path="doc.md" />)
    await waitFor(() => expect(screen.getByText(/^Today /)).toBeInTheDocument())
  })

  it('shows the API error in a danger alert', async () => {
    vi.spyOn(apiModule.api, 'fileActivity').mockRejectedValue(
      new Error('boom'),
    )
    render(<ActivityPanel path="doc.md" />)
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument())
  })
})
