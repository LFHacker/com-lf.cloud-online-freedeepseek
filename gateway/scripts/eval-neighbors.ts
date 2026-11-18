/**
 * 量化「邻块扩展」：它到底能不能把漏掉的原文带回来。
 *
 *   node scripts/eval-neighbors.ts <memory.db> <eval-set.jsonl> [topK]
 *
 * 只测一件事：直接检索没命中时，**相邻切片**能不能把标准答案补进来。
 * 这是邻块扩展唯一能改善的指标——它不会改变检索排名。
 */
import { MemoryStore } from '../src/memory/store.ts'
import { readFileSync } from 'node:fs'

const dbPath = process.argv[2]
const setPath = process.argv[3]
const topK = Number(process.argv[4] ?? 4)
if (!dbPath || !setPath) {
  console.error('用法: node scripts/eval-neighbors.ts <memory.db> <eval-set.jsonl> [topK]')
  process.exit(1)
}

type Case = { query: string; chunkId: string; sessionId: string }
const cases: Case[] = readFileSync(setPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case)

const store = new MemoryStore({ dbPath })
let baseHit = 0
let expandedHit = 0
let charBase = 0
let charExpanded = 0
const rescued: Array<{ query: string; body: string }> = []

for (const item of cases) {
  const hits = await store.search({ text: item.query, excludeSessionId: '', limit: topK })
  const baseContains = hits.some((h) => h.chunkId === item.chunkId)
  if (baseContains) {
    baseHit += 1
  }
  charBase += hits.reduce((sum, h) => sum + h.body.length, 0)

  const expanded = store.expandNeighbors(hits)
  charExpanded += expanded.reduce((sum, h) => sum + h.body.length, 0)
  if (expanded.some((h) => h.chunkId === item.chunkId)) {
    expandedHit += 1
    if (!baseContains) {
      rescued.push({ query: item.query, body: expanded.find((h) => h.chunkId === item.chunkId)?.body ?? '' })
    }
  }
}

const n = cases.length
const pct = (v: number) => `${((v / n) * 100).toFixed(1)}%`

console.log('')
console.log(`  样本 ${n} 条，topK=${topK}`)
console.log(`  直接命中     ${baseHit}/${n}  ${pct(baseHit)}`)
console.log(`  邻块补全后   ${expandedHit}/${n}  ${pct(expandedHit)}`)
console.log(`  被邻块救回   ${rescued.length} 条`)
console.log(`  注入字符量   直接 ${Math.round(charBase / n)} 字/条 → 扩展后 ${Math.round(charExpanded / n)} 字/条`)
if (rescued.length > 0) {
  console.log('  救回样例（前 3 条）：')
  for (const item of rescued.slice(0, 3)) {
    console.log(`    · 问：${item.query.slice(0, 44)}`)
    console.log(`      补回的原文：${item.body.replace(/\n/g, ' ').slice(0, 60)}`)
  }
}
store.close()
