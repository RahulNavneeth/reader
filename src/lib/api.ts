import type { TreeNode, SearchHit } from '../types'

async function jget<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

export const api = {
  home: () => jget<{ home: string; separator: string }>('/api/home'),
  list: (path: string, root: string) =>
    jget<{ path: string; items: TreeNode[] }>(
      `/api/list?path=${encodeURIComponent(path)}&root=${encodeURIComponent(root)}`,
    ),
  file: (path: string, root: string) =>
    jget<{ path: string; content: string; size: number; mtime: number }>(
      `/api/file?path=${encodeURIComponent(path)}&root=${encodeURIComponent(root)}`,
    ),
  search: (root: string, q: string) =>
    jget<{ results: SearchHit[] }>(
      `/api/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`,
    ),
  validate: (path: string) =>
    jget<{ exists: boolean; isDirectory?: boolean; path?: string }>(
      `/api/validate?path=${encodeURIComponent(path)}`,
    ),
}
