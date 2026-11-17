/**
 * 导入 DeepSeek 官方聊天记录导出文件。
 *
 * 官方没有导出功能，只能用浏览器扩展抓（DeepSeek Chat Exporter 之类），
 * 各扩展的 JSON 结构并不统一 —— 所以这里做成**容错适配**，先用 --probe 看结构。
 *
 * 用法：
 *   node scripts/import-history.ts --file export.json --probe        # 只看结构，不写库
 *   node scripts/import-history.ts --file export.json --dry-run      # 统计与体积预估，不写库
 *   node scripts/import-history.ts --file export.json                # 真导入（默认 global）
 *   node scripts/import-history.ts --file export.json --scope local  # 只进本对话记忆
 *   node scripts/import-history.ts --rollback hist-20261117          # 整批撤销
 *
 * 设计要点：
 * - **幂等**：会话 id 由「批次 + 会话稳定键」哈希得出，消息 id 由内容哈希得出，
 *   配合 store 的 `insert or ignore`，同一份文件重复导入不会产生重复数据。
 * - **只索引用户消息**：与线上行为一致（助手回复入库但不参与召回，避免自问自答污染）。
 * - **批次可撤销**：会话 id 带 `hist-<批次>-` 前缀，撤销时按前缀删干净四处数据。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, type MemoryScope } from '../src/memory/store.ts'

type Role = 'user' | 'assistant'

type Conversation = {
  /** 会话稳定键：优先用导出里的 id，否则用「标题+首条消息」推导 */
  key: string
  title: string
  createdAt: number
  messages: { role: Role; text: string; createdAt: number }[]
}

type Options = {
  file?: string
  scope: MemoryScope
  batch: string
  dryRun: boolean
  probe: boolean
  limit: number
  rollback?: string
}

const sha = (value: string) => createHash('sha1').update(value).digest('hex')

const sanitizeBatch = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'import'

export const parseArgs = (argv: string[]): Options => {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const has = (name: string) => argv.includes(name)
  const scopeRaw = get('--scope') ?? 'global'
  return {
    file: get('--file'),
    scope: (scopeRaw === 'local' ? 'local' : 'global') as MemoryScope,
    batch: sanitizeBatch(get('--batch') ?? 'import'),
    dryRun: has('--dry-run'),
    probe: has('--probe'),
    limit: Number(get('--limit') ?? 0) || 0,
    rollback: get('--rollback'),
  }
}

/** 从各种可能的形状里挖出会话数组 */
export const findConversations = (json: unknown): unknown[] => {
  if (Array.isArray(json)) {
    return json
  }
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>
    // 常见的几种键名，按可能性排序
    for (const key of ['conversations', 'chat_sessions', 'sessions', 'chats', 'data', 'items', 'history']) {
      const value = record[key]
      if (Array.isArray(value)) {
        return value
      }
      // { data: { conversations: [...] } } 这类再套一层的
      if (value && typeof value === 'object') {
        for (const inner of ['conversations', 'sessions', 'chats', 'items']) {
          const nested = (value as Record<string, unknown>)[inner]
          if (Array.isArray(nested)) {
            return nested
          }
        }
      }
    }
  }
  return []
}

/** 从消息对象里取角色 */
const pickRole = (record: Record<string, unknown>): Role | null => {
  for (const key of ['role', 'sender', 'from', 'author', 'type']) {
    const value = record[key]
    if (typeof value !== 'string') {
      continue
    }
    const lower = value.toLowerCase()
    if (lower === 'user' || lower === 'human' || lower === 'me') {
      return 'user'
    }
    if (lower === 'assistant' || lower === 'ai' || lower === 'bot' || lower === 'system') {
      return 'assistant'
    }
  }
  // author 可能是 { role: 'user' }
  const author = record.author
  if (author && typeof author === 'object') {
    const inner = (author as Record<string, unknown>).role
    if (typeof inner === 'string') {
      return inner.toLowerCase() === 'user' ? 'user' : 'assistant'
    }
  }
  return null
}

