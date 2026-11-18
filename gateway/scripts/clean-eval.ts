/**
 * 清洗评测集：判断「问题能否仅凭这段原文回答」。
 *
 * 背景：`gen-eval.ts` 让模型就某段切片生成问题，但模型有时会**脱离原文自由发挥**
 * （实测：给一段英语课本填空题，它生成了「科学家用什么方法能发现水中的化学物质」）。
 * 这种题无论检索多好都不可能命中，留在评测集里只会把分数往下拉，
 * 让人误以为系统有缺陷。
 *
 *   node scripts/clean-eval.ts <输入.jsonl> <输出.jsonl>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const inputPath = process.argv[2]
const outputPath = process.argv[3]
const dbPath = process.argv[4]
if (!inputPath || !outputPath || !dbPath) {
  console.error('用法: node scripts/clean-eval.ts <输入.jsonl> <输出.jsonl> <memory.db>')
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

type Case = { query: string; chunkId: string; sessionId: string }
const cases: Case[] = readFileSync(inputPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Case)

const db = new DatabaseSync(dbPath, { readOnly: true } as never)
const bodyOf = db.prepare('select body from chunks where id = ?')

const judge = async (query: string, body: string): Promise<boolean | null> => {
  /**
   * 用「能不能答出来」作为客观判据，而不是让模型主观打标签。
   *
   * 试过两版主观判定，都不可用：
   *   · 「能否仅凭原文回答」→ 剔掉 39%，把"原文含报错栈但原因在别处"的好样本也删了
   *   · 「是否相关」→ 只剔掉 1%，几乎全留（判官太宽松）
   * 改成让判官**动手回答**：答得出来说明原文确实承载了这段信息，
   * 答不出来（输出【无】）说明这条评测题与原文不接地。
   */
  const prompt = [
    '请**仅依据**下面这段原文回答问题。',
    '如果原文不足以回答，只输出四个字符：【无】',
    '不要解释，不要补充原文之外的信息。',
    '',
    `问题：${query}`,
    '',
    `原文：${body.slice(0, 1200)}`,
  ].join('\n')
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      return null
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const text = (payload.choices?.[0]?.message?.content ?? '').trim().toUpperCase()
    if (!text) return null
    const cleaned = text.replace(/[【】]/g, '').trim()
    if (cleaned === '无' || cleaned.startsWith('无')) return false
    return cleaned.length >= 4
    return null
  } catch {
    return null
  }
}

const kept: string[] = []
const dropped: Array<{ query: string; body: string }> = []
let unknown = 0

console.log(`  待判定 ${cases.length} 条…`)
for (const [index, item] of cases.entries()) {
  const row = bodyOf.get(item.chunkId) as { body: string } | undefined
  if (!row) {
    unknown += 1
    continue
  }
  const verdict = await judge(item.query, row.body)
  if (verdict === true) {
    kept.push(JSON.stringify(item))
  } else if (verdict === false) {
    dropped.push({ query: item.query, body: row.body })
  } else {
    // 判定失败（网络/超时）：保守保留，避免把好样本当噪声删掉
    kept.push(JSON.stringify(item))
    unknown += 1
  }
  if ((index + 1) % 25 === 0) {
    console.log(`    已判定 ${index + 1}（保留 ${kept.length}，剔除 ${dropped.length}）`)
  }
}

db.close()
writeFileSync(outputPath, `${kept.join('\n')}\n`, 'utf8')

console.log('')
console.log(`  原 ${cases.length} 条 → 保留 ${kept.length}，剔除 ${dropped.length}，判定失败 ${unknown}`)
if (dropped.length > 0) {
  console.log('  剔除样例（前 3 条）：')
  for (const item of dropped.slice(0, 3)) {
    console.log(`    · 问：${item.query.slice(0, 50)}`)
    console.log(`      文：${item.body.replace(/\n/g, ' ').slice(0, 60)}`)
  }
}
console.log(`  结果写入 ${outputPath}`)
