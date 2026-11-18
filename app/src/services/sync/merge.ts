/**
 * 云端清单与本地缓存的合并规则（纯函数，方便单测）。
 *
 * 规则只有一句话：**云端说了算，但本地更新的不能被丢掉**。
 *  - 云端有、本地没有 → 列表里先出现（正文点开才下载）
 *  - 云端有、本地更旧 → 用云端的
 *  - 云端有、本地更新 → 用本地的，并标记待推送（推完两边就一致了）
 *  - 云端没有、本地有 → 保留并推送。绝不静默丢弃：那可能是刚建的会话
 *    还没推上去，或者上一轮推送失败了
 *  - 云端已删（墓碑）→ 本地删掉
 */
import type { CloudSessionMeta } from '../chat/db.js'
import type { SessionSummary } from '../chat/types.js'

export type MergeOutcome = {
  sessions: SessionSummary[]
  /** 本地更新 / 云端没有 —— 需要推上去 */
  toPush: string[]
  /** 云端已删 —— 本地要删 */
  removed: string[]
  /** 云端有、本地没有正文 —— 列表先显示，点开才下载 */
  remoteOnly: string[]
}

/**
 * 清单看起来像"云端被清空"吗？
 *
 * 这个判断专门防一类事故：请求失败被当成"云端没有会话"，
 * 于是本地缓存被整体覆盖成空，用户看到历史全没了。
 * 空清单 + 无墓碑 + 本地有一堆会话 = 几乎一定是异常，不是用户真的删光了。
 * （真删光的情况一定带着墓碑。）
 */
export const cloudLooksWiped = (localCount: number, remoteCount: number, deletedCount: number): boolean =>
  localCount > 0 && remoteCount === 0 && deletedCount === 0

export const mergeSessionIndex = (
  local: readonly SessionSummary[],
  remote: readonly CloudSessionMeta[],
  deleted: readonly string[]
): MergeOutcome => {
  const deletedSet = new Set(deleted)
  const localById = new Map(local.map((summary) => [summary.id, summary]))
  const remoteIds = new Set<string>()
  const sessions: SessionSummary[] = []
  const toPush = new Set<string>()
  const remoteOnly: string[] = []

  for (const meta of remote) {
    if (deletedSet.has(meta.id)) {
      continue
    }
    remoteIds.add(meta.id)
    const localSummary = localById.get(meta.id)
    if (localSummary && localSummary.updatedAt > meta.updatedAt) {
      sessions.push(localSummary)
      toPush.add(meta.id)
      continue
    }
    sessions.push({
      id: meta.id,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      // 记忆模式不在清单里，本地有就沿用（它创建后不可改）
      memoryScope: localSummary?.memoryScope,
      pinned: meta.pinned,
    })
    if (!localSummary) {
      remoteOnly.push(meta.id)
    }
  }

  for (const summary of local) {
    if (remoteIds.has(summary.id) || deletedSet.has(summary.id)) {
      continue
    }
    sessions.push(summary)
    toPush.add(summary.id)
  }

  return { sessions, toPush: [...toPush], removed: deleted.filter((id) => id.length > 0), remoteOnly }
}
