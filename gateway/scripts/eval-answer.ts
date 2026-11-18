/**
 * 回答级评测：邻块扩展到底有没有让模型答得更对。
 *
 *   node scripts/eval-answer.ts <memory.db> <eval-set.jsonl> [样本数]
 *
 * 为什么必须做这一层：
 *   "精确切片命中率"衡量的是**检索**，而邻块扩展改的是**注入内容的完整性**。
 *   用检索指标去判它，永远看不出差别（实测只从 82.0% 涨到 82.7%）。
 *   真正要问的是：拿到这些资料，回答对不对。
 *
 * 流程：同一批题 → 分别用「不扩展 / 只扩第一条」的资料让模型回答 →
 *      再用判官对照标准原文打分（2 = 完全正确，1 = 部分/含糊，0 = 错或答不出）。
 */
import { MemoryStore, type MemoryHit } from '../src/memory/store.ts'
import { readFileSync } from 'node:fs'

const dbPath = process.argv[2]
const setPath = process.argv[3]
const sampleSize = Number(process.argv[4] ?? 40)
if (!dbPath || !setPath) {
  console.error('用法: node scripts/eval-answer.ts <memory.db> <eval-set.jsonl> [样本数]')
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
  if (!response.ok) {
    return ''
  }
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return (payload.choices?.[0]?.message?.content ?? '').trim()
}

type Case = { query: string; chunkId: string; sessionId: string }
const all: Case[] = readFileSync(setPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case)
// 固定步长取样：可复现，且覆盖整个集合
const step = Math.max(1, Math.floor(all.length / sampleSize))
const cases = all.filter((_, index) => index % step === 0).slice(0, sampleSize)

const store = new MemoryStore({ dbPath })
// 与生产的 buildRecallBlock 保持一致：把助手回答也当作资料的一部分
const contextOf = (hits: MemoryHit[]): string =>
  hits
    .map((hit, index) => {
      const context = hit.context?.trim()
      return context
        ? `[资料${index + 1}] 用户说：${hit.body}\n（当时助手的回答：${context}）`
        : `[资料${index + 1}] ${hit.body}`
    })
    .join('\n\n')

const judge = async (query: string, truth: string, answer: string): Promise<number> => {
  const prompt = [
    '你在评估一个记忆系统给出的回答是否与真实原文一致。',
    '只输出一个数字：2（回答与原文一致且有实质信息）、1（部分正确或含糊）、0（错误或未答出）。',
    '',
    `问题：${query}`,
    `原文（事实依据）：${truth.slice(0, 800)}`,
    `回答：${answer.slice(0, 800)}`,
  ].join('\n')
  const text = await chat(prompt, 8)
  const score = Number.parseInt(text.replace(/[^0-2]/g, ''), 10)
  return Number.isFinite(score) ? score : 0
}

let baseScore = 0
let expScore = 0
let baseChars = 0
let expChars = 0
let baseFail = 0
let expFail = 0

console.log(`  样本 ${cases.length} 条（取自 ${all.length} 条，固定步长）`)

for (const [index, item] of cases.entries()) {
  const hits = await store.search({ text: item.query, excludeSessionId: '', limit: 4 })
  const expanded = [...store.expandNeighbors(hits.slice(0, 1)), ...hits.slice(1)]
  baseChars += contextOf(hits).length
  expChars += contextOf(expanded).length

  const truthRow = store.chunkBody(item.chunkId) ?? ''
  const ask = (context: string, label: string) =>
    chat(
      [
        '只依据下面的资料回答问题。资料里没有的信息不要编造，直接说没有。',
        '',
        context,
        '',
        `问题：${item.query}`,
        '',
        `（${label}）只输出回答本身。`,
      ].join('\n')
    )

  const baseAnswer = await ask(contextOf(hits), 'A')
  const expAnswer = await ask(contextOf(expanded), 'B')
  if (!baseAnswer) baseFail += 1
  if (!expAnswer) expFail += 1

  const [s1, s2] = await Promise.all([
    judge(item.query, truthRow, baseAnswer || '(空)'),
    judge(item.query, truthRow, expAnswer || '(空)'),
  ])
  baseScore += s1
  expScore += s2

  if ((index + 1) % 10 === 0) {
    console.log(`    已评 ${index + 1}：不扩展 ${(baseScore / (index + 1)).toFixed(2)} / 扩展 ${(expScore / (index + 1)).toFixed(2)}`)
  }
}

const n = cases.length
console.log('')
console.log(`  不扩展   平均分 ${(baseScore / n).toFixed(2)} / 2   （满分 ${n * 2}，失败 ${baseFail}）`)
console.log(`  扩第一条 平均分 ${(expScore / n).toFixed(2)} / 2   （满分 ${n * 2}，失败 ${expFail}）`)
console.log(`  上下文   不扩展 ${Math.round(baseChars / n)} 字/条 → 扩展后 ${Math.round(expChars / n)} 字/条`)
store.close()
