/**
 * 网关限流 —— 自用部署的兜底保护。
 *
 * 防的不是黑客，是两件更现实的事：
 *  1. 网关令牌泄露后，别人拿你的 DeepSeek Key 刷钱
 *  2. 客户端出 bug 疯狂重试，一夜之间烧掉几百块
 *
 * 用滑动窗口而不是固定窗口：固定窗口在边界处会放行双倍流量
 * （59 秒来一批、61 秒再来一批，两批都不超限但实际速率翻倍）。
 */

export type RateDecision = {
  allowed: boolean
  /** 被拒时建议等待的秒数（写进 Retry-After） */
  retryAfterSeconds: number
  /** 本窗口内还剩多少次 */
  remaining: number
}

export type RateLimiterOptions = {
  /** 窗口长度（毫秒） */
  windowMs: number
  /** 单窗口内允许的请求数 */
  maxPerWindow: number
  /** 最多跟踪多少个来源键，防止被大量不同 IP 撑爆内存 */
  maxKeys: number
}

export type RateLimiter = {
  check(key: string, now?: number): RateDecision
  /** 当前跟踪的来源数量，测试与观测用 */
  size(): number
  /** 清掉某来源的记录（例如人工解封） */
  reset(key: string): void
}

export const createRateLimiter = (options: RateLimiterOptions): RateLimiter => {
  const { windowMs, maxPerWindow, maxKeys } = options
  /** 每个来源键 → 该窗口内的请求时间戳（升序） */
  const hits = new Map<string, number[]>()

  /** 丢掉过期时间戳，返回剩下的 */
  const prune = (list: number[], now: number): number[] => {
    const cutoff = now - windowMs
    // 时间戳升序，找到第一个未过期的位置即可整段切掉
    let index = 0
    while (index < list.length && (list[index] ?? 0) <= cutoff) {
      index += 1
    }
    return index === 0 ? list : list.slice(index)
  }

  return {
    check(key, now = Date.now()) {
      const existing = hits.get(key)
      const list = existing ? prune(existing, now) : []

      if (list.length >= maxPerWindow) {
        // 窗口内最早那次请求过期后才会重新放行
        const oldest = list[0] ?? now
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
        hits.set(key, list)
        return { allowed: false, retryAfterSeconds, remaining: 0 }
      }

      list.push(now)

      // 来源过多时淘汰最久未活动的，避免内存无上限增长
      if (!existing && hits.size >= maxKeys) {
        let oldestKey: string | null = null
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [candidate, timestamps] of hits) {
          const last = timestamps.at(-1) ?? 0
          if (last < oldestAt) {
            oldestAt = last
            oldestKey = candidate
          }
        }
        if (oldestKey !== null) {
          hits.delete(oldestKey)
        }
      }

      hits.set(key, list)
      return { allowed: true, retryAfterSeconds: 0, remaining: maxPerWindow - list.length }
    },

    size() {
      return hits.size
    },

    reset(key) {
      hits.delete(key)
    },
  }
}
