/** Contribute data to DSH's native Session header menu. */
window.__ModuleLoader__.load({
  id: 'dsh-vscode-workspace-launcher',
  factory(require) {
    const NS = 'vscodeWorkspaceLauncher'
    // Resolve before the native registry's 1000ms cutoff, keeping the folder
    // action available even when listing is slow or the workspace is offline.
    const listTimeMs = 800
    const dictionaries = {
      zh: { open: '打开 VS Code 工作区', folder: '打开当前工作区文件夹',
        empty: '没有找到工作区文件', truncated: '仅显示部分工作区文件', incomplete: '扫描未完成，暂未找到工作区文件', failed: '无法打开 VS Code 工作区',
        listFailed: '无法读取 VS Code 工作区文件', unavailable: '当前会话未关联可用的 DSH 工作区',
        vscode: '未找到可用的 VS Code', missing: '工作区文件已更改，请重新打开菜单',
        depth: '搜索深度', depthHint: '工作区根目录为 0；默认 2，搜索到第二级子目录。', depthSave: '保存',
        depthLoading: '正在读取设置…', depthUnavailable: '搜索深度设置不可用',
        depthInvalid: '请输入 0 到 8 的整数', depthFailed: '保存搜索深度失败', depthSaved: '搜索深度已保存' },
      en: { open: 'Open VS Code Workspace', folder: 'Open current workspace folder',
        empty: 'No workspace files found', truncated: 'Only some workspace files are shown', incomplete: 'Scan incomplete; no workspace files found yet', failed: 'Could not open the VS Code workspace',
        listFailed: 'Could not list VS Code workspace files', unavailable: 'This session has no available DSH workspace',
        vscode: 'VS Code was not found', missing: 'The workspace file has changed; reopen the menu',
        depth: 'Search depth', depthHint: 'The workspace root is 0. Default 2 includes second-level folders.', depthSave: 'Save',
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
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'VS Code workspace launcher: locale')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.contextMenus.register({
        id: 'vscode-workspace-launcher.open', target: 'sessionHeader', order: 510,
        observe: () => [ctx.locale],
        async resolve({ sessionId }, signal) {
          if (!ctx.connection.isLoopback || typeof sessionId !== 'string' || !sessionId || signal.aborted) return []
          let outcome
          const listSignal = AbortSignal.any([signal, AbortSignal.timeout(listTimeMs)])
          try {
            outcome = await client.list(sessionId, listSignal)
          } catch (error) {
            if (signal.aborted) return []
            outcome = { files: [], error: listSignal.aborted ? 'incomplete' : codeKeys[error?.code] || 'listFailed' }
          }
          if (signal.aborted) return []
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
