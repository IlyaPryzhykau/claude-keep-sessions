import type { EngineInterface, Register } from 'claude-code'

import { DATA_DIR, SESSIONS, countPointers, isPointer, pickTarget, planSync, rootOfExec, sameFolder } from './plan'
import type { Folder, FolderId } from './plan'

const APP_SUPPORT = 'Library/Application Support'

type Scan = {
  targetPath: string
  target: Folder
  others: Folder[]
}

const folderPath = (id: FolderId): string => `${id.root}/${id.account}/${id.org}`

const names = async ($: EngineInterface, path: string): Promise<string[]> =>
  (await $.fs.list(path)).map(entry => entry.name)

/** `<data dir>/claude-code-sessions` of every app instance on this Mac. */
async function sessionRoots($: EngineInterface, base: string): Promise<string[]> {
  if (!(await $.fs.exists(base))) return []
  const roots: string[] = []
  for (const entry of await $.fs.list(base)) {
    if (entry.kind !== 'dir' || !DATA_DIR.test(entry.name)) continue
    const root = `${base}/${entry.name}/${SESSIONS}`
    if (await $.fs.exists(root)) roots.push(root)
  }
  return roots
}

/**
 * Finds the current account's session-list folder and every other
 * account/org folder of every app instance. Undefined when this is not a
 * desktop session (no account variables) or the folder does not exist yet.
 */
async function scan($: EngineInterface): Promise<Scan | undefined> {
  const home = await $.env.get('HOME')
  const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const org = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')
  if (!home || !account || !org) return undefined

  const base = `${home}/${APP_SUPPORT}`
  const folders: Folder[] = []
  for (const root of await sessionRoots($, base)) {
    for (const acc of await $.fs.list(root)) {
      if (acc.kind !== 'dir') continue
      for (const o of await $.fs.list(`${root}/${acc.name}`)) {
        if (o.kind !== 'dir') continue
        const id: FolderId = { root, account: acc.name, org: o.name }
        folders.push({ id, names: await names($, folderPath(id)) })
      }
    }
  }

  const ownRoot = rootOfExec(await $.env.get('CLAUDE_CODE_EXECPATH'), base)
  const target = pickTarget(folders, { account, org }, ownRoot)
  if (!target) return undefined
  const others = folders.filter(f => !sameFolder(f.id, target.id))
  return { targetPath: folderPath(target.id), target, others }
}

type SyncOutcome = { copied: number; backupDir?: string }

/** Copies missing pointers into the current folder; never overwrites. */
async function sync($: EngineInterface, found: Scan): Promise<SyncOutcome> {
  const plan = planSync(found.target, found.others)
  if (plan.copies.length === 0) return { copied: 0 }

  const home = await $.env.get('HOME')
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  const backupDir = `${home}/.claude/keep-sessions-backup-${stamp}`
  let backedUp = 0
  for (const name of found.target.names.filter(isPointer)) {
    const text = await $.fs.read(`${found.targetPath}/${name}`)
    await $.fs.write(`${backupDir}/${name}`, text)
    backedUp++
  }

  let copied = 0
  for (const copy of plan.copies) {
    const destination = `${found.targetPath}/${copy.name}`
    if (await $.fs.exists(destination)) continue
    const text = await $.fs.read(`${folderPath(copy.from)}/${copy.name}`)
    await $.fs.write(destination, text)
    copied++
  }
  return backedUp > 0 ? { copied, backupDir } : { copied }
}

/** `Claude-acc2/1d471898/2f0388e2`: the instance's data dir, then account and org. */
const short = (id: FolderId): string => {
  const dir = id.root.split('/').slice(-2, -1)[0] ?? ''
  return `${dir}/${id.account.slice(0, 8)}/${id.org.slice(0, 8)}`
}

function statusText(found: Scan): string {
  const plan = planSync(found.target, found.others)
  const lines = [
    `Текущий аккаунт ${short(found.target.id)}: ${countPointers(found.target.names)} чатов в списке.`,
  ]
  for (const other of found.others) {
    lines.push(`Другая папка ${short(other.id)}: ${countPointers(other.names)} чатов.`)
  }
  if (found.others.length === 0) lines.push('Других аккаунтов и окон приложения на этом компьютере нет.')
  lines.push(
    `Будет добавлено: ${plan.copies.length}` +
      (plan.skippedExisting > 0 ? `, уже есть: ${plan.skippedExisting}` : '') +
      (plan.skippedDeleted > 0 ? `, удалённых пропущено: ${plan.skippedDeleted}` : '') +
      '.',
  )
  return lines.join('\n')
}

const RESTART_HINT =
  'Полностью перезапусти приложение (Cmd+Q и открыть снова), чтобы они появились в списке.'

const NOT_DESKTOP =
  'keep-sessions: это не сессия десктоп-приложения (нет переменных аккаунта), или папка списка сессий этого аккаунта ещё не создана, или их несколько и непонятно, какая у этого окна.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'keep-sessions',
      description: 'Вернуть в список чаты Code из других аккаунтов на этом компьютере',
      argumentHint: 'sync | status',
    })
    const started = await next(e)

    try {
      const found = await scan($)
      const copied = found ? (await sync($, found)).copied : 0
      if (copied > 0) {
        $.ui.toast(`Добавлено ${copied} чатов из других аккаунтов. ${RESTART_HINT}`, {
          timeoutMs: 15000,
        })
      }
    } catch (error) {
      $.ui.log(`keep-sessions: sync at start failed: ${String(error)}`, { to: 'debug' })
    }

    return started
  })

  on('command.run', { command: 'keep-sessions' }, async ($, e) => {
    const action = e.args.trim().toLowerCase() || 'status'
    if (action !== 'sync' && action !== 'status') {
      return { text: 'Использование: /keep-sessions status | /keep-sessions sync' }
    }
    try {
      const found = await scan($)
      if (!found) return { text: NOT_DESKTOP }
      if (action === 'status') return { text: statusText(found) }

      const { copied, backupDir } = await sync($, found)
      if (copied === 0) return { text: 'Уже синхронизировано: добавлять нечего.' }
      const backupLine = backupDir ? `\nРезервная копия прежнего списка: ${backupDir}` : ''
      return { text: `Добавлено ${copied} чатов. ${RESTART_HINT}${backupLine}` }
    } catch (error) {
      return { text: `keep-sessions: ошибка: ${String(error)}` }
    }
  })
}
