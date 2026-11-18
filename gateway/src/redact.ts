/**
 * 日志脱敏。
 *
 * 背景：用户的 DeepSeek 官方 Key 会随每个请求经过我们的进程（这是「网关转发」模式
 * 无法回避的事实），但我们承诺**不在服务端留下任何可读的 Key**。
 * 内存里存在是必要的，落盘就是事故 —— 这个模块唯一的职责就是保证落盘前被替换掉。
 *
 * 覆盖两种形态：
 *  1. 裸 Key：`sk-xxxxx…`
 *  2. 带字段名的：`x-deepseek-key: sk-xxxxx`、`"key":"sk-xxxxx"`
 */
const RAW_KEY = /sk-[A-Za-z0-9_-]{16,}/g
const NAMED_KEY = /((?:x-deepseek-key|api[_-]?key|authorization)["'\]\s:=]+)(?:Bearer\s+)?([A-Za-z0-9_-]{16,})/gi

/** 替换成固定占位，保留"这里原本有个密钥"的信息，便于排查 */
export const REDACTED = 'sk-***'

export const redactSecrets = (text: string): string => {
  if (!text) {
    return text
  }
  return text.replace(NAMED_KEY, (_match, prefix: string) => `${prefix}${REDACTED}`).replace(RAW_KEY, REDACTED)
}

/** 递归脱敏对象里的字符串（诊断日志有时是 JSON 对象） */
export const redactDeep = <T>(value: T): T => {
  if (typeof value === 'string') {
    return redactSecrets(value) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = /key|token|secret/i.test(key) && typeof item === 'string' ? REDACTED : redactDeep(item)
    }
    return out as unknown as T
  }
  return value
}
