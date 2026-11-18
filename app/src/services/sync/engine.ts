/**
 * 同步引擎（阶段 2-1 / 2-3）：拉清单 → 合并进列表 → 推送本地更新 → 冲待发送队列。
 *
 * 顺序是有意的：
 *  1. 先拉清单：得到"云端有哪些会话"，这是列表的真相
 *  2. 再合并：本地更新但云端没有的会被标记成待推送
 *  3. 推送：让云端追上本地
 *  4. 最后冲队列：消息确认（它也会推会话）
 *
 * 失败一律走指数退避，且**不把失败当成"云端是空的"** —— 那会清空本地缓存。
 */
import { loadSyncMeta, saveSyncMeta } from '../chat/db.js'
import { backoffDelay } from './backoff.js'
import { fetchSessionIndex } from './index.js'
import { flushOutbox, pendingOutboxCount } from './outbox.js'
import { markRetry, setSync, useSync } from './status.js'

export type SyncOutcome = 'ok' | 'offline' | 'error' | 'suspicious'

let running = false
let retryTimer: ReturnType<typeof setTimeout> | undefined

/** 多久算"该重新同步了"（切回前台时用） */
const STALE_AFTER_MS = 60_000

const scheduleRetry = (message: string, retryable: boolean): SyncOutcome => {
  const failures = useSync.getState().failures + 1
  if (!retryable) {
    setSync({ phase: 'error', failures, retryAt: 0, message })
    return 'error'
  }
  const delay = backoffDelay(failures)
  const retryAt = Date.now() + delay
  markRetry(failures, retryAt, message)
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    void syncNow()
  }, delay)
  return 'offline'
}

/**
 * 同步一次。
 *
 * 重入保护：正在同步时再次调用直接返回，避免"切回前台 + online 事件"
 * 同时触发两轮，把同一批会话推两遍。
 */
export const syncNow = async (): Promise<SyncOutcome> => {
  if (running) {
    return 'ok'
  }
  running = true
  setSync({ phase: 'syncing', message: null })
  try {
    const index = await fetchSessionIndex()
    if (!index) {
      return scheduleRetry('网络不可用，改动已保存在本机', true)
    }
    // 动态 import：chat/store 依赖本模块的队列，静态互相 import 会成环
    const store = await import('../chat/store.js')
    const applied = store.applyRemoteIndex(index.sessions, index.deleted)
    /**
     * suspicious = 云端清单空、本地有数据。这时**不算失败**：
     * 列表没被动过（数据安全），本地会话已经触发补推，下一轮就恢复正常。
     * 当成错误反而会让状态条一直红着，而用户其实什么都没做错。
     */
    if (applied.suspicious) {
      setSync({ phase: 'idle', lastSyncedAt: Date.now(), retryAt: 0, failures: 0, message: null })
      return 'suspicious'
    }
    await saveSyncMeta({ lastSyncedAt: String(Date.now()) })
    await flushOutbox({ force: true })
    /**
     * 队列里还有没发出去的消息，就别报"同步完成" ——
     * 那几条的错误状态是队列自己设置的，这里覆盖成 idle 会让用户以为消息已经发出去了。
     *
     * ⚠️ 判据必须是**队列**，不能判 `phase`：走到这里 phase 一定是 'syncing'
     * （本函数开头刚设的），拿它做条件就成了"永远不报完成"，
     * 顶部会一直卡在「正在同步…」——真踩过这一脚（v0.17.0B）。
     */
    if (pendingOutboxCount() > 0) {
      /**
       * 正常情况下队列自己已经把状态设成"重试中/失败"了；
       * 只有它没能给结论时（例如没有令牌、根本没发出去）才会还停在 syncing，
       * 这时补一个终态，免得状态条又卡在「正在同步」。
       */
      if (useSync.getState().phase === 'syncing') {
        setSync({ phase: 'offline', retryAt: 0, message: '有消息待发送，联网后会自动补发' })
      }
      return 'offline'
    }
    setSync({
      phase: 'idle',
      lastSyncedAt: Date.now(),
      retryAt: 0,
      failures: 0,
      message: null,
    })
    return 'ok'
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : '同步失败'
    return scheduleRetry(message, true)
  } finally {
    running = false
  }
}

/** 状态条上的「立即重试」 */
export const retrySyncNow = async (): Promise<SyncOutcome> => {
  clearTimeout(retryTimer)
  setSync({ retryAt: 0 })
  return syncNow()
}

const needsSync = (): boolean => {
  const last = useSync.getState().lastSyncedAt
  return last === null || Date.now() - last > STALE_AFTER_MS
}

/**
 * 启动联动：联网 / 回到前台时自动补一次同步。
 *
 * 为什么监听 visibilitychange：手机锁屏时 JS 基本不跑，
 * 定时器会漂移甚至停摆；"回到前台"才是移动端最可靠的触发点。
 */
export const startSyncEngine = (): (() => void) => {
  void loadSyncMeta()
    .then((meta) => {
      const last = Number(meta.lastSyncedAt ?? 0) || 0
      if (last > 0) {
        setSync({ lastSyncedAt: last })
      }
    })
    .catch(() => undefined)

  const onOnline = () => {
    setSync({ phase: 'idle', retryAt: 0, failures: 0, message: null })
    void syncNow()
  }
  const onOffline = () => {
    setSync({ phase: 'offline', message: '设备已离线，改动已保存在本机' })
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible' && needsSync()) {
      void syncNow()
    }
  }
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  document.addEventListener('visibilitychange', onVisible)
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setSync({ phase: 'offline', message: '设备已离线，改动已保存在本机' })
  }
  return () => {
    clearTimeout(retryTimer)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
