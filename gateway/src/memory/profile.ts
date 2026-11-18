/**
 * 长期记忆（稳定层）。
 *
 * 为什么要有这一层：
 *   现在的记忆块拼在**最后一条用户消息**里（为了不破坏 system+历史的缓存前缀），
 *   代价是它永远落在"会变的那一头"，一次都吃不到上下文缓存，全价计费。
 *   实测（2026-11-18）：稳定前缀 6009 token，第二次调用命中 5760、只有 249 全价。
 *
 *   所以把记忆拆成两层：
 *     · 稳定层（本文件）：长期事实，一天最多更新一次 → 放 system 里，吃 1/10 缓存价
 *     · 动态层：本次检索到的片段 → 仍在最后一条消息，保持前缀稳定
 *
 * ⚠️ 稳定性是这一层的**核心约束**：内容一旦抖动，整个前缀缓存作废，
 * 反而比没有更贵。所以生成策略必须"少而稳"：按天 + 按新增量触发。
 */
import type { MemoryStore } from './store.ts'

export type ProfileConfig = {
  /** 多久重建一次（默认 24 小时） */
  maxAgeMs: number
  /** 新增切片超过这个比例才重建（默认 5%），避免一天内反复重建 */
  growthRatio: number
  /** 生成用的样本切片数 */
  sampleSize: number
  /** 摘要最大字数 */
  maxChars: number
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
}

export const readProfileConfig = (env: NodeJS.ProcessEnv): ProfileConfig | null => {
  if ((env.MEMORY_PROFILE ?? '1') === '0') {
    return null
  }
  const apiKey = env.MEMORY_PROFILE_API_KEY ?? env.DEEPSEEK_API_KEY ?? ''
  if (!apiKey) {
    return null
  }
  return {
    maxAgeMs: Number(env.MEMORY_PROFILE_MAX_AGE_HOURS ?? 24) * 3_600_000,
    growthRatio: Number(env.MEMORY_PROFILE_GROWTH ?? 0.05),
    sampleSize: Number(env.MEMORY_PROFILE_SAMPLES ?? 60),
    maxChars: Number(env.MEMORY_PROFILE_CHARS ?? 900),
    apiKey,
    baseUrl: (env.MEMORY_PROFILE_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: env.MEMORY_PROFILE_MODEL ?? 'deepseek-chat',
    timeoutMs: Number(env.MEMORY_PROFILE_TIMEOUT_MS ?? 30_000),
  }
}

const PROMPT_HEAD = [
  '下面是一位用户过去与 AI 的对话片段（只含用户自己说的话）。',
  '请提炼一份**长期有效的用户档案**，供以后回答时参考。',
  '',
  '要求：',
  '1. 只写长期成立的事实与偏好，不写一次性的闲聊、临时问题',
  '2. 写清楚：身份/称呼、职业或学习阶段、正在做的项目或目标、常用工具、明确的偏好与禁忌',
  '3. 每条一行，用「- 」开头，总量控制在 15 行以内',
  '4. 不要编造片段里没有的信息；不确定就不写',
  '5. 直接输出档案，不要前言后语',
].join('\n')

export type ProfileResult = { body: string; rebuilt: boolean }

/**
 * 取稳定层内容：没建过、过期、或切片增长明显时重建。
 *
 * 失败一律退回**旧内容**（而不是空）：空内容会让 system 每轮都变，
 * 反而把缓存全部打散，比给一份略旧的档案更糟。
 */
export const ensureProfile = async (
  store: MemoryStore,
  config: ProfileConfig,
  now = Date.now()
): Promise<ProfileResult> => {
  const existing = store.getProfile()
  const chunks = store.stats().chunks
  if (existing) {
    const age = now - existing.updatedAt
    const growth = existing.sourceChunks > 0 ? chunks / existing.sourceChunks - 1 : 1
    const fresh = age < config.maxAgeMs && growth < config.growthRatio
    if (fresh) {
      return { body: existing.body, rebuilt: false }
    }
  }

  const samples = store.sampleForProfile(config.sampleSize)
  if (samples.length === 0) {
    return { body: existing?.body ?? '', rebuilt: false }
  }

  const prompt = `${PROMPT_HEAD}\n\n片段：\n${samples.join('\n---\n')}`
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    if (!response.ok) {
      console.warn(`[memory] 档案重建 HTTP ${response.status}，沿用旧档案`)
      return { body: existing?.body ?? '', rebuilt: false }
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const body = (payload.choices?.[0]?.message?.content ?? '').trim().slice(0, config.maxChars)
    if (!body) {
      return { body: existing?.body ?? '', rebuilt: false }
    }
    store.saveProfile(body, chunks, now)
    console.log(`[memory] 已重建用户档案（${body.length} 字，基于 ${samples.length} 条样本）`)
    return { body, rebuilt: true }
  } catch (error) {
    console.warn(
      `[memory] 档案重建失败，沿用旧档案：${error instanceof Error ? error.message : String(error)}`
    )
    return { body: existing?.body ?? '', rebuilt: false }
  }
}