/**
 * 把任意形状的"正文"取值归一成字符串。递归是为了覆盖
 * `content: { parts: [...] }` 这类嵌套（ChatGPT 导出就是这样）。
 */
const textOf = (value: unknown, depth = 0): string => {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => textOf(item, depth + 1)).join('')
  }
  if (value && typeof value === 'object' && depth < 4) {
    const block = value as Record<string, unknown>
    for (const key of ['text', 'content', 'parts', 'value', 'blocks']) {
      const inner = block[key]
      if (inner !== undefined) {
        const text = textOf(inner, depth + 1)
        if (text.trim()) {
          return text
        }
      }
    }
  }
  return ''
}

/** 从消息对象里取正文；兼容 string / {text} / [{type,text}] / {parts:[...]} */
const pickText = (record: Record<string, unknown>): string => {
  for (const key of ['content', 'text', 'message', 'parts', 'blocks']) {
    if (record[key] === undefined) {
      continue
    }
    const text = textOf(record[key])
    if (text.trim()) {
      return text
    }
  }
  return ''
}

/** 从各种时间字段里取毫秒时间戳 */
const pickTime = (record: Record<string, unknown>, fallback: number): number => {
  for (const key of ['createdAt', 'created_at', 'create_time', 'timestamp', 'time', 'inserted_at']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      // 秒级时间戳自动升到毫秒
      return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
  }
  return fallback
}

/** 消息列表可能是数组，也可能是 ChatGPT 那种 { 节点id: {message} } 的映射对象 */
const resolveMessageList = (value: unknown): unknown[] | undefined => {
  if (Array.isArray(value)) {
    return value
  }
  if (value && typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>)
    // 只有"看起来像消息"的对象才当列表，避免把任意配置对象误当成消息
    const looksLikeMessages = values.some((item) => {
      if (!item || typeof item !== 'object') {
        return false
      }
      const record = item as Record<string, unknown>
      return 'message' in record || 'role' in record || 'author' in record || 'sender' in record
    })
    return looksLikeMessages ? values : undefined
  }
  return undefined
}

export const toConversations = (raw: unknown[], limit: number): Conversation[] => {
  const result: Conversation[] = []
  raw.forEach((entry, index) => {
    if (limit > 0 && result.length >= limit) {
      return
    }
    if (!entry || typeof entry !== 'object') {
      return
    }
    const record = entry as Record<string, unknown>
    const list = ['messages', 'chat_messages', 'mapping', 'items', 'turns']
      .map((key) => resolveMessageList(record[key]))
      .find((value) => value && value.length > 0)
    if (!list || list.length === 0) {
      return
    }

    const normalized: Conversation['messages'] = []
    let index2 = 0
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        continue
      }
      const message = item as Record<string, unknown>
      // ChatGPT 风格的 mapping 是 { node: { message: {...} } }
      const inner = message.message && typeof message.message === 'object'
        ? (message.message as Record<string, unknown>)
        : message
      const role = pickRole(inner)
      const text = pickText(inner).trim()
      if (!role || !text) {
        continue
      }
      normalized.push({
        role,
        text,
        createdAt: pickTime(inner, 0) || pickTime(record, 0) + index2 * 1000,
      })
      index2 += 1
    }
    if (normalized.length === 0) {
      return
    }

    const idValue = record.id ?? record.conversation_id ?? record.session_id ?? record.uuid
    const title =
      (typeof record.title === 'string' && record.title) ||
      (typeof record.name === 'string' && record.name) ||
      normalized.find((message) => message.role === 'user')?.text.slice(0, 40) ||
      `会话 ${index + 1}`

    // 稳定键：同一份导出文件重复解析必须得到同一个值
    const key =
      typeof idValue === 'string' && idValue
        ? idValue
        : sha(`${title}|${normalized[0]?.text ?? ''}|${index}`).slice(0, 16)

    result.push({
      key,
      title,
      createdAt: pickTime(record, normalized[0]?.createdAt ?? Date.now()),
      messages: normalized,
    })
  })
  return result
}

