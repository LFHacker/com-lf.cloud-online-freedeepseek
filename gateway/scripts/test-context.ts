/**
 * context.ts 的单元测试：估算与裁剪的不变量。
 *
 * 重点不是"能不能裁"，而是那几个**一旦破坏就会让请求直接 400** 的约束：
 * 裁剪后的历史必须以 user 开头、最后一条提问不能被丢、不能把一问一答拆散。
 */
import assert from 'node:assert'
import {
  buildTrimNotice,
  estimateMessageTokens,
  estimateTextTokens,
  trimMessages,
} from '../src/context.ts'

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

const round = (n: number, textLength = 40) => {
  const body = '问'.repeat(textLength)
  const answer = '答'.repeat(textLength)
  const items: unknown[] = []
  for (let i = 0; i < n; i += 1) {
    items.push({ role: 'user', content: `${body}${i}` })
    items.push({ role: 'assistant', content: [{ type: 'text', text: `${answer}${i}` }] })
  }
  return items
}

console.log('=== token 估算 ===')
test('中文按 1 字符 ≈ 1 token', () => {
  const tokens = estimateTextTokens('你好世界')
  assert.ok(tokens >= 4 && tokens <= 5, `得到 ${tokens}`)
})
test('英文按 4 字符 ≈ 1 token', () => {
  assert.strictEqual(estimateTextTokens('abcdefgh'), 2)
})
test('空串为 0', () => {
  assert.strictEqual(estimateTextTokens(''), 0)
})
test('混合内容不会低估纯中文部分', () => {
  const cjk = estimateTextTokens('中文测试')
  const mixed = estimateTextTokens('中文测试abc')
  assert.ok(mixed >= cjk, 'mixed 应不小于纯中文')
})
test('消息估算含结构开销', () => {
  const msg = { role: 'user', content: 'a' }
  assert.ok(estimateMessageTokens(msg) > estimateTextTokens('a'))
})
test('内容块数组能被递归统计', () => {
  const msg = {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '想'.repeat(50), signature: 'sig' }],
  }
  assert.ok(estimateMessageTokens(msg) >= 50, `得到 ${estimateMessageTokens(msg)}`)
})

console.log('\n=== 裁剪：不需要裁 ===')
test('预算充足时原样返回', () => {
  const messages = round(2)
  const r = trimMessages(messages, 100_000)
  assert.strictEqual(r.trimmed, false)
  assert.strictEqual(r.messages.length, messages.length)
  assert.strictEqual(r.trimmedMessages, 0)
})
test('只有一条消息时不裁', () => {
  const r = trimMessages([{ role: 'user', content: 'hi' }], 1)
  assert.strictEqual(r.messages.length, 1)
  assert.strictEqual(r.trimmed, false)
})

console.log('\n=== 裁剪：会裁时必须守住的不变量 ===')
const history = [...round(20), { role: 'user', content: '这是本轮最新提问' }]
const budget = 400
const cut = trimMessages(history, budget)

test('确实发生了裁剪', () => {
  assert.strictEqual(cut.trimmed, true)
  assert.ok(cut.trimmedMessages > 0)
})
test('★ 最后一条（本轮提问）必须保留', () => {
  const last = cut.messages.at(-1) as { role: string; content: string }
  assert.strictEqual(last.role, 'user')
  assert.strictEqual(last.content, '这是本轮最新提问')
})
test('★ 裁剪后必须以 user 开头（assistant 打头会 400）', () => {
  const first = cut.messages[0] as { role: string }
  assert.strictEqual(first.role, 'user')
})
test('★ 不许把一问一答拆散：user 数 = assistant 数 或 多 1', () => {
  const roles = cut.messages.map((m) => (m as { role: string }).role)
  const users = roles.filter((r) => r === 'user').length
  const assistants = roles.filter((r) => r === 'assistant').length
  assert.ok(users === assistants || users === assistants + 1, `users=${users} assistants=${assistants}`)
})
test('角色顺序严格交替（user, assistant, user, ...）', () => {
  const roles = cut.messages.map((m) => (m as { role: string }).role)
  roles.forEach((role, index) => {
    const expected = index % 2 === 0 ? 'user' : 'assistant'
    assert.strictEqual(role, expected, `第 ${index} 条应为 ${expected}，实际 ${role}`)
  })
})
test('保留部分确实在预算内', () => {
  assert.ok(cut.keptTokens <= budget, `keptTokens=${cut.keptTokens} budget=${budget}`)
})
test('trimmedTokens + keptTokens = 原始总量', () => {
  const total = history.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  assert.strictEqual(cut.trimmedTokens + cut.keptTokens, total)
})
test('不修改传入的原数组', () => {
  assert.strictEqual(history.length, 41)
})

console.log('\n=== 极端情况 ===')
test('单条就超预算时仍保留它，并标记 overBudgetAfterTrim', () => {
  const huge = [{ role: 'user', content: '巨'.repeat(10_000) }, { role: 'user', content: '巨'.repeat(10_000) }]
  const r = trimMessages(huge, 100)
  assert.strictEqual(r.messages.length >= 1, true)
  assert.strictEqual(r.overBudgetAfterTrim, true)
})
test('通知文案包含被省略的条数', () => {
  const notice = buildTrimNotice(7)
  assert.ok(notice.includes('7'), notice)
  assert.ok(notice.includes('不要猜测') || notice.includes('不要编造'), '应明确要求不要编造')
})
test('文档被丢时的通知要明确说"看不到该文档"', () => {
  const notice = buildTrimNotice(9, true)
  assert.ok(notice.includes('文档'), notice)
  assert.ok(notice.includes('看不到') || notice.includes('重新上传'), notice)
})

