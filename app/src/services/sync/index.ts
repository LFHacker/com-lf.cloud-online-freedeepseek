/**
 * 会话与附件的云端同步。
 *
 * 阶段 2 起这里的分工变了（**云端为主，本地仅缓存**）：
 *  · 会话**列表**由 `/sync/sessions` 决定，本地只存副本，用于离线时也能画出来
 *  · 会话**正文**点开才下载（本地缓存优先，云端的更新才覆盖）
 *  · 附件仍然懒加载，且带引用计数（阶段 3），删会话后由服务端 GC 回收
 *
 * 三条容易做错、做错就丢数据的规矩：
 *  1. 拉清单失败 ≠ 云端没有会话。失败必须返回 null 让上层走"离线"分支，
 *     否则一次网络抖动就会被当成"云端被清空"，本地跟着清空。
 *  2. 推送失败要区分能不能重试。401/413 重试一万次也不会成功，
 *     而网络错误/5xx 必须重试，否则消息就卡死在队列里。
 *  3. 旧 payload 不能被"顺手重推"：服务端按 updatedAt 取较新者，
 *     但引用计数只在真正写入时更新，所以重推旧版本既无效也不该更新引用。
 */
import { apiOrigin } from '../api/client.js'
import { useSettings } from '../settings.js'
import { splitByBytes } from './batching.js'
import {
  cacheSessionOnly,
  loadFile,
  loadSession,
  type CloudSessionMeta,
} from '../chat/db.js'
import type { Session, UserMessage } from '../chat/types.js'

const sessionToken = (): string => useSettings.getState().apiKey ?? ''

const jsonHeaders = (): Record<string, string> => ({
  'Content-Type': 'application/json',
  'x-api-key': sessionToken(),
})

/**
 * 一次同步失败值不值得重试。
 *
 * 没有 status 表示请求根本没到服务端（断网、跨域、DNS）—— 必须重试。
 * 5xx / 429 / 408 是暂时性的 —— 重试。
 * 其余 4xx 是"这条请求本身有问题"（401 令牌失效、413 太大、400 参数错）——
 * 重试只会无限刷日志，要停下来告诉用户。
 */
const isRetryableStatus = (status?: number): boolean =>
  status === undefined || status === 408 || status === 429 || status >= 500

const failureMessage = (status?: number): string => {
  if (status === undefined) {
    return '网络不可用'
  }
  if (status === 401) {
    return '登录状态已失效'
  }
  if (status === 413) {
    return '会话或附件过大'
  }
  return `服务端返回 ${status}`
}

export type PushOutcome = {
  ok: boolean
  /** 值不值得退避重试；false 表示要停下来让用户处理 */
  retryable: boolean
  status?: number
  message?: string
  /**
   * 增量推送被服务端拒绝（会话不存在 / 云端更新 / payload 不合法）。
   * 不是错误，只是"增量这条路走不通"，调用方应改走整段推送。
   */
  needFullPush?: boolean
}

export type RemoteIndex = {
  sessions: CloudSessionMeta[]
  deleted: Array<{ id: string; deletedAt: number }>
  /** 服务端时间：用它做增量游标，避免依赖手机本地时钟 */
  serverTime: number
}

/** 每页条数；服务端上限 500，200 是移动网络下的稳妥值 */
const PAGE_SIZE = 200
/** 防御性上限：1 万条会话，再多说明游标逻辑坏了，不要无限翻 */
const MAX_PAGES = 60

/**
 * 拉全量云端清单（自动翻页）。
 *
 * 失败返回 null，**不返回空数组** —— 空数组在这个函数里的语义是
 * "云端确实一条都没有"，用它去覆盖本地缓存就等于清空用户数据。
 */
