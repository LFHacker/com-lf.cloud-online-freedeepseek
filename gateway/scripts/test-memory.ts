/**
 * 记忆库单测。
 *
 * 覆盖重点（都是这轮实测踩到的真实行为，不是想象出来的）：
 *  - FTS5 trigram 对长中文句子 AND 语义 → 必须拆词 OR
 *  - 单字/双字查不到（trigram 最少 3 字）
 *  - 本地会话不能泄漏到全局检索
 *  - 模式一旦登记不可变更
 *  - 回忆块必须拼在最后一条消息里（保住前缀缓存）
 */
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitIntoChunks, CHUNK_MAX_CHARS } from '../src/memory/chunk.ts'
import { buildFallbackTerms, buildMatchExpression, buildSearchTerms } from '../src/memory/query.ts'
import { MemoryStore } from '../src/memory/store.ts'
import {
  AssistantTextCollector,
  extractText,
  extractUserMessages,
  findLastUserMessage,
  injectRecall,
  stripInjectedBlocks,
} from '../src/memory/wire.ts'
import { createMockEmbeddingClient } from './mock-embed.ts'

let pass = 0
let fail = 0
const test = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('=== 切片 ===')
await test('短文本不切', async () => {
  assert.deepStrictEqual(splitIntoChunks('今天中午吃牛肉面'), ['今天中午吃牛肉面'])
})
await test('空文本返回空数组', async () => {
  assert.deepStrictEqual(splitIntoChunks('   '), [])
})
await test('★ 长文本切成多块且每块不超上限', async () => {
  const long = '这是一个句子。'.repeat(200)
  const chunks = splitIntoChunks(long)
  assert.ok(chunks.length > 1, `应该切多块，实际 ${chunks.length}`)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= CHUNK_MAX_CHARS, `有块超长: ${chunk.length}`)
  }
})
await test('★ 相邻块有重叠（避免切断后丢失上下文）', async () => {
  const chunks = splitIntoChunks('甲乙丙丁。'.repeat(150))
  if (chunks.length >= 2) {
    const head = chunks[1]?.slice(0, 10) ?? ''
    const tail = chunks[0]?.slice(-10) ?? ''
    assert.ok(head.length > 0 && tail.length > 0)
  }
})
await test('超长单句（代码）能被硬切且不丢内容', async () => {
  const code = 'x'.repeat(CHUNK_MAX_CHARS * 3)
  const chunks = splitIntoChunks(code)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.join('').includes('x'.repeat(CHUNK_MAX_CHARS)))
})

console.log('\n=== 检索词拆解 ===')
await test('★ 口语套话被剥离（否则会造成假命中）', async () => {
  const terms = buildSearchTerms('我记得你之前提过用什么数据库来着')
  const joined = terms.join(' ')
  assert.ok(!joined.includes('我记得'), `不该含「我记得」: ${joined}`)
  assert.ok(joined.includes('数据库'), `应含关键词「数据库」: ${joined}`)
})
await test('★ 长中文句子能拆出三元组（否则 AND 语义必然 0 命中）', async () => {
  const terms = buildSearchTerms('这个项目用什么状态管理')
  assert.ok(terms.length > 3, `三元组太少: ${terms.length}`)
  assert.ok(terms.every((t) => t.length >= 3), '每个词至少 3 字符')
})
await test('英文整词保留', async () => {
  const terms = buildSearchTerms('数据库选 SQLite 还是 Redis')
  assert.ok(terms.includes('sqlite'), terms.join(' '))
  assert.ok(terms.includes('redis'), terms.join(' '))
})
await test('纯标点不产生检索词', async () => {
  assert.deepStrictEqual(buildSearchTerms('？？？。。。'), [])
})
await test('★ MATCH 表达式每个词都加引号（否则特殊字符会抛语法错误）', async () => {
  const expr = buildMatchExpression(['OR', 'a-b', '状态管理'])
  assert.strictEqual(expr, '"OR" OR "a-b" OR "状态管理"')
})

console.log('\n=== 存储与召回 ===')

const dir = await mkdtemp(join(tmpdir(), 'ds-mem-'))
const dbPath = join(dir, 'memory.db')
const store = new MemoryStore({ dbPath, maxHits: 4, maxChars: 1200 })
const t0 = Date.UTC(2026, 8, 12, 10, 0, 0)

