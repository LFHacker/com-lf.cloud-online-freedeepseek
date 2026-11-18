/**
 * 端到端验收：注册（需验证码）→ 聊天 → 验证码重放 → 登录退避。
 *
 *   node scripts/e2e-signup.ts <邮箱> <验证码> [基础地址]
 *
 * 刻意做成脚本而不是一堆 curl：shell 转义会咬坏 JSON，
 * 而这条链路（尤其是"验证码只能用一次"）必须能反复跑。
 */
import { readFileSync } from 'node:fs'

const applyEnv = (path: string): void => {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const at = trimmed.indexOf('=')
      const key = trimmed.slice(0, at)
      if (!(key in process.env)) process.env[key] = trimmed.slice(at + 1)
    }
  } catch {
    // 本机跑时没有这个文件也正常
  }
}
applyEnv('/etc/ds-gateway.env')

const email = process.argv[2]
const code = process.argv[3]
const base = process.argv[4] ?? process.env.GATEWAY_BASE ?? 'http://127.0.0.1:8787'
const password = process.env.E2E_PASSWORD ?? 'E2e-Test-Pass-77'
const upstreamKey = process.env.DEEPSEEK_API_KEY ?? ''

if (!email || !code) {
  console.error('用法: node scripts/e2e-signup.ts <邮箱> <验证码> [基础地址]')
  process.exit(1)
}

let failures = 0
const expect = (label: string, ok: boolean, detail = '') => {
  if (ok) {
    console.log(`  ✅ ${label}`)
  } else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? `：${detail}` : ''}`)
  }
}

const post = async (
  path: string,
  body: unknown,
  token?: string
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-api-key': token } : {}) },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = null
  }
  return { status: response.status, text, json }
}

console.log(`  目标 ${base}，邮箱 ${email}`)

const wrong = await post('/auth/register', { email, password, code: '000000' })
expect('错误验证码被拒', wrong.status === 400, `${wrong.status} ${wrong.text.slice(0, 80)}`)

const reg = await post('/auth/register', { email, password, code })
expect('正确验证码注册成功', reg.status === 200, `${reg.status} ${reg.text.slice(0, 120)}`)
const token = typeof reg.json?.token === 'string' ? reg.json.token : ''
expect('返回了会话令牌', token.length > 30, String(token.length))

if (token && upstreamKey) {
  const chat = await fetch(`${base}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': token, 'x-deepseek-key': upstreamKey },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 12,
      messages: [{ role: 'user', content: '只回复两个字：收到' }],
    }),
  })
  const text = await chat.text()
  let reply = text
  try {
    reply = (JSON.parse(text) as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? text
  } catch {
    // 保持原文
  }
  expect('新账号能聊天', chat.status === 200 && String(reply).includes('收到'), `${chat.status} ${String(reply).slice(0, 60)}`)
}

const replay = await post('/auth/register', { email, password, code })
expect('验证码不能重放', replay.status === 400 || replay.status === 409, `${replay.status}`)

const codes: number[] = []
for (let i = 0; i < 6; i += 1) {
  const attempt = await post('/auth/login', { email, password: 'definitely-wrong-password' })
  codes.push(attempt.status)
}
expect('前 4 次失败是 401', codes.slice(0, 4).every((c) => c === 401), codes.join(','))
expect('第 5 次起开始退避（429）', codes[4] === 429 || codes[5] === 429, codes.join(','))

console.log(`\n=== FAIL=${failures} ===`)
if (failures > 0) {
  process.exitCode = 1
}
