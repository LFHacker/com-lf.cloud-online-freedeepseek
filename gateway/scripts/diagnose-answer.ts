/**
 * 回答失分诊断：把低分案例的「问题 / 检索到的资料 / 模型回答」摊开看。
 *
 *   node scripts/diagnose-answer.ts <memory.db> <eval-set.jsonl> [样本数]
 *
 * 目的不是打分，而是**归类失分原因**：
 *   A. 资料是碎片（缺前因后果）→ 该改切块
 *   B. 资料含答案但模型没提取 → 该改提示词/注入格式
 *   C. 资料根本不含答案 → 检索问题，改切块没用
 */
import { MemoryStore } from '../src/memory/store.ts'
import { readFileSync } from 'node:fs'

const dbPath = process.argv[2]
const setPath = process.argv[3]
const sampleSize = Number(process.argv[4] ?? 12)
if (!dbPath || !setPath) {
  console.error('用法: node scripts/diagnose-answer.ts <memory.db> <eval-set.jsonl> [样本数]')
  process.exit(1)
}

const env: Record<string, string> = {}
try {
  for (const line of readFileSync('/etc/ds-gateway.env', 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const i = t.indexOf('=')
    env[t.slice(0, i)] = t.slice(i + 1)
  }
} catch {
  // 允许纯环境变量
}
const apiKey = process.env.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY ?? ''
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY')
  process.exit(1)
}

const chat = async (prompt: string, maxTokens = 400): Promise<string> => {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) return ''
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return (payload.choices?.[0]?.message?.content ?? '').trim()
}

type Case = { query: string; chunkId: string; sessionId: string }
const all: Case[] = readFileSync(setPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case)
const step = Math.max(1, Math.floor(all.length / sampleSize))
const cases = all.filter((_, index) => index % step === 0).slice(0, sampleSize)

const store = new MemoryStore({ dbPath })
const buckets = { A: 0, B: 0, C: 0, ok: 0 }

for (const [index, item] of cases.entries()) {
  const hits = await store.search({ text: item.query, excludeSessionId: '', limit: 4 })
  const context = hits.map((hit, i) => `[资料${i + 1}] ${hit.body}`).join('\n\n')
  const truth = store.chunkBody(item.chunkId) ?? ''

  const answer = await chat(
    [
      '只依据下面的资料回答问题。资料里没有的信息不要编造。',
      '',
      context,
      '',
      `问题：${item.query}`,
    ].join('\n')
  )

  const verdict = await chat(
    [
      '判断回答是否准确。只输出一个字：A / B / C / 好',
      'A = 资料只有碎片，缺前因后果，无法据以准确回答',
      'B = 资料里其实有答案，但回答没提取出来或答偏了',
      'C = 资料里根本没有答案（检索到了不相干内容）',
      '好 = 回答准确',
      '',
      `问题：${item.query}`,
      `真实原文：${truth.slice(0, 600)}`,
      `检索到的资料：${context.slice(0, 1200)}`,
      `回答：${answer.slice(0, 500)}`,
    ].join('\n'),
    8
  )

  const key = verdict.includes('A') ? 'A' : verdict.includes('B') ? 'B' : verdict.includes('C') ? 'C' : 'ok'
  buckets[key] += 1

  if (key !== 'ok') {
    console.log('')
    console.log(`  [${index + 1}] 归类 ${key}：${item.query.slice(0, 50)}`)
    console.log(`      原文：${truth.replace(/\n/g, ' ').slice(0, 70)}`)
    console.log(`      资料1：${(hits[0]?.body ?? '').replace(/\n/g, ' ').slice(0, 70)}`)
    console.log(`      回答：${answer.replace(/\n/g, ' ').slice(0, 70)}`)
  }
}

const n = cases.length
console.log('')
console.log(`  A 碎片化 ${buckets.A}   B 未提取 ${buckets.B}   C 检索错 ${buckets.C}   正确 ${buckets.ok}  （共 ${n}）`)
store.close()
