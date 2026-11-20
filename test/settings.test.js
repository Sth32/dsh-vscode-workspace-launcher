import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const code = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

test('search depth Settings sits on the official bundle page and updates only the profile value', async () => {
  const calls = []
  let snapshot = { status: 'loading', writable: true, value: undefined }
  let subscribeCaptured, slot, render
  const state = []
  let cursor
  const react = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useId: () => 'depth',
    useState(initial) {
      const i = cursor++
      if (!(i in state)) state[i] = initial
      return [state[i], value => { state[i] = value }]
    },
    useSyncExternalStore: (subscribe, read) => {
      subscribeCaptured = subscribe
      return read()
    },
  }
  const notify = () => {}
  const scope = {
    configForms: { get(id) {
      assert.equal(id, 'vscode-workspace-launcher')
      return {
        subscribe(listener) { assert.equal(listener, notify); return () => {} },
        getSnapshot: () => snapshot,
        async set(field, value) {
          calls.push([field, value])
          if (value === 8) return false
          snapshot = { ...snapshot, value: { searchDepth: value } }
          return true
        },
      }
    } },
    slots: {
      inject(name, init) { assert.equal(name, 'plugins.bundle.config'); init() },
      register(entry, component) { slot = entry; render = component },
    },
  }
  let module
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: value => { module = value } } } })
  module.factory(name => { assert.equal(name, 'react'); return react }).apply({
    effect: register => register(),
    locale: { register() {}, bind: () => label => label },
    contextMenus: { register() {} },
    inject(services, run) { assert.deepEqual([...services], ['slots', 'configForms']); run(scope) },
  })
  assert.equal(slot.key, 'dsh-vscode-workspace-launcher')
  const draw = () => { cursor = 0; return render({ t: key => key }) }
  const input = view => view.children[1].children[0]
  const button = view => view.children[1].children[1]
  const update = value => input(draw()).props.onChange({ currentTarget: { value } })
  const save = () => draw().props.onSubmit({ preventDefault() {} })
  assert.equal(draw().children[0], 'depthLoading')
  assert.equal(typeof subscribeCaptured(notify), 'function')
  snapshot = { status: 'ready', writable: true, value: { searchDepth: 2 } }
  assert.equal(input(draw()).props.value, '2')
  assert.equal(button(draw()).props.disabled, true)
  for (const invalid of ['', '9', '-1', '2.5', '2e0']) {
    update(invalid)
    assert.equal(input(draw()).props['aria-invalid'], true)
    assert.equal(button(draw()).props.disabled, true)
    await save()
  }
  assert.deepEqual(calls, [])
  update('0')
  assert.equal(button(draw()).props.disabled, false)
  await save()
  assert.equal(input(draw()).props.value, '0')
  assert.equal(draw().children.at(-1).children[0], 'depthSaved')
  update('8')
  await save()
  assert.equal(draw().children.at(-1).children[0], 'depthFailed')
  assert.equal(snapshot.value.searchDepth, 0)
  assert.deepEqual(calls, [['searchDepth', 0], ['searchDepth', 8]])
  snapshot = { ...snapshot, writable: false }
  assert.equal(input(draw()).props.disabled, true)
  await save()
  assert.equal(calls.length, 2)
})
