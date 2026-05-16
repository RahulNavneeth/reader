import { Lock } from 'lucide-react'
import { api } from '../lib/api'
import { MakePublicPopover } from './MakePublicPopover'
import { RevokePublicPopover } from './RevokePublicPopover'

/**
 * Minimal shape the button needs to render. Both DocumentMeta (files) and
 * FolderMeta (folders) satisfy this — `publicPasswordHash` is a bool-ish on
 * folders since the server redacts the hash and reports `hasPassword`
 * instead.
 */
type PublicMetaShape = {
  public?: boolean
  publicExpiresAt?: number | null
  publicPasswordHash?: string | null
  hasPassword?: boolean
}

type Props = {
  path: string
  meta: PublicMetaShape
  /** `folder` flips the entire subtree (cascading) via /api/folder/visibility. */
  kind?: 'file' | 'folder'
  /** Override the trigger label. Defaults to the state-driven
   *  "Public" / "Private". */
  triggerLabel?: string
  /** Force the green/active styling even when meta.public is false (used
   *  when a folder isn't itself cascade-published but contains public
   *  items). */
  forceActiveStyle?: boolean
  onSaved: (next: PublicMetaShape) => void
}

/**
 * State-driven public-visibility control for a single file or folder.
 * Thin dispatcher over the two shared popover components so files and
 * folders use the same building blocks:
 *
 *   meta.public === true  → RevokePublicPopover (URL + Copy + Make Private)
 *   meta.public === false → MakePublicPopover  (expiry + password + Publish)
 *
 * Folder toolbars that need *both* buttons at once (e.g. mixed-state
 * folders) compose the underlying popovers directly instead of going
 * through this dispatcher.
 */
export function PublicButton({
  path,
  meta,
  kind = 'file',
  triggerLabel,
  forceActiveStyle,
  onSaved,
}: Props) {
  if (meta.public) {
    return (
      <RevokePublicPopover
        triggerLabel={triggerLabel ?? 'Public'}
        folderPublic={true}
        folderExpiresAt={meta.publicExpiresAt}
        folderHasPassword={!!meta.publicPasswordHash || !!meta.hasPassword}
        onRevoke={async () => {
          if (kind === 'folder') {
            await api.setFolderVisibility(path, false)
          } else {
            await api.setVisibility(path, false)
          }
          onSaved({
            public: false,
            publicExpiresAt: null,
            publicPasswordHash: null,
            hasPassword: false,
          })
        }}
      />
    )
  }
  return (
    <MakePublicPopover
      title="Public link"
      confirmLabel="Make public"
      onConfirm={async (opts) => {
        const saved =
          kind === 'folder'
            ? (await api.setFolderVisibility(path, true, opts)).folder
            : ((await api.setVisibility(path, true, opts)).document as PublicMetaShape)
        onSaved(saved)
      }}
      trigger={
        <button
          className="btn-ghost"
          title="Make public"
          style={forceActiveStyle ? { color: '#00875A' } : undefined}
        >
          <Lock size={13} />
          {triggerLabel ?? 'Private'}
        </button>
      }
    />
  )
}
