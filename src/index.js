import { randomUUID } from 'node:crypto'
import { discover, matchesIdentity, registeredRoot, verifyFile } from './workspaces.js'
import { launchVSCode, resolveVSCode } from './vscode.js'

export const name = 'vscode-workspace-launcher'
export const inject = ['connection', 'workspaceRegistry']
const routes = { list: '/api/vscode-workspace/list', open: '/api/vscode-workspace/open' }
const maxBody = 1024
const fileLifetime = 120_000
const maxListings = 16
const idPattern = /^[A-Za-z0-9_-]{1,128}$/
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

const result = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const failure = (status, code) => result(status, { code })

function loopback(request) {
  const host = request.headers.get('host')
  // HTTP bridge constructs Request at dsh.internal and copies physical Host.
  // The DSH connection has already authenticated the owner and checked Origin.
  let hostname
  try { hostname = host ? new URL('http://' + host).hostname : new URL(request.url).hostname }
  catch { return false }
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

async function parse(request, kind) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return
  const reader = request.body?.getReader()
  if (!reader) return
  try {
    let size = 0
    const chunks = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBody) {
        await reader.cancel()
        return
      }
      chunks.push(value)
    }
    const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) return
    if (!Object.keys(body).every(key => key === 'sessionId' || (kind === 'open' && key === 'fileId'))) return
    if (typeof body.sessionId !== 'string' || !idPattern.test(body.sessionId)) return
    if ('fileId' in body && (typeof body.fileId !== 'string' || !tokenPattern.test(body.fileId))) return
    return body
  } catch { return undefined }
  finally { reader.releaseLock() }
}

function trustedLaunchEnv(ctx) {
  const snapshot = ctx.get?.('launchEnvironment')
  if (!snapshot?.getFrom) return { ...process.env }
  const result = {}
  for (const name of Object.keys(process.env)) {
    const inherited = snapshot.getFrom(name, ['process'])
    if (inherited !== undefined) result[name] = inherited.value
  }
  return result
}

export function createHandlers({ registry, env, now = Date.now, resolveEditor = resolveVSCode, launch = launchVSCode }) {
  let inFlight = 0
  const listings = new Map()
  function prune() {
    for (const [key, value] of listings) if (value.expires <= now()) listings.delete(key)
  }
  const ssh = !!(env.SSH_CONNECTION || env.SSH_TTY)

  const handle = kind => async request => {
    if (ssh || !loopback(request)) return failure(403, 'local-host-required')
    if (inFlight >= 4) return failure(503, 'busy')
    inFlight++
    try {
      const body = await parse(request, kind)
      if (!body) return failure(400, 'invalid-request')
      const { sessionId, fileId } = body
      const root = await registeredRoot(registry, sessionId)
      if (!root) return failure(404, 'workspace-unavailable')
      const editor = await resolveEditor(root.canonical, env)
      if (!editor) return failure(503, 'vscode-unavailable')
      prune()
      if (kind === 'list') {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(1_500)])
        const { files, truncated } = await discover(root.canonical, signal)
        const after = await registeredRoot(registry, sessionId)
        if (!matchesIdentity(root, after) || root.id !== after?.id) return failure(409, 'workspace-unavailable')
        const tokens = new Map()
        const publicFiles = files.map(file => {
          const id = randomUUID()
          tokens.set(id, file)
          return { id, label: file.label }
        })
        // Independent concurrent menus for one Session may replace old offers.
        listings.delete(sessionId)
        if (listings.size >= maxListings) listings.delete(listings.keys().next().value)
        listings.set(sessionId, { root, tokens, expires: now() + fileLifetime })
        return result(200, { files: publicFiles, truncated, expiresInMs: fileLifetime })
      }
      let target = root.canonical
      if (fileId) {
        const listing = listings.get(sessionId)
        const file = listing?.tokens.get(fileId)
        if (!file || listing.root.id !== root.id || !matchesIdentity(listing.root, root)) {
          return failure(409, 'file-unavailable')
        }
        target = await verifyFile(root.canonical, file)
        if (!target) return failure(409, 'file-unavailable')
      }
      const after = await registeredRoot(registry, sessionId)
      if (!matchesIdentity(root, after) || root.id !== after?.id) return failure(409, 'workspace-unavailable')
      if (request.signal.aborted) return failure(409, 'launch-failed')
      try { await launch(editor, target, env) }
      catch { return failure(502, 'launch-failed') }
      return result(200, { opened: true })
    } catch { return failure(500, 'operation-failed') }
    finally { inFlight-- }
  }
  return { list: handle('list'), open: handle('open') }
}

export function apply(ctx) {
  const handlers = createHandlers({ registry: ctx.workspaceRegistry, env: trustedLaunchEnv(ctx) })
  for (const [kind, path] of Object.entries(routes)) {
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods: ['POST'], requestBody: 'buffered', fetch: handlers[kind],
    }), `vscode-workspace-launcher: ${kind}`)
  }
}
