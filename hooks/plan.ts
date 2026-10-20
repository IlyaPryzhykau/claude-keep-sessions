/**
 * Pure planning: which session pointer files to copy into the current
 * account's folder. No I/O here, so it is unit-tested directly.
 *
 * The desktop app keeps one folder per account and organization:
 *   claude-code-sessions/<accountUuid>/<orgUuid>/
 * holding `local_<id>.json` (one per session listed in the sidebar) and
 * `deleted_<id>` markers for sessions the person removed from the list.
 */

/** `root` is the claude-code-sessions folder of one app data dir (Claude, Claude-01, …). */
export type FolderId = { root?: string; account: string; org: string }
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
