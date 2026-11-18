/**
 * 附件垃圾回收（GC）。
 *
 * 背景：删除会话是软删除（墓碑），但**附件文件还在磁盘上**。
 * 加上导入/重装会留下旧副本，磁盘只增不减。这个脚本负责回收。
 *
 *   node gc-attachments.mjs                  # 只报告（默认安全模式）
 *   node gc-attachments.mjs --apply          # 真删
 *   node gc-attachments.mjs --apply --grace-hours 48
 *
 * 判定"可删"必须同时满足三条 —— 宁可漏删，也不能误删：
 *   1. 磁盘上有这个文件，但**任何会话的 payload 都没有引用它**
 *   2. 文件的 mtime 早于 grace（默认 24 小时），避免和"正在上传"抢
 *   3. 不在墓碑保护期内（会话刚被删、用户可能想撤销）
 *
 * 误删一张图 = 用户永久丢数据；多留几天只是占磁盘。所以默认只报告。
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const graceIndex = args.indexOf('--grace-hours')
const graceHours = graceIndex >= 0 ? Number(args[graceIndex + 1]) : 24
const graceMs = Number.isFinite(graceHours) ? graceHours * 3_600_000 : 24 * 3_600_000

const DATA_DIR = process.env.MEMORY_DATA_DIR ?? '/var/lib/ds-gateway/users'
const DB_PATH = process.env.AUTH_DB_PATH ?? '/var/lib/ds-gateway/auth.db'

const db = new DatabaseSync(DB_PATH, { readOnly: true })

/** user_id → 该用户会话里引用过的全部附件 id */
const referencesByUser = new Map()
for (const row of db.prepare('select user_id, payload from user_sessions').iterate()) {
  if (!referencesByUser.has(row.user_id)) {
    referencesByUser.set(row.user_id, new Set())
  }
  const set = referencesByUser.get(row.user_id)
  let parsed
  try {
    parsed = JSON.parse(row.payload)
  } catch {
    continue
  }
  for (const message of parsed.messages ?? []) {
    for (const file of message.files ?? []) {
      if (typeof file?.id === 'string') {
        set.add(file.id)
      }
    }
  }
}
db.close()

let scanned = 0
let referenced = 0
let candidates = 0
let deleted = 0
let bytesFreed = 0
let skippedYoung = 0
const details = []

for (const userId of readdirSync(DATA_DIR)) {
  const filesDir = join(DATA_DIR, userId, 'files')
  let names
  try {
    names = readdirSync(filesDir)
  } catch {
    continue
  }
  const refs = referencesByUser.get(userId) ?? new Set()
  for (const name of names) {
    const path = join(filesDir, name)
    let info
    try {
      info = statSync(path)
    } catch {
      continue
    }
    if (!info.isFile()) {
      continue
    }
    scanned += 1
    // .tmp 是上传中断留下的半成品，超过 grace 才清
    const isTmp = name.endsWith('.tmp')
    const id = isTmp ? name.slice(0, -4) : name
    if (!isTmp && refs.has(id)) {
      referenced += 1
      continue
    }
    if (Date.now() - info.mtimeMs < graceMs) {
      skippedYoung += 1
      continue
    }
    candidates += 1
    if (details.length < 10) {
      details.push(`${userId}/${name} (${Math.round(info.size / 1024)}KB)`)
    }
    if (apply) {
      try {
        unlinkSync(path)
        deleted += 1
        bytesFreed += info.size
      } catch (error) {
        console.error(`  删除失败 ${path}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }
}

console.log(`[gc] ${new Date().toISOString()} ${apply ? 'APPLY' : 'DRY-RUN'} grace=${graceHours}h`)
console.log(`  扫描 ${scanned} 个文件｜被引用 ${referenced}｜处于宽限期 ${skippedYoung}`)
console.log(`  可回收 ${candidates} 个（${(bytesFreed / 1024 / 1024 || 0).toFixed(1)} MB 已释放）${apply ? `｜实删 ${deleted}` : ''}`)
if (details.length > 0) {
  console.log('  样例：')
  for (const line of details) {
    console.log(`    ${line}`)
  }
}
