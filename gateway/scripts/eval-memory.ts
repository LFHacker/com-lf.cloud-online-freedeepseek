/**
 * 记忆检索评测。
 *
 *   node scripts/eval-memory.ts <memory.db> <eval-set.jsonl> [topK]
 *
 * 输出：Recall@K、MRR、延迟分位、以及"注入内容里有多少是相关的"（精确率代理）。
 *
 * 为什么要同时看召回率和精确率：
 *   只提召回 → 多注水，模型被无关内容干扰，回答变差；
 *   只提精确率 → 宁可少给，忘了该记的事。
 * 记忆注入是有限的上下文预算，两者必须一起看。
 */
import { MemoryStore } from '../src/memory/store.ts'
import { readFileSync } from 'node:fs'

const dbPath = process.argv[2]
const setPath = process.argv[3]
const topK = Number(process.argv[4] ?? 8)
if (!dbPath || !setPath) {
  console.error('用法: node scripts/eval-memory.ts <memory.db> <eval-set.jsonl> [topK]')
  process.exit(1)
}

type Case = { query: string; chunkId: string; sessionId: string }
const cases: Case[] = readFileSync(setPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case)

// 允许用环境变量扫参数，便于做对照实验而不用改代码
const freshnessBoost = process.env.EVAL_FRESHNESS ? Number(process.env.EVAL_FRESHNESS) : undefined
const decayHalfLifeDays = process.env.EVAL_DECAY ? Number(process.env.EVAL_DECAY) : undefined
const store = new MemoryStore({ dbPath, freshnessBoost, decayHalfLifeDays })
console.log(`  评测集 ${cases.length} 条，topK=${topK}，库内切片 ${store.stats().chunks}`)

const latencies: number[] = []
let hit1 = 0
let hit4 = 0
let hit8 = 0
let mrrSum = 0
let relevantInjected = 0
let injectedTotal = 0

for (const item of cases) {
  const started = Date.now()
  const hits = await store.search({ text: item.query, excludeSessionId: '', limit: topK })
  latencies.push(Date.now() - started)

  const rank = hits.findIndex((h) => h.chunkId === item.chunkId)
  if (rank === 0) hit1 += 1
  if (rank >= 0 && rank < 4) hit4 += 1
  if (rank >= 0 && rank < 8) hit8 += 1
  if (rank >= 0) mrrSum += 1 / (rank + 1)
  injectedTotal += hits.length
  // 精确率代理：同一条会话的切片算相关（比逐条人工标注可操作）
  relevantInjected += hits.filter((h) => h.sessionId === item.sessionId).length
}

/**
 * Wilson 95% 置信区间。
 * 40 条样本时 ±1 条就是 2.5 个百分点，不给区间很容易把噪声当改进。
 */
const wilson = (hits: number, total: number): [number, number] => {
  if (total === 0) return [0, 0]
  const z = 1.96
  const p = hits / total
  const denom = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / denom
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom
  return [Math.max(0, (center - margin) * 100), Math.min(100, (center + margin) * 100)]
}

const pct = (n: number) => {
  const [lo, hi] = wilson(n, cases.length)
  return `${((n / cases.length) * 100).toFixed(1)}%  (95%CI ${lo.toFixed(1)}–${hi.toFixed(1)})`
}
const sorted = [...latencies].sort((a, b) => a - b)
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]

console.log('')
console.log(`  召回率 @1   ${hit1}/${cases.length}  ${pct(hit1)}`)
console.log(`  召回率 @4   ${hit4}/${cases.length}  ${pct(hit4)}`)
console.log(`  召回率 @8   ${hit8}/${cases.length}  ${pct(hit8)}`)
console.log(`  MRR@8       ${(mrrSum / cases.length).toFixed(3)}`)
console.log(`  注入相关率  ${((relevantInjected / Math.max(1, injectedTotal)) * 100).toFixed(1)}%（同会话占比）`)
console.log(`  延迟 p50    ${q(0.5)} ms`)
console.log(`  延迟 p95    ${q(0.95)} ms`)
console.log(`  延迟 max    ${q(1)} ms`)
store.close()
