import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const code = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const next = () => new Promise(resolve => setImmediate(resolve))

function fixture(fetch, { local = true } = {}) {
  const effects = []
  const hooks = []
  let cursor = 0
  const react = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.filter(Boolean) } },
    useId: () => 'disclosure-id',
    useState(init) { const i = cursor++; hooks[i] ??= [init, nextValue => { hooks[i][0] = nextValue }]; return hooks[i] },
    useRef(init) { const i = cursor++; hooks[i] ??= { current: init }; return hooks[i] },
    useEffect(run, deps) {
      const i = cursor++
      const previous = hooks[i]
      if (!previous || previous.deps.some((value, index) => value !== deps[index])) {
        effects.push(() => { previous?.cleanup?.(); hooks[i] = { deps, cleanup: run() } })
      }
    },
  }
  let module
  const MenuItemButton = () => {}
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load: input => { module = input } } },
    fetch, AbortController,
  })
  const registrations = [], notices = [], localeNames = []
  let dismissed = 0
  module.factory(name => name === 'react' ? react : { MenuItemButton }).apply({
    effect: fn => fn(),
    locale: { register: (ns, dictionaries) => { localeNames.push([ns, dictionaries.zh.open, dictionaries.en.open]) } },
    slots: {
      inject: (_name, fn) => fn(),
      register: (slot, component) => registrations.push({ slot, component }),
    },
    connection: { isLoopback: local },
    contextMenus: { notify: message => notices.push(message) },
  })
  const { slot, component } = registrations[0]
  const openMenu = (sessionId, kind = 'sessionHeader') => component({
    ...slot.inject(), dismiss: () => { dismissed++ }, t: key => key, target: { kind, value: { sessionId } },
  })
  function draw(mount) {
    cursor = 0
    const tree = mount.type(mount.props)
    while (effects.length) effects.shift()()
    return tree
  }
  return { slot, openMenu, draw, notices, localeNames, dismissed: () => dismissed, unmount() {
    for (const hook of hooks) hook?.cleanup?.()
  } }
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined
  if (predicate(tree)) return tree
  for (const child of tree.children) {
    const entry = find(child, predicate)
    if (entry) return entry
  }
}
const response = (json, ok = true) => ({ ok, json: async () => json })
const press = (tree, key, flags) => tree.props.onKeyDown({
  key, target: {}, preventDefault: () => { flags.default++ }, stopPropagation: () => { flags.stop++ },
})

test('registered in stock sessionHeader menu content and does not modify native menu', () => {
  const f = fixture(() => { throw new Error('unexpected traffic') })
  assert.equal(f.slot.name, 'contextMenu.content')
  assert.equal(f.slot.key, 'sessionHeader')
  assert.deepEqual(f.localeNames[0].slice(1), ['打开 VS Code 工作区', 'Open VS Code Workspace'])
  assert.equal(f.openMenu('session-a', 'session'), null)
  assert.equal(f.openMenu(null), null)
  assert.equal(f.openMenu('session-a').props.key, 'session-a')
  assert.equal(f.openMenu('session-b').props.key, 'session-b')
  assert.equal(fixture(() => {}, { local: false }).openMenu('session-a'), null)
})

test('main row launches captured session root directly and dismisses once, even without hover', async () => {
  const requests = []
  const f = fixture(async (route, opts) => { requests.push([route, JSON.parse(opts.body)]); return response({ opened: true }) })
  const draw = f.draw(f.openMenu('session-a'))
  const main = find(draw, node => node.children[0] === 'open')
  main.props.onSelect()
  main.props.onSelect()
  assert.equal(f.dismissed(), 1)
  assert.deepEqual(requests, [['/api/vscode-workspace/open', { sessionId: 'session-a' }]])
  await next()
})

test('hover and keyboard disclosure show root-relative filenames; picking launches only opaque ID', async () => {
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
  const m = f.openMenu('session-a')
  const initial = f.draw(m)
  initial.props.onPointerEnter({ pointerType: 'touch' })
  assert.equal(requests.length, 0)
  const flags = { default: 0, stop: 0 }
  press(initial, 'ArrowRight', flags)
  const loading = f.draw(m)
  assert.deepEqual(flags, { default: 1, stop: 1 })
  assert.ok(find(loading, node => node.props.role === 'status' && node.children[0] === 'loading'))
  assert.equal(requests[0][2].credentials, 'same-origin')
  await next()
  const list = f.draw(m)
  assert.ok(find(list, node => node.props.role === 'status' && node.children[0] === 'truncated'))
  const file = find(list, node => node.children[0]?.props?.title === 'nested/a.code-workspace')
  assert.equal(file.props.key, 'opaque-a')
  assert.equal(find(list, node => node.children[0]?.props?.title === 'duplicate ignored'), undefined)
  file.props.onSelect()
  assert.equal(f.dismissed(), 1)
  assert.deepEqual(requests.map(([route, payload]) => [route, payload]), [
    ['/api/vscode-workspace/list', { sessionId: 'session-a' }],
    ['/api/vscode-workspace/open', { sessionId: 'session-a', fileId: 'opaque-a' }],
  ])
  await next()
})

test('menu unmount aborts captured list, and late response cannot populate closed menu', async () => {
  let complete, signal
  const f = fixture((_route, opts) => { signal = opts.signal; return new Promise(resolve => { complete = resolve }) })
  const m = f.openMenu('session-a')
  f.draw(m).props.onPointerEnter({ pointerType: 'mouse' })
  f.draw(m)
  assert.equal(signal.aborted, false)
  f.unmount()
  assert.equal(signal.aborted, true)
  complete(response({ files: [{ id: 'stale', label: 'stale.code-workspace' }] }))
  await next()
  assert.equal(find(f.draw(m), node => node.props.key === 'stale'), undefined)
})

test('failed launch uses localized notice without exposing host response', async () => {
  const f = fixture(async () => response({ code: 'file-unavailable', message: '/secret/file' }, false))
  find(f.draw(f.openMenu('session-a')), node => node.children[0] === 'open').props.onSelect()
  assert.equal(f.dismissed(), 1)
  await next()
  assert.deepEqual(f.notices, ['missing'])
})

test('leaving disclosure and hovering again makes fresh list and keeps previous handles out', async () => {
  let calls = 0
  const f = fixture(async () => response({ files: [{ id: 'opaque-' + (++calls), label: 'one.code-workspace' }] }))
  const m = f.openMenu('session-a')
  f.draw(m).props.onPointerEnter({ pointerType: 'mouse' })
  f.draw(m)
  await next()
  const first = f.draw(m)
  assert.ok(find(first, node => node.props.key === 'opaque-1'))
  first.props.onPointerLeave({ pointerType: 'mouse', currentTarget: { ownerDocument: { activeElement: null } } })
  const closed = f.draw(m)
  assert.equal(find(closed, node => node.props.key === 'opaque-1'), undefined)
  closed.props.onPointerEnter({ pointerType: 'mouse' })
  f.draw(m)
  await next()
  const reopened = f.draw(m)
  assert.ok(find(reopened, node => node.props.key === 'opaque-2'))
  assert.equal(find(reopened, node => node.props.key === 'opaque-1'), undefined)
})
