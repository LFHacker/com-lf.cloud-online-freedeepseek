/**
 * 验证「重排（rerank）」能否把最相关的提到第一位。
 *
 *   node scripts/eval-rerank.ts <memory.db> <eval-set.jsonl> [候选数] [模型]
 *
 * 做法：先按现有混合检索取 topN 候选，再让 cross-encoder 重排，比较重排前后。
 * 只看指标不够，还要看**多花的延迟**——重排是同步等待，用户能感知。
 */
import { MemoryStore } from '../src/memory/store.ts'
import { readFileSync } from 'node:fs'

const dbPath = process.argv[2]
const setPath = process.argv[3]
const poolSize = Number(process.argv[4] ?? 20)
const model = process.argv[5] ?? 'BAAI/bge-reranker-v2-m3'
if (!dbPath || !setPath) {
  console.error('用法: node scripts/eval-rerank.ts <memory.db> <eval-set.jsonl> [候选数] [模型]')
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
const apiKey = process.env.SILICONFLOW_KEY ?? env.MEMORY_EMBED_API_KEY ?? ''
const baseUrl = (env.MEMORY_EMBED_BASE_URL ?? 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
if (!apiKey) {
  console.error('缺少 MEMORY_EMBED_API_KEY')
  process.exit(1)
}

type Case = { query: string; chunkId: string; sessionId: string }
const cases: Case[] = readFileSync(setPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case)

/** 调一次重排，返回按相关性排序的下标数组 */
const rerank = async (query: string, documents: string[]): Promise<number[] | null> => {
  try {
    const response = await fetch(`${baseUrl}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, query, documents, top_n: documents.length, return_documents: false }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      console.warn(`  重排接口 HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`)
      return null
    }
    const payload = (await response.json()) as { results?: Array<{ index: number }> }
    const results = payload.results ?? []
    return results.map((r) => r.index)
  } catch (error) {
    console.warn('  重排失败:', error instanceof Error ? error.message : error)
    return null
  }
}

const store = new MemoryStore({ dbPath })
console.log(`  ${cases.length} 条，候选 ${poolSize}，模型 ${model}`)

let before1 = 0
let before4 = 0
let after1 = 0
let after4 = 0
let mrrBefore = 0
let mrrAfter = 0
const rerankLatency: number[] = []

for (const item of cases) {
  const hits = await store.search({ text: item.query, excludeSessionId: '', limit: poolSize })
  const rankBefore = hits.findIndex((h) => h.chunkId === item.chunkId)
  if (rankBefore === 0) before1 += 1
  if (rankBefore >= 0 && rankBefore < 4) before4 += 1
  if (rankBefore >= 0) mrrBefore += 1 / (rankBefore + 1)

  if (hits.length === 0) {
    continue
  }
  const started = Date.now()
  const order = await rerank(
    item.query,
    hits.map((h) => h.body)
  )
  rerankLatency.push(Date.now() - started)
  if (!order) {
    continue
  }
  const rankAfter = order.findIndex((index) => hits[index]?.chunkId === item.chunkId)
  if (rankAfter === 0) after1 += 1
  if (rankAfter >= 0 && rankAfter < 4) after4 += 1
  if (rankAfter >= 0) mrrAfter += 1 / (rankAfter + 1)
}

const n = cases.length
const pct = (v: number) => `${((v / n) * 100).toFixed(1)}%`
const sorted = [...rerankLatency].sort((a, b) => a - b)
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0

console.log('')
console.log(`  重排前 @1 ${pct(before1)}   @4 ${pct(before4)}   MRR ${(mrrBefore / n).toFixed(3)}`)
console.log(`  重排后 @1 ${pct(after1)}   @4 ${pct(after4)}   MRR ${(mrrAfter / n).toFixed(3)}`)
console.log(`  重排延迟 p50 ${q(0.5)}ms  p95 ${q(0.95)}ms`)
store.close()
