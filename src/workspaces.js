import { lstat, opendir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { inside } from './vscode.js'

const suffix = '.code-workspace'
const excluded = new Set(['.git', 'node_modules'])

export const discoveryLimits = Object.freeze({ entries: 4000, depth: 8, files: 100 })

async function identify(file, kind) {
  const info = await lstat(file, { bigint: true })
  if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) return
  const canonical = await realpath(file)
  const after = await lstat(file, { bigint: true })
  if (after.isSymbolicLink() || info.dev !== after.dev || info.ino !== after.ino) return
  return { canonical, device: info.dev, inode: info.ino }
}

export function matchesIdentity(a, b) {
  return !!a && !!b && a.canonical === b.canonical && a.device === b.device && a.inode === b.inode
}

export async function registeredRoot(registry, sessionId) {
  const bound = registry.list().filter(item => item.sessionIds.includes(sessionId))
  if (bound.length !== 1) return
  const { id, path: root } = bound[0]
  if (!path.isAbsolute(root ?? '')) return
  try {
    const identity = await identify(root, 'directory')
    if (identity) return { id, ...identity }
  } catch { /* stale or missing registered directory */ }
}

async function identifyWorkspaceFile(root, parts) {
  try {
    let current = root
    for (const part of parts.slice(0, -1)) {
      const next = await identify(path.join(current, part), 'directory')
      if (!next || !inside(root, next.canonical) || path.relative(current, next.canonical) !== part) return
      current = next.canonical
    }
    const leaf = parts.at(-1)
    const file = await identify(path.join(current, leaf), 'file')
    if (!file || !inside(root, file.canonical) || path.relative(current, file.canonical) !== leaf) return
    return file
  } catch { /* disappeared or permission changed */ }
}

export async function discover(root, signal, limits = discoveryLimits) {
  let entries = 0
  let truncated = false
  const files = []
  // Finish the root, then its immediate children, before visiting any
  // deeper directory. A large early subtree must not spend the shared budget
  // before a later shallow workspace file has even been considered.
  const queue = [[]]
  scan: for (let i = 0; i < queue.length; i++) {
    if (signal?.aborted || entries >= limits.entries || files.length >= limits.files) {
      truncated = true
      break
    }
    const parts = queue[i]
    const dir = path.join(root, ...parts)
    let handle
    try {
      // Dirent types are hints. Recheck the path and canonical containment
      // when dequeuing; a queued path may have been replaced in the meantime.
      const item = await identify(dir, 'directory')
      if (!item || !inside(root, item.canonical) || item.canonical !== dir) {
        truncated = true
        continue
      }
      handle = await opendir(dir)
    } catch {
      truncated = true
      continue
    }
    try {
      for await (const entry of handle) {
        if (signal?.aborted || ++entries > limits.entries || files.length >= limits.files) {
          truncated = true
          break scan
        }
        if (entry.isSymbolicLink() || excluded.has(entry.name.toLowerCase())) continue
        const next = [...parts, entry.name]
        if (entry.isDirectory()) {
          // Preference depth defines scope, not an incomplete scan.
          if (parts.length < limits.depth) queue.push(next)
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
          const identity = await identifyWorkspaceFile(root, next)
          if (identity) files.push({ parts: next, label: next.join('/'), identity })
          else truncated = true
        }
      }
    } catch { truncated = true }
  }
  files.sort((a, b) => a.label.localeCompare(b.label))
  return { files, truncated }
}

export async function verifyFile(root, candidate) {
  const actual = await identifyWorkspaceFile(root, candidate.parts)
  return matchesIdentity(actual, candidate.identity) ? actual.canonical : undefined
}
