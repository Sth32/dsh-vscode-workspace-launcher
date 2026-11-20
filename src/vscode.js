import { spawn } from 'node:child_process'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

export function inside(root, target) {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

export async function resolveVSCode(root, env, platform = process.platform) {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir))
  const candidate = (parent, ...parts) => path.isAbsolute(parent ?? '') ? path.join(parent, ...parts) : undefined
  // Windows' code.cmd is deliberately not executed; .cmd requires a shell.
  const candidates = platform === 'win32' ? [
    candidate(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    candidate(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    candidate(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
    ...dirs.map(dir => path.join(dir, 'Code.exe')),
  ] : [
    ...(platform === 'darwin' ? [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      candidate(env.HOME, 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'),
    ] : []),
    ...dirs.map(dir => path.join(dir, 'code')),
  ]
  for (const file of candidates) {
    if (!file || inside(root, file)) continue
    try {
      const exe = await realpath(file)
      if (inside(root, exe) || !(await stat(exe)).isFile()) continue
      await access(exe, constants.X_OK)
      return exe
    } catch { /* not installed here */ }
  }
  return undefined
}

export function launchVSCode(executable, target, env, spawnProcess = spawn) {
  // Detached, no shell, a single absolute path argument; inherited cwd is not
  // switched to the workspace. Don't inherit the Electron Host's Node mode.
  const safeEnv = Object.fromEntries(Object.entries(env).filter(([name]) =>
    !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase())))
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, [target], {
      shell: false, detached: true, stdio: 'ignore', env: safeEnv, windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
