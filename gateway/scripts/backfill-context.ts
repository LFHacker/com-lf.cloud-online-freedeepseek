/**
 * 回填历史助手回答：按「用户消息正文」把答复挂到已有切片上。
 *
 *   node scripts/backfill-context.ts <memory.db> <normalized.json> [--dry-run]
 *
 * 为什么不重新导入：上一次重新导入时，会话键与历史批次不一致，
 * 结果把 1010 个会话又建了一遍（user 7046→14086、chunks 7752→15499），只能回滚。
 * 回填不建会话、不建切片，只在**已有**切片上填 `context` 列，风险小得多。
 *
 * 匹配方式：用户消息正文 → 紧随其后的助手回答。
 * 同一句话在不同会话里出现过时（"继续""好的"），按出现顺序依次消费，
 * 允许轻微错配——错配的代价是注入一段不相关的回答，远小于"没有回答"。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

const dbPath = process.argv[2]
const normalizedPath = process.argv[3]
const dryRun = process.argv.includes('--dry-run')
const maxContextChars = 600
if (!dbPath || !normalizedPath) {
  console.error('用法: node scripts/backfill-context.ts <memory.db> <normalized.json> [--dry-run]')
  process.exit(1)
}

type Role = 'user' | 'assistant'
type Normalized = {
  conversations: Array<{ key: string; createdAt: number; messages: Array<{ role: Role; text: string; createdAt: number }> }>
}

const parsed = JSON.parse(readFileSync(normalizedPath, 'utf8')) as Normalized

/** 用户正文 → 该正文后面出现过的助手回答（按文件顺序排队） */
const replies = new Map<string, string[]>()
let pairCount = 0
for (const conversation of parsed.conversations) {
  let pendingUser: string | null = null
  for (const message of conversation.messages) {
    if (message.role === 'user') {
      // 连续两条用户消息时，前一条没有回答，丢弃待定
      pendingUser = message.text.trim()
    } else if (pendingUser) {
      const queue = replies.get(pendingUser) ?? []
      queue.push(message.text.trim())
      replies.set(pendingUser, queue)
      pairCount += 1
      pendingUser = null
    }
  }
}

console.log(`  规范化文件：${parsed.conversations.length} 个会话，${pairCount} 对问答`)
console.log(`  可匹配的用户正文：${replies.size} 种`)

const db = new DatabaseSync(dbPath)
db.exec('pragma busy_timeout = 3000;')
const columns = new Set(
  (db.prepare('pragma table_info(chunks)').all() as Array<{ name: string }>).map((row) => row.name)
)
if (!columns.has('context') && !dryRun) {
  db.exec('alter table chunks add column context text')
  console.log('  ✅ 已新增 chunks.context 列')
}

const users = db
  .prepare(
    `select id, body, created_at from messages
      where role = 'user'
      order by created_at asc, id asc`
  )
  .all() as Array<{ id: string; body: string; created_at: number }>

const update = db.prepare(
  `update chunks set context = ? where message_id = ? and (context is null or context = '')`
)

let matched = 0
let chunksUpdated = 0
let empty = 0
const used = new Map<string, number>()

if (!dryRun) {
  db.exec('begin')
}
for (const message of users) {
  const queue = replies.get(message.body.trim())
  if (!queue || queue.length === 0) {
    empty += 1
    continue
  }
  const index = used.get(message.body.trim()) ?? 0
  const reply = queue[Math.min(index, queue.length - 1)]
  used.set(message.body.trim(), index + 1)
  matched += 1
  if (!dryRun) {
    const result = update.run(reply.slice(0, maxContextChars), message.id)
    chunksUpdated += Number(result.changes)
  }
}
if (!dryRun) {
  db.exec('commit')
}

console.log(`  ${dryRun ? '（dry-run）' : ''}匹配到回答的用户消息 ${matched} / ${users.length}（无回答 ${empty}）`)
if (!dryRun) {
  console.log(`  更新切片 ${chunksUpdated} 个`)
}
const withContext = db
  .prepare("select count(*) n from chunks where context is not null and context <> ''")
  .get() as { n: number }
const total = db.prepare('select count(*) n from chunks').get() as { n: number }
console.log(`  库内带上下文：${withContext.n} / ${total.n}`)
db.close()
