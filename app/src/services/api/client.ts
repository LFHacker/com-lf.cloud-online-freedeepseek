import { translate, type TranslationMessage } from '../../i18n/index.js'
import { cachedUpstreamKey } from '../secure/upstreamKey.js'
import { useSettings } from '../settings.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/**
 * 当前生效的 API 地址。默认取构建期注入的 __API_ORIGIN__，可在设置里改，
 * 改完立即生效、不需要重新构建 —— 接自建网关靠的就是这一处。
 */
export const apiOrigin = (): string => useSettings.getState().apiOrigin
/**
 * Anthropic 兼容接口的前缀。
 * ⚠️ 必须是函数而不是模块级常量：地址能运行时改，常量会把旧值固化下来。
 */
const anthropicBaseUrl = (): string => `${apiOrigin()}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

/**
 * 网关在响应头里额外给了两条本轮元信息：
 *   x-ds-memory-recall       本次注入了多少条记忆
 *   x-ds-context-kept-tokens 裁剪后保留了多少上下文 token
 * 响应头只能在拿到 Response 的那一刻读，所以在这里顺手存一份给界面用。
 */
export type TurnMeta = { memoryHits: number; contextTokens: number; at: number }

let lastTurnMeta: TurnMeta | null = null

/** 最近一次请求的元信息（界面渲染「本轮」统计用；刷新页面会丢，属预期） */
export const readLastTurnMeta = (): TurnMeta | null => lastTurnMeta

const captureTurnMeta = (response: Response): void => {
  const recall = Number(response.headers.get('x-ds-memory-recall') ?? '')
  const kept = Number(response.headers.get('x-ds-context-kept-tokens') ?? '')
  if (!Number.isFinite(recall) && !Number.isFinite(kept)) {
    return
  }
  lastTurnMeta = {
    memoryHits: Number.isFinite(recall) ? recall : 0,
    contextTokens: Number.isFinite(kept) ? kept : 0,
    at: Date.now(),
  }
}
export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
    captureTurnMeta(response)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => {
  const upstream = cachedUpstreamKey()
  return {
    // 自建网关：x-api-key 是**我们的会话令牌**（认「你是谁」）
    'x-api-key': apiKey,
    // 官方 Key 由用户本地输入、随请求带给网关转发；网关不留存，只记指纹
    ...(upstream ? { 'x-deepseek-key': upstream } : {}),
    // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
    ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
  }
}

/** 自建网关用于区分会话与记忆模式的两个头；直连官方时它们会被忽略 */
export type SessionMeta = {
  sessionId: string
  scope: 'global' | 'local'
}

const sessionHeaders = (meta?: SessionMeta): Record<string, string> =>
  meta ? { 'x-ds-session-id': meta.sessionId, 'x-ds-memory-scope': meta.scope } : {}

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(`${apiOrigin()}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${anthropicBaseUrl()}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${anthropicBaseUrl()}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  /** 自建网关会在超预算时裁掉最旧的历史，并通过响应头告知裁了多少条 */
  onContextTrim?: (trimmedMessages: number) => void,
  /** 会话与记忆模式：只有自建网关认这两个头 */
  sessionMeta?: SessionMeta
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${anthropicBaseUrl()}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      ...sessionHeaders(sessionMeta),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  // 直连官方时这个头不存在，只有自建网关才会给
  const trimmedHeader = response.headers.get('x-ds-context-trimmed-messages')
  if (onContextTrim && trimmedHeader) {
    const trimmed = Number(trimmedHeader)
    if (Number.isFinite(trimmed) && trimmed > 0) {
      onContextTrim(trimmed)
    }
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
