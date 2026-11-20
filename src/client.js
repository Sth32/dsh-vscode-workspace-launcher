/** Contribute data to DSH's native Session header menu. */
window.__ModuleLoader__.load({
  id: 'dsh-vscode-workspace-launcher',
  factory(require) {
    const NS = 'vscodeWorkspaceLauncher'
    // Menu resolution is synchronous; filesystem discovery has its own bounded
    // lifetime, owned by observers of the captured Session.
    const listTimeMs = 5000
    const dictionaries = {
      zh: { open: '打开 VS Code 工作区', folder: '打开当前工作区文件夹',
        scanning: '正在扫描…', empty: '没有找到工作区文件', truncated: '仅显示部分工作区文件', incomplete: '扫描未完成，暂未找到工作区文件', failed: '无法打开 VS Code 工作区',
        listFailed: '无法读取 VS Code 工作区文件', unavailable: '当前会话的工作目录不可用',
        vscode: '未找到可用的 VS Code', missing: '工作区文件已更改，请重新打开菜单',
        depth: '搜索深度', depthHint: '会话工作目录为 0；默认 2，搜索到第二级子目录。', depthSave: '保存',
        depthLoading: '正在读取设置…', depthUnavailable: '搜索深度设置不可用',
        depthInvalid: '请输入 0 到 8 的整数', depthFailed: '保存搜索深度失败', depthSaved: '搜索深度已保存' },
      en: { open: 'Open VS Code Workspace', folder: 'Open current workspace folder',
        scanning: 'Scanning…', empty: 'No workspace files found', truncated: 'Only some workspace files are shown', incomplete: 'Scan incomplete; no workspace files found yet', failed: 'Could not open the VS Code workspace',
        listFailed: 'Could not list VS Code workspace files', unavailable: 'The session working directory is unavailable',
        vscode: 'VS Code was not found', missing: 'The workspace file has changed; reopen the menu',
        depth: 'Search depth', depthHint: 'The session working directory is 0. Default 2 includes second-level folders.', depthSave: 'Save',
        depthLoading: 'Loading settings…', depthUnavailable: 'Search depth settings are unavailable',
        depthInvalid: 'Enter a whole number from 0 to 8', depthFailed: 'Could not save search depth', depthSaved: 'Search depth saved' },
    }
    const codeKeys = { 'workspace-unavailable': 'unavailable', 'vscode-unavailable': 'vscode', 'file-unavailable': 'missing' }
    function createClient(fetchRequest) {
      const request = async (action, payload, signal) => {
        const response = await fetchRequest('/api/vscode-workspace/' + action, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        })
        const reply = await response.json()
        if (!response.ok) throw Object.assign(new Error('Workspace request failed'), { code: reply?.code })
        return reply
      }
      return {
        async list(sessionId, signal) {
          const result = await request('list', { sessionId }, signal)
          const seen = new Set()
          const files = Array.isArray(result?.files) ? result.files.filter(item => {
            if (typeof item?.id !== 'string' || !item.id || typeof item.label !== 'string' || !item.label || seen.has(item.id)) return false
            seen.add(item.id)
            return true
          }).map(({ id, label }) => ({ id, label })) : []
          return { files, truncated: result?.truncated === true }
        },
        async open(sessionId, fileId) {
          const result = await request('open', fileId === undefined ? { sessionId } : { sessionId, fileId })
          if (result?.opened !== true) throw new Error('Workspace did not open')
        },
      }
    }

    function createDiscovery(client) {
      const active = new Map()
      const loading = { files: [], error: 'scanning' }

      // Expose the native ObservableSnapshot contract. Subscribing (not the
      // async result of resolve) owns the request, so a locale/results refresh
      // of the current menu does not cancel its discovery.
      function sourceFor(sessionId) {
        // A source is cheap and only gains a map entry once registered by
        // the menu occurrence. Concurrent menus for one Session share IDs.
        return {
          getSnapshot: () => active.get(sessionId)?.outcome ?? loading,
          subscribe(listener) {
            let entry = active.get(sessionId)
            if (entry === undefined) {
              const controller = new AbortController()
              entry = { controller, listeners: new Set(), outcome: loading }
              active.set(sessionId, entry)
              const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(listTimeMs)])
              const announce = outcome => {
                if (controller.signal.aborted || active.get(sessionId) !== entry) return
                entry.outcome = outcome
                for (const handle of [...entry.listeners]) handle.listener()
              }
              void client.list(sessionId, signal).then(
                outcome => announce(signal.aborted ? { files: [], error: 'incomplete' } : outcome),
                error => announce({ files: [], error: signal.aborted ? 'incomplete' : codeKeys[error?.code] || 'listFailed' }),
              )
            }
            const handle = { listener }
            entry.listeners.add(handle)
            return () => {
              if (!entry.listeners.delete(handle) || entry.listeners.size !== 0) return
              if (active.get(sessionId) === entry) active.delete(sessionId)
              entry.controller.abort()
            }
          },
        }
      }

      return { sourceFor, read: sessionId => active.get(sessionId)?.outcome ?? loading }
    }

    function registerDepthSettings(ctx) {
      // ConfigForm owns the profile value, validation fence and persistence.
      // Keep this optional so an alternate composition can still use the menu.
      ctx.inject?.(['slots', 'configForms'], scope => {
        const React = require('react')
        const h = React.createElement
        const form = scope.configForms.get('vscode-workspace-launcher')
        const watch = listener => form.subscribe(listener)
        const read = () => form.getSnapshot()
        function DepthSettings({ t }) {
          const snapshot = React.useSyncExternalStore(watch, read)
          const inputId = React.useId()
          const [draft, setDraft] = React.useState(null)
          const [saving, setSaving] = React.useState(false)
          const [notice, setNotice] = React.useState(null)
          if (snapshot.status !== 'ready') {
            return h('p', { role: 'status' }, t(snapshot.status === 'loading' ? 'depthLoading' : 'depthUnavailable'))
          }
          const accepted = snapshot.value?.searchDepth ?? 2
          const text = draft ?? String(accepted)
          const valid = /^[0-8]$/.test(text)
          const writable = snapshot.writable && !saving
          const save = async event => {
            event.preventDefault()
            if (!writable || !valid || Number(text) === accepted) return
            setSaving(true)
            setNotice(null)
            try {
              if (await form.set('searchDepth', Number(text))) {
                setDraft(null)
                setNotice('depthSaved')
              } else {
                setNotice('depthFailed')
              }
            } catch {
              setNotice('depthFailed')
            } finally {
              setSaving(false)
            }
          }
          return h('form', { onSubmit: save, style: { display: 'grid', justifyItems: 'start', gap: 8 } },
            h('label', { htmlFor: inputId }, t('depth')),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('input', { id: inputId, type: 'number', min: 0, max: 8, step: 1, inputMode: 'numeric',
                value: text, disabled: !writable, 'aria-describedby': inputId + '-hint', 'aria-invalid': !valid,
                style: { inlineSize: '5rem', font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: 6 },
                onChange: event => { setDraft(event.currentTarget.value); setNotice(null) } }),
              h('button', { type: 'submit', disabled: !writable || !valid || Number(text) === accepted }, t('depthSave'))),
            h('p', { id: inputId + '-hint', style: { margin: 0 } }, t('depthHint')),
            !valid && h('p', { role: 'alert', style: { margin: 0 } }, t('depthInvalid')),
            notice && h('p', { role: 'status', style: { margin: 0 } }, t(notice)))
        }
        scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
          name: 'plugins.bundle.config', key: 'dsh-vscode-workspace-launcher', locale: NS,
        }, DepthSettings))
      })
    }

    function apply(ctx) {
      const client = createClient((...args) => globalThis.fetch(...args))
      const discovery = createDiscovery(client)
      const available = sessionId => ctx.connection.isLoopback && typeof sessionId === 'string' && sessionId.length > 0
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'VS Code workspace launcher: locale')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.contextMenus.register({
        id: 'vscode-workspace-launcher.open', target: 'sessionHeader', order: 510,
        observe: ({ sessionId }) => available(sessionId) ? [ctx.locale, discovery.sourceFor(sessionId)] : [],
        resolve({ sessionId }, signal) {
          if (!available(sessionId) || signal.aborted) return []
          const outcome = discovery.read(sessionId)
          const launch = (id) => async () => {
            // The native registry closes and disposes resolution before running
            // a selected leaf: use a distinct request, not the listing signal.
            try {
              await client.open(sessionId, id)
            } catch (error) {
              ctx.contextMenus.notify(t(codeKeys[error?.code] || 'failed'))
            }
          }
          const status = outcome.error || (outcome.truncated ? (outcome.files.length ? 'truncated' : 'incomplete') : !outcome.files.length ? 'empty' : null)
          return [{
            id: 'vscodeWorkspace', label: t('open'),
            children: [
              { id: 'vscodeWorkspace:folder', label: t('folder'), run: launch() },
              ...outcome.files.map(({ id, label }, index) => ({
                id: 'vscodeWorkspace:file:' + id, label, separatorBefore: index === 0,
                run: launch(id),
              })),
              ...(status ? [{ id: 'vscodeWorkspace:status', label: t(status), disabled: true }] : []),
            ],
          }]
        },
      }), 'VS Code workspace launcher: native session-header action')
      registerDepthSettings(ctx)
    }

    return { inject: ['connection', 'locale', 'contextMenus'], apply }
  },
})