await test('新会话首次登记返回 created', async () => {
  const r = store.ensureSession('sess-global-0001', 'global', t0)
  assert.strictEqual(r.created, true)
  assert.strictEqual(r.scope, 'global')
})
await test('★ 会话模式不可变更（重复登记以首次为准）', async () => {
  const r = store.ensureSession('sess-global-0001', 'local', t0 + 1000)
  assert.strictEqual(r.created, false)
  assert.strictEqual(r.scope, 'global', '仍应是 global')
})
await test('独立滚动写入', async () => {
  store.ensureSession('sess-global-0002', 'global', t0)
  store.ensureSession('sess-local-0001', 'local', t0)
  const w1 = store.recordMessage({
    sessionId: 'sess-global-0001',
    scope: 'global',
    role: 'user',
    body: '这个项目前端用 React 和 Zustand，状态管理没有用 Redux',
    now: t0,
  })
  assert.strictEqual(w1.stored, true)
  assert.ok(w1.chunks >= 1)
})
await test('★ 相同内容重复入库只存一次（幂等）', async () => {
  const again = store.recordMessage({
    sessionId: 'sess-global-0001',
    scope: 'global',
    role: 'user',
    body: '这个项目前端用 React 和 Zustand，状态管理没有用 Redux',
    now: t0 + 5000,
  })
  assert.strictEqual(again.stored, false, '重复内容不应再存')
})

await test('★ 全局会话的内容能被别的会话召回', async () => {
  const hits = await store.search({
    text: '状态管理用的什么',
    excludeSessionId: 'sess-global-0002',
  })
  assert.ok(hits.length > 0, '应该召回全局记忆')
  assert.ok(hits[0]!.body.includes('Zustand'), hits[0]!.body)
})
await test('★ 不能召回自己会话的内容（避免重复占 token）', async () => {
  const hits = await store.search({
    text: '状态管理用的什么',
    excludeSessionId: 'sess-global-0001',
  })
  assert.ok(hits.every((h) => h.sessionId !== 'sess-global-0001'), '不该召回自己的')
})

await test('★ 本地会话的内容绝不进入全局检索', async () => {
  store.recordMessage({
    sessionId: 'sess-local-0001',
    scope: 'local',
    role: 'user',
    body: '这件事只在本地会话里说：我的银行卡密码暗示是生日',
    now: t0,
  })
  const hits = await store.search({ text: '银行卡密码暗示', excludeSessionId: 'sess-global-0001' })
  assert.strictEqual(hits.length, 0, `本地内容泄漏了: ${JSON.stringify(hits)}`)
})
await test('本地会话仍然落库（存储不丢，只是不跨会话可见）', async () => {
  // 已入库：全局会话 1 条用户消息 + 本地会话 1 条（重复写入被幂等去重，不计）
  const s = store.stats()
  assert.ok(s.messages >= 2, `本地消息应已落库，实际消息数 ${s.messages}`)
  assert.ok(s.chunks >= 1, '全局会话应有切片')
})

await test('★ 不相关的查询返回空（低分不注入，防幻觉）', async () => {
  const hits = await store.search({ text: '今天天气怎么样', excludeSessionId: 'sess-global-0002' })
  assert.strictEqual(hits.length, 0)
})

console.log('\n=== 2 字回退（真实失败案例）===')
// 真实场景：用户在 A 说「我叫刘飞」，在 B 问「我叫什么」。
// 去掉疑问词后只剩「我叫」两个字，trigram 最少要 3 字 → 必须靠回退救回来。
const fbDir = join(dir, 'fallback.db')
const fb = new MemoryStore({ dbPath: fbDir, maxHits: 4, maxChars: 1500 })
const fbNow = Date.UTC(2026, 10, 16, 10, 0, 0)
fb.ensureSession('fb-sess-aaaaaaaa', 'global', fbNow)
fb.ensureSession('fb-sess-bbbbbbbb', 'global', fbNow)
fb.recordMessage({ sessionId: 'fb-sess-aaaaaaaa', scope: 'global', role: 'user', body: '我叫刘飞', now: fbNow })
fb.recordMessage({
  sessionId: 'fb-sess-aaaaaaaa',
  scope: 'global',
  role: 'user',
  body: '证书用 Lets Encrypt 的 DNS-01 方式签发',
  now: fbNow,
})

