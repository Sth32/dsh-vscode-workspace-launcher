import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const code = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const response = (json, ok = true) => ({ ok, json: async () => json })
const settle = () => new Promise(resolve => setImmediate(resolve))

function fixture(fetch, { local = true, timeout = AbortSignal.timeout } = {}) {
  let module
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load: input => { module = input } } }, fetch,
    AbortController, AbortSignal: { any: AbortSignal.any, timeout },
  })
  const notices = [], dictionaries = {}
  const locale = {
    register: (_ns, dictionary) => Object.assign(dictionaries, dictionary),
    bind: () => key => dictionaries.en[key],
    subscribe: () => () => {},
  }
  let action
  const effects = []
  let unregistered = false
  module.factory().apply({
    effect: fn => effects.push(fn()), locale, connection: { isLoopback: local },
    contextMenus: {
      register: value => { action = value; return () => { unregistered = true } },
      notify: value => notices.push(value),
    },
  })
  const openMenu = (sessionId = 'session-a') => {
    const target = { sessionId }
    let prep, actions, updates = 0, closed = false
    // Mirror actual rc.5 order: subscribe first, then resolve; every update
    // aborts the prior preparation even when the menu is still open.
    const prepare = () => {
      assert.equal(closed, false, 'late response must not re-render a closed menu')
      prep?.abort()
      prep = new AbortController()
      actions = action.resolve(target, prep.signal)
      assert.equal(Array.isArray(actions), true, 'do not consume native 1000ms resolver budget')
      updates++
    }
    const dispose = action.observe(target).map(source => source.subscribe(prepare))
    prepare()
    return {
      parent: () => actions[0], updates: () => updates,
      close() { closed = true; prep.abort(); for (const drop of dispose) drop() },
    }
  }
  return { action, dictionaries, notices, locale, openMenu, unregister: () => effects.at(-1)(), disposed: () => unregistered }
}

test('native 510 contribution immediately renders folder plus scanning, even past 1s, then refreshes stable flyout', async () => {
  let requested
  let finish
  const f = fixture((_route, options) => {
    requested = options.signal
    return new Promise(resolve => { finish = resolve })
  })
  assert.equal(f.action.target, 'sessionHeader')
  assert.equal(f.action.order, 510)
  assert.equal(f.action.observe({ sessionId: 'session-a' })[0], f.locale)
  assert.equal(f.dictionaries.zh.open, '打开 VS Code 工作区')
  const menu = f.openMenu()
  const before = menu.parent()
  assert.equal(before.label, 'Open VS Code Workspace')
  assert.equal(before.run, undefined)
  assert.equal(before.children[0].label, 'Open current workspace folder')
  assert.equal(typeof before.children[0].run, 'function')
  assert.equal(before.children[1].label, 'Scanning…')
  assert.equal(before.children[1].disabled, true)
  await wait(1050)
  assert.equal(requested.aborted, false)
  finish(response({ files: [{ id: 'opaque-a', label: 'nested/file.code-workspace' }] }))
  await settle()
  const after = menu.parent()
  assert.equal(menu.updates(), 2)
  assert.equal(after.id, before.id)
  assert.equal(after.children[0].id, before.children[0].id)
  assert.equal(after.children[1].label, 'nested/file.code-workspace')
  menu.close()
  f.unregister()
  assert.equal(f.disposed(), true)
})

test('captures session and sends only opaque IDs; native dismiss cancels scan but not selected open', async () => {
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
  const menu = f.openMenu()
  await settle()
  const parent = menu.parent()
  assert.equal(parent.children.length, 3)
  assert.equal(parent.children[1].label, 'nested/a.code-workspace')
  assert.equal(parent.children[1].separatorBefore, true)
  assert.equal(parent.children[2].label, 'Only some workspace files are shown')
  menu.close()
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

test('last observer cancels discovery; late response cannot leak into re-opened and switched sessions', async () => {
  const pending = []
  const f = fixture((_route, opts) => new Promise(resolve => {
    pending.push({ resolve, signal: opts.signal, id: JSON.parse(opts.body).sessionId })
  }))
  const first = f.openMenu(), parallel = f.openMenu()
  assert.equal(pending.length, 1, 'same Session shares one list and set of IDs')
  first.close()
  assert.equal(pending[0].signal.aborted, false)
  parallel.close()
  assert.equal(pending[0].signal.aborted, true)
  const again = f.openMenu(), switched = f.openMenu('session-b')
  assert.deepEqual(pending.map(x => x.id), ['session-a', 'session-a', 'session-b'])
  pending[0].resolve(response({ files: [{ id: 'stale', label: 'old.code-workspace' }] }))
  pending[1].resolve(response({ files: [{ id: 'fresh', label: 'new.code-workspace' }] }))
  pending[2].resolve(response({ files: [{ id: 'different', label: 'other.code-workspace' }] }))
  await settle()
  assert.equal(again.parent().children[1].id, 'vscodeWorkspace:file:fresh')
  assert.equal(switched.parent().children[1].id, 'vscodeWorkspace:file:different')
  assert.equal(first.updates(), 1)
  assert.equal(parallel.updates(), 1)
  again.close()
  switched.close()
})

test('localized refusal, no remote scan, clean empty, partial and timed out remain distinct', async () => {
  const f = fixture(async () => response({ code: 'file-unavailable', message: '/secret/file' }, false))
  const failed = f.openMenu()
  await settle()
  assert.equal(failed.parent().children[1].label, 'The workspace file has changed; reopen the menu')
  await failed.parent().children[0].run()
  assert.deepEqual(f.notices, ['The workspace file has changed; reopen the menu'])
  failed.close()
  assert.equal(fixture(() => { throw new Error('unexpected remote traffic') }, { local: false }).openMenu().parent(), undefined)

  for (const [payload, expected] of [
    [{ files: [] }, 'No workspace files found'],
    [{ files: [], truncated: true }, 'Scan incomplete; no workspace files found yet'],
  ]) {
    const menu = fixture(async () => response(payload)).openMenu()
    await settle()
    assert.equal(menu.parent().children[1].label, expected)
    menu.close()
  }

  const timeout = new AbortController()
  const delayed = fixture((_route, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason))
  }), { timeout(ms) { assert.equal(ms, 5000); return timeout.signal } }).openMenu()
  timeout.abort()
  await settle()
  assert.equal(delayed.parent().children[1].label, 'Scan incomplete; no workspace files found yet')
  assert.equal(typeof delayed.parent().children[0].run, 'function')
  delayed.close()
})