export const fetchSessionIndex = async (): Promise<RemoteIndex | null> => {
  const sessions: CloudSessionMeta[] = []
  const deleted: Array<{ id: string; deletedAt: number }> = []
  let before = 0
  let beforeId = ''
  let deletedBefore = 0
  let deletedBeforeId = ''
  let serverTime = 0
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
      if (before > 0) {
        params.set('before', String(before))
        params.set('beforeId', beforeId)
      }
      if (deletedBefore > 0) {
        params.set('deletedBefore', String(deletedBefore))
        params.set('deletedBeforeId', deletedBeforeId)
      }
      const response = await fetch(`${apiOrigin()}/sync/sessions?${params}`, {
        headers: jsonHeaders(),
      })
      if (!response.ok) {
        return null
      }
      const payload = (await response.json()) as {
        sessions?: CloudSessionMeta[]
        deleted?: Array<{ id: string; deletedAt: number }>
        hasMore?: boolean
        nextBefore?: number
        nextBeforeId?: string
        deletedHasMore?: boolean
        nextDeletedBefore?: number
        nextDeletedBeforeId?: string
        serverTime?: number
      }
      for (const item of payload.sessions ?? []) {
        if (typeof item?.id === 'string') {
          sessions.push({
            id: item.id,
            title: typeof item.title === 'string' ? item.title : '',
            createdAt: Number(item.createdAt ?? 0),
            updatedAt: Number(item.updatedAt ?? 0),
            pinned: item.pinned === true,
          })
        }
      }
      for (const item of payload.deleted ?? []) {
        if (typeof item?.id === 'string') {
          deleted.push({ id: item.id, deletedAt: Number(item.deletedAt ?? 0) })
        }
      }
      serverTime = Number(payload.serverTime ?? 0) || serverTime
      const sessionsMore = payload.hasMore === true
      const deletedMore = payload.deletedHasMore === true
      if (sessionsMore) {
        before = Number(payload.nextBefore ?? 0)
        beforeId = payload.nextBeforeId ?? ''
        // 游标没前进就停手，别把同一页拉 60 次
        if (before <= 0) {
          break
        }
      }
      if (deletedMore) {
        deletedBefore = Number(payload.nextDeletedBefore ?? 0)
        deletedBeforeId = payload.nextDeletedBeforeId ?? ''
        if (deletedBefore <= 0) {
          break
        }
      }
      if (!sessionsMore && !deletedMore) {
        break
      }
    }
    return { sessions, deleted, serverTime: serverTime || Date.now() }
  } catch {
    return null
  }
}

/** 单条会话全文（列表里点开某个还没缓存的会话时用） */
export const fetchSessionPayload = async (id: string): Promise<Session | null> => {
  try {
    const response = await fetch(`${apiOrigin()}/sync/session?id=${encodeURIComponent(id)}`, {
      headers: jsonHeaders(),
    })
    if (!response.ok) {
      return null
    }
    const payload = (await response.json()) as { payload?: string }
    if (!payload.payload) {
      return null
    }
    return JSON.parse(payload.payload) as Session
  } catch {
    return null
  }
}

/** 会话引用的附件 id（服务端据此维护引用计数） */
const sessionFileIds = (session: Session): string[] => {
  const ids = new Set<string>()
  for (const message of session.messages ?? []) {
    const files = (message as { files?: Array<{ id?: string }> }).files
    if (!Array.isArray(files)) {
      continue
    }
    for (const file of files) {
      if (typeof file?.id === 'string' && file.id.length >= 8) {
        ids.add(file.id)
      }
    }
  }
  return [...ids]
}

export type PushResult = {
  written: number
  failed: number
  /** 有一批是因为"可重试原因"失败的 */
  retryable: boolean
  status?: number
  message?: string
}

/** 一批里的会话条目（发出去的东西） */
type PushItem = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  fileIds: string[]
  payload: string
}

/**
 * 服务端单次请求上限 8 MB（`readBodyCapped`）。切批规则见 `batching.ts`。
 */

