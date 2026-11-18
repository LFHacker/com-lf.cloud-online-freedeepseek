import { useEffect, useMemo, useState } from 'react'
import type { Session } from '../../services/chat/types.js'
import { useTranslate } from '../../i18n/index.js'
import {
  costOf,
  formatCost,
  formatTokens,
  hitRate,
  loadPricing,
  usageOf,
  type Pricing,
} from '../../services/usage/index.js'
import styles from './SessionUsageBar.module.css'

/**
 * 输入框下方的「本对话累计」。
 *
 * 为什么放这里而不是回答下面：
 *   用户要的是**一直能看到**——"这个对话到现在一共花了多少"。
 *   挂在最后一条回答下方，一旦往上翻就看不见了；放在输入框上方则始终在视野里。
 *   单轮的用量仍然留在各自回答下方，两者回答的是不同问题。
 *
 * 数据来源：消息里存的 usage（持久），所以刷新、切会话回来都还在。
 */
export const SessionUsageBar = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const [pricing, setPricing] = useState<Pricing | null>(null)

  const totals = useMemo(() => {
    let cacheHit = 0
    let cacheMiss = 0
    let output = 0
    let turns = 0
    for (const message of session.messages) {
      const usage = usageOf((message as { usage?: unknown }).usage)
      if (!usage) {
        continue
      }
      cacheHit += usage.cacheHit
      cacheMiss += usage.cacheMiss
      output += usage.output
      turns += 1
    }
    return { cacheHit, cacheMiss, output, turns }
  }, [session.messages])

  useEffect(() => {
    if (totals.turns === 0) {
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
  }, [totals.turns])

  // 没有用量记录时整条不显示：新会话上方不该出现一行"--"
  if (totals.turns === 0) {
    return null
  }

  const usage = { cacheHit: totals.cacheHit, cacheMiss: totals.cacheMiss, output: totals.output }
  const rate = hitRate(usage)
  const cost = costOf(usage, pricing)

  return (
    <div className={styles.bar}>
      <span className={styles.label}>{t('statsSessionTotal')}</span>
      <span className={styles.item}>
        {totals.turns} {t('statsTurns')}
      </span>
      <span className={styles.sep} aria-hidden>
        ·
      </span>
      <span className={styles.item}>
        {t('statsTotalInput')} <b>{formatTokens(totals.cacheHit + totals.cacheMiss)}</b> token
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
        {t('statsTotalOutput')} <b>{formatTokens(totals.output)}</b> token
      </span>
      {cost ? (
        <>
          <span className={styles.sep} aria-hidden>
            ·
          </span>
          <span className={styles.item} title={cost.peak ? t('statsPeak') : t('statsOffPeak')}>
            {t('statsTotalCost')} <b>{formatCost(cost.total, cost.currency)}</b>（
            {t('statsEstimate')}）
          </span>
        </>
      ) : null}
    </div>
  )
}
