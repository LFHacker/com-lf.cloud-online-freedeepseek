/**
 * 费用计算。
 *
 * 价格来自 DeepSeek 官方定价页（2026-11-18 抓取，模型 DeepSeek-V4.1-Flash-1017）：
 *
 *   1M 输入 token（缓存命中）  谷时 $0.003   峰时 $0.006
 *   1M 输入 token（缓存未命中）谷时 $0.15    峰时 $0.30
 *   1M 输出 token              谷时 $0.60    峰时 $1.20
 *
 * 峰时 = UTC 周一至周五 01:00–04:00 与 06:00–10:00（中国法定节假日除外；
 * 节假日无法从代码判断，所以这里不处理，误差只影响那几个小时的估算）。
 *
 * ⚠️ 这里算的是**估算值**：金额以平台实际扣费为准。
 * 价格随时会变，所以单价支持用环境变量覆盖，改价不用改代码。
 */

export type PriceTable = {
  /** 美元 / 百万 token */
  cacheHit: number
  cacheMiss: number
  output: number
  currency: 'USD'
}

export type UsageNumbers = {
  /** 缓存命中的输入 token */
  cacheHit: number
  /** 未命中的输入 token（含缓存写入） */
  cacheMiss: number
  output: number
}

export type CostEstimate = {
  inputCacheHit: number
  inputCacheMiss: number
  output: number
  total: number
  /** 本次是否按峰时价计算 */
  peak: boolean
  currency: 'USD'
}

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** 峰时单价（默认为峰时；谷时是其一半） */
export const readPriceTable = (env: NodeJS.ProcessEnv): PriceTable => ({
  cacheHit: num(env.PRICE_CACHE_HIT_PEAK, 0.006),
  cacheMiss: num(env.PRICE_CACHE_MISS_PEAK, 0.3),
  output: num(env.PRICE_OUTPUT_PEAK, 1.2),
  currency: 'USD',
})

/** 谷时单价 = 峰时 / 2（官方口径） */
export const offPeakTable = (peak: PriceTable): PriceTable => ({
  cacheHit: peak.cacheHit / 2,
  cacheMiss: peak.cacheMiss / 2,
  output: peak.output / 2,
  currency: peak.currency,
})

/**
 * 现在是否峰时。
 * UTC 周一至周五（getUTCDay 1..5）的 01:00–04:00 与 06:00–10:00。
 */
export const isPeakNow = (now = new Date()): boolean => {
  const day = now.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  const inRange = (start: number, end: number) => minutes >= start * 60 && minutes < end * 60
  return inRange(1, 4) || inRange(6, 10)
}

/** 按当前时段算一次调用的费用（美元） */
export const estimateCost = (
  usage: UsageNumbers,
  peak: PriceTable,
  now = new Date()
): CostEstimate => {
  const table = isPeakNow(now) ? peak : offPeakTable(peak)
  const perMillion = (tokens: number, price: number) => (tokens / 1_000_000) * price
  const inputCacheHit = perMillion(usage.cacheHit, table.cacheHit)
  const inputCacheMiss = perMillion(usage.cacheMiss, table.cacheMiss)
  const output = perMillion(usage.output, table.output)
  return {
    inputCacheHit,
    inputCacheMiss,
    output,
    total: inputCacheHit + inputCacheMiss + output,
    peak: isPeakNow(now),
    currency: 'USD',
  }
}

/** 把两家 API 的 usage 字段统一成内部形状 */
export const normalizeUsage = (raw: unknown): UsageNumbers | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const record = raw as Record<string, unknown>
  const pick = (...keys: string[]): number => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value
      }
    }
    return 0
  }
  const details = record.prompt_tokens_details as Record<string, unknown> | undefined
  const cached = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0
  const hit = pick('prompt_cache_hit_tokens', 'cache_read_input_tokens') || cached
  const missExplicit = pick('prompt_cache_miss_tokens', 'cache_creation_input_tokens')
  // Anthropic 的 input_tokens 就是"未缓存部分"
  const anthopicInput = pick('input_tokens')
  const totalPrompt = pick('prompt_tokens')
  const miss = missExplicit > 0 ? missExplicit : anthopicInput > 0 ? anthopicInput : Math.max(0, totalPrompt - hit)
  const output = pick('completion_tokens', 'output_tokens')
  if (hit === 0 && miss === 0 && output === 0) {
    return null
  }
  return { cacheHit: hit, cacheMiss: miss, output }
}
