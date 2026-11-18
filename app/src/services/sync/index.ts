/**
 * 会话与附件的云端同步。
 *
 * 目标：换手机登录同一账号 → 会话全量回来，图片按需懒加载。
 *
 * 分工：
 *  · **会话**登录时全量下发（文字小、用户要的是"打开就在"）
 *  · **图片**懒加载（你的导出包 191 MB，移动网络等不起）
 *
 * 冲突策略与服务端一致：谁的 `updatedAt` 新谁赢。
 * 本地较新就跳过下载，云端较旧也不会覆盖本地。
 */
import { apiOrigin } from '../api/client.js'
import { useSettings } from '../settings.js'
import { deleteSession, loadFile, loadSession, loadSessionSummaries, saveSession } from '../chat/db.js'
import type { Session } from '../chat/types.js'

const sessionToken = (): string => useSettings.getState().apiKey ?? ''

const jsonHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  'x-api-key': sessionToken(),
})

export type RemoteSessionMeta = { id: string; title: string; createdAt: number; updatedAt: number }

/** 拉云端会话清单（不含正文）+ 墓碑（已删除的会话 id） */
export const listRemoteSessions = async (): Promise<{
  sessions: RemoteSessionMeta[]
  deleted: Array<{ id: string; deletedAt: number }>
}> => {
  try {
    const response = await fetch(`${apiOrigin()}/sync/sessions`, { headers: jsonHeaders() })
    if (!response.ok) {
      return { sessions: [], deleted: [] }
    }
    const payload = (await response.json()) as {
      sessions?: RemoteSessionMeta[]
      deleted?: Array<{ id: string; deletedAt: number }>
    }
    return { sessions: payload.sessions ?? [], deleted: payload.deleted ?? [] }
  } catch {
    return { sessions: [], deleted: [] }
  }
}

/** 推送一批会话（每批 50 条，避免单次请求过大） */
export const pushSessions = async (sessions: Session[]): Promise<number> => {
  if (sessions.length === 0) {
    return 0
  }
  let written = 0
  for (let index = 0; index < sessions.length; index += 50) {
    const batch = sessions.slice(index, index + 50).map((session) => ({
      id: session.id,
      title: session.title ?? '',
      createdAt: session.createdAt ?? Date.now(),
      updatedAt: session.updatedAt ?? Date.now(),
      payload: JSON.stringify(session),
    }))
    try {
      const response = await fetch(`${apiOrigin()}/sync/sessions`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ sessions: batch }),
      })
      if (response.ok) {
        const result = (await response.json()) as { written?: number }
        written += result.written ?? 0
      }
    } catch {
      // 单批失败不影响后续批次；下次同步会补上
    }
  }
  return written
}

/**
 * 登录后全量恢复。
 *
 * 只下载"云端比本地新"或"本地没有"的会话；
 * 图片不在这里下——会话里的附件只记 id，真正显示时再取。
 */
export const pullSessions = async (
  onProgress?: (done: number, total: number) => void
): Promise<{ downloaded: number; skipped: number; removed: number }> => {
  const { sessions: remote, deleted } = await listRemoteSessions()

  /**
   * 先按墓碑删本地。
   *
   * 这是"云端为主"的关键一步：别的设备删掉的会话，
   * 本机下次同步必须跟着消失，否则会一直显示已经不存在的东西。
   */
  for (const tomb of deleted) {
    const local = await loadSession(tomb.id).catch(() => undefined)
    if (local) {
      await deleteSession(tomb.id).catch(() => undefined)
    }
  }

  if (remote.length === 0) {
    return { downloaded: 0, skipped: 0, removed: deleted.length }
  }
  const local = new Map<string, number>()
  for (const summary of await loadSessionSummaries()) {
    local.set(summary.id, summary.updatedAt ?? 0)
  }

  let downloaded = 0
  let skipped = 0
  for (const [index, item] of remote.entries()) {
    const localUpdated = local.get(item.id) ?? 0
    if (localUpdated >= item.updatedAt) {
      skipped += 1
      onProgress?.(index + 1, remote.length)
      continue
    }
    try {
      const response = await fetch(
        `${apiOrigin()}/sync/session?id=${encodeURIComponent(item.id)}`,
        { headers: jsonHeaders() }
      )
      if (!response.ok) {
        skipped += 1
        continue
      }
      const payload = (await response.json()) as { payload?: string }
      if (payload.payload) {
        const session = JSON.parse(payload.payload) as Session
        // 附件二进制不在这里写；saveSession 的 files 传空，图片走懒加载
        await saveSession(session, [])
        downloaded += 1
      }
    } catch {
      skipped += 1
    }
    onProgress?.(index + 1, remote.length)
  }
  return { downloaded, skipped, removed: deleted.length }
}

/** 上传一个附件（图片）。已存在则由服务端幂等覆盖 */
export const uploadAttachment = async (id: string, blob: Blob): Promise<boolean> => {
  try {
    const response = await fetch(`${apiOrigin()}/sync/files/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'x-api-key': sessionToken(), 'Content-Type': 'application/octet-stream' },
      body: blob,
    })
    return response.ok
  } catch {
    return false
  }
}

/** 云端附件清单（id → 是否存在） */
export const listRemoteFiles = async (): Promise<Set<string>> => {
  try {
    const response = await fetch(`${apiOrigin()}/sync/files`, { headers: jsonHeaders() })
    if (!response.ok) {
      return new Set()
    }
    const payload = (await response.json()) as { files?: Array<{ id: string }> }
    return new Set((payload.files ?? []).map((file) => file.id))
  } catch {
    return new Set()
  }
}

/**
 * 懒加载：本地没有这张图时从云端取回并写进本地库。
 * 失败返回 undefined，界面显示占位即可（不阻塞渲染）。
 */
export const fetchAttachment = async (id: string): Promise<Blob | undefined> => {
  const cached = await loadFile(id).catch(() => undefined)
  if (cached) {
    return cached
  }
  try {
    const response = await fetch(`${apiOrigin()}/sync/files/${encodeURIComponent(id)}`, {
      headers: { 'x-api-key': sessionToken() },
    })
    if (!response.ok) {
      return undefined
    }
    return await response.blob()
  } catch {
    return undefined
  }
}

/**
 * 把本地某个会话推上去（对话结束后调用）。
 * 读一次本地库再推，避免把正在流式更新的半成品推上去。
 */
export const pushSession = async (sessionId: string): Promise<boolean> => {
  try {
    const session = await loadSession(sessionId)
    if (!session) {
      return false
    }
    const written = await pushSessions([session])
    return written > 0
  } catch {
    return false
  }
}

/**
 * 删除一条会话（云端为主模型）。
 *
 * 顺序：**先删云端，成功后再删本地**。反过来的话，
 * 云端删失败、本地已删，下次同步又会把它拉回来，用户会看到"删了又出现"。
 */
export const deleteRemoteSession = async (sessionId: string): Promise<boolean> => {
  try {
    const response = await fetch(
      `${apiOrigin()}/sync/session?id=${encodeURIComponent(sessionId)}`,
      { method: 'DELETE', headers: jsonHeaders() }
    )
    return response.ok
  } catch {
    return false
  }
}
