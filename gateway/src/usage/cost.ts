/**
 * 费用计算。
 *
 * 价格来自 DeepSeek 官方定价页**中文版**（2026-11-18 抓取，模型 DeepSeek-V4.1-Flash-1017）：
 *
 *   1M 输入 token（缓存命中）  空闲 0.02 元   高峰 0.04 元
 *   1M 输入 token（缓存未命中）空闲 1 元      高峰 2 元
 *   1M 输出 token              空闲 4 元      高峰 8 元
 *
 * ⚠️ 第一版用的是英文页的**美元**价，还把峰时按 UTC 算（01–04、06–10），
 * 两者都错：平台按人民币计费，峰时是**北京时间**周一至周五 9:00–12:00、14:00–18:00。
 * 币种和时段都错，算出来的数当然和平台对不上。
 *
 * 中国法定节假日无法从代码判断，所以不处理 —— 只影响那几个小时的估算。
 *
 * ⚠️ 这里算的是**估算值**：金额以平台实际扣费为准。
 * 价格随时会变，所以单价支持用环境变量覆盖，改价不用改代码。
 */

export type PriceTable = {
  /** 元 / 百万 token */
  cacheHit: number
  cacheMiss: number
  output: number
  currency: 'CNY'
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
  currency: 'CNY'
}

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** 峰时单价（元 / 百万 token）；空闲价 = 峰时 / 2 */
export const readPriceTable = (env: NodeJS.ProcessEnv): PriceTable => ({
  cacheHit: num(env.PRICE_CACHE_HIT_PEAK, 0.04),
  cacheMiss: num(env.PRICE_CACHE_MISS_PEAK, 2),
  output: num(env.PRICE_OUTPUT_PEAK, 8),
  currency: 'CNY',
})

/** 谷时单价 = 峰时 / 2（官方口径） */
export const offPeakTable = (peak: PriceTable): PriceTable => ({
  cacheHit: peak.cacheHit / 2,
  cacheMiss: peak.cacheMiss / 2,
  output: peak.output / 2,
  currency: peak.currency,
})

/**
 * 现在是否高峰时段。
 *
 * 官方口径：**北京时间（UTC+8）周一至周五 9:00–12:00、14:00–18:00**。
 * 其余时间（含周末全天）为空闲时段，价格减半。
 */
export const isPeakNow = (now = new Date()): boolean => {
  // 换算到北京时间：用 UTC 时间戳 +8 小时，避免依赖运行机器的时区
  const beijing = new Date(now.getTime() + 8 * 3_600_000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  const inRange = (start: number, end: number) => minutes >= start * 60 && minutes < end * 60
  return inRange(9, 12) || inRange(14, 18)
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
    currency: 'CNY',
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
