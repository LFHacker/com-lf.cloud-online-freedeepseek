/**
 * 历史导入器单测。
 *
 * 重点不是"能跑"，而是这几条容易出事的语义：
 *  - 各扩展导出的 JSON 结构不统一 → 容错适配必须覆盖多种形状
 *  - 助手回复**入库但不建索引**（否则会自问自答污染召回）
 *  - 重复导入必须幂等（同一份文件导两次，数量不变）
 *  - 同一会话里内容相同的消息不能被去重掉（用 occurrence 区分）
 *  - 撤销批次要删干净四处（chunks / fts / vec / usage）
 */
import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory/store.ts'
import {
  findConversations,
  importConversations,
  parseArgs,
  rollbackBatch,
  toConversations,
} from './import-history.ts'

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

const tempDirs: string[] = []
const makeDb = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'import-test-'))
  tempDirs.push(dir)
  return join(dir, 'memory.db')
}

console.log('\n[历史导入]')

await test('数组形状：messages + role/content 字符串', () => {
  const json = [
    {
      id: 'conv-1',
      title: '关于部署',
      created_at: 1700000000000,
      messages: [
        { role: 'user', content: '服务器怎么部署' },
        { role: 'assistant', content: '用 systemd' },
      ],
    },
  ]
  const parsed = toConversations(findConversations(json), 0)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].title, '关于部署')
  assert.equal(parsed[0].messages.length, 2)
  assert.equal(parsed[0].messages[0].role, 'user')
  assert.equal(parsed[0].messages[1].role, 'assistant')
})

await test('对象形状：conversations + content 为块数组', () => {
  const json = {
    conversations: [
      {
        conversation_id: 'abc',
        name: 'SSE 调试',
        chat_messages: [
          { sender: 'user', content: [{ type: 'text', text: 'SSE 为什么被缓冲' }] },
          { sender: 'ai', content: [{ type: 'text', text: '因为反向代理' }] },
        ],
      },
    ],
  }
  const parsed = toConversations(findConversations(json), 0)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].key, 'abc')
  assert.equal(parsed[0].messages[0].text, 'SSE 为什么被缓冲')
  assert.equal(parsed[0].messages[1].role, 'assistant')
})

await test('ChatGPT 风格：mapping + author.role + parts', () => {
  const json = [
    {
      title: '嵌套结构',
      mapping: {
        a: { message: { author: { role: 'user' }, content: { parts: ['第一句'] } } },
        b: { message: { author: { role: 'assistant' }, content: { parts: ['第二句'] } } },
      },
    },
  ]
  const parsed = toConversations(findConversations(json), 0)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].messages.length, 2)
  assert.equal(parsed[0].messages[0].text, '第一句')
  assert.equal(parsed[0].messages[1].role, 'assistant')
})

await test('时间：秒级时间戳自动升到毫秒，ISO 字符串可解析', () => {
  const json = [
    {
      title: 't',
      created_at: 1700000000, // 秒
      messages: [
        { role: 'user', content: 'a', created_at: 1700000000 },
        { role: 'user', content: 'b', createdAt: '2024-03-01T10:00:00Z' },
      ],
    },
  ]
  const parsed = toConversations(findConversations(json), 0)
  assert.ok(parsed[0].messages[0].createdAt >= 1.7e12, '秒级应升到毫秒')
  assert.equal(parsed[0].messages[1].createdAt, Date.parse('2024-03-01T10:00:00Z'))
})

await test('无法识别的结构返回空，不抛异常', () => {
  assert.deepEqual(findConversations({ foo: 'bar' }), [])
  assert.deepEqual(findConversations(null), [])
  assert.deepEqual(toConversations([{ noMessages: true }], 0), [])
})

await test('导入：助手消息入库但不建索引（切片数 == 用户消息数）', async () => {
  const dbPath = await makeDb()
  const store = new MemoryStore({ dbPath })
  const json = [
    {
      id: 'c1',
      title: '索引范围',
      messages: [
        { role: 'user', content: '我叫刘飞' },
        { role: 'assistant', content: '你好刘飞，很高兴认识你' },
        { role: 'user', content: '我喜欢用 VSCode' },
      ],
    },
  ]
  const parsed = toConversations(findConversations(json), 0)
  const result = importConversations(store, parsed, { scope: 'global', batch: 't1' })
  const stats = store.stats()
  assert.equal(result.storedMessages, 3, '三条消息都应入库')
  assert.equal(stats.messages, 3)
  assert.equal(result.chunks, 2, '只有两条用户消息该建索引')
  assert.equal(stats.chunks, 2)
  store.close()
})

await test('幂等：同一份数据导入两次，库内数量不变', async () => {
  const dbPath = await makeDb()
  const json = [
    {
      id: 'c1',
      title: '幂等',
      messages: [
        { role: 'user', content: '第一次' },
        { role: 'user', content: '第二次' },
      ],
    },
  ]
  const parsed = toConversations(findConversations(json), 0)

  const first = new MemoryStore({ dbPath })
  const r1 = importConversations(first, parsed, { scope: 'global', batch: 't2' })
  const s1 = first.stats()
  first.close()

  const second = new MemoryStore({ dbPath })
  const r2 = importConversations(second, parsed, { scope: 'global', batch: 't2' })
  const s2 = second.stats()
  second.close()

  assert.equal(r1.storedMessages, 2)
  assert.equal(r2.storedMessages, 0, '第二次不应再写入')
  assert.equal(s1.messages, s2.messages, '消息数不应增长')
  assert.equal(s1.chunks, s2.chunks, '切片数不应增长')
})

