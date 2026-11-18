/**
 * 端到端验收：会话分页 / 墓碑 / 置顶 / 附件引用与回收（阶段 2-1 + 2-3 的服务端侧）。
 *
 * 为什么要起真进程而不是直接调 store：这些行为有一半在 HTTP 层
 * （查询参数、返回字段、GC 默认 dryRun、refs_not_ready 护栏），
 * 只测 store 会把"接口把参数读错了"整类问题漏掉。
 *
 *   node scripts/e2e-sync.ts
 *
 * 用临时目录 + 临时端口，不碰生产库。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 18787
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'e2e-sync-token-0123456789abcdef'
const dir = mkdtempSync(join(tmpdir(), 'ds-sync-e2e-'))

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

const child = spawn(process.execPath, ['src/index.ts'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    GATEWAY_TOKEN: TOKEN,
    AUTH_DB_PATH: join(dir, 'auth.db'),
    MEMORY_DATA_DIR: join(dir, 'users'),
    // 端到端只关心同步，不碰上游与记忆
    DEEPSEEK_API_KEY: '',
    ALLOW_INSTANCE_KEY: '0',
    MEMORY_ENABLE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let gatewayLog = ''
child.stdout?.on('data', (chunk) => {
  gatewayLog += String(chunk)
})
child.stderr?.on('data', (chunk) => {
  gatewayLog += String(chunk)
})

const waitForHealth = async (): Promise<boolean> => {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${BASE}/health`)
      if (response.ok) {
        return true
      }
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

const call = async (
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN, ...(init.headers ?? {}) },
  })
  let json: Record<string, unknown> = {}
  try {
    json = (await response.json()) as Record<string, unknown>
  } catch {
    json = {}
  }
  return { status: response.status, json }
}

const payload = (fileIds: string[] = []) =>
  JSON.stringify({
    id: 'x',
    title: 'x',
    messages: fileIds.map((id) => ({ role: 'user', content: '', files: [{ id }] })),
  })

const push = async (
  sessions: Array<{ id: string; title?: string; updatedAt: number; pinned?: boolean; fileIds?: string[] }>
) =>
  call('/sync/sessions', {
    method: 'POST',
    body: JSON.stringify({
      sessions: sessions.map((item) => ({
        id: item.id,
        title: item.title ?? item.id,
        createdAt: item.updatedAt,
        updatedAt: item.updatedAt,
        pinned: item.pinned === true,
        fileIds: item.fileIds ?? [],
        payload: payload(item.fileIds ?? []),
      })),
    }),
  })

try {
  if (!(await waitForHealth())) {
    console.log('网关没起来：\n' + gatewayLog.slice(-2000))
    throw new Error('gateway did not start')
  }

  // ── 1. 推送与列表 ──────────────────────────────────
  const first = await push([
    { id: 's1', title: '一', updatedAt: 1000, pinned: true },
    { id: 's2', title: '二', updatedAt: 2000 },
  ])
  check('推送会话成功', first.status === 200 && first.json.written === 2, JSON.stringify(first.json))

  const list = await call('/sync/sessions')
  const sessions = (list.json.sessions ?? []) as Array<Record<string, unknown>>
  check('列表返回 2 条', sessions.length === 2, JSON.stringify(sessions))
  check('置顶字段随列表返回', sessions.some((item) => item.id === 's1' && item.pinned === true))
  check('列表不含正文', !('payload' in (sessions[0] ?? {})))
  check('返回 serverTime 供增量游标', typeof list.json.serverTime === 'number')

  // ── 2. 分页：不漏不重 ──────────────────────────────
  const bulk = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, updatedAt: 3000 + i }))
  // 同一毫秒的并列会话：只用时间做游标会在跨页处漏掉
  const ties = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, updatedAt: 4000 }))
  await push([...bulk, ...ties])

  const seen = new Set<string>()
  let cursor = { before: 0, beforeId: '' }
  let pages = 0
  for (;;) {
    const query = new URLSearchParams({ limit: '3' })
    if (cursor.before) {
      query.set('before', String(cursor.before))
      query.set('beforeId', cursor.beforeId)
    }
    const page = await call(`/sync/sessions?${query}`)
    const rows = (page.json.sessions ?? []) as Array<Record<string, unknown>>
    pages += 1
    for (const row of rows) {
      seen.add(String(row.id))
    }
    if (page.json.hasMore !== true) {
      break
    }
    cursor = {
      before: Number(page.json.nextBefore ?? 0),
      beforeId: String(page.json.nextBeforeId ?? ''),
    }
    if (pages > 20) {
      break
    }
  }
  check('翻页拿到全部 12 条会话（不漏）', seen.size === 12, `${seen.size} / 12`)
  check('并列时间戳的会话没被跳过', ['t0', 't1', 't2'].every((id) => seen.has(id)))
  check('翻页至少 4 页（limit=3）', pages >= 4, `pages=${pages}`)

  // ── 3. 附件引用计数 ────────────────────────────────
  const fileId = 'file_shared_e2e'
  const upload = await fetch(`${BASE}/sync/files/${fileId}`, {
    method: 'PUT',
    headers: { 'x-api-key': TOKEN, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  })
  check('上传附件成功', upload.ok, String(upload.status))

  await push([
    { id: 'r1', updatedAt: 5000, fileIds: [fileId] },
    { id: 'r2', updatedAt: 5001, fileIds: [fileId] },
  ])
  const files = await call('/sync/files')
  const fileRows = (files.json.files ?? []) as Array<Record<string, unknown>>
  const shared = fileRows.find((item) => item.id === fileId)
  check('附件列表带引用计数', shared?.refs === 2, JSON.stringify(shared))

  // ── 4. 删除 → 引用下降 → 墓碑 ─────────────────────
  await call('/sync/session?id=r2', { method: 'DELETE' })
  const afterDelete = await call('/sync/files')
  const sharedAfter = ((afterDelete.json.files ?? []) as Array<Record<string, unknown>>).find(
    (item) => item.id === fileId
  )
  check('删一条会话后引用降到 1', sharedAfter?.refs === 1, JSON.stringify(sharedAfter))
  const tombstones = await call('/sync/sessions')
  check(
    '墓碑随清单下发',
    ((tombstones.json.deleted ?? []) as Array<Record<string, unknown>>).some((item) => item.id === 'r2')
  )

  // ── 5. GC：默认 dry-run，引用还在就不删 ────────────
  const dry = await call('/sync/files/gc', { method: 'POST', body: '{}' })
  check('GC 默认 dry-run', dry.json.dryRun === true, JSON.stringify(dry.json))
  check(
    '仍被引用的附件不在候选里',
    !((dry.json.candidates ?? []) as Array<Record<string, unknown>>).some((item) => item.id === fileId)
  )

  // 把 r1 也删掉 → 引用归零 → 宽限期 0 天后可回收
  await call('/sync/session?id=r1', { method: 'DELETE' })
  const zero = await call('/sync/files')
  const sharedZero = ((zero.json.files ?? []) as Array<Record<string, unknown>>).find(
    (item) => item.id === fileId
  )
  check('引用归零', sharedZero?.refs === 0, JSON.stringify(sharedZero))

  const dryZero = await call('/sync/files/gc', {
    method: 'POST',
    body: JSON.stringify({ graceDays: 0 }),
  })
  check(
    '零引用附件进入候选',
    ((dryZero.json.candidates ?? []) as Array<Record<string, unknown>>).some((item) => item.id === fileId),
    JSON.stringify(dryZero.json)
  )
  check('dry-run 没真删', (await fetch(`${BASE}/sync/files/${fileId}`, { headers: { 'x-api-key': TOKEN } })).ok)

  const applied = await call('/sync/files/gc', {
    method: 'POST',
    body: JSON.stringify({ graceDays: 0, dryRun: false }),
  })
  check('真删执行成功', applied.json.dryRun === false && Number(applied.json.removed) === 1, JSON.stringify(applied.json))
  const gone = await fetch(`${BASE}/sync/files/${fileId}`, { headers: { 'x-api-key': TOKEN } })
  check('真删后附件取不到了', gone.status === 404, String(gone.status))

  // ── 6. 引用重建 ───────────────────────────────────
  const rebuild = await call('/sync/files/refs/rebuild', { method: 'POST', body: '{}' })
  check('引用重建成功', rebuild.status === 200 && Number(rebuild.json.sessions) > 0, JSON.stringify(rebuild.json))

  // ── 7. 鉴权 ───────────────────────────────────────
  const anonymous = await fetch(`${BASE}/sync/sessions`)
  check('未带令牌返回 401', anonymous.status === 401, String(anonymous.status))
} finally {
  child.kill()
  await new Promise((resolve) => setTimeout(resolve, 200))
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${pass} 项通过，${fail} 项失败`)
if (fail > 0) {
  process.exitCode = 1
}
