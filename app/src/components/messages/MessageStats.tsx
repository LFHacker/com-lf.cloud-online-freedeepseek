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
 * 用户原话是"看不懂啊"。现在每一项都自带主语和单位。
 *
 * 信息取舍：
 *  · 缓存命中率、输入/输出 token、费用、会话累计 —— 从消息里持久的数据算，刷新也在
 *  · 记忆条数、上下文长度 —— 来自响应头，只能拿到最近一次，所以只在最后一条显示
 */
export const MessageStats = ({
  usage,
  isLast,
}: {
  usage: unknown
  isLast: boolean
}) => {
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

  return (
    <>
      <div className={styles.line}>
        <span className={styles.item}>
          {t('statsInput')} <b>{formatTokens(numbers.cacheHit + numbers.cacheMiss)}</b> token
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
          {t('statsOutput')} <b>{formatTokens(numbers.output)}</b> token
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
              {t('statsCostAbout')} <b>{formatCost(cost.total, cost.currency)}</b>（
              {t('statsEstimate')}）
            </span>
          </>
        ) : null}
      </div>
      {/* 会话累计已移到输入框上方常驻显示（SessionUsageBar），这里只管本轮 */}
    </>
  )
}