await test('同一会话内重复内容用 occurrence 保留，不被吞掉', async () => {
  const dbPath = await makeDb()
  const store = new MemoryStore({ dbPath })
  const json = [
    {
      id: 'c1',
      title: '重复内容',
      messages: [
        { role: 'user', content: '再说一遍' },
        { role: 'user', content: '再说一遍' },
      ],
    },
  ]
  const result = importConversations(store, toConversations(findConversations(json), 0), {
    scope: 'global',
    batch: 't3',
  })
  assert.equal(result.storedMessages, 2, '两条相同的用户消息都应保留')
  assert.equal(store.stats().messages, 2)
  store.close()
})

await test('local 范围只归档不建索引（这是设计，导历史不该用它）', async () => {
  const dbPath = await makeDb()
  const store = new MemoryStore({ dbPath })
  const json = [{ id: 'c1', title: 't', messages: [{ role: 'user', content: '本地记忆' }] }]
  const result = importConversations(store, toConversations(findConversations(json), 0), {
    scope: 'local',
    batch: 't4',
  })
  assert.equal(result.storedMessages, 1, '消息应入库')
  assert.equal(result.chunks, 0, 'local 不建索引')
  assert.equal(store.stats().chunks, 0)
  store.close()
})

await test('撤销批次：四处数据都删干净', async () => {
  const dbPath = await makeDb()
  const store = new MemoryStore({ dbPath })
  const json = [
    {
      id: 'c1',
      title: '待撤销',
      messages: [
        { role: 'user', content: '这条会被撤销' },
        { role: 'user', content: '这条也会' },
      ],
    },
  ]
  importConversations(store, toConversations(findConversations(json), 0), {
    scope: 'global',
    batch: 'revoke',
  })
  // 制造一条使用痕迹，验证 usage 表也被清理
  await store.search({ text: '撤销', excludeSessionId: '' })
  const before = store.stats()
  store.close()
  assert.equal(before.chunks, 2)

  rollbackBatch(dbPath, 'revoke')

  const after = new MemoryStore({ dbPath })
  const stats = after.stats()
  assert.equal(stats.sessions, 0, '会话应清空')
  assert.equal(stats.messages, 0, '消息应清空')
  assert.equal(stats.chunks, 0, '切片应清空')
  assert.equal(stats.usageRows ?? 0, 0, '使用痕迹应清空')
  after.close()
})

await test('撤销只影响指定批次', async () => {
  const dbPath = await makeDb()
  const store = new MemoryStore({ dbPath })
  const make = (id: string) => [{ id, title: id, messages: [{ role: 'user', content: `内容${id}` }] }]
  importConversations(store, toConversations(findConversations(make('a')), 0), {
    scope: 'global',
    batch: 'keep',
  })
  importConversations(store, toConversations(findConversations(make('b')), 0), {
    scope: 'global',
    batch: 'drop',
  })
  store.close()

  rollbackBatch(dbPath, 'drop')

  const after = new MemoryStore({ dbPath })
  const stats = after.stats()
  assert.equal(stats.sessions, 1, '另一个批次应保留')
  assert.equal(stats.chunks, 1)
  after.close()
})

await test('limit 限制解析数量', () => {
  const json = Array.from({ length: 5 }, (_, index) => ({
    id: `c${index}`,
    title: `t${index}`,
    messages: [{ role: 'user', content: `内容 ${index}` }],
  }))
  const parsed = toConversations(findConversations(json), 2)
  assert.equal(parsed.length, 2)
})

await test('CLI 参数解析：默认 global，批次名会被清洗', () => {
  const options = parseArgs(['--file', 'a.json'])
  assert.equal(options.scope, 'global')
  assert.equal(options.batch, 'import')
  const custom = parseArgs(['--file', 'a.json', '--scope', 'local', '--batch', '../坏 名字!'])
  assert.equal(custom.scope, 'local')
  assert.equal(/^[a-zA-Z0-9_-]+$/.test(custom.batch), true, '批次名必须被清洗成安全字符')
})

await test('真实文件端到端：写入临时 json 再解析', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'import-file-'))
  tempDirs.push(dir)
  const file = join(dir, 'export.json')
  await writeFile(
    file,
    JSON.stringify({
      conversations: [
        {
          id: 'x1',
          title: '端到端',
          messages: [
            { role: 'user', content: '端到端测试' },
            { role: 'assistant', content: '收到' },
          ],
        },
      ],
    }),
    'utf8'
  )
  const { readFileSync } = await import('node:fs')
  const json = JSON.parse(readFileSync(file, 'utf8'))
  const parsed = toConversations(findConversations(json), 0)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].messages.length, 2)
})

for (const dir of tempDirs) {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n  合计: PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  process.exitCode = 1
}
