/**
 * 上下文预算管理 —— 网关侧的第 4 步。
 *
 * 为什么必须在网关做：客户端把这轮完整历史原样发上来，它既不知道服务端算了多少
 * token，也没法在"发送前"做决定。而官方文档明确写了：引用的文档全文会一直留在
 * 上下文里，「If the context is too long, the request returns 400; documents are
 * not truncated silently」——服务端绝不帮你裁。所以裁剪只能发生在我们这一层。
 *
 * 估算精度说明：DeepSeek 没公开分词器，这里用**保守高估**的启发式，
 * 宁可提前裁一点，也不要撞 400 把错误甩给用户。
 */

/** 每条消息的固定结构开销（role/JSON 结构等） */
const PER_MESSAGE_OVERHEAD = 8

/** CJK 统一表意文字及扩展区间的判定 */
const isCjk = (code: number): boolean =>
  (code >= 0x4e00 && code <= 0x9fff) || // 基本区
  (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
  (code >= 0x3040 && code <= 0x30ff) || // 日文假名
  (code >= 0xac00 && code <= 0xd7af) || // 韩文
  (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
  (code >= 0x20000 && code <= 0x2a6df) // 扩展 B

/**
 * 估算一段文本的 token 数。
 * - CJK 字符：按 1 字符 ≈ 1 token（DeepSeek 对中文大致在这个量级，取高不取低）
 * - ASCII：按 4 字符 ≈ 1 token（英文/代码的常见比例）
 * - 其他（标点、emoji、符号）：按 1 字符 ≈ 1 token
 */
export const estimateTextTokens = (text: string): number => {
  if (!text) {
    return 0
  }
  let cjk = 0
  let ascii = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (isCjk(code)) {
      cjk += 1
    } else if (code < 0x80) {
      ascii += 1
    } else {
      other += 1
    }
  }
  return cjk + Math.ceil(ascii / 4) + other
}

/** 递归估算任意 JSON 值里的文本 token（内容块数组、图片 base64 等都能覆盖） */
export const estimateValueTokens = (value: unknown): number => {
  if (value === null || value === undefined) {
    return 0
  }
  if (typeof value === 'string') {
    return estimateTextTokens(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return 1
  }
  if (Array.isArray(value)) {
    let total = 0
    for (const item of value) {
      total += estimateValueTokens(item)
    }
    return total
  }
  if (typeof value === 'object') {
    let total = 0
    for (const item of Object.values(value as Record<string, unknown>)) {
      total += estimateValueTokens(item)
    }
    return total
  }
  return 0
}

/** 单条消息的 token 估算（含结构开销） */
export const estimateMessageTokens = (message: unknown): number =>
  estimateValueTokens(message) + PER_MESSAGE_OVERHEAD

type Role = 'user' | 'assistant' | string

const roleOf = (message: unknown): Role | null => {
  if (message && typeof message === 'object' && 'role' in message) {
    const role = (message as { role?: unknown }).role
    return typeof role === 'string' ? role : null
  }
  return null
}

export type TrimOutcome = {
  /** 裁剪后的 messages（原数组不被修改） */
  messages: unknown[]
  /** 被丢弃的消息条数 */
  trimmedMessages: number
  /** 被丢弃部分的估算 token */
  trimmedTokens: number
  /** 保留部分的估算 token（不含 system） */
  keptTokens: number
  /** 是否发生了裁剪 */
  trimmed: boolean
  /**
   * 是否连**带附件/文档**的轮次也被丢掉了。
   * 为 true 时意味着模型已经看不到那份文档，必须明确告知用户，
   * 否则用户会以为"我明明上传过"而模型却答不出来。
   */
  droppedPinned: boolean
  /** 只保留最后一条仍超预算时为 true —— 说明单条就装不下 */
  overBudgetAfterTrim: boolean
}

/** 该消息是否携带文件块（图片或文档）——这类轮次是"锚点"，应最后才丢 */
const hasFileBlock = (message: unknown): boolean => {
  if (!message || typeof message !== 'object') {
    return false
  }
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some((block) => {
    if (!block || typeof block !== 'object') {
      return false
    }
    const type = (block as { type?: unknown }).type
    return type === 'document' || type === 'image'
  })
}

type Round = { start: number; end: number; tokens: number; pinned: boolean }

/**
 * 按「轮」切分消息。
 *
 * 不能简单假设 user/assistant 严格交替：App 会在每个 user 前插入
 * role='latest_reminder' 的元信息快照，所以真实序列可能是
 * [reminder, user, assistant, reminder, user, ...]。
 * 因此一轮 = 紧邻在前的 reminder + user + 其后的 assistant/工具块。
 */
const buildRounds = (messages: unknown[], tokens: number[]): Round[] => {
  const starts: number[] = []
  messages.forEach((message, index) => {
    if (roleOf(message) !== 'user') {
      return
    }
    let start = index
    while (start > 0 && roleOf(messages[start - 1]) === 'latest_reminder') {
      start -= 1
    }
    const previous = starts.at(-1)
    if (previous === undefined || start > previous) {
      starts.push(start)
    }
  })
  if (starts.length === 0) {
    return []
  }
  // 开头若有落单的 reminder，并入第一轮
  starts[0] = 0

  const rounds: Round[] = []
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] ?? 0
    const end = (starts[i + 1] ?? messages.length) - 1
    if (end < start) {
      continue
    }
    let roundTokens = 0
    let pinned = false
    for (let k = start; k <= end; k += 1) {
      roundTokens += tokens[k] ?? 0
      if (hasFileBlock(messages[k])) {
        pinned = true
      }
    }
    rounds.push({ start, end, tokens: roundTokens, pinned })
  }
  return rounds
}

