/**
 * 记忆管理的数据层。
 *
 * 走的是网关自己托管的 /memory/api/*（不需要开浏览器，App 内直接调），
 * 用 App 里已经配好的网关令牌鉴权。
 */
import { apiOrigin } from '../api/client.js'
import { useSettings } from '../settings.js'

export type MemoryItem = {
  id: string
  sessionId: string
  createdAt: number
  body: string
  /** 被召回过的次数（P4 增权的依据） */
  hits: number
}

export type MemoryStats = {
  sessions: number
  messages: number
  chunks: number
  usageRows: number
  vectors: boolean
}

export type RecallHit = {
  body: string
  createdAt: number
  sessionId: string
  score: number
}

const authHeaders = (): Record<string, string> => ({
  'x-api-key': useSettings.getState().apiKey ?? '',
})

const readJson = async <T>(response: Response): Promise<T> => {
  if (response.status === 401) {
    throw new Error('unauthorized')
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export const loadMemoryStats = async (): Promise<MemoryStats> => {
  const response = await fetch(`${apiOrigin()}/memory/api/stats`, { headers: authHeaders() })
  const data = await readJson<MemoryStats & { ok: boolean }>(response)
  return {
    sessions: data.sessions,
    messages: data.messages,
    chunks: data.chunks,
    usageRows: data.usageRows,
    vectors: data.vectors,
  }
}

export const loadMemories = async (keyword: string): Promise<MemoryItem[]> => {
  const query = keyword.trim()
  const url = `${apiOrigin()}/memory/api/list?limit=200${query ? `&q=${encodeURIComponent(query)}` : ''}`
  const response = await fetch(url, { headers: authHeaders() })
  const data = await readJson<{ items: MemoryItem[] }>(response)
  return data.items
}

export const previewRecall = async (text: string): Promise<RecallHit[]> => {
  const response = await fetch(
    `${apiOrigin()}/memory/api/recall?q=${encodeURIComponent(text)}`,
    { headers: authHeaders() }
  )
  const data = await readJson<{ hits: RecallHit[] }>(response)
  return data.hits
}

export const deleteMemories = async (ids: readonly string[]): Promise<number> => {
  const response = await fetch(`${apiOrigin()}/memory/api/delete`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  const data = await readJson<{ deleted: number }>(response)
  return data.deleted
}