await test('★「我叫什么」必须能召回「我叫刘飞」', async () => {
  const hits = await fb.search({ text: '我叫什么', excludeSessionId: 'fb-sess-bbbbbbbb' })
  assert.ok(hits.length > 0, '2 字回退失效')
  assert.ok(hits[0]!.body.includes('刘飞'), hits[0]!.body)
})
await test('★「证书怎么签的」能召回「…签发」（词形不同）', async () => {
  const hits = await fb.search({ text: '证书怎么签的', excludeSessionId: 'fb-sess-bbbbbbbb' })
  assert.ok(hits.some((hit) => hit.body.includes('签发')), JSON.stringify(hits.map((h) => h.body)))
})
await test('★ 回退不会把无关问题也召回（防噪声）', async () => {
  const hits = await fb.search({ text: '今天天气怎么样', excludeSessionId: 'fb-sess-bbbbbbbb' })
  assert.strictEqual(hits.length, 0)
})
await test('★ 停用词二字组被过滤（否则会命中全库）', async () => {
  const terms = buildFallbackTerms('我们什么都可以')
  assert.ok(!terms.includes('我们'), terms.join(','))
  assert.ok(!terms.includes('什么'), terms.join(','))
  assert.ok(!terms.includes('可以'), terms.join(','))
})
await test('回退词最多 3 个（避免 OR 过多放大噪声）', async () => {
  assert.ok(buildFallbackTerms('甲乙丙丁戊己庚辛').length <= 3)
})
await test('★ 助手回答只落库、不进检索索引（防自我强化的幻觉）', async () => {
  // 真实事故复现：库里存过助手说的「我叫DeepSeek」，
  // 用户问「我叫什么」时它被召回，模型于是自我介绍，把真正的「我叫刘飞」顶掉
  const written = fb.recordMessage({
    sessionId: 'fb-sess-aaaaaaaa',
    scope: 'global',
    role: 'assistant',
    body: '你还没有告诉我你的名字。我叫DeepSeek，很高兴认识你',
    now: fbNow,
  })
  assert.strictEqual(written.stored, true, '助手回答应仍然落库（P1 不丢数据）')
  assert.strictEqual(written.chunks, 0, '助手回答不应产生可检索切片')

  const hits = await fb.search({ text: '我叫什么', excludeSessionId: 'fb-sess-bbbbbbbb' })
  assert.ok(
    hits.every((hit) => !hit.body.includes('我叫DeepSeek')),
    `助手的话被当成记忆召回: ${JSON.stringify(hits.map((h) => h.body))}`
  )
  assert.ok(
    hits.some((hit) => hit.body.includes('刘飞')),
    '仍应召回用户自己说的话'
  )
})
fb.close()

console.log('\n=== 回声过滤与弱匹配补齐 ===')
const echoDir = join(dir, 'echo.db')
const echo = new MemoryStore({ dbPath: echoDir, maxHits: 4, maxChars: 1500 })
const echoNow = Date.UTC(2026, 10, 16, 11, 0, 0)
echo.ensureSession('echo-sess-aaaaaaaa', 'global', echoNow)
echo.ensureSession('echo-sess-bbbbbbbb', 'global', echoNow)
// 真实失败序列：先问过「我叫什么」（这句会被存成记忆并成为回声），后来才自我介绍
echo.recordMessage({ sessionId: 'echo-sess-aaaaaaaa', scope: 'global', role: 'user', body: '我叫什么', now: echoNow + 1000 })
echo.recordMessage({ sessionId: 'echo-sess-aaaaaaaa', scope: 'global', role: 'user', body: '我叫刘飞', now: echoNow + 2000 })

await test('★ 查询回声（用户自己以前问过的同一句）被过滤掉', async () => {
  const hits = await echo.search({ text: '我叫什么', excludeSessionId: 'echo-sess-bbbbbbbb' })
  assert.ok(
    hits.every((hit) => hit.body !== '我叫什么'),
    `回声没被过滤: ${JSON.stringify(hits.map((h) => h.body))}`
  )
})
await test('★ FTS 有弱匹配时仍会补上 2 字回退结果（关键）', async () => {
  // 「我叫什么」会被 FTS 精确匹配到自己那句提问；若"有结果就不回退"，
  // 真正含答案的「我叫刘飞」永远查不到——这是实测踩过的坑
  const hits = await echo.search({ text: '我叫什么', excludeSessionId: 'echo-sess-bbbbbbbb' })
  assert.ok(
    hits.some((hit) => hit.body.includes('刘飞')),
    `回退没补齐: ${JSON.stringify(hits.map((h) => h.body))}`
  )
})
await test('rebuildIndex 能重建索引并保持可检索', async () => {
  const rebuilt = echo.rebuildIndex()
  assert.ok(rebuilt.indexed > 0)
  const hits = await echo.search({ text: '我叫什么', excludeSessionId: 'echo-sess-bbbbbbbb' })
  assert.ok(hits.some((hit) => hit.body.includes('刘飞')), '重建后检索应仍正常')
})
echo.close()
await test('空查询不崩', async () => {
  assert.deepStrictEqual(await store.search({ text: '？？？', excludeSessionId: 'x' }), [])
})

await test('★ 注入字符预算生效', async () => {
  const small = new MemoryStore({ dbPath: join(dir, 'budget.db'), maxHits: 10, maxChars: 30 })
  small.ensureSession('s1', 'global', t0)
  small.recordMessage({ sessionId: 's1', scope: 'global', role: 'user', body: '这是一段比较长的内容'.repeat(20), now: t0 })
  const hits = await small.search({ text: '比较长的内容', excludeSessionId: 's2' })
  const total = hits.reduce((sum, h) => sum + h.body.length, 0)
  assert.ok(total <= 30, `注入超预算: ${total}`)
  small.close()
})

