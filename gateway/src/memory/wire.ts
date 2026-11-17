/**
 * 记忆与转发流程的粘合层。
 *
 * 这里只做三件纯函数式的事：取出本轮用户原话、把回忆块插进去、从流里捞出回答文本。
 * 不放业务判断，方便单独测。
 */

const MAX_ASSISTANT_CHARS = 200_000

/** 我们注入过的两种块：回忆块、裁剪提示。存库前必须剥掉 */
const RECALL_BLOCK_RE = /<回忆>[\s\S]*?<\/回忆>/gu
const TRIM_NOTICE_RE = /\[网关提示\][^\n]*/gu

/**
 * 剥掉注入内容，还原成用户真正说的话。
 *
 * 为什么要这道防御：网关每轮都会往最后一条用户消息里拼回忆块和裁剪提示。
 * 正常情况下 App 存的是用户原文，不会带回这些；但只要有任何一条路径
 * 把「网关加工后的请求」当成了历史（重放、导出再导入、将来改成网关存历史），
 * 注入块就会被当成"用户说的话"永久入库，之后每次召回都在自我复制。
 * 这类污染是静默扩散的，所以宁可每次都剥一遍。
 */
export const stripInjectedBlocks = (text: string): string =>
  text.replace(RECALL_BLOCK_RE, '').replace(TRIM_NOTICE_RE, '').replace(/\s+\n/gu, '\n').trim()

/** 从消息 content（字符串或块数组）里取纯文本，附件块忽略 */
export const extractText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const record = block as { type?: unknown; text?: unknown }
      if (record.type === 'text' && typeof record.text === 'string') {
        parts.push(record.text)
      }
    }
  }
  return parts.join('\n')
}

/** 找出最后一条 user 消息的下标与文本 */
export const findLastUserMessage = (
  messages: readonly unknown[]
): { index: number; text: string } | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || typeof message !== 'object') {
      continue
    }
    const record = message as { role?: unknown; content?: unknown }
    if (record.role !== 'user') {
      continue
    }
    return { index: i, text: extractText(record.content) }
  }
  return null
}

/** 该消息是否携带附件块（图片/文档） */
export const hasAttachmentBlock = (content: unknown): boolean => {
  if (!Array.isArray(content)) {
    return false
  }
  return content.some((block) => {
    if (!block || typeof block !== 'object') {
      return false
    }
    const type = (block as { type?: unknown }).type
    return type === 'image' || type === 'document'
  })
}

export type UserMessageInfo = {
  index: number
  text: string
  hasAttachment: boolean
}

/**
 * 取出本次请求里的**所有**用户消息，不只是最后一条。
 *
 * 为什么要全部：App 每轮都会把完整历史重发一遍，
 * 所以逐条 INSERT OR IGNORE 相当于自带**自愈**——
 * 万一某条因为任何原因漏存了，下一轮就会被补回来。
 * 早先只存最后一条，漏了就永远漏了。
 */
export const extractUserMessages = (messages: readonly unknown[]): UserMessageInfo[] => {
  const result: UserMessageInfo[] = []
  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') {
      return
    }
    const record = message as { role?: unknown; content?: unknown }
    if (record.role !== 'user') {
      return
    }
    result.push({
      index,
      // 存库的永远是用户原话：剥掉网关自己注入过的回忆块与裁剪提示
      text: stripInjectedBlocks(extractText(record.content)),
      hasAttachment: hasAttachmentBlock(record.content),
    })
  })
  return result
}

/**
 * 把回忆块拼到本轮用户消息的最前面。
 *
 * 为什么拼进消息而不是塞 system prompt：**上下文缓存按前缀匹配**。
 * system 每轮都变会让整个前缀缓存失效、每轮全价；
 * 拼在最后一条消息里，前面的 system + 历史前缀保持不变，缓存照常命中。
 */
export const injectRecall = (jsonText: string, block: string): string => {
  if (!block) {
    return jsonText
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return jsonText
  }
  if (!parsed || typeof parsed !== 'object') {
    return jsonText
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.messages)) {
    return jsonText
  }
  const found = findLastUserMessage(record.messages)
  if (!found) {
    return jsonText
  }
  const message = record.messages[found.index] as { content?: unknown }
  const composed = composedContent(message.content, block)
  if (composed === null) {
    return jsonText
  }
  const messages = [...record.messages]
  messages[found.index] = { ...(record.messages[found.index] as object), content: composed }
  return JSON.stringify({ ...record, messages })
}

const composedContent = (content: unknown, block: string): unknown => {
  const prefix = `${block}\n\n`
  if (typeof content === 'string') {
    return prefix + content
  }
  if (Array.isArray(content)) {
    return [{ type: 'text', text: prefix.trimEnd() }, ...content]
  }
  return null
}

/**
 * 从上游响应流里捞出助手回答的文本，用于入库。
 *
 * 为什么要捞：记忆里只有用户提问是残缺的——
 * 「A 会话说过的」往往指助手给出的结论（比如"最后选了 SQLite"）。
 * 流是 SSE 逐帧来的，必须跨 chunk 拼行，不能假设一帧就是一行。
 */
export class AssistantTextCollector {
  private buffer = ''
  private text = ''
  private truncated = false

  push(chunk: Buffer | string): void {
    if (this.truncated) {
      return
    }
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.consumeLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) {
      return
    }
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') {
      return
    }
    try {
      const event = JSON.parse(payload) as {
        type?: string
        delta?: { type?: string; text?: string }
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        this.append(event.delta.text ?? '')
      }
    } catch {
      // 非 JSON 的 data 行（心跳等）直接忽略
    }
  }

  /** 非流式响应：整个 body 是 JSON，从中取 content[].text */
  pushJsonBody(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as { content?: unknown }
      this.append(extractText(parsed.content))
    } catch {
      // 解析失败就算了，宁可记忆少一条也不要因为记录失败影响对话
    }
  }

  private append(piece: string): void {
    if (!piece) {
      return
    }
    if (this.text.length + piece.length > MAX_ASSISTANT_CHARS) {
      this.truncated = true
      return
    }
    this.text += piece
  }

  result(): string {
    return this.text.trim()
  }
}