const printProbe = (json: unknown) => {
  console.log('  === 结构探测 ===')
  if (Array.isArray(json)) {
    console.log(`  顶层是数组，长度 ${json.length}`)
    const first = json[0]
    if (first && typeof first === 'object') {
      console.log('  第一条的键:', Object.keys(first as object).join(', '))
      const record = first as Record<string, unknown>
      for (const key of ['messages', 'chat_messages', 'mapping']) {
        if (Array.isArray(record[key])) {
          const sample = (record[key] as unknown[])[0]
          console.log(`  ${key}[0] 的键:`, sample && typeof sample === 'object' ? Object.keys(sample as object).join(', ') : typeof sample)
        }
      }
    }
  } else if (json && typeof json === 'object') {
    const keys = Object.keys(json as object)
    console.log(`  顶层是对象，键: ${keys.join(', ')}`)
    for (const key of keys) {
      const value = (json as Record<string, unknown>)[key]
      if (Array.isArray(value)) {
        console.log(`  ${key}: 数组，长度 ${value.length}`)
        const first = value[0]
        if (first && typeof first === 'object') {
          console.log(`    ${key}[0] 的键:`, Object.keys(first as object).join(', '))
        }
      } else {
        console.log(`  ${key}: ${typeof value}`)
      }
    }
  } else {
    console.log('  无法识别的顶层类型:', typeof json)
  }
}

export const rollbackBatch = (dbPath: string, batch: string) => {
  const db = new DatabaseSync(dbPath)
  const prefix = `hist-${batch}-`
  const sessions = db
    .prepare('select id from sessions where id like ?')
    .all(`${prefix}%`) as { id: string }[]
  if (sessions.length === 0) {
    console.log(`  没有找到批次 "${batch}" 的数据（前缀 ${prefix}）`)
    db.close()
    return
  }
  let chunks = 0
  for (const { id } of sessions) {
    const chunkIds = db.prepare('select id from chunks where session_id = ?').all(id) as { id: string }[]
    chunks += chunkIds.length
    for (const chunk of chunkIds) {
      db.prepare('delete from chunk_vec where chunk_id = ?').run(chunk.id)
      db.prepare('delete from chunks_fts where chunk_id = ?').run(chunk.id)
      db.prepare('delete from chunk_usage where chunk_id = ?').run(chunk.id)
    }
    db.prepare('delete from chunks where session_id = ?').run(id)
    db.prepare('delete from messages where session_id = ?').run(id)
    db.prepare('delete from sessions where id = ?').run(id)
  }
  db.close()
  console.log(`  已撤销批次 "${batch}"：${sessions.length} 个会话、${chunks} 个切片`)
}

