/**
 * 退避时长（纯函数，方便单测）。
 *
 * 为什么要有抖动：多台设备/多个队列条目在同一时刻失败时，
 * 固定间隔会让它们每分钟同时打一次网关（惊群），退避就失去意义。
 */
export const BASE_DELAY_MS = 2_000
export const MAX_DELAY_MS = 60_000

/**
 * 第 n 次失败后等多久（n 从 1 开始）：2s、4s、8s、16s、32s、60s…，每次 ±20% 抖动。
 * 上限 60s：手机锁屏几小时后再打开，重新同步不该再等更久。
 */
export const backoffDelay = (attempts: number, random: () => number = Math.random): number => {
  const exponent = Math.min(6, Math.max(0, Math.floor(attempts) - 1))
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent)
  const jitter = 0.8 + random() * 0.4
  return Math.round(base * jitter)
}