/** 发一批；413 时自动二分重试（单条过大才算真失败） */
const postSessionBatch = async (items: PushItem[]): Promise<PushResult> => {
  const result: PushResult = { written: 0, failed: 0, retryable: false }
  if (items.length === 0) {
    return result
  }
  try {
    const response = await fetch(`${apiOrigin()}/sync/sessions`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessions: items }),
    })
    if (response.ok) {
      const payload = (await response.json()) as { written?: number }
      result.written = payload.written ?? 0
      return result
    }
    if (response.status === 413 && items.length > 1) {
      // 拆半重试：可能是这批太大，而不是某一条有问题
      const middle = Math.ceil(items.length / 2)
      const left = await postSessionBatch(items.slice(0, middle))
      const right = await postSessionBatch(items.slice(middle))
      return {
        written: left.written + right.written,
        failed: left.failed + right.failed,
        retryable: left.retryable || right.retryable,
        status: left.status ?? right.status,
        message: left.message ?? right.message,
      }
    }
    result.failed = items.length
    result.status = response.status
    result.retryable = isRetryableStatus(response.status)
    result.message =
      response.status === 413 ? '单条会话超过云端上限（8MB）' : failureMessage(response.status)
    return result
  } catch {
    result.failed = items.length
    result.retryable = true
    result.message = failureMessage(undefined)
    return result
  }
}

/**
 * 推送一批会话：**按体积切批**（规则见 `batching.ts`），单批 413 时二分重试。
 * 返回按批汇总的成败，供上层决定是否重试。
 */
export const pushSessions = async (sessions: Session[]): Promise<PushResult> => {
  const total: PushResult = { written: 0, failed: 0, retryable: false }
  if (sessions.length === 0) {
    return total
  }
  const items: PushItem[] = sessions.map((session) => ({
    id: session.id,
    title: session.title ?? '',
    createdAt: session.createdAt ?? Date.now(),
    updatedAt: session.updatedAt ?? Date.now(),
    pinned: session.pinned === true,
    // 让服务端直接拿到引用，不必再解析几百 KB 的 payload
    fileIds: sessionFileIds(session),
    payload: JSON.stringify(session),
  }))
  for (const batch of splitByBytes(items)) {
    const result = await postSessionBatch(batch)
    total.written += result.written
    total.failed += result.failed
    total.retryable ||= result.retryable
    total.status = result.status ?? total.status
    total.message = result.message ?? total.message
  }
  return total
}

/**
 * 把本地某个会话推上去。
 *
 * 读一次本地库再推，避免把正在流式更新的半成品推上去；
 * 返回值区分"可以重试"和"停下来"，队列靠它决定下一步。
 */
export const pushSession = async (sessionId: string): Promise<PushOutcome> => {
  const session = await loadSession(sessionId).catch(() => undefined)
  if (!session) {
    // 本地都没了：重试也没意义，交给上层把队列条目判死
    return { ok: false, retryable: false, message: '本地找不到这条会话' }
  }
  const result = await pushSessions([session])
  return {
    ok: result.failed === 0,
    retryable: result.failed === 0 ? false : result.retryable,
    status: result.status,
    message: result.message,
  }
}

/**
 * 只推**一条新消息**（增量）。
 *
 * 为什么值得单开一条路：`pushSession` 每次上行的是**整段会话**，
 * 线上实测中位 26 KB、p90 134 KB、最长 4.74 MB —— 而这一轮真正新增的只有一条消息，
 * 几百字节到几 KB。手机上行慢，长会话里这几乎就是"点发送后那几秒空白"。
 *
 * 返回 `needFullPush` **不是错误**：说明云端与本地对不上（会话还没推上去、或别的设备
 * 已经改过）。这时回落 `pushSession`，由服务端原有的"取较新者"规则裁决 ——
 * 在这里猜着合并只会丢别人的改动。
 */
