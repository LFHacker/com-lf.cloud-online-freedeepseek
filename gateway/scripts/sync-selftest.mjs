/**
 * 部署后自检（真写一次再删掉）：验证新代码在**生产库**上能写、能读、能墓碑、能清干净。
 *
 * 用法（在服务器上跑）：
 *   scp gateway/scripts/sync-selftest.mjs root@<host>:/root/
 *   ssh root@<host> "node /root/sync-selftest.mjs"
 *
 * 为什么值得真写一次：本地 e2e 用的是临时库，生产库可能卡在迁移中间态
 * （列没加上、引用表没建、可信标记缺失）。这 11 项就是那 11 个可能的坑。
 * 结束时会把自检留下的会话、墓碑、引用边全部删掉，库回到原样。
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const BASE = 'http://127.0.0.1:8787'
const env = readFileSync('/etc/ds-gateway.env', 'utf8')
const token = /^GATEWAY_TOKEN=(.*)$/m.exec(env)?.[1]?.trim() ?? ''
const ID = 'deploy-selftest-0001'
const FILE = 'deploy_selftest_file'
const now = Date.now()

const call = async (path, init = {}) => {
  const response = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-api-key': token, ...(init.headers ?? {}) },
  })
  const text = await response.text()
  try {
    return { status: response.status, json: JSON.parse(text) }
  } catch {
    return { status: response.status, json: { raw: text.slice(0, 200) } }
  }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : `：${detail}`}`)
}

const payload = JSON.stringify({
  id: ID,
  title: '部署自检会话',
  createdAt: now,
  updatedAt: now,
  pinned: true,
  messages: [{ id: 'm1', role: 'user', content: '自检', files: [{ id: FILE }], createdAt: now }],
  rootMessageId: null,
})

const push = await call('/sync/sessions', {
  method: 'POST',
  body: JSON.stringify({
    sessions: [
      {
        id: ID,
        title: '部署自检会话',
        createdAt: now,
        updatedAt: now,
        pinned: true,
        fileIds: [FILE],
        payload,
      },
    ],
  }),
})
check('写入会话成功', push.status === 200 && push.json.written === 1, JSON.stringify(push.json))

const index = await call('/sync/sessions?limit=5')
const row = (index.json.sessions ?? []).find((item) => item.id === ID)
check('列表能看到它', Boolean(row), JSON.stringify(index.json).slice(0, 200))
check('pinned 随列表返回', row?.pinned === true, JSON.stringify(row))

const full = await call(`/sync/session?id=${ID}`)
check('单条正文可取回', full.json.payload === payload)

// 引用计数直接查库（磁盘上没有这个附件文件，HTTP 列表看不到它）
const db = new DatabaseSync('/var/lib/ds-gateway/auth.db')
const refs = db
  .prepare('select count(*) n from file_refs where session_id = ?')
  .get(ID).n
check('引用边已写入', Number(refs) === 1, String(refs))

const keys = db
  .prepare("select key from store_meta where key like 'file_refs%'")
  .all()
  .map((r) => r.key)
check('引用表可信标记存在（GC 前置条件）', keys.length > 0, keys.join(','))

const removed = await call(`/sync/session?id=${ID}`, { method: 'DELETE' })
check('删除成功', removed.status === 200, String(removed.status))

const after = await call('/sync/sessions?limit=5')
check('墓碑已下发', (after.json.deleted ?? []).some((item) => item.id === ID))
check('会话行已删', !(after.json.sessions ?? []).some((item) => item.id === ID))

const orphan = db.prepare('select count(*) n from file_refs where session_id = ?').get(ID).n
check('引用边随删除清掉', Number(orphan) === 0, String(orphan))

// 清场：把自检留下的墓碑删掉，生产库回到原样
db.prepare('delete from session_tombstones where session_id = ?').run(ID)
const leftover = db
  .prepare('select (select count(*) from user_sessions) s, (select count(*) from session_tombstones) t, (select count(*) from file_refs) r')
  .get()
check(
  '清场后库回到原样（0/0/0）',
  Number(leftover.s) === 0 && Number(leftover.t) === 0 && Number(leftover.r) === 0,
  JSON.stringify(leftover)
)
db.close()

console.log(results.join('\n'))
const failed = results.filter((line) => line.startsWith('❌')).length
console.log(`\n${results.length - failed} 项通过，${failed} 项失败`)
process.exitCode = failed > 0 ? 1 : 0
