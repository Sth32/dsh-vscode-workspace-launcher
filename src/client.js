/** DSH's Module Loader supplies its own React and menu primitives. */
window.__ModuleLoader__.load({
  id: 'dsh-vscode-workspace-launcher',
  factory(require) {
    const React = require('react')
    const { MenuItemButton } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'vscodeWorkspaceLauncher'
    const dictionaries = {
      zh: { open: '打开 VS Code 工作区', files: '选择 VS Code 工作区文件', loading: '正在查找工作区文件…',
        empty: '没有找到工作区文件', truncated: '仅显示部分工作区文件', failed: '无法打开 VS Code 工作区',
        listFailed: '无法读取 VS Code 工作区文件', unavailable: '当前会话未关联可用的 DSH 工作区',
        vscode: '未找到可用的 VS Code', missing: '工作区文件已更改，请重新打开菜单' },
      en: { open: 'Open VS Code Workspace', files: 'Choose a VS Code workspace file', loading: 'Finding workspace files…',
        empty: 'No workspace files found', truncated: 'Only some workspace files are shown', failed: 'Could not open the VS Code workspace',
        listFailed: 'Could not list VS Code workspace files', unavailable: 'This session has no available DSH workspace',
        vscode: 'VS Code was not found', missing: 'The workspace file has changed; reopen the menu' },
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

    function SessionWorkspaceActions({ sessionId, dismiss, client, notify, t }) {
      const [disclosed, setDisclosed] = React.useState(false)
      const [listing, setListing] = React.useState(null)
      const disclosure = React.useId()
      const wrapper = React.useRef(null)
      const fileList = React.useRef(null)
      const focusPending = React.useRef(false)
      const launched = React.useRef(false)
      React.useEffect(() => {
        if (!disclosed || listing !== null) return
        const scope = new AbortController()
        client.list(sessionId, scope.signal).then(
          result => { if (!scope.signal.aborted) setListing(result) },
          error => { if (!scope.signal.aborted) setListing({ error: codeKeys[error?.code] || 'listFailed' }) },
        )
        return () => scope.abort()
      }, [disclosed, listing, client, sessionId])
      React.useEffect(() => {
        if (!disclosed || !focusPending.current) return
        const file = fileList.current?.querySelector('button')
        if (file) {
          focusPending.current = false
          file.focus()
        }
      }, [disclosed, listing])
      const reveal = (focus) => {
        if (focus) focusPending.current = true
        if (focus && disclosed) {
          const file = fileList.current?.querySelector('button')
          if (file) { focusPending.current = false; file.focus() }
        }
        setDisclosed(true)
      }
      const closeList = () => {
        focusPending.current = false
        setDisclosed(false)
        // Opaque handles expire and can be superseded by another listing.
        setListing(null)
      }
      const select = (fileId) => {
        if (launched.current) return
        launched.current = true
        dismiss()
        void client.open(sessionId, fileId).catch(error => notify(t(codeKeys[error?.code] || 'failed')))
      }
      const onKeyDown = event => {
        if (event.key === 'ArrowRight' && !fileList.current?.contains(event.target)) {
          event.preventDefault(); event.stopPropagation(); reveal(true)
        } else if (event.key === 'ArrowLeft' && disclosed) {
          event.preventDefault(); event.stopPropagation()
          wrapper.current?.querySelector('button[role="menuitem"]')?.focus()
          closeList()
        }
      }
      const extraStyle = { flex: 'none', cursor: 'pointer', color: 'inherit', background: 'none', border: 0,
        minWidth: 30, borderRadius: 6, fontSize: 15 }
      return h('div', {
        ref: wrapper, role: 'presentation', onKeyDown,
        onPointerEnter: event => { if (event.pointerType !== 'touch') reveal(false) },
        onPointerLeave: event => {
          if (event.pointerType !== 'touch' && !fileList.current?.contains(event.currentTarget.ownerDocument.activeElement)) closeList()
        },
        onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) closeList() },
      },
      h('div', { role: 'presentation', style: { display: 'flex', alignItems: 'stretch' } },
        h('div', { role: 'presentation', style: { flex: '1 1 auto', minWidth: 0 } },
          h(MenuItemButton, { onSelect: () => select(undefined) }, t('open'))),
        h('button', { type: 'button', role: 'menuitem', 'aria-label': t('files'),
          'aria-expanded': disclosed, 'aria-controls': disclosure, style: extraStyle,
          onClick: () => reveal(true) }, '›')),
      disclosed && h('div', {
        id: disclosure, ref: fileList, role: 'group', 'aria-label': t('files'),
        style: { marginInlineStart: 12, borderInlineStart: '1px solid var(--dsw-alias-border-l2, currentColor)' },
      },
      ...(listing?.files ?? []).map(({ id, label }) => h(MenuItemButton, { key: id, onSelect: () => select(id) },
        h('span', { title: label, style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label))),
      (!listing || listing.error || listing.files.length === 0 || listing.truncated) && h('div', {
        role: 'status', style: { fontSize: 12, padding: '4px 9px', color: 'var(--dsw-alias-label-tertiary, currentColor)' },
      }, t(!listing ? 'loading' : listing.error || (listing.files.length === 0 ? 'empty' : 'truncated')))))
    }

    function apply(ctx) {
      if (typeof MenuItemButton !== 'function') return
      const client = createClient((...args) => globalThis.fetch(...args))
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'VS Code workspace launcher: locale')
      ctx.slots.inject('contextMenu.content', () => ctx.slots.register({
        name: 'contextMenu.content', key: 'sessionHeader', locale: NS,
        inject: () => ({ client, canUseHost: ctx.connection.isLoopback, notify: text => ctx.contextMenus.notify(text) }),
      }, function SessionHeaderWorkspace({ target, dismiss, t, client, canUseHost, notify }) {
        const sessionId = target?.kind === 'sessionHeader' ? target.value?.sessionId : undefined
        if (!canUseHost || typeof sessionId !== 'string' || !sessionId) return null
        // Different target = different component lifetime, even under the same slot owner.
        return h(SessionWorkspaceActions, { key: sessionId, sessionId, dismiss, client, notify, t })
      }))
    }

    return { inject: ['slots', 'connection', 'locale', 'contextMenus'], apply }
  },
})
