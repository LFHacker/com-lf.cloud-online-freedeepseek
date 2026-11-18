/**
 * 生成记忆检索评测集。
 *
 *   node scripts/gen-eval.ts <memory.db> <数量> [输出文件]
 *
 * 做法：从真实记忆库里抽样切片，让 DeepSeek 就每段写一个**换了说法**的问题，
 * 再把原切片当作标准答案。这样测的是"按意思找得到"，而不是"复制粘贴能不能匹配"。
 *
 * 为什么不手工写题：手工只能写几十条，且会不自觉挑自己擅长的那类；
 * 自动生成能覆盖历史里真实的长尾内容。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'

const dbPath = process.argv[2]
const count = Number(process.argv[3] ?? 40)
const outPath = process.argv[4] ?? '/root/eval-set.jsonl'
if (!dbPath) {
  console.error('用法: node scripts/gen-eval.ts <memory.db> [数量] [输出]')
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
  // 允许直接给环境变量
}
const apiKey = process.env.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY ?? ''
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY')
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
// 抽中长切片：太短的（"好的""继续"）没法据此提问
const rows = db
  .prepare(
    `select id, session_id, body from chunks
      where length(body) between 80 and 420
      order by random() limit ?`
  )
  .all(count) as Array<{ id: string; session_id: string; body: string }>
db.close()

console.log(`  抽到 ${rows.length} 条切片，开始生成问题…`)

const lines: string[] = []
let done = 0
for (const row of rows) {
  const prompt = [
    '下面是一段用户过去说过的话。',
    '请写一个用户可能自然提出的问题：这个问题必须能通过这段话回答，',
    '但要用**不同的说法**，不要照抄原文措辞，也不要提到"上面这段话"。',
    '只输出问题本身，不要加引号或解释。',
    '',
    '原文：',
    row.body,
  ].join('\n')

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 120,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      console.warn(`  跳过一条：HTTP ${response.status}`)
      continue
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const query = payload.choices?.[0]?.message?.content?.trim().replace(/^"|"$/g, '')
    if (!query || query.length < 6) {
      continue
    }
    lines.push(JSON.stringify({ query, chunkId: row.id, sessionId: row.session_id }))
    done += 1
    if (done % 10 === 0) {
      console.log(`    已生成 ${done}`)
    }
  } catch (error) {
    console.warn('  跳过一条:', error instanceof Error ? error.message : error)
  }
}

writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')
console.log(`  ✅ 写入 ${lines.length} 条到 ${outPath}`)
