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
 * 信息取舍：
 *  · 缓存命中率、输入/输出 token、费用 —— 每轮都能从 usage 里拿到，**持久**可见
 *  · 记忆条数、上下文长度 —— 来自响应头，只能拿到最近一次（刷新页面即失去），
 *    所以只在最后一条回答上显示，并且明确这是"本轮"
 *
 * 为什么费用写"估算"：单价随平台调价与峰谷时段变化，
 * 界面上给一个精确到小数的数字会让人以为是账单。
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

  return (
    <div className={styles.line}>
      {rate === null ? null : (
        <span className={styles.item} title={t('statsCacheHint')}>
          {t('statsCache')} <b>{rate.toFixed(0)}%</b>
        </span>
      )}
      <span className={styles.item}>
        {t('statsTokens')}{' '}
        <b>
          {formatTokens(numbers.cacheHit + numbers.cacheMiss)} → {formatTokens(numbers.output)}
        </b>
      </span>
      {meta ? (
        <>
          <span className={styles.item} title={t('statsMemoryHint')}>
            {t('statsMemory')} <b>{meta.memoryHits}</b>
          </span>
          <span className={styles.item} title={t('statsContextHint')}>
            {t('statsContext')} <b>{formatTokens(meta.contextTokens)}</b>
          </span>
        </>
      ) : null}
      {cost ? (
        <span className={styles.item} title={cost.peak ? t('statsPeak') : t('statsOffPeak')}>
          {t('statsCost')} <b>{formatCost(cost.total, cost.currency)}</b>
          <em className={styles.estimate}>{t('statsEstimate')}</em>
        </span>
      ) : null}
    </div>
  )
}