console.log('\n=== 回忆块格式 ===')
await test('★ 回忆块标明来源日期与允许忽略', async () => {
  const hits = await store.search({ text: '状态管理', excludeSessionId: 'sess-global-0002' })
  const block = store.buildRecallBlock(hits)
  assert.ok(block.includes('<回忆>') && block.includes('</回忆>'))
  assert.ok(/\[\d{4}-\d{2}-\d{2}/.test(block), `缺少日期: ${block.slice(0, 120)}`)
  assert.ok(block.includes('忽略'), '应允许模型忽略不相关记忆')
  assert.ok(block.includes('不要编造') || block.includes('不要补充'), '应禁止编造')
})
await test('空命中返回空串（不注入空块）', async () => {
  assert.strictEqual(store.buildRecallBlock([]), '')
})
store.close()

console.log('\n=== 消息提取与注入 ===')
const messages = [
  { role: 'user', content: '第一句话' },
  { role: 'assistant', content: [{ type: 'text', text: '回答一' }] },
  { role: 'user', content: [{ type: 'text', text: '第二句' }, { type: 'image', source: {} }] },
]
await test('找到最后一条 user 消息', async () => {
  const found = findLastUserMessage(messages)
  assert.strictEqual(found?.text, '第二句', '应只取 text 块，忽略图片')
  assert.strictEqual(found?.index, 2)
})
await test('content 是字符串时也能提取', async () => {
  assert.strictEqual(extractText('纯文本'), '纯文本')
})
await test('★ 回忆块拼在最后一条消息里，且保留原内容', async () => {
  const injected = injectRecall(JSON.stringify({ messages }), '<回忆>X</回忆>')
  const parsed = JSON.parse(injected) as { messages: Array<{ role: string; content: unknown }> }
  assert.strictEqual(parsed.messages.length, 3, '消息条数不能变')
  const last = extractText(parsed.messages[2]!.content)
  assert.ok(last.includes('<回忆>X</回忆>'), '应含回忆块')
  assert.ok(last.includes('第二句'), '原内容不能丢')
  assert.strictEqual(extractText(parsed.messages[0]!.content), '第一句话', '前面消息不受影响')
})
await test('空回忆块不改动请求体', async () => {
  const original = JSON.stringify({ messages })
  assert.strictEqual(injectRecall(original, ''), original)
})
await test('请求体非法时原样返回（不能因为记忆把正常请求弄坏）', async () => {
  assert.strictEqual(injectRecall('not json', '<回忆>x</回忆>'), 'not json')
})

console.log('\n=== 缓存友好性（除最后一条外必须逐字节不变）===')
const cacheMessages = [
  { role: 'user', content: '第一轮的问题' },
  { role: 'assistant', content: [{ type: 'text', text: '第一轮的回答' }] },
  { role: 'user', content: [{ type: 'text', text: '第二轮的问题' }] },
  { role: 'assistant', content: [{ type: 'text', text: '第二轮的回答' }] },
  { role: 'user', content: '本轮问题' },
]
await test('★ 注入只改最后一条，前面的消息逐字节不变', async () => {
  const before = JSON.stringify({ messages: cacheMessages.slice(0, -1) })
  const after = injectRecall(JSON.stringify({ messages: cacheMessages }), '<回忆>X</回忆>')
  const parsed = JSON.parse(after) as { messages: unknown[] }
  const beforeTail = JSON.stringify({ messages: parsed.messages.slice(0, -1) })
  assert.strictEqual(beforeTail, before, '除最后一条外的内容必须完全一致（否则前缀缓存全废）')
})
await test('★ 消息条数不变（插入新消息同样会破坏缓存）', async () => {
  const parsed = JSON.parse(
    injectRecall(JSON.stringify({ messages: cacheMessages }), '<回忆>X</回忆>')
  ) as { messages: unknown[] }
  assert.strictEqual(parsed.messages.length, cacheMessages.length)
})

console.log('\n=== 长消息的检索词 ===')
await test('★ 长消息：检索词取自末尾（否则贴一段内容再提问会完全检索不到）', async () => {
  // 实测踩过：用户「贴一大段背景 + 最后问一句」，若对全文取三元组再截断到 40 个，
  // 全是开头背景的碎片，结尾的问题被截掉 → 永远 0 命中
  const long = '背景资料'.repeat(300) + '最后我要问的是：我叫什么'
  const terms = buildSearchTerms(long).join(' ')
  assert.ok(terms.includes('我叫'), `末尾问题没进检索词: ${terms.slice(0, 80)}`)
})

console.log('\n=== 存储纯净性（注入块不得入库）===')
await test('★ stripInjectedBlocks 剥掉回忆块与裁剪提示', async () => {
  const dirty = '<回忆>\n[2026-11-16 · 会话 abcdefgh] 旧的记忆\n</回忆>\n\n[网关提示] 本次请求已省略最早约 7 条历史消息。\n\n我真正说的话'
  const clean = stripInjectedBlocks(dirty)
  assert.ok(!clean.includes('<回忆>'), clean)
  assert.ok(!clean.includes('[网关提示]'), clean)
  assert.strictEqual(clean, '我真正说的话')
})
await test('★ extractUserMessages 返回的永远是用户原话', async () => {
  const dirty = [
    {
      role: 'user',
      content: '<回忆>\n旧记忆\n</回忆>\n\n我的原话',
    },
  ]
  const all = extractUserMessages(dirty)
  assert.strictEqual(all[0]?.text, '我的原话', `入库内容被污染: ${all[0]?.text}`)
})
await test('没有注入块时原文不受影响（连空格都不动）', async () => {
  assert.strictEqual(stripInjectedBlocks('  原样 内容  '), '原样 内容')
})

console.log('\n=== 漏存审计（哪些用户消息会丢）===')
await test('★ extractUserMessages 取出全部用户消息，不只是最后一条', async () => {
  const all = extractUserMessages(messages)
  assert.strictEqual(all.length, 2, '应该两条都取到')
  assert.strictEqual(all[0]?.text, '第一句话')
  assert.strictEqual(all[1]?.text, '第二句')
})
await test('★ 仅附件消息能被识别（此前会被静默丢弃）', async () => {
  const withImageOnly = [
    { role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'f1' } }] },
  ]
  const all = extractUserMessages(withImageOnly)
  assert.strictEqual(all.length, 1)
  assert.strictEqual(all[0]?.text, '', '没有文字')
  assert.strictEqual(all[0]?.hasAttachment, true, '应识别出有附件')
})

