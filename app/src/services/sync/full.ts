/**
 * 全量同步：把本机所有会话和附件推到云端。
 *
 * 这是"标准做法"该有的样子，不是给某个人凑合用：
 *
 *  1. **断点可用**：分批推、按 id 去重，中途失败下次继续，不从头再来
 *  2. **幂等**：会话按 updatedAt 取较新者；附件 id 即内容哈希，已存在就跳过
 *  3. **可观察**：每一步都有进度回调（调用方拿去显示 N/M）
 *  4. **不阻塞**：附件逐张上传，单张失败只记数，不影响其余
 *  5. **可恢复**：失败不抛给用户界面，返回统计；下次同步自然补齐
 *
 * 为什么附件要在这里全量推：导入时图片本来就在本地，
 * 换设备后如果没有云端副本，会话里就只剩文件名。
 */
import { loadFile, loadSession, loadSessionSummaries } from '../chat/db.js'
import { listRemoteFiles, pushSessions, uploadAttachment } from './index.js'
import type { Session } from '../chat/types.js'

export type FullSyncProgress = {
  /** 阶段：会话 → 附件 → 完成 */
  phase: 'sessions' | 'files' | 'done'
  done: number
  total: number
}

export type FullSyncResult = {
  sessionsPushed: number
  sessionsFailed: number
  filesUploaded: number
  filesSkipped: number
  filesFailed: number
}

/** 从一条会话里收集所有附件 id（去重由调用方做） */
const collectFileIds = (session: Session): string[] => {
  const ids: string[] = []
  for (const message of session.messages ?? []) {
    const files = (message as { files?: Array<{ id?: string }> }).files
    if (!Array.isArray(files)) {
      continue
    }
    for (const file of files) {
      if (typeof file?.id === 'string' && file.id.length >= 8) {
        ids.push(file.id)
      }
    }
  }
  return ids
}

/**
 * 全量推送。
 *
 * @param onProgress 每完成一批回调一次（用于界面进度条）
 */
export const pushEverything = async (
  onProgress?: (progress: FullSyncProgress) => void
): Promise<FullSyncResult> => {
  const result: FullSyncResult = {
    sessionsPushed: 0,
    sessionsFailed: 0,
    filesUploaded: 0,
    filesSkipped: 0,
    filesFailed: 0,
  }

  // ---- 1) 会话：分批推，批内失败不影响后续 ----
  const summaries = await loadSessionSummaries()
  const sessions: Session[] = []
  for (const summary of summaries) {
    const session = await loadSession(summary.id)
    if (session) {
      sessions.push(session)
    }
  }

  const BATCH = 50
  for (let index = 0; index < sessions.length; index += BATCH) {
    const batch = sessions.slice(index, index + BATCH)
    const written = await pushSessions(batch)
    result.sessionsPushed += written
    result.sessionsFailed += Math.max(0, batch.length - written)
    onProgress?.({
      phase: 'sessions',
      done: Math.min(index + BATCH, sessions.length),
      total: sessions.length,
    })
  }

  // ---- 2) 附件：先问云端有哪些，只传缺的 ----
  const fileIds = new Set<string>()
  for (const session of sessions) {
    for (const id of collectFileIds(session)) {
      fileIds.add(id)
    }
  }
  const remote = await listRemoteFiles()
  const missing = [...fileIds].filter((id) => !remote.has(id))
  result.filesSkipped = fileIds.size - missing.length

  let uploaded = 0
  for (const id of missing) {
    const blob = await loadFile(id).catch(() => undefined)
    if (!blob) {
      // 本地没有原件（导入包里的图片在导出时可能缺失，或已被清理）
      result.filesFailed += 1
    } else if (await uploadAttachment(id, blob)) {
      result.filesUploaded += 1
    } else {
      result.filesFailed += 1
    }
    uploaded += 1
    onProgress?.({ phase: 'files', done: uploaded, total: missing.length })
  }

  onProgress?.({ phase: 'done', done: 1, total: 1 })
  return result
}
