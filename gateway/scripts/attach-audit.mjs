/**
 * 附件完整性核对（一次性取证）：磁盘上的文件 vs 会话里引用的附件，逐个对齐。
 *
 * 要回答的问题只有一个：**没上传的那 266 个，真的都不是图片吗？**
 * 如果里面混着 is_image: true 的，说明导入时丢了图，那是另一件事。
 *
 * 用法（在服务器上）：node /root/attach-audit.mjs
 */
import { readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const FILES_DIR = '/var/lib/ds-gateway/users/u_1407e25fc83e928f/files'
const DB = '/var/lib/ds-gateway/auth.db'

const onDisk = new Set(readdirSync(FILES_DIR))
const db = new DatabaseSync(DB, { readOnly: true })

/** id → {isImage, name, sessions} */
const referenced = new Map()
for (const row of db.prepare('select session_id, payload from user_sessions').iterate()) {
  let parsed
  try {
    parsed = JSON.parse(row.payload)
  } catch {
    continue
  }
  for (const message of parsed.messages ?? []) {
    for (const file of message.files ?? []) {
      const id = file?.id
      if (typeof id !== 'string') continue
      const entry = referenced.get(id) ?? {
        isImage: false,
        name: '',
        mime: '',
        sessions: 0,
      }
      entry.isImage ||= file.isImage === true
      entry.name ||= String(file.name ?? '')
      entry.mime ||= String(file.mimeType ?? '')
      entry.sessions += 1
      referenced.set(id, entry)
    }
  }
}
db.close()

const missing = [...referenced].filter(([id]) => !onDisk.has(id))
const orphanOnDisk = [...onDisk].filter((id) => !referenced.has(id))

const missingImages = missing.filter(([, meta]) => meta.isImage)
const missingDocs = missing.filter(([, meta]) => !meta.isImage)

const byMime = {}
for (const [, meta] of missingDocs) {
  const key = meta.mime || (meta.name.includes('.') ? meta.name.split('.').pop().toLowerCase() : '未知')
  byMime[key] = (byMime[key] ?? 0) + 1
}

console.log(
  JSON.stringify(
    {
      磁盘文件数: onDisk.size,
      会话引用数: referenced.size,
      引用了但没有文件的: missing.length,
      其中图片is_image为真: missingImages.length,
      其中非图片: missingDocs.length,
      非图片按类型: byMime,
      有文件但没被引用: orphanOnDisk.length,
      缺失图片示例: missingImages.slice(0, 5).map(([id, m]) => ({ id, name: m.name })),
      缺失文档示例: missingDocs.slice(0, 5).map(([id, m]) => ({ id, name: m.name, mime: m.mime })),
    },
    null,
    2
  )
)
