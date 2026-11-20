import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const code = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const response = (json, ok = true) => ({ ok, json: async () => json })
const resolve = async (f, sessionId = 'session-a', scope = new AbortController()) =>
  f.action.resolve({ sessionId }, scope.signal)

function fixture(fetch, { local = true, signalApi = AbortSignal } = {}) {
  let module
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: input => { module = input } } }, fetch, AbortSignal: signalApi })
  const notices = [], dictionaries = {}
  const locale = {
    register: (_ns, dictionary) => Object.assign(dictionaries, dictionary),
    bind: () => key => dictionaries.en[key],
  }
  let action
  const effects = []
  let unregistered = false
  module.factory().apply({
    effect: fn => effects.push(fn()),
    locale, connection: { isLoopback: local },
    contextMenus: {
      register: value => { action = value; return () => { unregistered = true } },
      notify: value => notices.push(value),
    },
  })
  return { action, dictionaries, notices, locale, unregister: () => effects.at(-1)(), disposed: () => unregistered }
}

test('native contribution is 510, between Open in app and Feedback; native submenu owns hover and selection', async () => {
  const f = fixture(async () => response({ files: [] }))
  assert.equal(f.action.target, 'sessionHeader')
  assert.equal(f.action.order, 510)
  assert.equal(f.action.observe()[0], f.locale)
  assert.equal(f.dictionaries.zh.open, '打开 VS Code 工作区')
  const [parent] = await resolve(f)
  assert.equal(parent.label, 'Open VS Code Workspace')
  assert.equal(parent.run, undefined)
  assert.equal(parent.children[0].label, 'Open current workspace folder')
  assert.equal(parent.children[1].disabled, true)
  assert.equal(parent.children[1].label, 'No workspace files found')
  f.unregister()
  assert.equal(f.disposed(), true)
})

test('captures session, keeps relative labels, only sends opaque file IDs, and folder/file launch survives native dismiss', async () => {
  const requests = []
  const f = fixture(async (route, opts) => {
    requests.push([route, JSON.parse(opts.body), opts])
    if (route.endsWith('/list')) return response({ files: [
      { id: 'opaque-a', label: 'nested/a.code-workspace' },
      { id: 'opaque-a', label: 'duplicate ignored' },
      { id: null, label: 'invalid ignored' },
    ], truncated: true })
    return response({ opened: true })
  })
  const scope = new AbortController()
  const [parent] = await resolve(f, 'session-a', scope)
  assert.equal(parent.children.length, 3)
  assert.equal(parent.children[1].label, 'nested/a.code-workspace')
  assert.equal(parent.children[1].separatorBefore, true)
  assert.equal(parent.children[2].label, 'Only some workspace files are shown')
  scope.abort()
  await parent.children[0].run()
  await parent.children[1].run()
  assert.deepEqual(requests.map(([route, payload]) => [route, payload]), [
    ['/api/vscode-workspace/list', { sessionId: 'session-a' }],
    ['/api/vscode-workspace/open', { sessionId: 'session-a' }],
    ['/api/vscode-workspace/open', { sessionId: 'session-a', fileId: 'opaque-a' }],
  ])
  assert.equal(requests[0][2].credentials, 'same-origin')
  assert.equal(requests[0][2].signal.aborted, true)
  assert.equal(requests[1][2].signal, undefined)
})

test('dismiss aborts stale discovery and reopening gets fresh opaque IDs', async () => {
  let complete, signal, calls = 0
  const f = fixture((_route, opts) => {
    signal = opts.signal
    if (calls++ > 0) return Promise.resolve(response({ files: [{ id: 'fresh', label: 'new.code-workspace' }] }))
    return new Promise(resolve => { complete = resolve })
  })
  const scope = new AbortController()
  const first = resolve(f, 'session-a', scope)
  assert.equal(signal.aborted, false)
  scope.abort()
  complete(response({ files: [{ id: 'stale', label: 'old.code-workspace' }] }))
  assert.equal((await first).length, 0)
  const [current] = await resolve(f)
  assert.equal(current.children[1].id, 'vscodeWorkspace:file:fresh')
})

test('failure localized without host details; remote cannot see or use the action', async () => {
  const f = fixture(async (_route) => response({ code: 'file-unavailable', message: '/secret/file' }, false))
  const [parent] = await resolve(f)
  assert.equal(parent.children[1].label, 'The workspace file has changed; reopen the menu')
  await parent.children[0].run()
  assert.deepEqual(f.notices, ['The workspace file has changed; reopen the menu'])
  assert.equal((await resolve(fixture(() => { throw new Error('unexpected remote traffic') }, { local: false }))).length, 0)
})


test('native action survives local listing timeout and distinguishes incomplete zero-result scan', async () => {
  const timer = new AbortController()
  const f = fixture((_route, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  }), { signalApi: { any: AbortSignal.any.bind(AbortSignal), timeout(ms) {
    assert.equal(ms, 800)
    return timer.signal
  } } })
  const testMenu = resolve(f)
  timer.abort()
  const [menu] = await testMenu
  assert.equal(menu.children[0].label, 'Open current workspace folder')
  assert.equal(menu.children[1].label, 'Scan incomplete; no workspace files found yet')
  const [truncated] = await resolve(fixture(async () => response({ files: [], truncated: true })))
  assert.equal(truncated.children[1].label, 'Scan incomplete; no workspace files found yet')
})