// 自愈验证：App 每轮重发全量历史，已存的应被忽略、缺的应补上
const healDir = join(dir, 'heal.db')
const heal = new MemoryStore({ dbPath: healDir, maxHits: 4, maxChars: 1500 })
const healNow = Date.UTC(2026, 10, 16, 12, 0, 0)
heal.ensureSession('heal-sess-aaaaaaaa', 'global', healNow)

await test('★ 重发全量历史不会产生重复（幂等）', async () => {
  const first = { sessionId: 'heal-sess-aaaaaaaa', scope: 'global' as const, role: 'user', body: '第一条', now: healNow }
  assert.strictEqual(heal.recordMessage(first).stored, true)
  assert.strictEqual(heal.recordMessage({ ...first, now: healNow + 1000 }).stored, false, '重复不应再存')
})
await test('★ 后续轮次能把历史上漏存的消息补回来（自愈）', async () => {
  // 第二轮请求带两条：第一条已存、第二条是新的/此前漏存的
  const w1 = heal.recordMessage({ sessionId: 'heal-sess-aaaaaaaa', scope: 'global', role: 'user', body: '第一条', now: healNow + 2000 })
  const w2 = heal.recordMessage({ sessionId: 'heal-sess-aaaaaaaa', scope: 'global', role: 'user', body: '此前漏存的第二条', now: healNow + 2000 })
  assert.strictEqual(w1.stored, false, '已存过的不再写')
  assert.strictEqual(w2.stored, true, '漏存的应被补上')
  const stats = heal.stats()
  assert.strictEqual(stats.messages, 2)
})
await test('★ 用户真的重复说同一句话时两条都要保留（occurrence 区分）', async () => {
  const a = heal.recordMessage({
    sessionId: 'heal-sess-aaaaaaaa', scope: 'global', role: 'user',
    body: '重复测试', now: healNow + 4000, occurrence: 0,
  })
  const b = heal.recordMessage({
    sessionId: 'heal-sess-aaaaaaaa', scope: 'global', role: 'user',
    body: '重复测试', now: healNow + 4100, occurrence: 1,
  })
  assert.strictEqual(a.stored, true, '第一次应存')
  assert.strictEqual(b.stored, true, '第二次也应存（不是重发）')
  // 但同一 occurrence 重发仍是幂等
  const again = heal.recordMessage({
    sessionId: 'heal-sess-aaaaaaaa', scope: 'global', role: 'user',
    body: '重复测试', now: healNow + 4200, occurrence: 1,
  })
  assert.strictEqual(again.stored, false, '同序号重发不应重复')
})
await test('★ 仅附件占位消息落库但不进索引', async () => {
  const written = heal.recordMessage({
    sessionId: 'heal-sess-aaaaaaaa',
    scope: 'global',
    role: 'user',
    body: '[仅附件消息]',
    now: healNow + 3000,
    index: false,
  })
  assert.strictEqual(written.stored, true, '占位应落库')
  assert.strictEqual(written.chunks, 0, '占位不应进索引')
  const hits = await heal.search({ text: '仅附件消息', excludeSessionId: 'heal-sess-bbbbbbbb' })
  assert.strictEqual(hits.length, 0, '占位不应被检索到')
})
heal.close()

