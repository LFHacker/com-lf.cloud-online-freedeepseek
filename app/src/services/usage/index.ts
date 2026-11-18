/**
 * 用量与费用。
 *
 * 设计取舍：
 *  · 价格**不写死在 App 里** —— 单价会变（官方还有峰谷价），所以从网关 `/usage/pricing` 拉，
 *    本地缓存 10 分钟。拿不到价格时就显示 token 数、费用显示"—"，
 *    而不是用陈旧单价算出一个看着精确的错数。
 *  · 余额用**用户自己的 Key** 查（网关只做转发，不保存 Key）。
 *  · 全程只做估算：真实扣费以平台为准，界面上必须写清楚。
 */
import { apiOrigin } from '../api/client.js'
import { useSettings } from '../settings.js'
import { cachedUpstreamKey } from '../secure/upstreamKey.js'

export type UsageNumbers = {
  /** 缓存命中的输入 token */
  cacheHit: number
  /** 未命中的输入 token */
  cacheMiss: number
  output: number
}

export type PriceTable = {
  cacheHit: number
  cacheMiss: number
  output: number
  currency: string
}

export type Pricing = {
  peak: boolean
  currency: string
  peakTable: PriceTable
  offPeakTable: PriceTable
  peakWindows: string
  unit: string
  note: string
}

export type Cost = {
  total: number
  cacheHit: number
  cacheMiss: number
  output: number
  peak: boolean
  currency: string
}

export type BalanceInfo = {
  currency: string
  total: string
  granted: string
  toppedUp: string
}

const PRICING_TTL_MS = 10 * 60_000
let pricingCache: { at: number; value: Pricing } | null = null

/****
 * 会话令牌（认「你是谁」）。
 * 
 * 注意：它存在 settings.apiKey 里 —— 这是当初引入账号系统时的有意设计，
 * 让已有的聊天/上传/记忆代码完全不用改（它们本来就只认 apiKey）。
 */
const sessionToken = (): string => useSettings.getState().apiKey ?? ''
/** 官方 Key（网关只转发，不留存） */
const upstreamKey = (): string => cachedUpstreamKey() ?? ''

/** 峰时判断与网关保持一致：UTC 周一至周五 01–04、06–10 */
const isPeak = (now = new Date()): boolean => {
  const day = now.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  const within = (start: number, end: number) => minutes >= start * 60 && minutes < end * 60
  return within(1, 4) || within(6, 10)
}

export const loadPricing = async (force = false): Promise<Pricing | null> => {
  if (!force && pricingCache && Date.now() - pricingCache.at < PRICING_TTL_MS) {
    return pricingCache.value
  }
  try {
    const response = await fetch(`${apiOrigin()}/usage/pricing`, {
      headers: { 'x-api-key': sessionToken() },
    })
    if (!response.ok) {
      return pricingCache?.value ?? null
    }
    const value = (await response.json()) as Pricing
    pricingCache = { at: Date.now(), value }
    return value
  } catch {
    return pricingCache?.value ?? null
  }
}

const perMillion = (tokens: number, price: number): number => (tokens / 1_000_000) * price

/** 按"现在是否峰时"算一次调用的费用 */
export const costOf = (usage: UsageNumbers, pricing: Pricing | null, now = new Date()): Cost | null => {
  if (!pricing) {
    return null
  }
  const peak = isPeak(now)
  const table = peak ? pricing.peakTable : pricing.offPeakTable
  const cacheHit = perMillion(usage.cacheHit, table.cacheHit)
  const cacheMiss = perMillion(usage.cacheMiss, table.cacheMiss)
  const output = perMillion(usage.output, table.output)
  return {
    total: cacheHit + cacheMiss + output,
    cacheHit,
    cacheMiss,
    output,
    peak,
    currency: pricing.currency,
  }
}

/**
 * 从消息里存的 usage 取出三项。
 * Anthropic 的 input_tokens 只是"未缓存部分"，总输入要加上缓存读取。
 */
