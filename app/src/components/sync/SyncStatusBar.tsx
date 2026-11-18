import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { retryOutboxEntry, useOutbox } from '../../services/sync/outbox.js'
import { retrySyncNow } from '../../services/sync/engine.js'
import { useSync } from '../../services/sync/status.js'
import { Button } from '../base/Button.js'
import styles from './SyncStatusBar.module.css'

/**
 * 顶部同步状态条（阶段 2-3）。
 *
 * 只在"有事要说"的时候出现：正常且无待发送时完全隐藏，不占一行高度。
 * 三种必须让用户看见的情况：
 *  · 正在同步 / 正在退避重试（说明数据还没落云端，但也别慌）
 *  · 离线（改动在本机，联网会自动补）
 *  · 有消息发送失败（不可重试，要用户处理或点重试）
 */
export const SyncStatusBar = () => {
  const t = useTranslate()
  const phase = useSync((state) => state.phase)
  const retryAt = useSync((state) => state.retryAt)
  const detail = useSync((state) => state.message)
  const entries = useOutbox((state) => state.entries)
  const [now, setNow] = useState(Date.now)

  // 只有在等待重试时才需要秒级刷新，其余状态不要白跑定时器
  useEffect(() => {
    if (retryAt <= 0) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [retryAt])

  const list = Object.values(entries)
  const pending = list.filter((entry) => entry.status !== 'failed').length
  const failedList = list.filter((entry) => entry.status === 'failed')
  const failed = failedList.length
  const seconds = retryAt > 0 ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0
  const visible = phase !== 'idle' || pending > 0 || failed > 0
  if (!visible) {
    return null
  }

  const text = (() => {
    if (failed > 0) {
      return t('syncStatusFailed', { count: failed })
    }
    if (phase === 'syncing') {
      return t('syncStatusSyncing')
    }
    if (phase === 'retrying') {
      return seconds > 0 ? t('syncStatusRetrying', { seconds }) : t('syncStatusRetryNow')
    }
    if (phase === 'offline') {
      const base = detail || t('syncStatusOffline')
      return pending > 0 ? `${base} · ${t('syncStatusPending', { count: pending })}` : base
    }
    if (phase === 'error') {
      return detail || t('syncStatusError')
    }
    return pending > 0 ? t('syncStatusPending', { count: pending }) : ''
  })()

  const tone = failed > 0 || phase === 'error' ? 'error' : phase === 'offline' ? 'offline' : phase === 'syncing' ? 'active' : 'wait'

  return (
    <div className={styles.bar} role="status" aria-live="polite">
      <span className={`${styles.dot} ${styles[tone]}`} aria-hidden />
      <span className={styles.text}>{text}</span>
      {failed > 0 ? (
        <Button
          variant="outlined"
          size="s"
          onClick={() => {
            for (const entry of failedList) {
              void retryOutboxEntry(entry.id)
            }
          }}
        >
          {t('syncStatusRetry')}
        </Button>
      ) : phase === 'retrying' || phase === 'offline' || phase === 'error' ? (
        <Button variant="outlined" size="s" onClick={() => void retrySyncNow()}>
          {t('syncStatusRetry')}
        </Button>
      ) : null}
    </div>
  )
}
