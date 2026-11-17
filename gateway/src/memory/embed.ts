/**
 * 向量检索的底座：embedding 客户端 + 相似度 + 结果融合。
 *
 * 为什么做成「可插拔」：DeepSeek 不提供 embedding API，而 2C2G 的机器上
 * 本地跑 bge-m3 要 2GB 内存（直接超配）、bge-small 也要占 150MB 且依赖原生 ONNX。
 * 所以向量来源走**外部 OpenAI 兼容接口**（硅基流动 / 阿里云百炼 / 智谱 / 本地 Ollama 都兼容），
 * 没配 key 时整条链路自动退回纯词法检索，不影响聊天。
 */

/** 一个 embedding 提供方的配置；缺任何一项就等于没启用 */
export type EmbeddingConfig = {
  baseUrl: string
  apiKey: string
  model: string
  /** 期望维度；与服务端返回不一致时会以实际返回为准并告警 */
  dim: number
  timeoutMs: number
}

export type EmbeddingClient = {
  enabled: boolean
  config: EmbeddingConfig | null
  /**
   * 批量向量化。**失败返回 null，绝不抛异常**——
   * 记忆是增强功能，不能因为第三方接口挂了就让聊天报错。
   */
  embed(texts: readonly string[]): Promise<number[][] | null>
}

/** 从环境变量读配置；缺关键项返回 null（= 未启用） */
export const readEmbeddingConfig = (env: NodeJS.ProcessEnv): EmbeddingConfig | null => {
  const baseUrl = (env.MEMORY_EMBED_BASE_URL ?? '').replace(/\/+$/, '')
  const apiKey = env.MEMORY_EMBED_API_KEY ?? ''
  const model = env.MEMORY_EMBED_MODEL ?? ''
  if (!baseUrl || !apiKey || !model) {
    return null
  }
  return {
    baseUrl,
    apiKey,
    model,
    dim: Number(env.MEMORY_EMBED_DIM ?? 1024),
    timeoutMs: Number(env.MEMORY_EMBED_TIMEOUT_MS ?? 20_000),
  }
}

export const createEmbeddingClient = (config: EmbeddingConfig | null): EmbeddingClient => {
  if (!config) {
    return {
      enabled: false,
      config: null,
      async embed() {
        return null
      },
    }
  }

  return {
    enabled: true,
    config,
    async embed(texts) {
      const input = texts.map((text) => text.slice(0, 4000)).filter((text) => text.length > 0)
      if (input.length === 0) {
        return []
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.timeoutMs)
      try {
        const response = await fetch(`${config.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ model: config.model, input }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          console.warn(
            `[memory] embedding 接口返回 ${response.status}：${text.slice(0, 200)}`
          )
          return null
        }
        const payload = (await response.json()) as {
          data?: Array<{ embedding?: number[]; index?: number }>
        }
        const rows = payload.data ?? []
        if (rows.length !== input.length) {
          console.warn(
            `[memory] embedding 条数不匹配：发送 ${input.length}，返回 ${rows.length}`
          )
          return null
        }
        // 按 index 排序，避免服务端乱序导致向量与文本错配（错配是静默的，极难发现）
        const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        const vectors: number[][] = []
        for (const row of ordered) {
          const vector = row.embedding
          if (!Array.isArray(vector) || vector.length === 0) {
            return null
          }
          vectors.push(vector)
        }
        if (vectors[0] && vectors[0].length !== config.dim) {
          console.warn(
            `[memory] embedding 维度与配置不符：配置 ${config.dim}，实际 ${vectors[0].length}`
          )
        }
        return vectors
      } catch (error) {
        console.warn(
          `[memory] embedding 调用失败：${error instanceof Error ? error.message : String(error)}`
        )
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** L2 归一化后存，检索时用点积等价于余弦 */
export const normalizeVector = (vector: readonly number[]): Float32Array => {
  let sum = 0
  for (const value of vector) {
    sum += value * value
  }
  const norm = Math.sqrt(sum) || 1
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) {
    out[i] = (vector[i] ?? 0) / norm
  }
  return out
}

/** 两个**已归一化**向量的余弦相似度 */
export const dot = (a: Float32Array, b: Float32Array): number => {
  const length = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < length; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0)
  }
  return sum
}

/**
 * RRF（Reciprocal Rank Fusion）融合两路排序结果。
 *
 * 为什么不用分数归一化再加权：BM25 是负分、余弦是 [-1,1]，量纲完全不同，
 * 强行归一化对参数极其敏感。RRF 只看**名次**，天然免疫量纲问题，
 * 也是工业界混合检索的默认做法。
 */
export const RRF_K = 60

export const fuseRanks = <T>(
  lists: ReadonlyArray<ReadonlyArray<T>>,
  keyOf: (item: T) => string
): Array<{ item: T; score: number }> => {
  const scores = new Map<string, { item: T; score: number }>()
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = keyOf(item)
      const gain = 1 / (RRF_K + index + 1)
      const existing = scores.get(key)
      if (existing) {
        existing.score += gain
      } else {
        scores.set(key, { item, score: gain })
      }
    })
  }
  return [...scores.values()].sort((a, b) => b.score - a.score)
}
