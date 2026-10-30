/**
 * Pure planning: which session pointer files to copy into the current
 * account's folder. No I/O here, so it is unit-tested directly.
 *
 * The desktop app keeps one folder per account and organization:
 *   <data dir>/claude-code-sessions/<accountUuid>/<orgUuid>/
 * holding `local_<id>.json` (one per session listed in the sidebar) and
 * `deleted_<id>` markers for sessions the person removed from the list.
 * The data dir is `~/Library/Application Support/Claude`, or another
 * `Claude…` folder beside it for an app instance started with
 * `--user-data-dir` (e.g. `Claude-acc2`).
 */

export type FolderId = { root: string; account: string; org: string }
export type Folder = { id: FolderId; names: readonly string[] }
export type Copy = { from: FolderId; name: string }
export type Plan = {
  copies: Copy[]
  /** pointers already present in the target (or taken from an earlier source) */
  skippedExisting: number
  /** pointers whose session was deleted in the target or in its own source */
  skippedDeleted: number
}

const POINTER = /^local_(.+)\.json$/
const DELETED = /^deleted_(.+)$/

export const SESSIONS = 'claude-code-sessions'
/** `Claude`, and the folders of extra instances: `Claude-acc2`, `Claude 2`. */
export const DATA_DIR = /^Claude([- ].*)?$/

export const isPointer = (name: string): boolean => POINTER.test(name)
export const pointerId = (name: string): string | undefined => POINTER.exec(name)?.[1]

export const deletedIds = (names: readonly string[]): Set<string> => {
  const ids = new Set<string>()
  for (const name of names) {
    const id = DELETED.exec(name)?.[1]
    if (id !== undefined) ids.add(id)
  }
  return ids
}

export const sameFolder = (a: FolderId, b: FolderId): boolean =>
  a.root === b.root && a.account === b.account && a.org === b.org

/**
 * The session-list root of the app instance running this session. The app
 * runs the CLI it downloaded into its own data dir
 * (`<base>/<data dir>/claude-code/<version>/…/claude`), so the CLI's path
 * names the instance. Undefined when the path is elsewhere.
 */
export function rootOfExec(execPath: string | undefined, base: string): string | undefined {
  if (!execPath?.startsWith(`${base}/`)) return undefined
  const [dir, next] = execPath.slice(base.length + 1).split('/')
  if (!dir || !DATA_DIR.test(dir) || next !== 'claude-code') return undefined
  return `${base}/${dir}/${SESSIONS}`
}

/**
 * The current account's folder. Two app instances can both hold a folder
 * for the same account and org, so the instance's own root wins; without
 * it, only an unambiguous folder is taken.
 */
export function pickTarget(
  folders: readonly Folder[],
  current: { account: string; org: string },
  ownRoot: string | undefined,
): Folder | undefined {
  const mine = folders.filter(f => f.id.account === current.account && f.id.org === current.org)
  if (ownRoot !== undefined) return mine.find(f => f.id.root === ownRoot)
  return mine.length === 1 ? mine[0] : undefined
}

export function planSync(target: Folder, sources: readonly Folder[]): Plan {
  const have = new Set(target.names)
  const deletedHere = deletedIds(target.names)
  const plan: Plan = { copies: [], skippedExisting: 0, skippedDeleted: 0 }

  for (const source of sources) {
    if (sameFolder(source.id, target.id)) continue
    const deletedThere = deletedIds(source.names)
    for (const name of source.names) {
      const id = pointerId(name)
      if (id === undefined) continue
      if (have.has(name)) {
        plan.skippedExisting++
        continue
      }
      if (deletedHere.has(id) || deletedThere.has(id)) {
        plan.skippedDeleted++
        continue
      }
      plan.copies.push({ from: source.id, name })
      have.add(name)
    }
  }
  return plan
}

export const countPointers = (names: readonly string[]): number =>
  names.filter(isPointer).length