/** 把解析好的会话写进记忆库；返回计数，便于测试与 main 复用 */
export const importConversations = (
  store: MemoryStore,
  conversations: Conversation[],
  options: { scope: MemoryScope; batch: string }
) => {
  const sessionIdOf = (key: string) => `hist-${options.batch}-${sha(key).slice(0, 16)}`
  let createdSessions = 0
  let storedMessages = 0
  let chunks = 0

  for (const conversation of conversations) {
    const sessionId = sessionIdOf(conversation.key)
    const session = store.ensureSession(sessionId, options.scope, conversation.createdAt)
    if (session.created) {
      createdSessions += 1
    }
    conversation.messages.forEach((message, index) => {
      // 同一会话里内容完全相同的消息用 occurrence 区分，避免被当成重复丢掉
      const result = store.recordMessage({
        sessionId,
        scope: options.scope,
        role: message.role,
        body: message.text,
        now: message.createdAt || conversation.createdAt,
        occurrence: index,
      })
      if (result.stored) {
        storedMessages += 1
        chunks += result.chunks
      }
    })
  }

  return { createdSessions, storedMessages, chunks }
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const dbPath = process.env.MEMORY_DB_PATH ?? '/var/lib/ds-gateway/memory.db'

  if (options.rollback) {
    console.log(`[import] 撤销批次 ${options.rollback} → ${dbPath}`)
    rollbackBatch(dbPath, sanitizeBatch(options.rollback))
    return
  }

  if (!options.file) {
    console.error('缺少 --file <导出文件.json>')
    process.exit(1)
  }
  if (!existsSync(options.file)) {
    console.error(`文件不存在: ${options.file}`)
    process.exit(1)
  }
  if (options.file.toLowerCase().endsWith('.zip')) {
    console.error('请先解压：本脚本只读 .json，不处理 zip')
    process.exit(1)
  }

  const raw = readFileSync(options.file, 'utf8')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    console.error('JSON 解析失败:', (error as Error).message)
    process.exit(1)
  }

  if (options.probe) {
    printProbe(json)
    const found = findConversations(json)
    console.log(`\n  可识别的会话数: ${found.length}`)
    if (found.length > 0) {
      const parsed = toConversations(found, 3)
      console.log(`  成功解析 ${parsed.length} 个（预览前 3 个）:`)
      for (const conversation of parsed) {
        const userCount = conversation.messages.filter((message) => message.role === 'user').length
        console.log(
          `    "${conversation.title.slice(0, 24)}" 共 ${conversation.messages.length} 条（用户 ${userCount} 条）`
        )
      }
    }
    return
  }

  const conversations = toConversations(findConversations(json), options.limit)
  if (conversations.length === 0) {
    console.error('没有解析出任何会话。请先跑 --probe 看结构，再据此调整适配规则。')
    process.exit(1)
  }

  const userMessages = conversations.reduce(
    (sum, conversation) => sum + conversation.messages.filter((message) => message.role === 'user').length,
    0
  )
  const totalChars = conversations.reduce(
    (sum, conversation) =>
      sum +
      conversation.messages
        .filter((message) => message.role === 'user')
        .reduce((inner, message) => inner + message.text.length, 0),
    0
  )
  const estimateMB = (totalChars * 3 * 5.04) / 1024 / 1024

  console.log('  === 解析结果 ===')
  console.log(`  会话 ${conversations.length} 个，消息 ${conversations.reduce((sum, c) => sum + c.messages.length, 0)} 条`)
  console.log(`  其中用户消息 ${userMessages} 条（这些才会进检索索引）`)
  console.log(`  用户正文约 ${totalChars.toLocaleString()} 字，预计数据库增长约 ${estimateMB.toFixed(2)} MB`)
  console.log(`  记忆范围: ${options.scope}，批次: ${options.batch}`)
  if (options.scope === 'local') {
    // 这不是提示性警告：recordMessage 对非 global 会直接 return，切片一个都不会建
    console.warn('  ⚠️ local 范围不会进检索索引 —— 等于只归档、永远召回不到。')
    console.warn('     历史记录应该用默认的 global，否则导了也用不上。')
  }

  if (options.dryRun) {
    console.log('\n  --dry-run：未写入任何数据')
    return
  }

  const sizeBefore = existsSync(dbPath) ? statSync(dbPath).size : 0
  const store = new MemoryStore({ dbPath })
  const started = Date.now()
  const { createdSessions, storedMessages, chunks } = importConversations(store, conversations, {
    scope: options.scope,
    batch: options.batch,
  })

  await store.flushEmbeddings()
  const stats = store.stats()
  store.close()

  const sizeAfter = existsSync(dbPath) ? statSync(dbPath).size : 0
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  console.log('\n  === 导入完成 ===')
  console.log(`  新建会话 ${createdSessions} 个（已存在则跳过）`)
  console.log(`  写入消息 ${storedMessages} 条，生成切片 ${chunks} 个`)
  console.log(`  库内现有: 会话 ${stats.sessions} / 消息 ${stats.messages} / 切片 ${stats.chunks}`)
  console.log(`  数据库 ${(sizeBefore / 1024 / 1024).toFixed(2)} MB → ${(sizeAfter / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  耗时 ${seconds}s`)
  console.log(`\n  撤销本批次: node scripts/import-history.ts --rollback ${options.batch}`)
}

// 只有在直接执行本文件时才跑 CLI；被测试 import 时保持安静
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
