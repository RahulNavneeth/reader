export type TreeNode = {
  name: string
  path: string
  type: 'dir' | 'file'
  ext?: string
  size?: number
  mtime?: number
  hasChildren?: boolean
}

export type SearchHit = {
  path: string
  name: string
  matches: Array<{ line: number; text: string }>
}

export type Heading = {
  level: number
  text: string
  id: string
}
