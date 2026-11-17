import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Modal } from '../base/Modal.js'
import { IconSearchOutline16, IconTrashOutline16 } from '../base/icons.js'
import {
  deleteMemories,
  loadMemories,
  loadMemoryStats,
  previewRecall,
  type MemoryItem,
  type MemoryStats,
  type RecallHit,
} from '../../services/memory/client.js'
import { closeMemoryDialog, useMemoryDialog } from './memoryDialogState.js'
import styles from './MemoryDialog.module.css'

const formatTime = (ms: number): string => {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

type Phase = 'loading' | 'ready' | 'error'

export const MemoryDialog = () => {
  const t = useTranslate()
  const open = useMemoryDialog((state) => state.open)
  const [tab, setTab] = useState<'list' | 'recall'>('list')
  const [phase, setPhase] = useState<Phase>('loading')
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [keyword, setKeyword] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [recallHits, setRecallHits] = useState<RecallHit[] | null>(null)
  const [recalling, setRecalling] = useState(false)
  const confirmTimer = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    setPhase('loading')
    try {
      const [nextStats, nextItems] = await Promise.all([loadMemoryStats(), loadMemories(keyword)])
      setStats(nextStats)
      setItems(nextItems)
      setPhase('ready')
    } catch {
      setPhase('error')
    }
  }, [keyword])

  useEffect(() => {
    if (!open) {
      return
    }
    setRecallHits(null)
    setPendingDelete(null)
    void refresh()
  }, [open, refresh])

  useEffect(
    () => () => {
      if (confirmTimer.current !== null) {
        window.clearTimeout(confirmTimer.current)
      }
    },
    []
  )

  const onDelete = async (id: string) => {
    if (pendingDelete !== id) {
      // 两段式确认：比原生 confirm 更顺手，也不用弹系统对话框
      setPendingDelete(id)
      if (confirmTimer.current !== null) {
        window.clearTimeout(confirmTimer.current)
      }
      confirmTimer.current = window.setTimeout(() => setPendingDelete(null), 4000)
      return
    }
    if (confirmTimer.current !== null) {
      window.clearTimeout(confirmTimer.current)
    }
    setPendingDelete(null)
    try {
      await deleteMemories([id])
      setItems((previous) => previous.filter((item) => item.id !== id))
      setStats((previous) => (previous ? { ...previous, chunks: previous.chunks - 1 } : previous))
    } catch {
      setPhase('error')
    }
  }

  const runRecall = async () => {
    if (!query.trim() || recalling) {
      return
    }
    setRecalling(true)
    try {
      setRecallHits(await previewRecall(query.trim()))
    } catch {
      setRecallHits([])
    } finally {
      setRecalling(false)
    }
  }

  const maxScore = Math.max(...(recallHits ?? []).map((hit) => Math.abs(hit.score)), 0.0001)

  // ⚠️ 必须在这里拦住：Modal 本身不管开关，若只靠 open 控制数据加载，
  // 对话框会一直挂在页面上（实测截图时发现它和设置弹窗同时存在）。
  if (!open) {
    return null
  }

  return (
    <Modal
      title={t('memoryTitle')}
      closable
      onClose={closeMemoryDialog}
      className={styles.wide}
      mainClassName={styles.main}
    >
      <div className={styles.chips}>
        <span className={styles.chip}>
          {t('memoryStatSessions')}
          <b>{stats?.sessions ?? 0}</b>
        </span>
        <span className={styles.chip}>
          {t('memoryStatChunks')}
          <b>{stats?.chunks ?? 0}</b>
        </span>
        {stats?.usageRows ? (
          <span className={styles.chip}>
            {t('memoryStatUsed')}
            <b>{stats.usageRows}</b>
          </span>
        ) : null}
        <span className={clsx(styles.chip, stats?.vectors && styles.chipOn)}>
          {t('memoryStatVectors')}
          <b>{stats?.vectors ? t('memoryStatOn') : t('memoryStatOff')}</b>
        </span>
      </div>

      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'list'}
          className={clsx(styles.tab, tab === 'list' && styles.tabOn)}
          onClick={() => setTab('list')}
        >
          {t('memoryTabList')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'recall'}
          className={clsx(styles.tab, tab === 'recall' && styles.tabOn)}
          onClick={() => setTab('recall')}
        >
          {t('memoryTabRecall')}
        </button>
      </div>

      {tab === 'list' ? (
        <>
          <div className={styles.searchRow}>
            <span className={styles.searchIcon}>
              <IconSearchOutline16 />
            </span>
            <input
              className={styles.search}
              type="search"
              value={keyword}
              placeholder={t('memorySearchPlaceholder')}
              aria-label={t('memorySearchPlaceholder')}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void refresh()
                }
              }}
            />
          </div>
          <p className={styles.hint}>{t('memoryListHint')}</p>

          <div className={styles.list}>
            {phase === 'loading' ? (
              <>
                <div className={clsx(styles.card, styles.skeleton)} />
                <div className={clsx(styles.card, styles.skeleton)} />
              </>
            ) : phase === 'error' ? (
              <p className={styles.empty}>{t('memoryLoadFailed')}</p>
            ) : items.length === 0 ? (
              <p className={styles.empty}>
                {keyword ? t('memoryEmptySearch') : t('memoryEmpty')}
              </p>
            ) : (
              items.map((item) => (
                <article key={item.id} className={styles.card}>
                  <header className={styles.cardHead}>
                    <span className={styles.stamp}>{formatTime(item.createdAt)}</span>
                    <span className={styles.stamp}>
                      {t('memorySessionTag', { id: item.sessionId.slice(0, 8) })}
                    </span>
                    {item.hits > 0 ? (
                      <span className={clsx(styles.stamp, styles.stampHit)}>
                        {t('memoryHits', { count: item.hits })}
                      </span>
                    ) : null}
                  </header>
                  <p className={styles.body}>{item.body}</p>
                  <footer className={styles.cardFoot}>
                    <button
                      type="button"
                      className={clsx(
                        styles.delete,
                        pendingDelete === item.id && styles.deleteArmed
                      )}
                      onClick={() => void onDelete(item.id)}
                    >
                      <IconTrashOutline16 />
                      {pendingDelete === item.id ? t('memoryDeleteConfirm') : t('memoryDelete')}
                    </button>
                  </footer>
                </article>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <div className={styles.searchRow}>
            <input
              className={clsx(styles.search, styles.searchPlain)}
              type="text"
              value={query}
              placeholder={t('memoryRecallPlaceholder')}
              aria-label={t('memoryRecallPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void runRecall()
                }
              }}
            />
            <button type="button" className={styles.run} onClick={() => void runRecall()}>
              {recalling ? t('memoryLoading') : t('memoryRecallRun')}
            </button>
          </div>
          <p className={styles.hint}>{t('memoryRecallHint')}</p>

          <div className={styles.list}>
            {recallHits === null ? null : recallHits.length === 0 ? (
              <div className={styles.emptyBox}>
                <p className={styles.empty}>{t('memoryRecallEmpty')}</p>
                <p className={styles.emptyHint}>{t('memoryRecallEmptyHint')}</p>
              </div>
            ) : (
              recallHits.map((hit, index) => {
                // score 是 bm25 原始值（负数，越负越相关），直接显示毫无意义。
                // 这里换算成「同批结果内的相对强度」，只用于判断哪条更相关。
                const magnitude = Math.abs(hit.score)
                const ratio = magnitude / maxScore
                const hasSignal = magnitude >= 0.001
                return (
                  <article key={`${hit.sessionId}-${index}`} className={styles.card}>
                    <header className={styles.cardHead}>
                      <span className={clsx(styles.stamp, styles.stampRank)}>#{index + 1}</span>
                      <span className={styles.stamp}>{formatTime(hit.createdAt)}</span>
                      <span className={styles.stamp}>
                        {t('memorySessionTag', { id: hit.sessionId.slice(0, 8) })}
                      </span>
                    </header>
                    <p className={styles.body}>{hit.body}</p>
                    <div className={styles.scoreRow}>
                      {hasSignal ? (
                        <>
                          <span className={styles.scoreBar} aria-hidden>
                            <span
                              className={styles.scoreFill}
                              style={{ width: `${Math.max(6, ratio * 100)}%` }}
                            />
                          </span>
                          <span className={styles.scoreValue}>{Math.round(ratio * 100)}%</span>
                        </>
                      ) : (
                        // 2 字回退命中没有 bm25 分数，显示 0.000 会让人以为"不相关"，
                        // 换成明确说明"这是关键词补漏"
                        <span className={styles.scoreTag}>{t('memoryKeywordHit')}</span>
                      )}
                    </div>
                  </article>
                )
              })
            )}
          </div>
        </>
      )}
    </Modal>
  )
}