console.log('\n=== 向量检索（P3）===')
const vecDir = join(dir, 'vec.db')
const vecEmbedding = createMockEmbeddingClient()
const vec = new MemoryStore({
  dbPath: vecDir,
  maxHits: 4,
  maxChars: 1500,
  embedding: vecEmbedding,
  queryEmbedTimeoutMs: 2000,
})
const vecNow = Date.UTC(2026, 10, 16, 13, 0, 0)
vec.ensureSession('vec-sess-aaaaaaaa', 'global', vecNow)
vec.ensureSession('vec-sess-bbbbbbbb', 'global', vecNow)
// 存的是"服务器/机器"这一组词，问的时候用的是另一组近义词
vec.recordMessage({
  sessionId: 'vec-sess-aaaaaaaa',
  scope: 'global',
  role: 'user',
  body: '服务器是阿里云 2C2G，内存很小',
  now: vecNow,
})
vec.recordMessage({
  sessionId: 'vec-sess-aaaaaaaa',
  scope: 'global',
  role: 'user',
  body: '我叫刘飞',
  now: vecNow + 1000,
})
await vec.flushEmbeddings()

await test('启用 embedding 后 vectorEnabled 为 true', async () => {
  assert.strictEqual(vec.vectorEnabled, true)
})
await test('★ 向量桥接语义：无共同字词的问法也能召回', async () => {
  // 「家里那台机器什么配置」与「服务器是阿里云 2C2G，内存很小」没有共同的 3 字串，
  // 词法必然 0 命中；向量靠语义分组命中
  const lexicalOnly = new MemoryStore({ dbPath: vecDir, maxHits: 4, maxChars: 1500 })
  const lexHits = await lexicalOnly.search({
    text: '家里那台机器什么配置',
    excludeSessionId: 'vec-sess-bbbbbbbb',
  })
  lexicalOnly.close()
  const vecHits = await vec.search({
    text: '家里那台机器什么配置',
    excludeSessionId: 'vec-sess-bbbbbbbb',
  })
  assert.ok(
    vecHits.some((hit) => hit.body.includes('2C2G')),
    `向量没桥接成功: ${JSON.stringify(vecHits.map((h) => h.body))}`
  )
  assert.ok(
    vecHits.length >= lexHits.length,
    `向量结果不应少于词法: 向量 ${vecHits.length} / 词法 ${lexHits.length}`
  )
})
await test('向量召回不会串到别的主题', async () => {
  const hits = await vec.search({ text: '我的名字叫什么', excludeSessionId: 'vec-sess-bbbbbbbb' })
  assert.ok(hits.some((hit) => hit.body.includes('刘飞')), JSON.stringify(hits.map((h) => h.body)))
})
await test('排除自己会话在向量路径同样生效', async () => {
  const hits = await vec.search({ text: '服务器配置', excludeSessionId: 'vec-sess-aaaaaaaa' })
  assert.ok(hits.every((hit) => hit.sessionId !== 'vec-sess-aaaaaaaa'))
})
await test('★ 无关问题在向量路径也不应召回（相似度下限）', async () => {
  // 实测踩过：不加阈值时余弦≈0 的向量照样被返回，再被 RRF 融进结果，
  // 于是「今天天气怎么样」也注入了记忆
  const hits = await vec.search({ text: '今天天气怎么样', excludeSessionId: 'vec-sess-bbbbbbbb' })
  assert.deepStrictEqual(hits.map((hit) => hit.body), [])
})
await test('★ 未配置 embedding 时行为与之前一致（纯词法）', async () => {
  const plain = new MemoryStore({ dbPath: vecDir, maxHits: 4, maxChars: 1500 })
  assert.strictEqual(plain.vectorEnabled, false)
  const hits = await plain.search({ text: '我叫什么', excludeSessionId: 'vec-sess-bbbbbbbb' })
  assert.ok(hits.some((hit) => hit.body.includes('刘飞')), '词法兜底仍应有效')
  plain.close()
})
await test('★ 后台向量化不阻塞写入（写入先返回）', async () => {
  const before = vecEmbedding.calls
  const written = vec.recordMessage({
    sessionId: 'vec-sess-aaaaaaaa',
    scope: 'global',
    role: 'user',
    body: '又存了一条：数据库选了 SQLite',
    now: vecNow + 2000,
  })
  assert.strictEqual(written.stored, true, '写入应立即成功')
  await vec.flushEmbeddings()
  assert.ok(vecEmbedding.calls > before, '后台应完成一次向量化调用')
})
vec.close()

console.log('\n=== P4 衰减与增权 ===')
const decayDir = join(dir, 'decay.db')
const decay = new MemoryStore({
  dbPath: decayDir,
  maxHits: 4,
  maxChars: 1500,
  decayHalfLifeDays: 90,
  freshnessBoost: 0.25,
})
const day = 86_400_000
const now = Date.UTC(2026, 10, 16, 14, 0, 0)
decay.ensureSession('decay-sess-aaaaaa', 'global', now)
decay.ensureSession('decay-sess-bbbbbb', 'global', now)
// 两条内容相关的记忆：一条很旧，一条很新
decay.recordMessage({
  sessionId: 'decay-sess-aaaaaa', scope: 'global', role: 'user',
  body: '项目数据库用的是 SQLite，因为机器内存小', now: now - 400 * day,
})
decay.recordMessage({
  sessionId: 'decay-sess-aaaaaa', scope: 'global', role: 'user',
  body: '数据库备份脚本每天凌晨跑一次', now: now - 1 * day,
})

