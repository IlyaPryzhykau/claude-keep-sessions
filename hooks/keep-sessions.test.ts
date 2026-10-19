import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { planSync } from './plan'

const A = { account: 'acc-a', org: 'org-a' }
const B = { account: 'acc-b', org: 'org-b' }

test('planSync copies missing pointers and skips existing, deleted and duplicates', () => {
  const target = { id: A, names: ['local_1.json', 'deleted_2', 'backlog', 'scheduled-tasks.json'] }
  const sources = [
    { id: B, names: ['local_1.json', 'local_2.json', 'local_3.json', 'local_4.json', 'deleted_4'] },
    { id: { account: 'acc-c', org: 'org-c' }, names: ['local_3.json', 'local_5.json', 'notes.txt'] },
  ]
  const plan = planSync(target, sources)
  expect(plan.copies).toEqual([
    { from: B, name: 'local_3.json' },
    { from: { account: 'acc-c', org: 'org-c' }, name: 'local_5.json' },
  ])
  expect(plan.skippedExisting).toBe(2)
  expect(plan.skippedDeleted).toBe(2)
})

test('planSync ignores a source that is the target itself', () => {
  const plan = planSync({ id: A, names: [] }, [{ id: A, names: ['local_9.json'] }])
  expect(plan.copies).toEqual([])
})

// ---- an in-memory file system beneath the plugin ----

const HOME = '/Users/test'
const ROOT = `${HOME}/Library/Application Support/Claude/claude-code-sessions`

type Tree = Record<string, Record<string, string>>

function fakeFs(on: On, tree: Tree) {
  const writes: Record<string, string> = {}
  const dirs = new Set<string>()
  for (const path of Object.keys(tree)) {
    let current = path
    while (current.includes('/')) {
      dirs.add(current)
      current = current.slice(0, current.lastIndexOf('/'))
    }
  }
  const split = (path: string) => {
    const cut = path.lastIndexOf('/')
    return { dir: path.slice(0, cut), name: path.slice(cut + 1) }
  }
  const fileAt = (path: string): string | undefined => {
    const { dir, name } = split(path)
    return writes[path] ?? tree[dir]?.[name]
  }
  const childrenOf = (path: string) => {
    const kinds = new Map<string, 'file' | 'dir'>()
    const direct = (candidate: string) =>
      candidate.startsWith(`${path}/`) && !candidate.slice(path.length + 1).includes('/')
    for (const dir of dirs) if (direct(dir)) kinds.set(dir.slice(path.length + 1), 'dir')
    for (const name of Object.keys(tree[path] ?? {})) kinds.set(name, 'file')
    for (const written of Object.keys(writes)) {
      if (direct(written)) kinds.set(written.slice(path.length + 1), 'file')
    }
    return [...kinds].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
  }

  on('fs.exists', (_, e) => ({ value: fileAt(e.path) !== undefined || dirs.has(e.path) }))
  on('fs.list', (_, e) => {
    if (!dirs.has(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: childrenOf(e.path) }
  })
  on('fs.read', (_, e) => {
    const text = fileAt(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    writes[e.path] = e.text
    return { value: undefined }
  })
  return { writes }
}

function desktopEnv(on: On, id: { account: string; org: string }) {
  mock.env(on, {
    HOME,
    CLAUDE_CODE_ACCOUNT_UUID: id.account,
    CLAUDE_CODE_ORGANIZATION_UUID: id.org,
  })
}

function world(on: On) {
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  mock.clock(on, { now: Date.UTC(2026, 9, 19, 12, 0, 0) })
  return { toasts }
}

const START = { cwd: '/Users/test/project', surface: 'desktop' as const, isInteractive: true }
const typed = (args: string) => ({
  command: 'keep-sessions',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

test('session.start copies pointers from the other account, backs up, never overwrites', async ($, on) => {
  desktopEnv(on, A)
  const { toasts } = world(on)
  const { writes } = fakeFs(on, {
    [`${ROOT}/acc-a/org-a`]: { 'local_1.json': '{"a":1}', deleted_2: 'x', 'scheduled-tasks.json': '[]' },
    [`${ROOT}/acc-a/org-a/backlog`]: {},
    [`${ROOT}/acc-b/org-b`]: { 'local_1.json': 'OTHER', 'local_2.json': '{"b":2}', 'local_3.json': '{"b":3}' },
  })

  await $.session.start(START)

  expect(writes[`${ROOT}/acc-a/org-a/local_3.json`]).toBe('{"b":3}')
  expect(writes[`${ROOT}/acc-a/org-a/local_2.json`]).toBeUndefined()
  expect(writes[`${ROOT}/acc-a/org-a/local_1.json`]).toBeUndefined()
  const backups = Object.keys(writes).filter(p => p.includes('/.claude/keep-sessions-backup-'))
  expect(backups).toEqual([`${HOME}/.claude/keep-sessions-backup-2026-10-19T12-00-00-000Z/local_1.json`])
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Добавлено 1 чатов')
})

test('/keep-sessions status is a dry run and sync reports already synced', async ($, on) => {
  desktopEnv(on, A)
  world(on)
  const { writes } = fakeFs(on, {
    [`${ROOT}/acc-a/org-a`]: { 'local_1.json': '{}', 'local_2.json': '{}' },
    [`${ROOT}/acc-b/org-b`]: { 'local_2.json': '{}' },
  })

  await $.session.start(START)
  const status = await $.command.run(typed('status'))
  expect(status.text).toContain('Текущий аккаунт acc-a/org-a: 2 чатов')
  expect(status.text).toContain('Другой аккаунт acc-b/org-b: 1 чатов')
  expect(status.text).toContain('Будет добавлено: 0, уже есть: 1.')
  expect(Object.keys(writes)).toEqual([])

  const synced = await $.command.run(typed('sync'))
  expect(synced.text).toBe('Уже синхронизировано: добавлять нечего.')
})

test('outside the desktop app nothing is read or written', async ($, on) => {
  mock.env(on, { HOME })
  world(on)
  let listed = 0
  on('fs.list', () => {
    listed++
    return { value: [] }
  })
  on('fs.exists', () => ({ value: true }))

  await $.session.start(START)
  const status = await $.command.run(typed('status'))
  expect(status.text).toContain('не сессия десктоп-приложения')
  expect(listed).toBe(0)
})

test('a missing session-list folder for the current account does nothing', async ($, on) => {
  desktopEnv(on, { account: 'acc-new', org: 'org-new' })
  const { toasts } = world(on)
  const { writes } = fakeFs(on, {
    [`${ROOT}/acc-b/org-b`]: { 'local_2.json': '{}' },
  })

  await $.session.start(START)
  expect(Object.keys(writes)).toEqual([])
  expect(toasts).toEqual([])
})
