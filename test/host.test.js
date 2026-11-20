import { mkdtemp, mkdir, writeFile, symlink, rename, rm, chmod, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, createHandlers } from '../src/index.js'
import { discover } from '../src/workspaces.js'
import { launchVSCode, resolveVSCode } from '../src/vscode.js'

const fn = (kind, body, host = 'localhost:2345') => new Request('http://dsh.internal/api/vscode-workspace/' + kind, {
  method: 'POST', headers: { host, 'content-type': 'application/json' }, body: JSON.stringify(body),
})
async function fixture(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-vscode-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'workspace')
  const outside = path.join(dir, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const hits = []
  const registry = { values: [{ id: 'workspace-id', path: root, sessionIds: ['session-here', 'session-other'] }], list() { return this.values } }
  let now = 1000
  const handlers = createHandlers({ registry, env: {}, now: () => now, resolveEditor: async () => '/trusted/code',
    launch: async (editor, target) => { hits.push({ editor, target }) } })
  return { dir, root, outside, handlers, hits, registry, advance: () => { now += 120_001 } }
}
const call = async (handlers, kind, body, host) => {
  const response = await handlers[kind](fn(kind, body, host))
  return { status: response.status, body: await response.json() }
}

test('finds sorted real workspace files, skips symlinks and ignored directories, exposes only relative labels', async t => {
  const { root, outside, handlers } = await fixture(t)
  for (const name of ['nested', '.git', 'node_modules']) await mkdir(path.join(root, name))
  for (const name of ['z.code-workspace', 'nested/a.code-workspace', 'nested/not-workspace.txt', '.git/hidden.code-workspace',
    'node_modules/skip.code-workspace']) await writeFile(path.join(root, name), '{}')
  await writeFile(path.join(outside, 'escape.code-workspace'), '{}')
  if (process.platform !== 'win32') {
    await symlink(outside, path.join(root, 'linked-dir'))
    await symlink(path.join(outside, 'escape.code-workspace'), path.join(root, 'linked-file.code-workspace'))
  }
  const { status, body } = await call(handlers, 'list', { sessionId: 'session-here' })
  assert.equal(status, 200)
  assert.deepEqual(body.files.map(file => file.label), ['nested/a.code-workspace', 'z.code-workspace'])
  assert.equal(body.truncated, false)
  assert.ok(!JSON.stringify(body).includes(root))
})

test('opaque IDs are session-scoped, expire, and refuse replacement; parent targets registered root', async t => {
  const { root, handlers, hits, advance } = await fixture(t)
  const file = path.join(root, 'with space & code.code-workspace')
  await writeFile(file, '{}')
  const list = () => call(handlers, 'list', { sessionId: 'session-here' })
  const open = (sessionId, fileId) => call(handlers, 'open', fileId === undefined ? { sessionId } : { sessionId, fileId })
  const id = (await list()).body.files[0].id
  assert.deepEqual(await open('session-other', id), { status: 409, body: { code: 'file-unavailable' } })
  assert.deepEqual(await open('session-here', id), { status: 200, body: { opened: true } })
  assert.deepEqual(await open('session-here'), { status: 200, body: { opened: true } })
  assert.deepEqual(hits, [{ editor: '/trusted/code', target: file }, { editor: '/trusted/code', target: root }])
  await rename(file, path.join(root, 'old'))
  await writeFile(file, '{"replaced":true}')
  assert.equal((await open('session-here', id)).status, 409)
  const newId = (await list()).body.files[0].id
  advance()
  assert.equal((await open('session-here', newId)).status, 409)
  assert.equal(hits.length, 2)
})

test('denies raw paths, remote frontend, unknown session, ambiguous binding and local Host via SSH', async t => {
  const { handlers, registry, root, hits } = await fixture(t)
  assert.equal((await call(handlers, 'open', { sessionId: 'session-here', path: root })).status, 400)
  assert.equal((await call(handlers, 'open', { sessionId: 'session-here' }, 'https.rebound.test')).status, 403)
  assert.equal((await call(handlers, 'open', { sessionId: 'missing' })).status, 404)
  assert.equal((await call(handlers, 'open', { sessionId: 's'.repeat(1100) })).status, 400)
  const ssh = createHandlers({ registry, env: { SSH_TTY: '/dev/pts/1' } })
  assert.equal((await call(ssh, 'list', { sessionId: 'session-here' })).status, 403)
  registry.values.push({ id: 'other', path: root, sessionIds: ['session-here'] })
  assert.equal((await call(handlers, 'open', { sessionId: 'session-here' })).status, 404)
  assert.deepEqual(hits, [])
})

test('bounded discovery and abort do not yield unrestricted traversal', async t => {
  const { root } = await fixture(t)
  await mkdir(path.join(root, 'dir'))
  await writeFile(path.join(root, 'dir', 'deep.code-workspace'), '{}')
  await writeFile(path.join(root, 'one.code-workspace'), '{}')
  await writeFile(path.join(root, 'two.code-workspace'), '{}')
  const shallow = await discover(root, undefined, { entries: 20, depth: 0, files: 1 })
  assert.equal(shallow.truncated, true)
  assert.equal(shallow.files.length, 1)
  const stopped = await discover(root, AbortSignal.abort())
  assert.deepEqual(stopped, { files: [], truncated: true })
})

test('executable lookup refuses a workspace-local PATH and symlinked local binary', { skip: process.platform === 'win32' }, async t => {
  const { root, outside } = await fixture(t)
  const local = path.join(root, 'code')
  const wanted = path.join(outside, 'code')
  await writeFile(local, '#!/bin/sh\nexit 0\n')
  await chmod(local, 0o755)
  await symlink(local, wanted)
  assert.equal(await resolveVSCode(root, { PATH: [root, outside, '.'].join(path.delimiter) }, 'linux'), undefined)
  await rm(wanted)
  await writeFile(wanted, '#!/bin/sh\nexit 0\n')
  await chmod(wanted, 0o755)
  assert.equal(await resolveVSCode(root, { PATH: [root, outside].join(path.delimiter) }, 'linux'), wanted)
})

test('launch uses one literal argv path, never a shell, and drops Electron boot env', async () => {
  let captured
  let unref = false
  const stub = new EventEmitter()
  stub.unref = () => { unref = true }
  const env = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: 'bad' }
  const target = '/some folder/it;still & literal.code-workspace'
  const launch = launchVSCode('/absolute/code', target, env, (...args) => {
    captured = args
    queueMicrotask(() => stub.emit('spawn'))
    return stub
  })
  await launch
  assert.deepEqual(captured, ['/absolute/code', [target], {
    shell: false, detached: true, stdio: 'ignore', env: { PATH: '/usr/bin' }, windowsHide: true,
  }])
  assert.ok(unref)
})

test('mounts only exact POST owner Connection routes through lifecycle', () => {
  const routes = []
  apply({
    workspaceRegistry: { list: () => [] },
    connection: { fetch: { register: route => { routes.push(route); return () => {} } } },
    effect: fn => fn(),
  })
  assert.deepEqual(routes.map(({ path, methods, requestBody }) => ({ path, methods, requestBody })), [
    { path: '/api/vscode-workspace/list', methods: ['POST'], requestBody: 'buffered' },
    { path: '/api/vscode-workspace/open', methods: ['POST'], requestBody: 'buffered' },
  ])
})
