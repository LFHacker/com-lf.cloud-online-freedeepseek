/**
 * 给每个用户切片挂上「紧随其后的助手回答」。
 *
 *   node scripts/attach-assistant-context.ts <memory.db> [--dry-run] [--limit 字数]
 *
 * 为什么只挂上下文、不改索引：
 *   记忆只索引用户说的话（防"模型把自己旧输出当事实"的幻觉回路）。
 *   但问「Flutter 报错怎么解决」时，用户那句话里只有报错，解法在助手回复里——
 *   资料自然就成了"只有问题没有答案"。
 *   所以：**索引不变**（FTS/向量仍然只建在用户原文上，不用重新向量化），
 *   只把助手回答作为注入上下文带上。检索精度不受影响，回答质量才有机会提升。
 *
 * 幂等：只填 context 为空的切片，重复执行不会叠加。
 */
import { DatabaseSync } from 'node:sqlite'

const dbPath = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
const maxContextChars = 600
if (!dbPath) {
  console.error('用法: node scripts/attach-assistant-context.ts <memory.db> [--dry-run]')
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
db.exec('pragma busy_timeout = 3000;')

// 老库补列（与 openMemoryDb 的迁移保持一致，这里直接操作，避免依赖网关模块）
const columns = new Set(
  (db.prepare('pragma table_info(chunks)').all() as Array<{ name: string }>).map((row) => row.name)
)
if (!columns.has('context')) {
  if (dryRun) {
    console.log('  （dry-run）需要新增 chunks.context 列')
  } else {
    db.exec('alter table chunks add column context text')
    console.log('  ✅ 已新增 chunks.context 列')
  }
}

/**
 * 取某个用户消息之后的第一条 assistant 消息。
 * 用 (created_at, id) 定序，和邻块扩展保持一致的稳定顺序。
 */
const nextAssistant = db.prepare(`
  select body from messages
   where session_id = ?
     and role = 'assistant'
     and (created_at > ? or (created_at = ? and id > ?))
   order by created_at asc, id asc
   limit 1
`)

const pending = db
  .prepare(
    `select c.id, c.session_id, c.message_id, c.created_at
       from chunks c
       join messages m on m.id = c.message_id
      where m.role = 'user'
        and (c.context is null or c.context = '')
      order by c.created_at asc`
  )
  .all() as Array<{ id: string; session_id: string; message_id: string; created_at: number }>

console.log(`  待处理切片 ${pending.length} 条`)

const update = db.prepare('update chunks set context = ? where id = ?')
let attached = 0
let skipped = 0
let totalChars = 0

if (!dryRun && pending.length > 0) {
  db.exec('begin')
}
for (const row of pending) {
  const hit = nextAssistant.get(row.session_id, row.created_at, row.created_at, row.message_id) as
    | { body: string }
    | undefined
  if (!hit || !hit.body.trim()) {
    skipped += 1
    continue
  }
  const text = hit.body.trim().slice(0, maxContextChars)
  totalChars += text.length
  if (!dryRun) {
    update.run(text, row.id)
  }
  attached += 1
}
if (!dryRun && pending.length > 0) {
  db.exec('commit')
}

console.log(`  ${dryRun ? '（dry-run）' : ''}挂上上下文 ${attached} 条，无对应回答 ${skipped} 条`)
if (attached > 0) {
  console.log(`  平均上下文长度 ${Math.round(totalChars / attached)} 字`)
}
const withContext = db
  .prepare("select count(*) n from chunks where context is not null and context <> ''")
  .get() as { n: number }
console.log(`  库内已有上下文 ${withContext.n} / ${(db.prepare('select count(*) n from chunks').get() as { n: number }).n}`)
db.close()
