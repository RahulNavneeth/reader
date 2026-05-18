import { useEffect, useRef, useState } from 'react'
import { LogOut, Shield, User as UserIcon, Settings, Trash2, MapPin, Clock } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { PublicUser } from '../lib/api'

type Props = {
  user: PublicUser
  onLogout: () => void
}

export function UserMenu({ user, onLogout }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const isAdmin = user.role === 'admin'

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost" onClick={() => setOpen((o) => !o)} title={user.username}>
        <UserIcon size={14} />
        <span className="hidden sm:inline">{user.username}</span>
        {isAdmin && <Shield size={12} className="text-accent ml-0.5" />}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 min-w-[220px] rounded-md shadow-raised z-30 overflow-hidden"
          style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
        >
          <div
            className="px-3 py-2 border-b"
            style={{ borderColor: 'var(--border-soft)' }}
          >
            <div className="text-[13px] font-medium text-fg truncate">{user.username}</div>
            <div className="text-[11.5px] text-muted capitalize flex items-center gap-1">
              {isAdmin && <Shield size={10} />}
              {user.role}
            </div>
          </div>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              navigate('/account')
            }}
          >
            <UserIcon size={13} className="text-muted" />
            Account
          </button>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              navigate('/timeline')
            }}
          >
            <Clock size={13} className="text-muted" />
            Timeline
          </button>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              navigate('/map')
            }}
          >
            <MapPin size={13} className="text-muted" />
            Map
          </button>
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              navigate('/trash')
            }}
          >
            <Trash2 size={13} className="text-muted" />
            Trash
          </button>
          {isAdmin && (
            <button
              className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
              onClick={() => {
                setOpen(false)
                navigate('/settings')
              }}
            >
              <Settings size={13} className="text-muted" />
              Workspace settings
            </button>
          )}
          <button
            className="w-full text-left px-3 py-2 text-[13px] text-fg hover:bg-hover flex items-center gap-2 transition-colors"
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
          >
            <LogOut size={13} className="text-muted" />
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