console.log('\n=== 带文档的轮次受保护（全文直传策略下必须成立）===')
/** 第一轮带文档，后面若干纯文本轮次，最后一轮是最新提问 */
const docRound = { role: 'user', content: [
  { type: 'document', source: { type: 'file', file_id: 'file-api-test' } },
  { type: 'text', text: '这份文档讲了什么' },
] }
const docAssistant = { role: 'assistant', content: [{ type: 'text', text: '答'.repeat(100) }] }
const withDoc = [docRound, docAssistant, ...round(10), { role: 'user', content: '最新问题' }]

const keepDoc = trimMessages(withDoc, 300)
test('★ 纯文本轮次够丢时，带文档的第一轮被保住', () => {
  assert.strictEqual(keepDoc.trimmed, true)
  assert.strictEqual(keepDoc.droppedPinned, false, '不应该丢掉文档轮次')
  const keptDoc = keepDoc.messages.some(
    (m) => Array.isArray((m as { content?: unknown }).content) &&
      ((m as { content: { type?: string }[] }).content).some((b) => b.type === 'document')
  )
  assert.ok(keptDoc, '文档块应仍在裁剪后的消息里')
})
test('保文档时最后一条提问也仍在', () => {
  const last = keepDoc.messages.at(-1) as { content: string }
  assert.strictEqual(last.content, '最新问题')
})

const dropDoc = trimMessages(withDoc, 100)
test('★ 纯文本全丢完仍超预算，才丢文档轮次', () => {
  assert.strictEqual(dropDoc.droppedPinned, true, '应标记为丢掉了文档轮次')
})
test('★ 即使丢了文档，也绝不超预算（否则会 400）', () => {
  assert.ok(dropDoc.keptTokens <= 100, `keptTokens=${dropDoc.keptTokens}`)
})

console.log('\n=== latest_reminder 归属 ===')
const withReminders = [
  { role: 'latest_reminder', content: '今天日期…' },
  { role: 'user', content: '问题'.repeat(20) },
  { role: 'assistant', content: [{ type: 'text', text: '答'.repeat(20) }] },
  { role: 'latest_reminder', content: '今天日期…' },
  { role: 'user', content: '问题'.repeat(20) },
  { role: 'assistant', content: [{ type: 'text', text: '答'.repeat(20) }] },
  { role: 'latest_reminder', content: '今天日期…' },
  { role: 'user', content: '最新问题' },
]
const trimmedReminders = trimMessages(withReminders, 60)
test('★ 裁剪后不会以 assistant 开头（reminder 不会把轮次切坏）', () => {
  const first = trimmedReminders.messages[0] as { role: string }
  assert.notStrictEqual(first.role, 'assistant')
})
test('★ 裁剪后每条 assistant 前面都有它的 user', () => {
  const roles = trimmedReminders.messages.map((m) => (m as { role: string }).role)
  assert.ok(roles.includes('user'), '至少要留着提问')
  // 第一条 user 之前只允许 reminder，不允许凭空出现 assistant
  const firstUser = roles.indexOf('user')
  assert.ok(firstUser >= 0)
  assert.ok(roles.slice(0, firstUser).every((r) => r === 'latest_reminder'))
})

console.log('\n=== 滞回裁剪（保住前缀缓存）===')
test('★ 给 reserve 时一次裁到目标水位以下（不是刚好卡在预算边缘）', () => {
  // 目的：让裁剪起点稳定很多轮。若每轮只裁掉刚超出的那一点，
  // 起点会每轮往后挪一格 → 每轮请求都没有公共前缀 → 缓存全灭。
  const rounds: unknown[] = []
  for (let i = 0; i < 40; i += 1) {
    rounds.push({ role: 'user', content: `问题${i}` + '问'.repeat(200) })
    rounds.push({ role: 'assistant', content: [{ type: 'text', text: `回答${i}` + '答'.repeat(200) }] })
  }
  rounds.push({ role: 'user', content: '最后一个问题' })
  const budget = 12_000
  const noReserve = trimMessages(rounds, budget, 0)
  const withReserve = trimMessages(rounds, budget, 0.2)
  assert.ok(withReserve.trimmed, '应该发生裁剪')
  assert.ok(
    withReserve.keptTokens <= budget * 0.8 + 50,
    `应裁到 80% 以下，实际 ${withReserve.keptTokens} / 预算 ${budget}`
  )
  assert.ok(
    withReserve.trimmedMessages >= noReserve.trimmedMessages,
    '带 reserve 应至少丢掉同样多的消息'
  )
})
test('★ reserve 不会把最后一条提问裁掉', () => {
  const rounds: unknown[] = []
  for (let i = 0; i < 40; i += 1) {
    rounds.push({ role: 'user', content: '问'.repeat(200) })
    rounds.push({ role: 'assistant', content: [{ type: 'text', text: '答'.repeat(200) }] })
  }
  rounds.push({ role: 'user', content: '这一定是最后一条' })
  const outcome = trimMessages(rounds, 12_000, 0.5)
  const last = outcome.messages.at(-1) as { content: string }
  assert.strictEqual(last.content, '这一定是最后一条')
})

console.log(`\n=== PASS=${pass}  FAIL=${fail} ===`)
if (fail > 0) {
  process.exitCode = 1
}
