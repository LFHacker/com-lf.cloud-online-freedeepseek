/**
 * 部署前后核对：直接读 auth.db（只读），不经过 HTTP。
 *
 * 用法（在服务器上跑；脚本独立，不 import 网关代码）：
 *   scp gateway/scripts/sync-precheck.mjs root@<host>:/root/
 *   ssh root@<host> "node /root/sync-precheck.mjs"
 *
 * 关注点：user_sessions 有没有 pinned 列、file_refs / store_meta 建没建、
 * 引用条数对不对。部署前后各跑一次，就能看出迁移到底做了什么。
 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('/var/lib/ds-gateway/auth.db', { readOnly: true })
const count = (sql) => {
  try {
    return Number(db.prepare(sql).get().n)
  } catch {
    return -1
  }
}

const tables = (db.prepare("select name from sqlite_master where type='table' order by name").all() ?? []).map(
  (row) => row.name
)

const columns = (table) => {
  try {
    return db
      .prepare(`pragma table_info(${table})`)
      .all()
      .map((row) => row.name)
      .join(',')
  } catch {
    return '(无此表)'
  }
}

console.log(
  JSON.stringify(
    {
      sessions: count('select count(*) n from user_sessions'),
      tombstones: count('select count(*) n from session_tombstones'),
      fileRefs: count('select count(*) n from file_refs'),
      refsDistinctFiles: count('select count(distinct file_id) n from file_refs'),
      hasFileRefsTable: tables.includes('file_refs'),
      hasStoreMeta: tables.includes('store_meta'),
      sessionColumns: columns('user_sessions'),
      users: count('select count(*) n from users'),
    },
    null,
    2
  )
)
db.close()
