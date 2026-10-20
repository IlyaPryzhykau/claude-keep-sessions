import type { EngineInterface, Register } from 'claude-code'

import { countPointers, isPointer, planSync, sameFolder } from './plan'
import type { Folder, FolderId } from './plan'

const APP_SUPPORT = 'Library/Application Support'
const SESSIONS = 'claude-code-sessions'

/** The app data dir this session runs from (Claude, Claude-01, …), read from the CLI path. */
const currentAppDir = (execPath: string | undefined): string =>
  /\/Library\/Application Support\/([^/]+)\//.exec(execPath ?? '')?.[1] ?? 'Claude'

const isAppDir = (name: string): boolean => name === 'Claude' || name.startsWith('Claude-')

type Scan = {
  targetPath: string
  target: Folder
  others: Folder[]
}

const folderPath = (id: FolderId): string => `${id.root}/${id.account}/${id.org}`

const names = async ($: EngineInterface, path: string): Promise<string[]> =>
  (await $.fs.list(path)).map(entry => entry.name)

/**
 * Finds the current account's session-list folder and every other
 * account/org folder beside it. Undefined when this is not a desktop
 * session (no account variables) or the folder does not exist yet.
 */
async function scan($: EngineInterface): Promise<Scan | undefined> {
  const home = await $.env.get('HOME')
  const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const org = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')
  if (!home || !account || !org) return undefined

  const appSupport = `${home}/${APP_SUPPORT}`
  const roots: string[] = []
  for (const app of await $.fs.list(appSupport)) {
    if (app.kind !== 'dir' || !isAppDir(app.name)) continue
    const r = `${appSupport}/${app.name}/${SESSIONS}`
    if (await $.fs.exists(r)) roots.push(r)
  }

  // Prefer the app dir this session runs from; otherwise the first one holding this account.
  const preferred = `${appSupport}/${currentAppDir(await $.env.get('CLAUDE_CODE_EXECPATH'))}/${SESSIONS}`
  let root: string | undefined
  for (const r of [preferred, ...roots]) {
    if (await $.fs.exists(`${r}/${account}/${org}`)) {
      root = r
      break
    }
  }
  if (!root) return undefined
  const current: FolderId = { root, account, org }
  const targetPath = folderPath(current)

  const target: Folder = { id: current, names: await names($, targetPath) }
  const others: Folder[] = []
  for (const r of roots) {
    for (const acc of await $.fs.list(r)) {
      if (acc.kind !== 'dir') continue
      for (const o of await $.fs.list(`${r}/${acc.name}`)) {
        if (o.kind !== 'dir') continue
        const id: FolderId = { root: r, account: acc.name, org: o.name }
        if (sameFolder(id, current)) continue
        others.push({ id, names: await names($, folderPath(id)) })
      }
    }
  }
  return { targetPath, target, others }
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

const short = (id: FolderId): string => `${id.account.slice(0, 8)}/${id.org.slice(0, 8)}`

function statusText(found: Scan): string {
  const plan = planSync(found.target, found.others)
  const lines = [
    `Текущий аккаунт ${short(found.target.id)}: ${countPointers(found.target.names)} чатов в списке.`,
  ]
  for (const other of found.others) {
    lines.push(`Другой аккаунт ${short(other.id)}: ${countPointers(other.names)} чатов.`)
  }
  if (found.others.length === 0) lines.push('Других аккаунтов на этом компьютере нет.')
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
  'keep-sessions: это не сессия десктоп-приложения (нет переменных аккаунта) или папка списка сессий ещё не создана.'

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
      if (!found) {
        const home = await $.env.get('HOME')
        const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
        const org = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')
        const exec = await $.env.get('CLAUDE_CODE_EXECPATH')
        const diag = [
          `HOME=${home ? 'ok' : 'нет'} ACCOUNT=${account ? account.slice(0, 8) : 'нет'} ORG=${org ? org.slice(0, 8) : 'нет'}`,
          `EXECPATH=${exec ?? 'нет'} → ${currentAppDir(exec)}`,
        ]
        if (home && account && org) {
          const appSupport = `${home}/${APP_SUPPORT}`
          for (const app of await $.fs.list(appSupport)) {
            if (app.kind !== 'dir' || !isAppDir(app.name)) continue
            const dir = `${appSupport}/${app.name}/${SESSIONS}/${account}/${org}`
            diag.push(`${app.name}: ${(await $.fs.exists(dir)) ? 'есть' : 'нет'}`)
          }
        }
        return { text: `${NOT_DESKTOP}\n${diag.join('\n')}` }
      }
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
