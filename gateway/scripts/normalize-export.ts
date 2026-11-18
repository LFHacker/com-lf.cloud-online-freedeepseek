/**
 * 把官方导出包（解压后的目录）规范化为记忆导入用的 JSON。
 *
 *   node scripts/normalize-export.ts <解压目录> <输出.json>
 *
 * 官方导出结构（实测 2026-11-17 版）：
 *   chat_sessions/<uuid>.json
 *     { id, title, pinned, messages: [
 *         { id, parent_id, role: 'USER'|'ASSISTANT', inserted_at, fragments: [
 *             { type: 'REQUEST'|'RESPONSE'|'THINK', content: string }
 *         ] }
 *     ] }
 *
 * ⚠️ 三个必须处理的点（上一版就是在这里丢了数据）：
 *  1. 正文在 fragments 里，不在 content
 *  2. 助手回答是 type='RESPONSE'，**必须保留** —— 上一版只取了 REQUEST，导致
 *     "记忆里只有问题没有答案"，模型遇到报错类提问只能复述
 *  3. type='THINK' 是模型的思考过程，**必须丢掉** —— 它体积大（常比回答长几倍）
 *     且不是用户要的事实
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const out = process.argv[3]
if (!dir || !out) {
  console.error('用法: node scripts/normalize-export.ts <解压目录> <输出.json>')
  process.exit(1)
}

type Role = 'user' | 'assistant'
type Fragment = { type?: string; content?: string }
type RawMessage = {
  role?: string
  inserted_at?: string | number
  fragments?: Fragment[]
  content?: string
}
type RawSession = {
  id?: string
  title?: string
  inserted_at?: string | number
  messages?: RawMessage[]
}

const toEpoch = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 秒级时间戳 vs 毫秒级：小于 1e12 的按秒处理
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return fallback
}

/** 只取正文：REQUEST（用户）/ RESPONSE（助手回答），跳过 THINK（思考过程） */
const pickText = (message: RawMessage): string => {
  const parts = (message.fragments ?? [])
    .filter((fragment) => {
      const type = (fragment.type ?? '').toUpperCase()
      return type === 'REQUEST' || type === 'RESPONSE' || (!type && Boolean(fragment.content))
    })
    .map((fragment) => (fragment.content ?? '').trim())
    .filter(Boolean)
  if (parts.length > 0) {
    return parts.join('\n')
  }
  // 兼容老格式：正文直接挂在 content 上
  return (message.content ?? '').trim()
}

const mapRole = (role: string | undefined): Role | null => {
  const upper = (role ?? '').toUpperCase()
  if (upper === 'USER') return 'user'
  if (upper === 'ASSISTANT') return 'assistant'
  return null
}

const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
const conversations: Array<{
  key: string
  createdAt: number
  messages: Array<{ role: Role; text: string; createdAt: number }>
}> = []

let skippedSessions = 0
let userMessages = 0
let assistantMessages = 0
let thinkDropped = 0

for (const [index, name] of files.entries()) {
  let raw: RawSession
  try {
    raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RawSession
  } catch {
    skippedSessions += 1
    continue
  }
  const sessionId = raw.id ?? name.replace(/\.json$/u, '')
  const fallbackTime = Date.parse('2025-01-01T00:00:00Z') + index * 1000
  const createdAt = toEpoch(raw.inserted_at, fallbackTime)

  const messages: Array<{ role: Role; text: string; createdAt: number }> = []
  for (const [position, message] of (raw.messages ?? []).entries()) {
    for (const fragment of message.fragments ?? []) {
      if ((fragment.type ?? '').toUpperCase() === 'THINK') {
        thinkDropped += 1
      }
    }
    const role = mapRole(message.role)
    const text = pickText(message)
    if (!role || !text) {
      continue
    }
    if (role === 'user') userMessages += 1
    else assistantMessages += 1
    messages.push({
      role,
      text,
      // 同一毫秒多条时用序号错开，保证 (created_at, id) 定序稳定
      createdAt: toEpoch(message.inserted_at, createdAt) + position,
    })
  }
  if (messages.length === 0) {
    skippedSessions += 1
    continue
  }
  conversations.push({ key: sessionId, createdAt, messages })
  if ((index + 1) % 200 === 0) {
    console.log(`    已处理 ${index + 1}/${files.length}`)
  }
}

writeFileSync(out, JSON.stringify({ conversations }), 'utf8')
console.log('')
console.log(`  会话 ${conversations.length} 个（跳过 ${skippedSessions}）`)
console.log(`  用户消息 ${userMessages} 条 / 助手消息 ${assistantMessages} 条`)
console.log(`  丢弃 THINK 片段 ${thinkDropped} 条`)
console.log(`  已写入 ${out}`)