export const pushMessage = async (
  sessionId: string,
  message: UserMessage,
  updatedAt: number,
  base: number
): Promise<PushOutcome> => {
  try {
    const response = await fetch(`${apiOrigin()}/sync/message`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId, message, updatedAt, base }),
    })
    if (!response.ok) {
      /**
       * 413 说明这条消息本身就超过增量接口的 2 MB 上限（比如整篇长文粘进来）。
       * 这不是"发不出去"，而是"这条路装不下" —— 回落整段推送，那边上限是 8 MB。
       */
      if (response.status === 413) {
        return { ok: false, retryable: false, needFullPush: true }
      }
      return {
        ok: false,
        retryable: isRetryableStatus(response.status),
        status: response.status,
        message: failureMessage(response.status),
      }
    }
    const payload = (await response.json()) as { ok?: boolean }
    if (payload.ok === true) {
      return { ok: true, retryable: false }
    }
    return { ok: false, retryable: false, needFullPush: true }
  } catch {
    // 请求根本没到服务端：整段推送同样会失败，按可重试处理，别白跑一次回落
    return { ok: false, retryable: true, message: failureMessage(undefined) }
  }
}

/**
 * 删除一条会话（云端为主模型）。
 *
 * 顺序：**先删云端，成功后再删本地**。反过来的话，
 * 云端删失败、本地已删，下次同步又会把它拉回来，用户会看到"删了又出现"。
 */
export const deleteRemoteSession = async (sessionId: string): Promise<PushOutcome> => {
  try {
    const response = await fetch(
      `${apiOrigin()}/sync/session?id=${encodeURIComponent(sessionId)}`,
      { method: 'DELETE', headers: jsonHeaders() }
    )
    return {
      ok: response.ok,
      retryable: !response.ok && isRetryableStatus(response.status),
      status: response.status,
      message: response.ok ? undefined : failureMessage(response.status),
    }
  } catch {
    return { ok: false, retryable: true, message: failureMessage(undefined) }
  }
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

export type RemoteFileInfo = {
  id: string
  size: number
  updatedAt: number
  /** 被多少条会话引用；0 表示孤儿，服务端 GC 会回收 */
  refs: number
}

/** 云端附件清单（含引用计数）；失败返回 null，调用方不应据此认为"云端没有" */
export const listRemoteFiles = async (): Promise<Map<string, RemoteFileInfo> | null> => {
  try {
    const response = await fetch(`${apiOrigin()}/sync/files`, { headers: jsonHeaders() })
    if (!response.ok) {
      return null
    }
    const payload = (await response.json()) as { files?: RemoteFileInfo[] }
    const map = new Map<string, RemoteFileInfo>()
    for (const file of payload.files ?? []) {
      if (typeof file?.id === 'string') {
        map.set(file.id, {
          id: file.id,
          size: Number(file.size ?? 0),
          updatedAt: Number(file.updatedAt ?? 0),
          refs: Number(file.refs ?? 0),
        })
      }
    }
    return map
  } catch {
    return null
  }
}

/**
 * 懒加载：本地没有这张图时从云端取回。
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

export type GcReport = {
  dryRun: boolean
  graceDays: number
  candidates: Array<{ id: string; size: number; ageDays: number }>
  removed: number
}

/**
 * 触发服务端附件回收（默认 dryRun，真删要显式传 dryRun:false）。
 *
 * 刻意没接进界面：真删不可逆，这种操作应该由运维脚本（gateway/scripts/gc-files.ts）
 * 或 cron 决定，不该让用户在一次误触里清掉历史图片。这里留一个客户端入口，
 * 是为了排查「某个附件为什么没了」时能先 dry-run 看一遍清单。
 */
export const gcRemoteFiles = async (
  options: { dryRun?: boolean; graceDays?: number } = {}
): Promise<GcReport | null> => {
  try {
    const response = await fetch(`${apiOrigin()}/sync/files/gc`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        dryRun: options.dryRun !== false,
        graceDays: options.graceDays ?? 7,
      }),
    })
    if (!response.ok) {
      return null
    }
    return (await response.json()) as GcReport
  } catch {
    return null
  }
}

/** 把云端正文写进本地缓存（附件走懒加载，这里不带 files；也不触发"落库后推云端"） */
export const cacheSession = async (session: Session): Promise<void> => {
  await cacheSessionOnly(session)
}
