/**
 * 评测「查询改写」是否真的提升检索。
 *
 *   node scripts/eval-rewrite.ts <memory.db> <eval-set.jsonl> [topK]
 *
 * 同一批题、同一套检索，只切换"是否加改写变体"，
 * 这样结论只归因于改写本身，而不是别的参数被顺手改了。
 */
import { MemoryStore } from '../src/memory/store.ts'
import { createQueryRewriter, readRewriteConfig } from '../src/memory/rewrite.ts'
import { readFileSync } from 'node:fs'

const dbPath = process.argv[2]
const setPath = process.argv[3]
const topK = Number(process.argv[4] ?? 8)
if (!dbPath || !setPath) {
  console.error('用法: node scripts/eval-rewrite.ts <memory.db> <eval-set.jsonl> [topK]')
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
for (const [key, value] of Object.entries(env)) {
  if (!(key in process.env)) process.env[key] = value
}

type Case = { query: string; chunkId: string; sessionId: string }
const cases: Case[] = readFileSync(setPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case)

const store = new MemoryStore({ dbPath })
const config = readRewriteConfig(process.env)
if (!config) {
  console.error('未启用改写（缺少 DEEPSEEK_API_KEY 或 MEMORY_REWRITE=0）')
  process.exit(1)
}
const rewriter = createQueryRewriter(config)

let base1 = 0
let base4 = 0
let rw1 = 0
let rw4 = 0
let mrrBase = 0
let mrrRw = 0
const baseLatency: number[] = []
const rwLatency: number[] = []
const rewriteCost: number[] = []
let changed = 0

for (const item of cases) {
  const t0 = Date.now()
  const base = await store.search({ text: item.query, excludeSessionId: '', limit: topK })
  baseLatency.push(Date.now() - t0)
  const rankBase = base.findIndex((h) => h.chunkId === item.chunkId)
  if (rankBase === 0) base1 += 1
  if (rankBase >= 0 && rankBase < 4) base4 += 1
  if (rankBase >= 0) mrrBase += 1 / (rankBase + 1)

  const t1 = Date.now()
  const variants = await rewriter(item.query)
  rewriteCost.push(Date.now() - t1)
  const t2 = Date.now()
  const texts = [item.query, ...variants]
  const rw = await store.searchMulti({ texts, excludeSessionId: '', limit: topK })
  rwLatency.push(Date.now() - t2)
  const rankRw = rw.findIndex((h) => h.chunkId === item.chunkId)
  if (rankRw === 0) rw1 += 1
  if (rankRw >= 0 && rankRw < 4) rw4 += 1
  if (rankRw >= 0) mrrRw += 1 / (rankRw + 1)
  if (rankRw !== rankBase) changed += 1
}

const n = cases.length
const pct = (v: number) => `${((v / n) * 100).toFixed(1)}%`
const med = (list: number[]) => {
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.5)] ?? 0
}
const p95 = (list: number[]) => {
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)] ?? 0
}

console.log('')
console.log(`  样本 ${n} 条`)
console.log(`  不用改写   @1 ${pct(base1)}   @4 ${pct(base4)}   MRR ${(mrrBase / n).toFixed(3)}`)
console.log(`  用改写     @1 ${pct(rw1)}   @4 ${pct(rw4)}   MRR ${(mrrRw / n).toFixed(3)}`)
console.log(`  排序发生变化 ${changed}/${n}`)
console.log(`  延迟        基线 p50 ${med(baseLatency)}ms / p95 ${p95(baseLatency)}ms`)
console.log(`              改写 p50 ${med(rewriteCost)}ms（模型调用）`)
console.log(`              检索 p50 ${med(rwLatency)}ms / p95 ${p95(rwLatency)}ms（3 路并行）`)
store.close()