/**
 * 按预算裁剪历史，优先级是**先丢纯文本轮次、最后才丢带文档的轮次**。
 *
 * 为什么不能只按"最旧优先"：文档通常就在第一轮。旧逻辑会第一个把它丢掉，
 * 于是用户明明上传过、模型却突然答"我看不到这份文档"——而且没有任何提示。
 */
export const trimMessages = (
  messages: unknown[],
  budgetTokens: number,
  /**
   * 需要裁剪时，额外多让出的比例（0~1）。
   *
   * 目的是**让裁剪起点稳定**：缓存按前缀命中，起点每轮挪一格就意味着每轮全价重算。
   * 一次裁到 budget×(1-reserve)，起点就能固定很多轮。
   */
  reserveRatio = 0
): TrimOutcome => {
  const tokens = messages.map(estimateMessageTokens)
  const total = tokens.reduce((sum, value) => sum + value, 0)
  /** 裁到哪个水位停手；不需要裁时以 budget 为界 */
  const target = budgetTokens * (1 - Math.min(Math.max(reserveRatio, 0), 0.8))

  if (total <= budgetTokens || messages.length <= 1) {
    return {
      messages: [...messages],
      trimmedMessages: 0,
      trimmedTokens: 0,
      keptTokens: total,
      trimmed: false,
      droppedPinned: false,
      overBudgetAfterTrim: total > budgetTokens,
    }
  }

  const rounds = buildRounds(messages, tokens)
  if (rounds.length <= 1) {
    // 只有一轮时无可裁剪，只能如实报告超预算
    return {
      messages: [...messages],
      trimmedMessages: 0,
      trimmedTokens: 0,
      keptTokens: total,
      trimmed: false,
      droppedPinned: false,
      overBudgetAfterTrim: true,
    }
  }

  const lastRound = rounds.length - 1
  const kept = new Set<number>(rounds.map((_, index) => index))
  let keptTokens = total
  let droppedPinned = false

  /** 从最旧的符合条件的轮次里丢一个；全部丢完返回 false */
  const dropOldest = (predicate: (round: Round) => boolean): boolean => {
    for (let i = 0; i < lastRound; i += 1) {
      if (!kept.has(i)) {
        continue
      }
      const round = rounds[i]
      if (!round || !predicate(round)) {
        continue
      }
      kept.delete(i)
      keptTokens -= round.tokens
      return true
    }
    return false
  }

  // 第一轮：先牺牲纯文本轮次
  while (keptTokens > target && dropOldest((round) => !round.pinned)) {
    // 继续
  }
  // 还不够，才动带文档的轮次（并记住这件事，好告诉用户）
  while (keptTokens > target && dropOldest((round) => round.pinned)) {
    droppedPinned = true
  }

  const keptIndexes: number[] = []
  for (let i = 0; i < rounds.length; i += 1) {
    if (!kept.has(i)) {
      continue
    }
    const round = rounds[i]
    if (!round) {
      continue
    }
    for (let k = round.start; k <= round.end; k += 1) {
      keptIndexes.push(k)
    }
  }

  return {
    messages: keptIndexes.map((index) => messages[index]),
    trimmedMessages: messages.length - keptIndexes.length,
    trimmedTokens: total - keptTokens,
    keptTokens,
    trimmed: keptIndexes.length < messages.length,
    droppedPinned,
    overBudgetAfterTrim: keptTokens > budgetTokens,
  }
}

/**
 * 裁剪发生时给模型补一句说明。
 *
 * 为什么补：不补的话模型不知道自己少了前文，用户问"刚才那个"它会硬答，
 * 甚至编一段不存在的内容出来。补上后它会照实说那部分不在上下文里。
 */
export const buildTrimNotice = (trimmedMessages: number, droppedPinned = false): string => {
  if (droppedPinned) {
    return (
      `\n\n[网关提示] 本次请求已省略最早约 ${trimmedMessages} 条历史消息，` +
      `**其中包含此前上传的文档内容**——当前上下文中已不再有该文档。` +
      `若用户问及文档内容，请如实说明你看不到该文档、需要重新上传，不要猜测或编造。`
    )
  }
  return (
    `\n\n[网关提示] 为控制上下文长度，本次请求已省略最早约 ${trimmedMessages} 条历史消息；` +
    `更早的对话内容不在当前上下文中。若用户提及更早的内容，请如实说明你看不到，不要猜测或编造。`
  )
}
