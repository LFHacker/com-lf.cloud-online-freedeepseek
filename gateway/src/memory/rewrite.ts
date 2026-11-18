/**
 * 查询改写：把用户的口语化长问题，改写成若干条**检索友好**的短串。
 *
 * 为什么有用（也是为什么不一定有用）：
 * 记忆检索是「词法 + 向量」双路。长句里混着语气词、指代、多主题，
 * 词法那一路会被稀释，向量那一路则被整句的平均语义带走。
 * 拆成 2–3 个聚焦短语后，两路都更容易命中。
 *
 * ⚠️ 但它**不能弥补**"库里根本没有这段内容"，也不保证一定提升——
 * 所以做了开关、超时和"失败即退回原查询"。
 */
import type { MemoryHit } from './store.ts'

export type RewriteConfig = {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  /** 生成几个变体（不含原问题） */
  variants: number
}

export const readRewriteConfig = (env: NodeJS.ProcessEnv): RewriteConfig | null => {
  const apiKey = env.MEMORY_REWRITE_API_KEY ?? env.DEEPSEEK_API_KEY ?? ''
  if ((env.MEMORY_REWRITE ?? '1') === '0' || !apiKey) {
    return null
  }
  return {
    enabled: true,
    baseUrl: (env.MEMORY_REWRITE_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey,
    model: env.MEMORY_REWRITE_MODEL ?? 'deepseek-chat',
    timeoutMs: Number(env.MEMORY_REWRITE_TIMEOUT_MS ?? 1500),
    variants: Math.max(1, Math.min(4, Number(env.MEMORY_REWRITE_VARIANTS ?? 3))),
  }
}

/** 简单 LRU：同一句话反复问（比如刷新重发）不必重复花钱 */
const CACHE_LIMIT = 200
const cache = new Map<string, string[]>()

const cacheGet = (key: string): string[] | undefined => {
  const hit = cache.get(key)
  if (hit) {
    // 命中即刷新顺序
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

const cacheSet = (key: string, value: string[]): void => {
  cache.set(key, value)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) {
      cache.delete(oldest)
    }
  }
}

export type QueryRewriter = (query: string) => Promise<string[]>

/**
 * 生成改写变体（不含原问题）。
 *
 * 失败、超时、模型答非所问 → 一律返回空数组，
 * 调用方拿到的检索词就只剩原问题，等价于没开这个功能。
 */
export const createQueryRewriter = (config: RewriteConfig): QueryRewriter => {
  return async (query: string): Promise<string[]> => {
    const text = query.trim()
    if (text.length < 6) {
      return []
    }
    const cached = cacheGet(text)
    if (cached) {
      return cached
    }

    const prompt = [
      '把下面的问题改写成若干条用于**全文检索**的短语，每条单独一行。',
      '要求：',
      '1. 保留关键的专有名词、型号、报错名、人名、数字（原样保留，不要翻译）',
      '2. 每条 2–12 个字，去掉语气词和指代（"这个""那个""帮我"）',
      '3. 可以从不同角度写：同义说法、上位概念、可能的原文用词',
      `4. 只输出 ${config.variants} 行，不要编号、不要解释、不要引号`,
      '',
      `问题：${text}`,
    ].join('\n')

    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 120,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
      if (!response.ok) {
        console.warn(`[memory] 查询改写 HTTP ${response.status}，本次只用原问题`)
        return []
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const lines = (payload.choices?.[0]?.message?.content ?? '')
        .split('\n')
        .map((line) => line.replace(/^[\s\-*\d.、)）]+/u, '').trim())
        .filter((line) => line.length >= 2 && line.length <= 40)
        .slice(0, config.variants)

      // 与原问题完全相同的变体没有意义
      const unique = lines.filter((line) => line !== text)
      if (unique.length === 0) {
        return []
      }
      cacheSet(text, unique)
      return unique
    } catch (error) {
      console.warn(
        `[memory] 查询改写失败，本次只用原问题：${error instanceof Error ? error.message : String(error)}`
      )
      return []
    }
  }
}

/** 把原问题与变体合成检索词列表：原问题永远排第一（重排会用它打分） */
export const buildSearchTexts = async (
  rewrite: QueryRewriter | null,
  query: string
): Promise<string[]> => {
  if (!rewrite) {
    return [query]
  }
  const variants = await rewrite(query)
  return [query, ...variants]
}

export type { MemoryHit }