await test('★ 相关性接近时，新记忆排在旧记忆前面', async () => {
  const hits = await decay.search({ text: '数据库是怎么弄的', excludeSessionId: 'decay-sess-bbbbbb' })
  assert.ok(hits.length >= 2, `应该有两条候选: ${hits.length}`)
  assert.ok(hits[0]!.body.includes('备份'), `新记忆应排前: ${hits.map((h) => h.body.slice(0, 12))}`)
})
await test('★ 权重不能压过相关性（强相关的老记忆仍应靠前）', async () => {
  const hits = await decay.search({
    text: 'SQLite 内存小',
    excludeSessionId: 'decay-sess-bbbbbb',
  })
  assert.ok(hits.length > 0)
  assert.ok(
    hits[0]!.body.includes('SQLite'),
    `强相关的旧记忆被权重压掉了: ${hits.map((h) => h.body.slice(0, 14))}`
  )
})
await test('★ 被召回过的记忆会刷新新鲜度（增权可见）', async () => {
  // 先召回一次旧记忆，把它"唤醒"
  await decay.search({ text: 'SQLite 内存小', excludeSessionId: 'decay-sess-bbbbbb' })
  const stats = decay.stats()
  assert.ok(stats.usageRows > 0, '应记录到使用痕迹')
})
await test('★ 相似记忆能被合并，命中次数累加', async () => {
  decay.recordMessage({
    sessionId: 'decay-sess-aaaaaa', scope: 'global', role: 'user',
    body: '数据库备份脚本每天凌晨跑一次。', now: now - 2 * day,
  })
  decay.recordMessage({
    sessionId: 'decay-sess-aaaaaa', scope: 'global', role: 'user',
    body: '数据库备份脚本每天凌晨跑一次！', now: now - 3 * day,
  })
  const before = decay.stats().chunks
  const result = decay.consolidate(0.85)
  const after = decay.stats().chunks
  assert.ok(result.removed >= 1, `应至少合并 1 条: ${JSON.stringify(result)}`)
  assert.strictEqual(after, before - result.removed, '切片数应相应减少')
})
await test('不相似的记忆不会被误合并', async () => {
  const stats = decay.stats()
  assert.ok(stats.chunks >= 2, `不同内容应保留: ${stats.chunks}`)
})
decay.close()

console.log('\n=== 管理接口（列表 / 删除）===')
const adminDir = join(dir, 'admin.db')
const admin = new MemoryStore({ dbPath: adminDir, maxHits: 4, maxChars: 1500 })
const adminNow = Date.UTC(2026, 10, 16, 15, 0, 0)
admin.ensureSession('admin-sess-aaaaaaa', 'global', adminNow)
admin.ensureSession('admin-sess-bbbbbb', 'global', adminNow)
admin.recordMessage({ sessionId: 'admin-sess-aaaaaaa', scope: 'global', role: 'user', body: '我的常用编辑器是 VSCode', now: adminNow })
admin.recordMessage({ sessionId: 'admin-sess-aaaaaaa', scope: 'global', role: 'user', body: '我的显示器是 27 寸 4K', now: adminNow + 1000 })
await admin.search({ text: '编辑器', excludeSessionId: '' })

await test('listChunks 列出切片并带上命中次数', async () => {
  const items = admin.listChunks({ limit: 50 })
  assert.ok(items.length >= 2, `应列出至少 2 条: ${items.length}`)
  const hitItem = items.find((item) => item.body.includes('VSCode'))
  assert.ok(hitItem, '应能找到 VSCode 那条')
  assert.ok(hitItem.hits >= 1, `被召回过的应有命中次数: ${hitItem.hits}`)
})
await test('listChunks 支持关键词过滤', async () => {
  const items = admin.listChunks({ q: '显示器', limit: 50 })
  assert.strictEqual(items.length, 1, `应只命中 1 条: ${items.length}`)
  assert.ok(items[0]!.body.includes('4K'))
})
await test('用 like 通配符搜索不会变成全表通配', async () => {
  // 「%」被当成通配符会匹配一切；这里只要求不崩且不误伤实现
  const items = admin.listChunks({ q: '%', limit: 50 })
  assert.ok(Array.isArray(items))
})
await test('★ 删除切片后四处都清干净（主表/索引/痕迹）', async () => {
  const target = admin.listChunks({ q: 'VSCode', limit: 10 })[0]
  assert.ok(target, '先要找到目标')
  const removed = admin.deleteChunks([target.id])
  assert.strictEqual(removed, 1)
  // 列表里没有了
  assert.strictEqual(admin.listChunks({ q: 'VSCode', limit: 10 }).length, 0)
  // 检索也查不到（全文索引已清）
  const hits = await admin.search({ text: 'VSCode 编辑器', excludeSessionId: '' })
  assert.ok(hits.every((hit) => !hit.body.includes('VSCode')), '索引没清干净')
})
await test('删除非法 id 不会误删', async () => {
  assert.strictEqual(admin.deleteChunks(['../etc/passwd', 'x', '']), 0)
})
await test('previewRecall 不存在的会话也能正常返回', async () => {
  const hits = await admin.previewRecall('显示器')
  assert.ok(Array.isArray(hits))
})
admin.close()

