/**
 * 会话云端同步：分页 / 墓碑 / 置顶 / 附件引用计数。
 *
 * 重点不是"能存能取"，而是**这三类错误一旦发生，数据就回不来了**：
 *  1. 分页漏会话 —— 客户端翻完最后一页就当拿到全量，漏掉的那些会被本地缓存
 *     当成"云端没有"，下一轮又推回去或被静默丢弃
 *  2. 引用计数偏小 —— GC 会删掉仍被引用的附件（不可逆）
 *  3. 引用计数被旧 payload 覆盖 —— 同上，而且更隐蔽（只有多设备才会撞上）
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthStore } from '../src/auth/store.ts'

let pass = 0
let fail = 0

const check = (name: string, condition: boolean, detail = '') => {
  if (condition) {
    pass += 1
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? `：${detail}` : ''}`)
  }
}

/** 造一条会话 payload：files 里的 id 就是它引用的附件 */
const payload = (title: string, fileIds: string[] = []) =>
  JSON.stringify({
    id: 'ignored',
    title,
    messages: fileIds.map((id) => ({ role: 'user', content: '', files: [{ id }] })),
  })

const dir = mkdtempSync(join(tmpdir(), 'ds-sync-test-'))
try {
  const store = new AuthStore(join(dir, 'auth.db'))
  const user = store.createUser('sync@example.com', 'Str0ng-Pass-9')
  const other = store.createUser('other@example.com', 'Str0ng-Pass-8')
  const uid = user.id

  // ── 1. 基本写入与列表 ───────────────────────────────
  const r1 = store.upsertSessions(uid, [
    { id: 's1', title: '甲', createdAt: 1000, updatedAt: 1000, payload: payload('甲') },
  ])
  check('首次推送写入 1 条', r1.written === 1, JSON.stringify(r1))
  const list1 = store.listSessions(uid)
  check('列表返回该会话', list1.length === 1 && list1[0].id === 's1')
  check('列表带出置顶字段（默认未置顶）', list1[0].pinned === false)

  const r2 = store.upsertSessions(uid, [
    {
      id: 's1',
      title: '甲-改',
      createdAt: 1000,
      updatedAt: 900,
      pinned: true,
      payload: payload('甲-改'),
    },
  ])
  check('旧 updatedAt 被拒绝', r2.written === 0 && r2.skipped === 1, JSON.stringify(r2))
  check(
    '被拒后正文没被覆盖',
    store.readSession(uid, 's1')?.payload === payload('甲'),
    store.readSession(uid, 's1')?.payload
  )

  store.upsertSessions(uid, [
    { id: 's1', title: '甲-新', createdAt: 1000, updatedAt: 1100, pinned: true, payload: payload('甲-新') },
  ])
  const list2 = store.listSessions(uid)
  check('较新版本覆盖成功', store.readSession(uid, 's1')?.payload === payload('甲-新'))
  check('置顶字段随会话存下来', list2[0].pinned === true)

  // ── 2. 分页（复合游标）──────────────────────────────
  for (let i = 0; i < 5; i += 1) {
    store.upsertSessions(uid, [
      { id: `p${i}`, title: `P${i}`, createdAt: 2000, updatedAt: 2000 + i, payload: payload(`P${i}`) },
    ])
  }
  // 同一毫秒的并列会话：只用时间做游标会在跨页处漏掉它们
  for (let i = 0; i < 3; i += 1) {
    store.upsertSessions(uid, [
      { id: `t${i}`, title: `T${i}`, createdAt: 3000, updatedAt: 3000, payload: payload(`T${i}`) },
    ])
  }
  const total = store.listSessions(uid, { limit: 500 }).length
  check('总数正确（1 + 5 + 3）', total === 9, String(total))

  const seen = new Set<string>()
  let before = 0
  let beforeId = ''
  let pages = 0
  const PAGE = 3
  for (;;) {
    // 与网关接口同构：多取一条判断"还有没有下一页"
    const rows = store.listSessions(uid, { before, beforeId, limit: PAGE + 1 })
    pages += 1
    if (pages > 20) {
      break
    }
    const page = rows.slice(0, PAGE)
    for (const row of page) {
      seen.add(row.id)
    }
    if (rows.length <= PAGE) {
      break
    }
    const last = page.at(-1)
    before = last?.updatedAt ?? 0
    beforeId = last?.id ?? ''
  }
  check('翻页拿到全部会话（不漏）', seen.size === 9, `${seen.size} / 9`)
  check('分页没有重复', seen.size === 9 && pages >= 3, `pages=${pages}`)

  // ── 3. 墓碑与删除 ────────────────────────────────────
  store.upsertSessions(uid, [
    { id: 'del1', title: 'D', createdAt: 4000, updatedAt: 4000, fileIds: ['file_del1_aaa'], payload: payload('D') },
  ])
  check('删除前引用计数为 1', store.fileRefCounts(uid).get('file_del1_aaa') === 1)
  store.deleteSession(uid, 'del1')
  const tombstones = store.listTombstones(uid)
  check('删除后留下墓碑', tombstones.some((t) => t.id === 'del1'))
  check('删除后会话不可读', store.readSession(uid, 'del1') === null)
  check('删除后引用边被清掉', (store.fileRefCounts(uid).get('file_del1_aaa') ?? 0) === 0)

  // 墓碑优先：离线设备带着"更新"的旧副本上线，也不能让已删的会话复活
  const revive = store.upsertSessions(uid, [
    {
      id: 'del1',
      title: 'D',
      createdAt: 4000,
      updatedAt: 999_999,
      fileIds: ['file_del1_aaa'],
      payload: payload('D', ['file_del1_aaa']),
    },
  ])
  check('带墓碑的会话不能被重推复活', revive.written === 0, JSON.stringify(revive))
  check('复活尝试没有写回正文', store.readSession(uid, 'del1') === null)
  check('复活尝试没有重建引用', (store.fileRefCounts(uid).get('file_del1_aaa') ?? 0) === 0)

  // 墓碑分页
  for (let i = 0; i < 4; i += 1) {
    store.upsertSessions(uid, [
      { id: `tm${i}`, title: 'x', createdAt: 5000, updatedAt: 5000 + i, payload: payload('x') },
    ])
    store.deleteSession(uid, `tm${i}`)
  }
  const tombPage1 = store.listTombstones(uid, { limit: 2 })
  check('墓碑分页返回 2 条', tombPage1.length === 2, String(tombPage1.length))
  const lastTomb = tombPage1.at(-1)
  const tombPage2 = store.listTombstones(uid, {
    limit: 10,
    before: lastTomb?.deletedAt ?? 0,
    beforeId: lastTomb?.id ?? '',
  })
  const tombAll = new Set([...tombPage1, ...tombPage2].map((t) => t.id))
  check('墓碑翻页不重叠、不漏（5 条）', tombAll.size === 5, [...tombAll].join(','))

  // ── 4. 引用计数 ──────────────────────────────────────
  const shared = 'file_shared_01'
  store.upsertSessions(uid, [
    { id: 'a', title: 'A', createdAt: 6000, updatedAt: 6000, fileIds: [shared], payload: payload('A') },
    { id: 'b', title: 'B', createdAt: 6001, updatedAt: 6001, fileIds: [shared], payload: payload('B') },
  ])
  check('两个会话共用附件 → 计数 2', store.fileRefCounts(uid).get(shared) === 2)

  store.upsertSessions(uid, [
    {
      id: 'a',
      title: 'A2',
      createdAt: 6000,
      updatedAt: 6100,
      fileIds: [shared, shared],
      payload: payload('A2', [shared, shared]),
    },
  ])
  check('同一条会话重复写同一附件不重复计数', store.fileRefCounts(uid).get(shared) === 2)

  // 旧 payload 带着旧附件列表推上来：绝不能覆盖引用
  store.upsertSessions(uid, [
    { id: 'b', title: 'B', createdAt: 6001, updatedAt: 6002, fileIds: ['file_b_new_xy'], payload: payload('B2', ['file_b_new_xy']) },
  ])
  check('改用新附件后旧附件计数降为 1', store.fileRefCounts(uid).get(shared) === 1)
  store.upsertSessions(uid, [
    // 更旧的版本，带的是已经换掉的旧附件
    { id: 'b', title: 'B', createdAt: 6001, updatedAt: 6000, fileIds: [shared], payload: payload('B-old', [shared]) },
  ])
  check(
    '被拒的旧 payload 不会把引用改回去',
    store.fileRefCounts(uid).get(shared) === 1,
    String(store.fileRefCounts(uid).get(shared))
  )
  check('新附件引用没被旧数据抹掉', store.fileRefCounts(uid).get('file_b_new_xy') === 1)

  // 客户端没传 fileIds 时从 payload 抽
  store.upsertSessions(uid, [
    { id: 'c', title: 'C', createdAt: 7000, updatedAt: 7000, payload: payload('C', ['file_from_body_zz']) },
  ])
  check('缺 fileIds 时从 payload 抽引用', store.fileRefCounts(uid).get('file_from_body_zz') === 1)

  // 路径穿越形状的 id 不许入表
  store.upsertSessions(uid, [
    {
      id: 'd',
      title: 'D',
      createdAt: 7001,
      updatedAt: 7001,
      payload: payload('D', ['../../etc/passwd']),
    },
  ])
  check('非法附件 id 不入引用表', ![...store.fileRefCounts(uid).keys()].includes('../../etc/passwd'))

  // ── 5. 全量重建 ──────────────────────────────────────
  const liveBefore = store.fileRefCounts(uid)
  const rebuilt = store.rebuildRefs(uid)
  check('重建扫到会话', rebuilt.sessions > 0, JSON.stringify(rebuilt))
  const afterRebuild = store.fileRefCounts(uid)
  const sameMap =
    liveBefore.size === afterRebuild.size &&
    [...liveBefore].every(([id, n]) => afterRebuild.get(id) === n)
  check(
    '重建结果与运行时维护的计数完全一致',
    sameMap,
    `before=${JSON.stringify([...liveBefore])} after=${JSON.stringify([...afterRebuild])}`
  )
  check('重建后共享附件计数为 1（B 已改用新附件）', afterRebuild.get(shared) === 1, String(afterRebuild.get(shared)))
  check('重建后从 payload 抽的引用还在', afterRebuild.get('file_from_body_zz') === 1)
  check('重建后会话数与库一致', rebuilt.sessions === store.countSessions(uid))

  // ── 6. 账号隔离 ──────────────────────────────────────
  check('另一个账号看不到这些引用', store.fileRefCounts(other.id).size === 0)
  check('另一个账号的会话列表为空', store.listSessions(other.id).length === 0)
  check('另一个账号没有墓碑', store.listTombstones(other.id).length === 0)

  // ── 7. GC 前置条件 ───────────────────────────────────
  check('重建标记存在（GC 才被允许）', store.refsTrusted())
  // 删光所有会话后引用表本来就是空的，这不该让 GC 失效
  for (const row of store.listSessions(uid, { limit: 2000 })) {
    store.deleteSession(uid, row.id)
  }
  check('删光会话后引用表为空', store.fileRefCounts(uid).size === 0)
  check('引用表为空但依然可信（这是该回收的时刻）', store.refsTrusted())

  // ── 8. 单条消息增量追加（发送热路径）─────────────────
  /**
   * 这条路径取代"每发一句就整车重传"。它一旦写错，后果比慢更糟：
   * 要么追加到别人的会话里，要么把已删除的会话复活，要么在别的设备
   * 已经改过时把对方的内容盖掉。下面每一项都对着一个具体的坏结果。
   */
  const incMsg = (id: string, fileIds: string[] = []) => ({
    id,
    role: 'user',
    content: 'hi',
    createdAt: 5,
    ...(fileIds.length > 0 ? { files: fileIds.map((fileId) => ({ id: fileId })) } : {}),
  })
  store.upsertSessions(uid, [
    {
      id: 's_inc',
      title: '增量',
      createdAt: 1000,
      updatedAt: 1000,
      payload: JSON.stringify({
        id: 's_inc',
        title: '增量',
        createdAt: 1000,
        updatedAt: 1000,
        messages: [incMsg('m0')],
      }),
    },
  ])
  const readInc = () => store.readSession(uid, 's_inc')!
  const incMessages = () =>
    (JSON.parse(readInc().payload) as { messages: Array<{ id: string }> }).messages

  const a1 = store.appendMessage(uid, 's_inc', {
    message: incMsg('m1', ['file_inc_aa']),
    updatedAt: 1600,
    base: 1000,
  })
  check('增量追加成功', a1.ok === true && a1.idempotent === false, JSON.stringify(a1))
  check('追加后消息数 +1', incMessages().length === 2, JSON.stringify(incMessages().map((m) => m.id)))
  check('服务端 updatedAt 前进', readInc().updatedAt === 1600, String(readInc().updatedAt))
  check(
    'payload 内的 updatedAt 同步（否则下次拉取会判成旧版本）',
    (JSON.parse(readInc().payload) as { updatedAt: number }).updatedAt === 1600
  )
  check(
    '追加消息里的附件进了引用表（否则 GC 会删掉在用的文件）',
    store.fileRefCounts(uid).get('file_inc_aa') === 1,
    JSON.stringify([...store.fileRefCounts(uid)])
  )

  const a2 = store.appendMessage(uid, 's_inc', {
    message: incMsg('m1'),
    updatedAt: 1700,
    base: 1600,
  })
  check('重复投递幂等（重试安全）', a2.ok === true && a2.idempotent === true, JSON.stringify(a2))
  check('幂等时不产生第二条', incMessages().length === 2)

  const a3 = store.appendMessage(uid, 's_inc', {
    message: incMsg('m2'),
    updatedAt: 1800,
    base: 100,
  })
  check(
    '云端版本超前时拒绝追加（不盖掉别的设备）',
    a3.ok === false && a3.reason === 'stale',
    JSON.stringify(a3)
  )
  check('拒绝后内容未变', incMessages().length === 2)

  const a4 = store.appendMessage(uid, 's_inc', {
    message: incMsg('m3'),
    updatedAt: 1200,
    base: 1600,
  })
  check(
    '客户端时钟回拨也不倒退（服务端时间戳单调前进）',
    a4.ok === true && readInc().updatedAt === 1601,
    JSON.stringify({ a4, updatedAt: readInc().updatedAt })
  )

  const a5 = store.appendMessage(uid, 'not_exists', {
    message: incMsg('m4'),
    updatedAt: 9000,
    base: 9000,
  })
  check(
    '会话不存在时返回 missing（客户端据此回落整段推送）',
    a5.ok === false && a5.reason === 'missing',
    JSON.stringify(a5)
  )

  const a6 = store.appendMessage(other.id, 's_inc', {
    message: incMsg('m5'),
    updatedAt: 9500,
    base: 9500,
  })
  check('别的账号追加不进来（跨用户隔离）', a6.ok === false && a6.reason === 'missing', JSON.stringify(a6))
  check('隔离失败会立刻写进别人的会话', incMessages().every((m) => m.id !== 'm5'))

  store.deleteSession(uid, 's_inc')
  const a7 = store.appendMessage(uid, 's_inc', {
    message: incMsg('m9'),
    updatedAt: 20_000,
    base: 20_000,
  })
  check(
    '删过的会话不会被一条追加消息复活',
    a7.ok === false && a7.reason === 'missing',
    JSON.stringify(a7)
  )
  check('墓碑后读回为空', store.readSession(uid, 's_inc') === null)

  store.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${pass} 项通过，${fail} 项失败`)
if (fail > 0) {
  process.exitCode = 1
}
