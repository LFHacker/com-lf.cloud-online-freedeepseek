import { useEffect, useState } from 'react'
import { readLastTurnMeta } from '../../services/api/client.js'
import {
  costOf,
  formatCost,
  formatTokens,
  hitRate,
  loadPricing,
  usageOf,
  type Pricing,
} from '../../services/usage/index.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './MessageStats.module.css'

/**
 * 一轮回答的用量统计。
 *
 * ⚠️ 文案要求（用户明确提过）：**必须写成能读懂的句子**，不能是一串裸缩写。
 * 第一版写成「缓存命中 83% token 1.2k → 312 记忆 4 上下文 2.8k 费用 $0.0004 估」，
 * 用户原话是"看不懂啊"。
 * 现在每一项都自带主语和单位：
 *   本次输入 1.2k token（其中 83% 命中缓存）· 输出 312 token
 *   · 命中记忆 4 条 · 上下文 2.8k token · 本次费用约 $0.0004（估算）
 *
 * 信息取舍：
 *  · 缓存命中率、输入/输出 token、费用 —— 从 usage 拿，**持久**可见
 *  · 记忆条数、上下文长度 —— 来自响应头，只能拿到最近一次，所以只在最后一条显示
 */
export const MessageStats = ({ usage, isLast }: { usage: unknown; isLast: boolean }) => {
  const t = useTranslate()
  const [pricing, setPricing] = useState<Pricing | null>(null)

  useEffect(() => {
    if (!usage) {
      return
    }
    let alive = true
    void loadPricing().then((value) => {
      if (alive) {
        setPricing(value)
      }
    })
    return () => {
      alive = false
    }
  }, [usage])

  const numbers = usageOf(usage)
  if (!numbers) {
    return null
  }
  const rate = hitRate(numbers)
  const cost = costOf(numbers, pricing)
  const meta = isLast ? readLastTurnMeta() : null
  const input = formatTokens(numbers.cacheHit + numbers.cacheMiss)
  const output = formatTokens(numbers.output)

  return (
    <div className={styles.line}>
      <span className={styles.item}>
        {t('statsInput')} <b>{input}</b> token
        {rate === null ? null : (
          <>
            （{t('statsCacheOf')} <b>{rate.toFixed(0)}%</b> {t('statsCacheHit')}）
          </>
        )}
      </span>
      <span className={styles.sep} aria-hidden>
        ·
      </span>
      <span className={styles.item}>
        {t('statsOutput')} <b>{output}</b> token
      </span>
      {meta ? (
        <>
          <span className={styles.sep} aria-hidden>
            ·
          </span>
          <span className={styles.item}>
            {t('statsMemoryHit')} <b>{meta.memoryHits}</b> {t('statsItems')}
          </span>
          <span className={styles.sep} aria-hidden>
            ·
          </span>
          <span className={styles.item}>
            {t('statsContext')} <b>{formatTokens(meta.contextTokens)}</b> token
          </span>
        </>
      ) : null}
      {cost ? (
        <>
          <span className={styles.sep} aria-hidden>
            ·
          </span>
          <span className={styles.item} title={cost.peak ? t('statsPeak') : t('statsOffPeak')}>
            {t('statsCostAbout')} <b>{formatCost(cost.total, cost.currency)}</b>
            （{t('statsEstimate')}）
          </span>
        </>
      ) : null}
    </div>
  )
}
