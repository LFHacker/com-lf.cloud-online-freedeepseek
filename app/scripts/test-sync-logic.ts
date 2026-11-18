/**
 * 客户端同步的纯逻辑测试：清单合并规则 + 退避时长。
 *
 * 这些断言不是"跑得通"，而是**每条数据损坏路径各有一条**：
 *   · 云端没有、本地有 → 必须推送，不能静默丢（丢的就是用户刚建的会话）
 *   · 云端为空且无墓碑 → 必须判异常，不能把本地清空
 *   · 本地更新 → 不能被旧的云端版本覆盖
 *   · 退避必须有上限且带抖动（否则多设备同时恢复会打表）
 *
 * 运行：node app/scripts/test-sync-logic.ts
 */
import { backoffDelay, BASE_DELAY_MS, MAX_DELAY_MS } from '../src/services/sync/backoff.ts'
import { cloudLooksWiped, mergeSessionIndex } from '../src/services/sync/merge.ts'

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

const summary = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `T-${id}`,
  createdAt: 1,
  updatedAt,
  ...extra,
})

const meta = (id: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `C-${id}`,
  createdAt: 1,
  updatedAt,
  pinned: false,
  ...extra,
})

// ── 1. 云端有、本地没有 ────────────────────────────────
{
  const result = mergeSessionIndex([], [meta('a', 100)], [])
  check('云端会话出现在列表里', result.sessions.length === 1 && result.sessions[0].id === 'a')
  check('标记为只在云端（正文待下载）', result.remoteOnly.length === 1 && result.remoteOnly[0] === 'a')
  check('不需要推回云端', result.toPush.length === 0)
  check('标题用云端的', result.sessions[0].title === 'C-a')
  check('置顶状态来自云端', result.sessions[0].pinned === false)
}

// ── 2. 云端更新 → 用云端 ──────────────────────────────
{
  const result = mergeSessionIndex([summary('a', 50)], [meta('a', 100, { pinned: true })], [])
  check('云端更新时用云端的标题', result.sessions[0].title === 'C-a')
  check('云端更新时不推送', result.toPush.length === 0)
  check('云端置顶生效', result.sessions[0].pinned === true)
  check('不是"只在云端"（本地有缓存）', result.remoteOnly.length === 0)
}

// ── 3. 本地更新 → 用本地 + 推送 ───────────────────────
{
  const result = mergeSessionIndex([summary('a', 200, { pinned: true })], [meta('a', 100)], [])
  check('本地更新时用本地标题', result.sessions[0].title === 'T-a')
  check('本地更新时标记待推送', result.toPush.includes('a'))
  check('本地置顶没被云端旧值覆盖', result.sessions[0].pinned === true)
}

// ── 4. 本地有、云端没有 → 保留并推送 ──────────────────
{
  const result = mergeSessionIndex([summary('local-only', 300)], [], [])
  check('云端没有的本地会话不被丢弃', result.sessions.some((item) => item.id === 'local-only'))
  check('云端没有的本地会话要推送', result.toPush.includes('local-only'))
}

// ── 5. 墓碑 ───────────────────────────────────────────
{
  const result = mergeSessionIndex([summary('gone', 100)], [], ['gone'])
  check('墓碑里的会话不进列表', !result.sessions.some((item) => item.id === 'gone'))
  check('墓碑会话没被当成"待推送"', !result.toPush.includes('gone'))
  check('墓碑列在 removed 里', result.removed.includes('gone'))
}

// ── 6. 记忆模式沿用本地（它创建后不可改） ─────────────
{
  const result = mergeSessionIndex(
    [summary('a', 50, { memoryScope: 'global' })],
    [meta('a', 100)],
    []
  )
  check('合并后保留本地记忆模式', result.sessions[0].memoryScope === 'global')
}

// ── 7. 空云端护栏 ─────────────────────────────────────
{
  check('本地有数据 + 云端空 + 无墓碑 → 判为空清单异常', cloudLooksWiped(5, 0, 0))
  check('本地有数据 + 云端空 + 有墓碑 → 正常（用户真的删了）', !cloudLooksWiped(5, 0, 3))
  check('本地为空 + 云端空 → 正常（新账号）', !cloudLooksWiped(0, 0, 0))
  check('云端有数据 → 正常', !cloudLooksWiped(5, 2, 0))
}

// ── 8. 混合场景：不重不漏 ─────────────────────────────
{
  const result = mergeSessionIndex(
    [summary('keep-local', 500), summary('update', 150), summary('gone', 20)],
    [meta('update', 100), meta('fresh', 100), meta('gone', 20)],
    ['gone']
  )
  const ids = result.sessions.map((item) => item.id).sort()
  check(
    '混合场景的列表正好是 keep-local / update / fresh',
    JSON.stringify(ids) === JSON.stringify(['fresh', 'keep-local', 'update']),
    JSON.stringify(ids)
  )
  check(
    '待推送只有本地更新的和云端没有的',
    JSON.stringify(result.toPush.sort()) === JSON.stringify(['keep-local', 'update']),
    JSON.stringify(result.toPush)
  )
  check('被删的不会重复出现在待推送里', !result.toPush.includes('gone'))
}

// ── 9. 退避 ───────────────────────────────────────────
{
  const fixed = () => 0.5 // 抖动系数正好 1.0，便于断言基数
  const delays = [1, 2, 3, 4, 5].map((n) => backoffDelay(n, fixed))
  check(
    '退避按 2 的幂递增',
    JSON.stringify(delays) === JSON.stringify([2000, 4000, 8000, 16000, 32000]),
    JSON.stringify(delays)
  )
  check('退避有上限', backoffDelay(20, fixed) === MAX_DELAY_MS, String(backoffDelay(20, fixed)))
  check('第 0 次也不会算出 0 或负数', backoffDelay(0, fixed) === BASE_DELAY_MS)
  const low = backoffDelay(3, () => 0)
  const high = backoffDelay(3, () => 1)
  check('抖动下限约 -20%', low === Math.round(8000 * 0.8), String(low))
  check('抖动上限约 +20%', high === Math.round(8000 * 1.2), String(high))
}

console.log(`\n${pass} 项通过，${fail} 项失败`)
if (fail > 0) {
  process.exitCode = 1
}