export const usageOf = (usage: unknown): UsageNumbers | null => {
  if (!usage || typeof usage !== 'object') {
    return null
  }
  const record = usage as Record<string, unknown>
  const num = (key: string): number => {
    const value = record[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  const cacheHit = num('cache_read_input_tokens') || num('prompt_cache_hit_tokens')
  const inputTokens = num('input_tokens') || num('prompt_tokens')
  const cacheCreation = num('cache_creation_input_tokens')
  const cacheMiss = Math.max(0, inputTokens - 0) + cacheCreation
  const output = num('output_tokens') || num('completion_tokens')
  if (cacheHit === 0 && cacheMiss === 0 && output === 0) {
    return null
  }
  return { cacheHit, cacheMiss, output }
}

/** 缓存命中率：命中 / 总输入 */
export const hitRate = (usage: UsageNumbers): number | null => {
  const total = usage.cacheHit + usage.cacheMiss
  return total > 0 ? (usage.cacheHit / total) * 100 : null
}

export const sumUsage = (list: UsageNumbers[]): UsageNumbers =>
  list.reduce(
    (acc, item) => ({
      cacheHit: acc.cacheHit + item.cacheHit,
      cacheMiss: acc.cacheMiss + item.cacheMiss,
      output: acc.output + item.output,
    }),
    { cacheHit: 0, cacheMiss: 0, output: 0 }
  )

/** 余额（用用户自己的 Key，网关只转发） */
export const loadBalance = async (): Promise<{ available: boolean; infos: BalanceInfo[] } | null> => {
  const key = upstreamKey()
  if (!key) {
    return null
  }
  try {
    const response = await fetch(`${apiOrigin()}/usage/balance`, {
      headers: { 'x-api-key': sessionToken(), 'x-deepseek-key': key },
    })
    if (!response.ok) {
      return null
    }
    const payload = (await response.json()) as {
      is_available?: boolean
      balance_infos?: Array<{
        currency?: string
        total_balance?: string
        granted_balance?: string
        topped_up_balance?: string
      }>
    }
    return {
      available: Boolean(payload.is_available),
      infos: (payload.balance_infos ?? []).map((item) => ({
        currency: item.currency ?? 'CNY',
        total: item.total_balance ?? '0',
        granted: item.granted_balance ?? '0',
        toppedUp: item.topped_up_balance ?? '0',
      })),
    }
  } catch {
    return null
  }
}

/** token 数字的人类可读形式：1234 → 1.2k */
export const formatTokens = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0'
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`
  }
  return String(Math.round(value))
}

/** 费用：金额很小，保留足够位数才有意义（$0.0004） */
export const formatCost = (value: number, currency = 'USD'): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return currency === 'USD' ? '$0' : '¥0'
  }
  const symbol = currency === 'USD' ? '$' : '¥'
  if (value < 0.0001) {
    return `${symbol}${value.toExponential(1)}`
  }
  if (value < 0.01) {
    return `${symbol}${value.toFixed(4)}`
  }
  return `${symbol}${value.toFixed(3)}`
}

/**
 * 查询本会话最近一轮是否写进了记忆。
 *
 * 为什么单独查：写记忆发生在**流式响应结束之后**，那时响应头已经发出去了，
 * 没法在同一个响应里告诉客户端。所以回答结束后单独问一次。
 */
export const loadTurnMemory = async (
  sessionId: string
): Promise<{ recorded: boolean | null; chunks: number } | null> => {
  if (!sessionId) {
    return null
  }
  try {
    const response = await fetch(
      `${apiOrigin()}/memory/last-turn?session=${encodeURIComponent(sessionId)}`,
      { headers: { 'x-api-key': sessionToken() } }
    )
    if (!response.ok) {
      return null
    }
    const payload = (await response.json()) as { recorded?: boolean | null; chunks?: number }
    return { recorded: payload.recorded ?? null, chunks: payload.chunks ?? 0 }
  } catch {
    return null
  }
}
