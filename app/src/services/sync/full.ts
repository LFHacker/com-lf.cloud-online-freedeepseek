/**
 * 全量同步：把本机所有会话和附件推到云端。
 *
 *  1. **增量**：先拉云端清单，已经是云端最新的一律跳过 —— 1000 条会话重推一次是 100 MB，
 *     手机上重推几轮就废了
 *  2. **按体积切批**（`pushSessions` 内部）：单条几百 KB 的会话按 50 条一批必然撞 8 MB 上限
 *  3. **可观察**：每一步都上报进度与最终成败，界面据此显示"推了多少、失败多少"
 *  4. **不阻塞**：附件逐张上传，单张失败只记数
 *
 * 这套东西是给「导入 1000 条历史之后」用的：那次自动推送是 fire-and-forget，
 * 失败了界面上什么都没有，用户只能看到"云端就是没有"。
 */
import { loadSession, loadSessionFileIds, loadSessionSummaries } from '../chat/db.js'
import { fetchSessionIndex, listRemoteFiles, pushSessions, uploadAttachment } from './index.js'
import { loadFile } from '../chat/db.js'
import { countStoredFiles } from '../chat/db.js'
import type { Session } from '../chat/types.js'

export type FullSyncProgress = {
  /** 阶段：会话 → 附件 → 完成 */
  phase: 'sessions' | 'files' | 'done'
  done: number
  total: number
}

export type FullSyncResult = {
  sessionsPushed: number
  /** 云端已经是最新、跳过的条数 */
  sessionsSkipped: number
  sessionsFailed: number
  filesUploaded: number
  filesSkipped: number
  /** 上传尝试过但失败（网络/服务端拒绝） */
  filesFailed: number
  /**
   * 会话里引用了、但**本机根本没有原件**的附件数。
   *
   * 这和"上传失败"是两件事：导入的包如果没带图片、或导入时图片没写进 IndexedDB，
   * 本机就没有可传的东西 —— 再点一万次同步也没用。
   * 不分开计数的话，用户只会看到"失败 N 项"，无法判断是网络问题还是数据本身缺。
   */
  filesMissing: number
  /** 本机实际存了多少个原件（诊断用） */
  localFiles: number
  /** 第一条失败原因（给界面显示，不刷屏） */
  error?: string
}

/**
 * 全量推送（增量）。
 *
 * @param onProgress 每完成一批回调一次（界面据此显示 N/M）
 */
export const pushEverything = async (
  onProgress?: (progress: FullSyncProgress) => void
): Promise<FullSyncResult> => {
  const result: FullSyncResult = {
    sessionsPushed: 0,
    sessionsSkipped: 0,
    sessionsFailed: 0,
    filesUploaded: 0,
    filesSkipped: 0,
    filesFailed: 0,
    filesMissing: 0,
    localFiles: 0,
  }

  /**
   * ---- 1) 先问云端有哪些、各自多新 ----
   * 清单拉失败（null）时不能当"云端是空的"去推全量：那等于把 100 MB 又发一遍，
   * 而且可能是离线。这里直接如实报错，让用户看得到"没推成"。
   */
  const remote = await fetchSessionIndex()
  if (!remote) {
    result.error = '拿不到云端清单（网络或登录状态有问题）'
    onProgress?.({ phase: 'done', done: 1, total: 1 })
    return result
  }
  const cloudUpdatedAt = new Map(remote.sessions.map((item) => [item.id, item.updatedAt]))

  // ---- 2) 挑出需要推的会话 ----
  const summaries = await loadSessionSummaries()
  const pending: Session[] = []
  for (const summary of summaries) {
    if ((cloudUpdatedAt.get(summary.id) ?? 0) >= summary.updatedAt) {
      result.sessionsSkipped += 1
      continue
    }
    const session = await loadSession(summary.id)
    if (!session) {
      // 摘要还在、正文没了（本地存储被清过）：如实计入失败，别假装推过
      result.sessionsFailed += 1
      continue
    }
    pending.push(session)
  }

  // ---- 3) 推会话：每 50 条一组，组内再按体积切 ----
  const BATCH = 50
  for (let index = 0; index < pending.length; index += BATCH) {
    const batch = pending.slice(index, index + BATCH)
    const pushed = await pushSessions(batch)
    result.sessionsPushed += pushed.written
    result.sessionsFailed += pushed.failed
    result.error ??= pushed.message
    onProgress?.({
      phase: 'sessions',
      done: Math.min(index + BATCH, pending.length),
      total: pending.length,
    })
  }

  // ---- 4) 附件：只传云端还没有的（引用 id 从摘要里直接取，不必读正文）----
  const fileIds = await loadSessionFileIds().catch(() => new Set<string>())
  result.localFiles = await countStoredFiles().catch(() => 0)
  const remoteFiles = await listRemoteFiles()
  const missing = [...fileIds].filter((id) => !remoteFiles || !remoteFiles.has(id))
  result.filesSkipped = fileIds.size - missing.length

  let uploaded = 0
  for (const id of missing) {
    const blob = await loadFile(id).catch(() => undefined)
    if (!blob) {
      /**
       * 本机没有原件：多数是导入的包里本来就没带图（或导入时图片没落盘）。
       * 单独计数 —— 它和"上传失败"完全是两回事，混在一起用户没法判断该怎么办。
       */
      result.filesMissing += 1
    } else if (await uploadAttachment(id, blob)) {
      result.filesUploaded += 1
    } else {
      result.filesFailed += 1
      result.error ??= '有附件上传失败（网络或服务端拒绝）'
    }
    uploaded += 1
    onProgress?.({ phase: 'files', done: uploaded, total: missing.length })
  }

  onProgress?.({ phase: 'done', done: 1, total: 1 })
  return result
}