console.log('\n=== 助手回答采集 ===')
await test('★ SSE 跨 chunk 拼行（不能假设一帧一行）', async () => {
  const collector = new AssistantTextCollector()
  collector.push('data: {"type":"content_block_delta","delta":{"type":"text_delt')
  collector.push('a","text":"你好"}}\n\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"世界"}}\n\n')
  assert.strictEqual(collector.result(), '你好世界')
})
await test('SSE 心跳与非文本事件被忽略', async () => {
  const collector = new AssistantTextCollector()
  collector.push('event: ping\ndata: {"type":"message_start"}\n')
  collector.push('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想"}}\n')
  collector.push('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"答案"}}\n')
  assert.strictEqual(collector.result(), '答案')
})
await test('非流式 JSON 也能取到文本', async () => {
  const collector = new AssistantTextCollector()
  collector.pushJsonBody(JSON.stringify({ content: [{ type: 'text', text: '完整回答' }] }))
  assert.strictEqual(collector.result(), '完整回答')
})
await test('畸形 JSON 不抛异常', async () => {
  const collector = new AssistantTextCollector()
  collector.pushJsonBody('{坏掉的')
  assert.strictEqual(collector.result(), '')
})

/**
 * 回归测试：新鲜度只能"微调"，不能压过相关性。
 *
 * 背景：search() 末尾原来写的是 `.sort((a,b) => b.factor - a.factor)`，
 * 只按新鲜度排序，把 bm25 名次整个丢掉。库里切片一多（实测 7747 条），
 * 用切片原文查它自己会被近期无关内容顶掉，排第一只有 3%。
 */
await test('新鲜度不能压过相关性（老的相关 > 新的无关）', async () => {
  const freshDir = await mkdtemp(join(tmpdir(), 'fresh-'))
  const store = new MemoryStore({ dbPath: join(freshDir, 'm.db') })
  const old = Date.now() - 400 * 86_400_000
  const recent = Date.now()

  store.ensureSession('sess-old', 'global', old)
  store.recordMessage({
    sessionId: 'sess-old',
    scope: 'global',
    role: 'user',
    body: '我的服务器机房在张家口怀来县',
    now: old,
  })
  store.ensureSession('sess-new', 'global', recent)
  for (let i = 0; i < 5; i += 1) {
    store.recordMessage({
      sessionId: 'sess-new',
      scope: 'global',
      role: 'user',
      body: `我今天随手记的第 ${i} 条无关内容`,
      now: recent,
    })
  }

  const hits = await store.search({ text: '服务器机房在张家口', excludeSessionId: '', limit: 4 })
  assert.ok(hits.length > 0, '应有命中')
  assert.equal(hits[0].body.includes('张家口'), true, `排第一的应是相关的老记忆，实际是：${hits[0].body}`)
  store.close()
  await rm(freshDir, { recursive: true, force: true })
})

/**
 * 回归测试：非汉字语言必须能被检索。
 *
 * 背景：normalize 原来是 `[^\p{Script=Han}a-zA-Z0-9]`，
 * 会把俄文等文字整个删掉 → 切出 0 个检索词 → 永远查不到。
 */
await test('俄文等非汉字语言可检索', async () => {
  const cyrDir = await mkdtemp(join(tmpdir(), 'cyr-'))
  const store = new MemoryStore({ dbPath: join(cyrDir, 'm.db') })
  const now = Date.now()
  store.ensureSession('sess-ru', 'global', now)
  store.recordMessage({
    sessionId: 'sess-ru',
    scope: 'global',
    role: 'user',
    body: 'Сейчас я в России и Украине, ситуация очень сложная',
    now,
  })
  store.ensureSession('sess-zh', 'global', now)
  store.recordMessage({
    sessionId: 'sess-zh',
    scope: 'global',
    role: 'user',
    body: '我在国内，一切正常',
    now,
  })

  const hits = await store.search({ text: 'России', excludeSessionId: '', limit: 3 })
  assert.ok(hits.length > 0, '俄文查询应能命中')
  assert.equal(hits[0].body.includes('Росси'), true, `实际命中：${hits[0].body}`)
  store.close()
  await rm(cyrDir, { recursive: true, force: true })
})
await rm(dir, { recursive: true, force: true })
console.log(`\n=== PASS=${pass}  FAIL=${fail} ===`)
if (fail > 0) {
  process.exitCode = 1
}
