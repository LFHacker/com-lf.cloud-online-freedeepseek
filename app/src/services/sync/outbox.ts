/**
 * 待发送队列（阶段 2-2）：消息"打在屏幕上"和"服务端确认"是两件事。
 *
 * 为什么必须落 IndexedDB：
 *  · 离线发的消息如果只在内存里，关一次 App 就没了 —— 用户会以为发出去了
 *  · 重试要在重启后继续，否则"退避重试"只对当前这次运行有效
 *
 * 幂等：队列条目的 id 就是消息 id。重推同一条会话不会产生第二条消息
 * （服务端按 updatedAt upsert），所以重复投递是安全的。
 */
import { create } from 'zustand'
import { loadOutbox, putOutbox, removeOutbox, type OutboxRecord } from '../chat/db.js'
import { useSettings } from '../settings.js'
import { backoffDelay } from './backoff.js'
import { pushSession } from './index.js'
import { markRetry, setSync, useSync } from './status.js'

export type { OutboxRecord }

/** 队列的内存镜像：UI 靠它判断"这条消息发出去没有" */
export const useOutbox = create<{ entries: Record<string, OutboxRecord> }>(() => ({ entries: {} }))

export type OutboxEvent = {
  type: 'confirmed' | 'retry' | 'failed'
  entry: OutboxRecord
}

type Listener = (event: OutboxEvent) => void
const listeners = new Set<Listener>()

/** 订阅队列结果；聊天 store 靠它决定"确认后开始回答" */
export const onOutboxEvent = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const emit = (event: OutboxEvent) => {
  for (const listener of listeners) {
    listener(event)
  }
}

const commit = (entry: OutboxRecord) => {
  useOutbox.setState((state) => ({ entries: { ...state.entries, [entry.id]: entry } }))
}

const forget = (id: string) => {
  useOutbox.setState((state) => {
    if (!Object.hasOwn(state.entries, id)) {
      return state
    }
    return {
      entries: Object.fromEntries(Object.entries(state.entries).filter(([key]) => key !== id)),
    }
  })
}

export const outboxEntries = (): OutboxRecord[] => Object.values(useOutbox.getState().entries)

/** 这个会话还有没有"没确认"的消息（有就别让用户再发，否则两个流会抢同一个槽） */
export const hasPendingForSession = (sessionId: string): boolean =>
  outboxEntries().some((entry) => entry.sessionId === sessionId && entry.status !== 'failed')

/** 待发送条数（不含彻底失败的，那些要用户点重试） */
export const pendingOutboxCount = (): number =>
  outboxEntries().filter((entry) => entry.status !== 'failed').length

const hasToken = (): boolean => Boolean(useSettings.getState().apiKey)

let timer: ReturnType<typeof setTimeout> | undefined
let flushing = false

/** 排出下一次尝试：取最早到点的那条，最长等 60 秒（锁屏回来要尽快恢复） */
const schedule = () => {
  clearTimeout(timer)
  const queued = outboxEntries().filter((entry) => entry.status !== 'failed')
  if (queued.length === 0) {
    return
  }
  const now = Date.now()
  const next = Math.min(...queued.map((entry) => entry.nextAttemptAt || now))
  const wait = Math.min(Math.max(0, next - now), 60_000)
  timer = setTimeout(() => {
    void flushOutbox()
  }, wait + 10)
}

/** 放进队列：立刻尝试一次，失败后按退避自动重试 */
export const enqueueOutbox = async (input: { id: string; sessionId: string }): Promise<void> => {
  const record: OutboxRecord = {
    id: input.id,
    sessionId: input.sessionId,
    createdAt: Date.now(),
    attempts: 0,
    nextAttemptAt: 0,
    status: 'queued',
  }
  await putOutbox(record).catch(() => undefined)
  commit(record)
  schedule()
  void flushOutbox()
}

/** 启动时把上次没发出去的消息读回来（不主动发：此时可能还没登录，401 会被判成不可重试） */
export const restoreOutbox = async (): Promise<void> => {
  const records = await loadOutbox().catch(() => [] as OutboxRecord[])
  if (records.length === 0) {
    return
  }
  const entries: Record<string, OutboxRecord> = {}
  for (const record of records) {
    // 上次进程被杀时正处于 sending：回到 queued 重新来
    entries[record.id] = record.status === 'sending' ? { ...record, status: 'queued' } : record
  }
  useOutbox.setState({ entries })
  schedule()
}

/** 用户点重试：清零退避，立刻再来一次 */
export const retryOutboxEntry = async (id: string): Promise<void> => {
  const entry = useOutbox.getState().entries[id]
  if (!entry) {
    return
  }
  const next: OutboxRecord = { ...entry, attempts: 0, nextAttemptAt: 0, status: 'queued', error: undefined }
  await putOutbox(next).catch(() => undefined)
  commit(next)
  void flushOutbox({ force: true })
}

/**
 * 冲一次队列。
 *
 * 关键取舍：一条失败就**停下整轮**（只要它是"可重试"的失败）。
 * 网络断了的时候继续冲下一条只会把每条都记一次失败、退避时间全被推远，
 * 恢复网络后反而要等更久。
 */
export const flushOutbox = async (options: { force?: boolean } = {}): Promise<void> => {
  if (flushing || !hasToken()) {
    schedule()
    return
  }
  flushing = true
  try {
    for (;;) {
      const now = Date.now()
      const due = outboxEntries()
        .filter(
          (entry) =>
            entry.status !== 'failed' &&
            entry.status !== 'sending' &&
            (options.force || entry.nextAttemptAt <= now)
        )
        .sort((a, b) => a.createdAt - b.createdAt)
      const entry = due[0]
      if (!entry) {
        return
      }
      const outcome = await attempt(entry)
      if (outcome === 'retry') {
        return
      }
    }
  } finally {
    flushing = false
    schedule()
  }
}

/** 发一条：成功 → 出队并通知；失败 → 记次数、排下一次 */
const attempt = async (entry: OutboxRecord): Promise<'ok' | 'retry' | 'dead'> => {
  commit({ ...entry, status: 'sending' })
  const result = await pushSession(entry.sessionId)
  if (result.ok) {
    await removeOutbox(entry.id).catch(() => undefined)
    forget(entry.id)
    emit({ type: 'confirmed', entry })
    // 队列空了就把状态条收回 idle，别让它一直挂着"同步中"
    if (pendingOutboxCount() === 0) {
      setSync({ phase: 'idle', retryAt: 0, failures: 0, message: null })
    }
    return 'ok'
  }
  const attempts = entry.attempts + 1
  const retryable = result.retryable
  const updated: OutboxRecord = {
    ...entry,
    attempts,
    status: retryable ? 'queued' : 'failed',
    nextAttemptAt: retryable ? Date.now() + backoffDelay(attempts) : 0,
    error: result.message,
  }
  await putOutbox(updated).catch(() => undefined)
  commit(updated)
  emit({ type: retryable ? 'retry' : 'failed', entry: updated })
  if (retryable) {
    // 让顶部状态条也反映"消息还没发出去"，不能只有消息上的小字
    markRetry(useSync.getState().failures + 1, updated.nextAttemptAt, result.message ?? null)
  } else {
    setSync({
      phase: 'error',
      retryAt: 0,
      failures: useSync.getState().failures + 1,
      message: result.message ?? null,
    })
  }
  return retryable ? 'retry' : 'dead'
}

/** 彻底放弃一条（例如用户删掉了那条消息） */
export const dropOutboxEntry = async (id: string): Promise<void> => {
  await removeOutbox(id).catch(() => undefined)
  forget(id)
}
