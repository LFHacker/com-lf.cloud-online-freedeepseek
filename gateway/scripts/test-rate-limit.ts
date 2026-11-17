/**
 * 限流器单测。
 *
 * 重点验证滑动窗口的边界行为——固定窗口在边界处会放行双倍流量，
 * 这条最容易写错也最容易漏测。
 */
import assert from 'node:assert'
import { createRateLimiter } from '../src/rate-limit.ts'

let pass = 0
let fail = 0
const test = (name: string, fn: () => void) => {
  try {
    fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('=== 基本放行/拦截 ===')
test('窗口内未超限时全部放行', () => {
  const rl = createRateLimiter({ windowMs: 1000, maxPerWindow: 3, maxKeys: 100 })
  assert.strictEqual(rl.check('a', 0).allowed, true)
  assert.strictEqual(rl.check('a', 100).allowed, true)
  assert.strictEqual(rl.check('a', 200).allowed, true)
})
test('超过上限后拦截', () => {
  const rl = createRateLimiter({ windowMs: 1000, maxPerWindow: 2, maxKeys: 100 })
  rl.check('a', 0)
  rl.check('a', 10)
  const third = rl.check('a', 20)
  assert.strictEqual(third.allowed, false)
  assert.ok(third.retryAfterSeconds >= 1, `retryAfter=${third.retryAfterSeconds}`)
})
test('remaining 随请求递减', () => {
  const rl = createRateLimiter({ windowMs: 1000, maxPerWindow: 3, maxKeys: 100 })
  assert.strictEqual(rl.check('a', 0).remaining, 2)
  assert.strictEqual(rl.check('a', 1).remaining, 1)
  assert.strictEqual(rl.check('a', 2).remaining, 0)
})
test('不同来源互不影响', () => {
  const rl = createRateLimiter({ windowMs: 1000, maxPerWindow: 1, maxKeys: 100 })
  assert.strictEqual(rl.check('a', 0).allowed, true)
  assert.strictEqual(rl.check('b', 0).allowed, true)
  assert.strictEqual(rl.check('a', 1).allowed, false)
})

console.log('\n=== 滑动窗口边界 ===')
test('★ 窗口过期后重新放行', () => {
  const rl = createRateLimiter({ windowMs: 1000, maxPerWindow: 1, maxKeys: 100 })
  assert.strictEqual(rl.check('a', 0).allowed, true)
  assert.strictEqual(rl.check('a', 500).allowed, false, '窗口内应被拦')
  assert.strictEqual(rl.check('a', 1001).allowed, true, '过了窗口应放行')
})
test('★ 不是固定窗口：跨边界不会放行双倍', () => {
  // 固定窗口实现下：t=999 用掉额度、t=1000 进入新窗口又满额度 → 短时间放行 2 倍
  const rl = createRateLimiter({ windowMs: 1000, maxPerWindow: 2, maxKeys: 100 })
  rl.check('a', 900)
  rl.check('a', 999)
  // 到 1000 时，900 那次仍在窗口内 → 只应剩余 0
  assert.strictEqual(rl.check('a', 1000).allowed, false, '滑动窗口不该在边界放行')
  // 900 过期后（t>1900）才腾出一个名额
  assert.strictEqual(rl.check('a', 1901).allowed, true)
})
test('retryAfter 指向最早那次过期的时间', () => {
  const rl = createRateLimiter({ windowMs: 10_000, maxPerWindow: 1, maxKeys: 100 })
  rl.check('a', 0)
  const blocked = rl.check('a', 4000)
  assert.strictEqual(blocked.allowed, false)
  // 最早那次在 0，窗口 10s → 到 10s 才放行，此刻 4s → 还应等约 6s
  assert.ok(blocked.retryAfterSeconds >= 5 && blocked.retryAfterSeconds <= 6, `retryAfter=${blocked.retryAfterSeconds}`)
})

console.log('\n=== 内存上界 ===')
test('★ 来源数达上限后淘汰最久未活动的，不会无限增长', () => {
  const rl = createRateLimiter({ windowMs: 10_000, maxPerWindow: 5, maxKeys: 3 })
  rl.check('a', 0)
  rl.check('b', 100)
  rl.check('c', 200)
  assert.strictEqual(rl.size(), 3)
  rl.check('d', 300) // 应淘汰最久未活动的 a
  assert.strictEqual(rl.size(), 3, '不应超过 maxKeys')
})
test('reset 能清掉某来源的记录', () => {
  const rl = createRateLimiter({ windowMs: 1000, maxPerWindow: 1, maxKeys: 100 })
  rl.check('a', 0)
  assert.strictEqual(rl.check('a', 1).allowed, false)
  rl.reset('a')
  assert.strictEqual(rl.check('a', 2).allowed, true)
})

console.log(`\n=== PASS=${pass}  FAIL=${fail} ===`)
if (fail > 0) {
  process.exitCode = 1
}
