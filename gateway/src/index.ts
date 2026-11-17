/**
 * ds-gateway —— DeepSeek C 端 App 的自建网关。
 *
 * 职责：
 *  1. 代持 DeepSeek API Key：客户端只拿得到网关令牌，拿不到真 Key
 *  2. 把请求转发到 api.deepseek.com，SSE 逐帧透传不缓冲
 *  3. 只放行 App 实际会用到的路径，其余一律 404
 *  4. 上下文预算管理：超预算时裁掉最旧轮次，避免撞服务端上限（第 4 步）
 *
 * 运行方式：node src/index.ts（Node 22.6+ 原生跑 .ts，无需构建）
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { timingSafeEqual } from 'node:crypto'
import { appendFile, rename, stat } from 'node:fs/promises'
import type { ChatModel } from '../../shared/protocol.js'
/**
 * ⚠️ 运行时导入必须写 `.ts`：Node 的类型剥离只删类型，**不重写导入说明符**。
 * 写成 `./context.js` 在编译期能过，运行时却会 ERR_MODULE_NOT_FOUND。
 * （纯 `import type` 不受影响，因为整条语句在运行前就被删掉了。）
 */
import { buildTrimNotice, trimMessages, type TrimOutcome } from './context.ts'
import { createRateLimiter } from './rate-limit.ts'

/** 客户端诊断日志路径（App 端导入流程上报，见 /client-log 路由） */
const CLIENT_LOG_PATH = process.env.CLIENT_LOG_PATH ?? '/var/log/ds-gateway/client.log'
import { MemoryStore, type MemoryScope } from './memory/store.ts'
import { MemoryRegistry } from './memory/registry.ts'
import { AuthFailure, AuthStore, type User } from './auth/store.ts'
import { randomBytes } from 'node:crypto'
import { MEMORY_ADMIN_HTML } from './memory/admin.ts'
import { AssistantTextCollector, extractUserMessages, injectRecall } from './memory/wire.ts'

const VERSION = '1.1.4'
const PORT = Number(process.env.PORT ?? 8787)
/** 默认只监听环回：前面由 Caddy 做 TLS 与反代 */
const HOST = process.env.HOST ?? '127.0.0.1'
const UPSTREAM = (process.env.DEEPSEEK_ORIGIN ?? 'https://api.deepseek.com').replace(/\/+$/, '')
/** 真正的 DeepSeek Key，只存在于网关环境里 */
const API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
/** 客户端要出示的网关令牌；没配就拒绝启动 */
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? ''
const DEFAULT_MODEL: ChatModel = 'deepseek-flash'

/**
 * 输入侧 token 预算。模型支持 1M，但「能装下不等于该装满」。
 *
 * 定 30 万的理由：用户上传的文档是**全量**进上下文的（不做检索裁剪），
 * 一份 200 页 PDF 约 10 万 token，12 万预算会让一份文档就吃掉全部余量。
 * 30 万允许多份中等文档共存，成本仍可控（缓存未命中约 $0.045/次，命中约 $0.001）。
 */
const CONTEXT_BUDGET_TOKENS = Number(process.env.CONTEXT_BUDGET_TOKENS ?? 300_000)
/**
 * 裁剪时多让出的余量比例（滞回/迟滞）。
 *
 * 为什么要多裁一刀：缓存是按**前缀**命中的，一旦开始从头丢消息，
 * 下一次请求的起始位置就不同了 → 与上次请求没有公共前缀 → **缓存完全失效**。
 * 如果每轮只裁掉刚好超出的那一点，起始位置会每轮往后挪一格，等于每轮全价。
 *
 * 改成「需要裁时一次性裁到 80%」，起始位置就能稳定很多轮（这里约 20% 预算 ≈ 6 万 token），
 * 期间每轮都能命中缓存，只在跨越阈值的那一轮付出全价。
 */
const CONTEXT_TRIM_RESERVE = Number(process.env.CONTEXT_TRIM_RESERVE ?? 0.2)
/**
 * 允许缓冲的 JSON 请求体上限。只有 /messages 需要缓冲（为了裁剪），
 * 文件上传走流式不缓冲，所以这个额度只约束对话请求。
 */
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES ?? 48 * 1024 * 1024)

/**
 * 限流：单个来源每窗口最多多少次。
 * 默认 60 次/分钟——正常聊天远用不到，但足以挡住「令牌泄露后被刷」和「客户端死循环重试」。
 */
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000)
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 60)
const RATE_LIMIT_MAX_KEYS = Number(process.env.RATE_LIMIT_MAX_KEYS ?? 2_000)

const limiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxPerWindow: RATE_LIMIT_MAX,
  maxKeys: RATE_LIMIT_MAX_KEYS,
})

/**
 * 记忆库（P1 + P2）。
 *  - P1：会话与消息落库（原文，永不删除）
 *  - P2：全局会话的内容进 FTS5 全文索引，跨会话按需召回并注入
 */
const MEMORY_ENABLED = (process.env.MEMORY_ENABLED ?? '1') !== '0'
/**
 * 改造前的单库路径。多用户之后只作为「老库」被吸收到管理员账号目录下，
 * 新数据一律写到 MEMORY_DATA_DIR/<userId>/memory.db。
 */
const LEGACY_MEMORY_DB_PATH = process.env.MEMORY_DB_PATH ?? '/var/lib/ds-gateway/memory.db'
/** 每用户一个子目录 */
const MEMORY_DATA_DIR = process.env.MEMORY_DATA_DIR ?? '/var/lib/ds-gateway/users'
/** 账号与会话 */
const AUTH_DB_PATH = process.env.AUTH_DB_PATH ?? '/var/lib/ds-gateway/auth.db'
/** 管理员账号：老网关令牌映射到它，老记忆库也迁到它名下 */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? 'admin@l-f-cloud.online').trim().toLowerCase()
/** 不配就随机生成并打印一次（首次部署用） */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? ''
/** 是否允许自助注册；关掉就只能由管理员建号 */
const ALLOW_SIGNUP = (process.env.ALLOW_SIGNUP ?? '1') !== '0'
/** 本地会话是否也读取全局记忆。默认 0 = 完全隔离（不写也不读），心智模型最简单 */
const MEMORY_LOCAL_READS_GLOBAL = (process.env.MEMORY_LOCAL_READS_GLOBAL ?? '0') === '1'
const MEMORY_MAX_HITS = Number(process.env.MEMORY_MAX_HITS ?? 4)
const MEMORY_MAX_CHARS = Number(process.env.MEMORY_MAX_CHARS ?? 1500)

let registry: MemoryRegistry | null = null
if (MEMORY_ENABLED) {
  try {
    registry = new MemoryRegistry({
      dataDir: MEMORY_DATA_DIR,
      maxHits: MEMORY_MAX_HITS,
      maxChars: MEMORY_MAX_CHARS,
      legacyPath: LEGACY_MEMORY_DB_PATH,
    })
  } catch (error) {
    // 记忆库起不来**不能让网关挂掉**——聊天是主功能，记忆是增强
    console.error(
      `[gateway] 记忆库初始化失败，将以无记忆模式运行：${error instanceof Error ? error.message : String(error)}`
    )
    registry = null
  }
}

/**
 * 账号库起不来就**拒绝启动**（与记忆不同）：
 * 没有账号库 = 无法判断请求属于谁 = 所有人都能看到同一份数据，
 * 这比「暂时没有记忆」危险得多。
 */
const authStore = new AuthStore(AUTH_DB_PATH)

/** 首次部署：没有账号就建一个管理员，密码随机并打印一次 */
const bootstrapAdmin = (): User => {
  const existing = authStore.findByEmail(ADMIN_EMAIL)
  if (existing) {
    return existing
  }
  const password = ADMIN_PASSWORD || randomBytes(18).toString('base64url')
  const created = authStore.createUser(ADMIN_EMAIL, password, 'admin')
  if (ADMIN_PASSWORD) {
    console.log(`[gateway] 已创建管理员账号 ${created.email}（密码取自 ADMIN_PASSWORD）`)
  } else {
    console.log(
      `[gateway] 已创建管理员账号 ${created.email}，初始密码：${password}
` +
        `[gateway] ↑ 这个密码只打印这一次，请立即在 App 里登录并修改`
    )
  }
  return created
}

const adminUser = bootstrapAdmin()

// 多用户改造之前的数据都在单库里，归到管理员账号下（只做一次）
const adopted = registry?.adoptLegacy(adminUser.id)
if (adopted?.adopted) {
  console.log(`[gateway] 已把改造前的单库迁移到管理员账号 ${adminUser.email} 名下`)
}

/** 会话 id 只允许安全字符，避免被当成路径或 SQL 拼接素材 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

const readHeader = (req: IncomingMessage, name: string): string | null => {
  const value = req.headers[name]
  return typeof value === 'string' && value ? value : null
}

/**
 * 取请求来源。
 *
 * ⚠️ 这里信任 X-Forwarded-For 是**因为网关只监听 127.0.0.1**，只有 Caddy 能连进来，
 * 而 Caddy 会把它写成真实客户端 IP。若哪天把网关直接暴露到公网，这个头就能被伪造，
 * 必须改成只信任来自反代的连接。
 */
const clientKey = (req: IncomingMessage): string => {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) {
      return first
    }
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** 白名单就是 App 实际会调的全部接口 */
const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/models$/,
  /^\/anthropic\/v1\/messages$/,
  /^\/anthropic\/v1\/files$/,
  /^\/anthropic\/v1\/files\/[^/]+$/,
  /^\/v1\/tools\/asr$/,
  /^\/v1\/tools\/tts$/,
]

const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-beta', 'accept-language']
const FORWARD_RESPONSE_HEADERS = ['content-type', 'cache-control']

/**
 * CORS —— 这里必须自己实现，不能省。
 *
 * 为什么：App 跑在 Capacitor 的 WebView 里（源是 http://localhost），调网关是**跨域**请求，
 * 且带了 x-api-key 这种非简单头，浏览器一定先发 OPTIONS 预检。
 * 网关若不会回预检，App 连一个请求都发不出去——而 curl 测试完全看不出这个问题。
 *
 * ALLOWED_ORIGINS 留空 = 回显请求的 Origin（配合令牌鉴权，风险可控）；
 * 填成逗号分隔列表则只放行这些源。
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

/** 客户端需要读取的自定义响应头；不列出来，JS 里读到的就是 null */
const EXPOSED_HEADERS = [
  'x-ds-context-trimmed-messages',
  'x-ds-context-trimmed-tokens',
  'x-ds-context-kept-tokens',
  'x-ds-memory-recall',
].join(', ')

const allowedOrigin = (req: IncomingMessage): string | null => {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || !origin) {
    // 非浏览器请求（curl、服务端调用）没有 Origin，不需要 CORS
    return null
  }
  if (ALLOWED_ORIGINS.length === 0) {
    return origin
  }
  return ALLOWED_ORIGINS.includes(origin) ? origin : null
}

/**
 * 在入口统一下发 CORS 头。
 * 用 res.setHeader 而不是塞进某一次的 writeHead：这样所有出口（含错误响应、
 * SSE 流、404）都会带上，不会漏掉某条分支导致浏览器报"CORS 头缺失"。
 */
const setCorsHeaders = (req: IncomingMessage, res: ServerResponse): boolean => {
  const origin = allowedOrigin(req)
  if (!origin) {
    return false
  }
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-credentials', 'true')
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  /**
   * 预检通过的条件是：浏览器列出的每一个请求头，都必须在这里出现。
   *
   * ⚠️ 这里踩过一次：早先写死了一份白名单，后来 App 新增 x-ds-session-id /
   * x-ds-memory-scope 两个头，预检立刻失败，表现是「网络异常」而网关日志里
   * 连请求都没有——极难排查。所以改成：**优先回显浏览器请求的头**，
   * 只有拿不到时才退回静态列表。这样以后加头不会再坏。
   *
   * 回显 Arbitrary 头不会扩大权限面：鉴权仍靠 x-api-key，服务端不做任何
   * 基于请求头的信任判断。
   */
  const requestedHeaders = req.headers['access-control-request-headers']
  res.setHeader(
    'access-control-allow-headers',
    typeof requestedHeaders === 'string' && requestedHeaders
      ? requestedHeaders
      : 'x-api-key, authorization, content-type, anthropic-beta, accept, accept-language, x-ds-session-id, x-ds-memory-scope'
  )
  res.setHeader('access-control-expose-headers', EXPOSED_HEADERS)
  res.setHeader('access-control-max-age', '86400')
  // Origin 会变化，必须声明，否则中间缓存可能把某个源的响应发给另一个源
  res.setHeader('vary', 'Origin')
  return true
}

/**
 * Node 的 fetch 接受任意可读流作为 body，但类型标注只有 BodyInit。
 * 这里从 RequestInit 反推，避免为一个类型去引入 DOM lib ——
 * Node 项目里开 DOM 全局会让"用了浏览器 API"这类错误在编译期漏过去。
 */
type FetchBody = NonNullable<RequestInit['body']>

/** 运行期统计，暴露在 /health 里便于观察是否真的在裁剪 / 记忆 */
const stats = {
  requests: 0,
  trimmedRequests: 0,
  trimmedMessages: 0,
  memoryWrites: 0,
  memoryRecalls: 0,
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/** 定长比较，避免通过响应时间逐字符猜令牌 */
const sameToken = (given: string, expected: string): boolean => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * 令牌 → 用户。
 *
 * 两种令牌并存：
 *  - 用户令牌（/auth/login 发的）：多用户的正路
 *  - 旧网关令牌（GATEWAY_TOKEN）：映射到管理员账号，保证改造前已经装在手机上的
 *    App 不会因为这次升级突然连不上
 */
const userFromToken = (token: string): User | null => {
  if (!token) {
    return null
  }
  if (GATEWAY_TOKEN && sameToken(token, GATEWAY_TOKEN)) {
    return adminUser
  }
  return authStore.resolveToken(token)
}

const userFromRequest = (req: IncomingMessage): User | null => {
  const found = readGatewayToken(req)
  return found ? userFromToken(found.token) : null
}

/** 该用户的记忆库；没登录或没启用记忆就返回 null */
const memoryFor = (user: User | null): MemoryStore | null =>
  registry && user ? registry.get(user.id) : null

/** App 对不同接口用不同鉴权头：对话走 x-api-key，/models 与语音走 Bearer。两种都认。 */
type AuthStyle = 'x-api-key' | 'bearer' | 'basic'

const readGatewayToken = (req: IncomingMessage): { token: string; style: AuthStyle } | null => {
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey) {
    return { token: apiKey, style: 'x-api-key' }
  }
  const auth = req.headers.authorization
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return { token: auth.replace(/^Bearer\s+/i, '').trim(), style: 'bearer' }
  }
  /**
   * Basic 认证只给记忆管理页面用。
   *
   * 为什么用 Basic：浏览器原生会弹一次登录框并把凭据自动带上后续请求，
   * 不用把令牌塞进 URL（那会进浏览器历史和访问日志），也不用页面自己管令牌。
   * 用户名随便填，**密码就是网关令牌**。
   */
  if (typeof auth === 'string' && /^Basic\s+/i.test(auth)) {
    try {
      const decoded = Buffer.from(auth.replace(/^Basic\s+/i, ''), 'base64').toString('utf8')
      const separator = decoded.indexOf(':')
      const password = separator >= 0 ? decoded.slice(separator + 1) : decoded
      if (password) {
        return { token: password, style: 'basic' }
      }
    } catch {
      return null
    }
  }
  return null
}

const upstreamHeaders = (req: IncomingMessage, style: AuthStyle): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string' && value) {
      headers[name] = value
    }
  }
  // 关键一步：用真 Key 替换掉客户端的网关令牌，鉴权风格跟随客户端
  if (style === 'x-api-key') {
    headers['x-api-key'] = API_KEY
  } else {
    headers.authorization = `Bearer ${API_KEY}`
  }
  return headers
}

const isAllowed = (pathname: string): boolean => ALLOWED_PATHS.some((pattern) => pattern.test(pathname))

type ReadResult = { ok: true; buffer: Buffer } | { ok: false; size: number }

/** 限长读取整个请求体；超过上限立刻返回，不把内存吃穿 */
const readBodyCapped = async (req: IncomingMessage, max: number): Promise<ReadResult> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > max) {
      return { ok: false, size }
    }
    chunks.push(buffer)
  }
  return { ok: true, buffer: Buffer.concat(chunks) }
}

type ManagedBody = {
  body: string
  outcome: TrimOutcome | null
  /**
   * 裁剪提示。**故意不写进 system**。
   *
   * 实测：改 system 里一个字，DeepSeek 的整段前缀缓存直接归零
   * （同前缀第二次请求 cache_read=512，改 system 后 cache_read=0）。
   * 而这条提示里带「省略了 N 条」，N 每轮都变 —— 写进 system 等于
   * 长对话里每轮都按全价重算。所以改成拼到最后一条用户消息里。
   */
  notice: string
}

/** 解析失败一律返回 null：宁可当作「没有消息」也不抛异常打断转发 */
const safeParseMessages = (text: string): unknown[] | null => {
  try {
    const parsed = JSON.parse(text) as { messages?: unknown }
    return Array.isArray(parsed.messages) ? parsed.messages : null
  } catch {
    return null
  }
}

/**
 * 对 /messages 的请求体做上下文裁剪。
 * 解析不了就**原样放行**——宁可不管，也不要因为网关判断失误把正常请求变成错误。
 */
const manageContext = (text: string, budget: number): ManagedBody => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { body: text, outcome: null, notice: '' }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { body: text, outcome: null, notice: '' }
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.messages)) {
    return { body: text, outcome: null, notice: '' }
  }

  const outcome = trimMessages(record.messages, budget, CONTEXT_TRIM_RESERVE)
  if (!outcome.trimmed) {
    return { body: text, outcome, notice: '' }
  }
  // system 原样保留：它必须逐字节稳定，缓存才命中
  return {
    body: JSON.stringify({ ...record, messages: outcome.messages }),
    outcome,
    notice: buildTrimNotice(outcome.trimmedMessages, outcome.droppedPinned),
  }
}

const proxy = async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
  const user = userFromRequest(req)
  if (!user) {
    json(res, 401, { ok: false, error: 'unauthorized', message: '缺少或无效的访问令牌' })
    return
  }
  // 上游仍然用 DeepSeek Key 转发，客户端令牌只用于识别「你是谁」
  const inbound = readGatewayToken(req)
  // 本次请求使用**这个用户自己的**记忆库
  const memory = memoryFor(user)

  // 客户端断开时中止上游请求，别让 DeepSeek 那边继续空跑计费。
  // ⚠️ 必须监听 res 而不是 req：req 的 'close' 在请求体正常读完时也会触发。
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort()
    }
  })

  const method = (req.method ?? 'GET').toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const needsContext = hasBody && pathname === '/anthropic/v1/messages'

  stats.requests += 1

  let body: FetchBody | undefined
  let outcome: TrimOutcome | null = null

  /**
   * 记忆相关的会话上下文。App 通过请求头告诉网关：
   *   x-ds-session-id    会话 id（App 本地生成的 uuid）
   *   x-ds-memory-scope  global | local（会话创建时定死，之后不可改）
   * 缺任一个就当作「无记忆」处理，不影响正常聊天。
   */
  const rawSessionId = memory ? readHeader(req, 'x-ds-session-id') : null
  const sessionId = rawSessionId && SESSION_ID_RE.test(rawSessionId) ? rawSessionId : null
  const requestedScope: MemoryScope =
    readHeader(req, 'x-ds-memory-scope') === 'global' ? 'global' : 'local'
  let sessionScope: MemoryScope | null = null
  let recallHits = 0
  /** 回忆块文本，稍后与裁剪提示一起拼进最后一条用户消息 */
  let recallBlock = ""

  if (!hasBody) {
    body = undefined
  } else if (needsContext) {
    const read = await readBodyCapped(req, MAX_JSON_BODY_BYTES)
    if (!read.ok) {
      req.destroy()
      json(res, 413, {
        ok: false,
        error: 'body_too_large',
        message: `请求体超过 ${Math.round(MAX_JSON_BODY_BYTES / 1024 / 1024)} MB 上限`,
        size: read.size,
      })
      return
    }
    const original = read.buffer.toString('utf8')
    const managed = manageContext(original, CONTEXT_BUDGET_TOKENS)
    body = managed.body
    outcome = managed.outcome
    if (outcome?.trimmed) {
      stats.trimmedRequests += 1
      stats.trimmedMessages += outcome.trimmedMessages
      console.log(
        `[gateway] 上下文裁剪：丢弃 ${outcome.trimmedMessages} 条消息 / ${outcome.trimmedTokens} token，保留 ${outcome.keptTokens} token`
      )
    }

    // 记忆：先入库本轮原话，再按需召回其他会话的相关片段
    if (memory && sessionId) {
      const ensured = memory.ensureSession(sessionId, requestedScope, Date.now())
      sessionScope = ensured.scope

      const parsed = safeParseMessages(original)
      // 逐条入库（不只最后一条）：App 每轮都重发完整历史，靠 INSERT OR IGNORE
      // 天然自愈——任何原因漏存的，下一轮会被补回来。
      const userMessages = parsed ? extractUserMessages(parsed) : []
      let lastRealText = ''
      // 记录每段文字在历史里第几次出现：重发时序号一致（保持幂等），
      // 用户真的重复说同一句话时序号不同（两次都能存下来）
      const seenCounts = new Map<string, number>()
      for (const item of userMessages) {
        const occurrence = seenCounts.get(item.text) ?? 0
        seenCounts.set(item.text, occurrence + 1)
        if (!item.text) {
          // 只发图片/文件、一个字没打：仍然留一条占位，否则聊天记录里这段会凭空消失。
          // 占位不进索引（它没有可检索的内容）。
          if (!item.hasAttachment) {
            continue
          }
          const placeholder = memory.recordMessage({
            sessionId,
            scope: ensured.scope,
            role: 'user',
            body: '[仅附件消息]',
            now: Date.now(),
            index: false,
            occurrence,
          })
          if (placeholder.stored) {
            stats.memoryWrites += 1
          }
          continue
        }
        const recorded = memory.recordMessage({
          sessionId,
          scope: ensured.scope,
          role: 'user',
          body: item.text,
          now: Date.now(),
          occurrence,
        })
        if (recorded.stored) {
          stats.memoryWrites += 1
        }
        lastRealText = item.text
      }

      if (lastRealText) {
        // 全局会话一定召回；本地会话默认不读（完全隔离），可用环境变量放开
        const canRead = ensured.scope === 'global' || MEMORY_LOCAL_READS_GLOBAL
        if (canRead) {
          const hits = await memory.search({ text: lastRealText, excludeSessionId: sessionId })
          if (hits.length > 0) {
            recallBlock = memory.buildRecallBlock(hits)
            recallHits = hits.length
            stats.memoryRecalls += 1
            console.log(
              `[gateway] 记忆召回：${hits.length} 条片段（会话 ${sessionId.slice(0, 8)}，模式 ${ensured.scope}）`
            )
          }
        }
      }
    }

    /**
     * 把「裁剪提示 + 回忆块」一起拼到最后一条用户消息里。
     *
     * ⚠️ 两者都**不能写进 system**：实测改 system 一个字，缓存读取就从
     * 512 掉到 0，整段前缀按全价重算。拼在最后一条消息里，
     * 前面的 system 与历史前缀保持不变，缓存照常命中。
     */
    const prefix = [managed.notice, recallBlock].filter(Boolean).join('\n\n')
    if (prefix) {
      body = injectRecall(managed.body, prefix)
    }
  } else {
    body = Readable.toWeb(req) as unknown as FetchBody
  }

  /** 助手回答的采集器：只有在「能记忆」的会话里才开 */
  const collector =
    memory && sessionId && sessionScope ? new AssistantTextCollector() : null
  const finalizeAssistant = () => {
    if (!collector || !memory || !sessionId || !sessionScope) {
      return
    }
    const text = collector.result()
    if (!text) {
      return
    }
    try {
      const recorded = memory.recordMessage({
        sessionId,
        scope: sessionScope,
        role: 'assistant',
        body: text,
        now: Date.now(),
      })
      if (recorded.stored) {
        stats.memoryWrites += 1
      }
    } catch (error) {
      console.error(
        `[gateway] 助手回答入库失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  let upstream: Response
  try {
    upstream = await fetch(`${UPSTREAM}${pathname}`, {
      method,
      headers: upstreamHeaders(req, inbound?.style ?? `x-api-key`),
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit)
  } catch (error) {
    if (res.writableEnded || res.destroyed) {
      return
    }
    if (controller.signal.aborted) {
      res.destroy()
      return
    }
    json(res, 502, {
      ok: false,
      error: 'upstream_unreachable',
      message: error instanceof Error ? error.message : String(error),
    })
    return
  }

  const headers: Record<string, string> = {}
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) {
      headers[name] = value
    }
  }
  headers['cache-control'] = headers['cache-control'] ?? 'no-store'
  // 把裁剪情况透出来，便于 App 侧将来做提示、也便于排查
  if (outcome) {
    headers['x-ds-context-trimmed-messages'] = String(outcome.trimmedMessages)
    headers['x-ds-context-trimmed-tokens'] = String(outcome.trimmedTokens)
    headers['x-ds-context-kept-tokens'] = String(outcome.keptTokens)
  }
  headers['x-ds-memory-recall'] = String(recallHits)
  res.writeHead(upstream.status, headers)

  if (!upstream.body) {
    res.end()
    return
  }
  // 逐帧转发：不缓冲、不聚合，SSE 才能边生成边显示
  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
  stream.on('error', () => res.destroy())

  if (!collector) {
    stream.pipe(res)
    return
  }

  if ((upstream.headers.get('content-type') ?? '').includes('text/event-stream')) {
    // SSE：边转发边捞文本。**绝不能先缓冲再转发**，否则首字延迟就毁掉流式体验
    const tap = new Transform({
      transform(chunk, _encoding, callback) {
        collector.push(chunk as Buffer)
        callback(null, chunk)
      },
      flush(callback) {
        finalizeAssistant()
        callback()
      },
    })
    stream.on('error', (error) => tap.destroy(error))
    stream.pipe(tap).pipe(res)
    return
  }

  // 非流式：整个 body 就是一段 JSON，攒到上限再统一解析
  const COLLECT_LIMIT = 2 * 1024 * 1024
  const pieces: Buffer[] = []
  let collected = 0
  stream.on('data', (chunk: Buffer) => {
    if (collected < COLLECT_LIMIT) {
      pieces.push(chunk)
      collected += chunk.length
    }
  })
  stream.on('end', () => {
    collector.pushJsonBody(Buffer.concat(pieces).toString('utf8'))
    finalizeAssistant()
  })
  stream.pipe(res)
}

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  // CORS 头先挂上，之后所有出口自动带上
  setCorsHeaders(req, res)

  // 预检必须在鉴权**之前**处理：浏览器发 OPTIONS 时不会带 x-api-key
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // ---- 客户端诊断日志 ----
  // 用途：App 端「导入历史对话」在手机上卡住且无任何可见提示时，
  // 由 App 把每一步 POST 上来，落成 jsonl，事后直接在服务器上读。
  // 鉴权与聊天接口共用网关令牌；日志按行追加，超过 2 MB 自动轮转。
  if (req.method === 'POST' && url.pathname === '/client-log') {
    // 令牌也可以走查询参数：客户端用 text/plain 发简单请求可以**绕过 CORS 预检**，
    // 导入卡死时预检失败会连日志都发不出来（这正是我们最需要日志的时刻）。
    const queryToken = url.searchParams.get('t') ?? ''
    const auth = readGatewayToken(req)
    const token = queryToken || auth?.token || ''
    if (!sameToken(token, GATEWAY_TOKEN)) {
      json(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    const body = await readBodyCapped(req, 16 * 1024)
    if (!body.ok) {
      json(res, 413, { ok: false, error: 'too_large' })
      return
    }
    const text = body.buffer.toString('utf8')
    const line = JSON.stringify({
      at: new Date().toISOString(),
      ip: (typeof req.headers['x-forwarded-for'] === 'string'
            ? req.headers['x-forwarded-for'].split(',')[0].trim()
            : '') || req.socket.remoteAddress || '',
      entry: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
    })
    try {
      await appendFile(CLIENT_LOG_PATH, `${line}\n`)
      const { size } = await stat(CLIENT_LOG_PATH)
      if (size > 2 * 1024 * 1024) {
        await rename(CLIENT_LOG_PATH, `${CLIENT_LOG_PATH}.1`)
      }
    } catch (error) {
      console.warn('[gateway] 写客户端日志失败：', error instanceof Error ? error.message : error)
    }
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      version: VERSION,
      node: process.version,
      upstream: UPSTREAM,
      defaultModel: DEFAULT_MODEL,
      hasApiKey: API_KEY.length > 0,
      hasGatewayToken: GATEWAY_TOKEN.length > 0,
      contextBudgetTokens: CONTEXT_BUDGET_TOKENS,
      allowedOrigins: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : 'any (echo)',
      auth: {
        users: authStore.countUsers(),
        signupAllowed: ALLOW_SIGNUP,
        legacyTokenWorks: GATEWAY_TOKEN.length > 0,
        admin: adminUser.email,
      },
      memory: registry
        ? {
            enabled: true,
            /** 每用户一个库；这里报的是管理员那份作为概览 */
            dataDir: MEMORY_DATA_DIR,
            dbPath: registry.pathFor(adminUser.id),
            localReadsGlobal: MEMORY_LOCAL_READS_GLOBAL,
            maxHits: MEMORY_MAX_HITS,
            /** 向量检索是否已启用（配了 embedding 接口才为 true） */
            vectors: memoryFor(adminUser)?.vectorEnabled ?? false,
            /** P4：记忆新鲜度半衰期与权重修正幅度 */
            decayHalfLifeDays: Number(process.env.MEMORY_DECAY_HALF_LIFE_DAYS ?? 90),
            freshnessBoost: Number(process.env.MEMORY_FRESHNESS_BOOST ?? 0.25),
            ...(memoryFor(adminUser)?.stats() ?? { sessions: 0, messages: 0, chunks: 0 }),
          }
        : { enabled: false },
      rateLimit: {
        windowMs: RATE_LIMIT_WINDOW_MS,
        maxPerWindow: RATE_LIMIT_MAX,
        trackedSources: limiter.size(),
      },
      stats,
      uptimeSeconds: Math.round(process.uptime()),
    })
    return
  }

  // 限流放在 /health 之后：健康检查免限（否则监控会被自己挡掉），
  // 其余请求（含被白名单挡成 404 的扫描流量）都计入，避免扫描器刷日志与 CPU。
  const gate = limiter.check(clientKey(req))
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfterSeconds))
    json(res, 429, {
      ok: false,
      error: 'rate_limited',
      message: `请求过于频繁，请 ${gate.retryAfterSeconds} 秒后重试`,
      retryAfterSeconds: gate.retryAfterSeconds,
    })
    return
  }

  // ---- 账号：注册 / 登录 / 登出 / 当前用户 / 改密码 ----
  if (url.pathname.startsWith('/auth/')) {
    const fail = (status: number, error: string, message: string) => {
      json(res, status, { ok: false, error, message })
    }
    const readJsonBody = async (): Promise<Record<string, unknown> | null> => {
      const body = await readBodyCapped(req, 16 * 1024)
      if (!body.ok) {
        fail(413, 'body_too_large', '请求体过大')
        return null
      }
      try {
        const parsed = JSON.parse(body.buffer.toString('utf8')) as unknown
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
      } catch {
        fail(400, 'bad_json', '请求体不是合法 JSON')
        return null
      }
    }
    const str = (value: unknown): string => (typeof value === 'string' ? value : '')
    const device = (): string | undefined => {
      const ua = req.headers['user-agent']
      return typeof ua === 'string' ? ua : undefined
    }
    /** AuthFailure → 合适的 HTTP 状态与错误码 */
    const authError = (error: unknown) => {
      if (!(error instanceof AuthFailure)) {
        console.error('[gateway] 账号接口异常:', error)
        fail(500, 'internal_error', '服务器内部错误')
        return
      }
      const map: Record<string, [number, string]> = {
        invalidEmail: [400, '邮箱格式不正确'],
        weakPassword: [400, '密码至少 8 位'],
        emailTaken: [409, '该邮箱已注册'],
        badCredentials: [401, '邮箱或密码不正确'],
        disabled: [403, '账号已被停用'],
        invalidToken: [401, '登录状态已失效，请重新登录'],
      }
      const [status, message] = map[error.key] ?? [400, '请求无法处理']
      fail(status, error.key, message)
    }
    const payloadUser = (user: User) => ({
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    })

    if (req.method === 'POST' && url.pathname === '/auth/register') {
      if (!ALLOW_SIGNUP) {
        fail(403, 'signup_disabled', '本实例未开放注册，请联系管理员')
        return
      }
      const body = await readJsonBody()
      if (!body) {
        return
      }
      try {
        const user = authStore.createUser(str(body.email), str(body.password))
        const session = authStore.createSession(user.id, device())
        console.log(`[gateway] 新注册：${user.email}`)
        json(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt, user: payloadUser(user) })
      } catch (error) {
        authError(error)
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/auth/login') {
      const body = await readJsonBody()
      if (!body) {
        return
      }
      try {
        const user = authStore.verifyPassword(str(body.email), str(body.password))
        const session = authStore.createSession(user.id, device())
        json(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt, user: payloadUser(user) })
      } catch (error) {
        authError(error)
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      const found = readGatewayToken(req)
      if (found) {
        authStore.revokeToken(found.token)
      }
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && url.pathname === '/auth/me') {
      const user = userFromRequest(req)
      if (!user) {
        fail(401, 'unauthorized', '登录状态已失效，请重新登录')
        return
      }
      const store = memoryFor(user)
      json(res, 200, {
        ok: true,
        user: payloadUser(user),
        /** 旧网关令牌登录时是 true：提示前端可以引导去设置密码 */
        legacyToken: ((inbound: string) => Boolean(inbound) && sameToken(inbound, GATEWAY_TOKEN))(
          readGatewayToken(req)?.token ?? ''
        ),
        memory: store ? store.stats() : null,
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/auth/password') {
      const user = userFromRequest(req)
      if (!user) {
        fail(401, 'unauthorized', '登录状态已失效，请重新登录')
        return
      }
      const body = await readJsonBody()
      if (!body) {
        return
      }
      try {
        // 用旧网关令牌进来的没有密码，允许直接设置；否则必须先验证旧密码
        const legacyLogin = sameToken(readGatewayToken(req)?.token ?? '', GATEWAY_TOKEN)
        if (!legacyLogin) {
          authStore.verifyPassword(user.email, str(body.oldPassword))
        }
        authStore.setPassword(user.id, str(body.newPassword))
        // 改密码会踢掉所有会话，这里给当前设备重新发一个，避免自己被登出
        const session = authStore.createSession(user.id, device())
        json(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt })
      } catch (error) {
        authError(error)
      }
      return
    }

    fail(404, 'not_found', '没有这个账号接口')
    return
  }

  // ---- 记忆管理页面（自用工具，不是 App 的接口）----
  if (url.pathname === '/memory' || url.pathname.startsWith('/memory/')) {
    /**
     * 页面本身**不认证**：它是一段纯静态 HTML，不含任何数据。
     *
     * 为什么改掉最初的 Basic 认证：浏览器原生登录框在手机内置浏览器里常常
     * 不弹、或弹了不提交（实测你的手机两次请求都返回 401，说明框没生效）。
     * 现在改成页面内填令牌，并支持 `#t=令牌` 直达链接，任何浏览器都能用。
     * 数据接口 /memory/api/* 仍然必须认证。
     */
    if (url.pathname === '/memory' || url.pathname === '/memory/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // 页面没有任何外部资源，锁死 CSP 也不会坏；顺便挡住注入
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      })
      res.end(MEMORY_ADMIN_HTML)
      return
    }

    const admin = userFromRequest(req)
    if (!admin) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '缺少或无效的访问令牌' })
      return
    }
    // 管理页面能列出并删除切片，只给管理员
    if (admin.role !== 'admin') {
      json(res, 403, { ok: false, error: 'forbidden', message: '需要管理员账号' })
      return
    }
    const memory = memoryFor(admin)
    if (!memory) {
      json(res, 503, { ok: false, error: 'memory_disabled', message: '记忆库未启用' })
      return
    }

    if (url.pathname === '/memory/api/stats') {
      json(res, 200, { ok: true, ...memory.stats(), vectors: memory.vectorEnabled })
      return
    }

    if (url.pathname === '/memory/api/list') {
      const items = memory.listChunks({
        q: url.searchParams.get('q') ?? '',
        limit: Number(url.searchParams.get('limit') ?? 200),
      })
      json(res, 200, { ok: true, items })
      return
    }

    if (url.pathname === '/memory/api/recall') {
      const q = (url.searchParams.get('q') ?? '').trim()
      if (!q) {
        json(res, 400, { ok: false, error: 'missing_query' })
        return
      }
      const hits = await memory.previewRecall(q, MEMORY_MAX_HITS)
      json(res, 200, { ok: true, hits })
      return
    }

    if (url.pathname === '/memory/api/delete' && req.method === 'POST') {
      const read = await readBodyCapped(req, 1024 * 1024)
      if (!read.ok) {
        json(res, 413, { ok: false, error: 'body_too_large' })
        return
      }
      let ids: string[] = []
      try {
        const parsed = JSON.parse(read.buffer.toString('utf8')) as { ids?: unknown }
        if (Array.isArray(parsed.ids)) {
          ids = parsed.ids.map((item) => String(item))
        }
      } catch {
        json(res, 400, { ok: false, error: 'bad_json' })
        return
      }
      const deleted = memory.deleteChunks(ids)
      console.log(`[gateway] 记忆管理：删除 ${deleted} 条切片`)
      json(res, 200, { ok: true, deleted })
      return
    }

    json(res, 404, { ok: false, error: 'not_found', path: url.pathname })
    return
  }

  if (!isAllowed(url.pathname)) {
    json(res, 404, { ok: false, error: 'not_found', path: url.pathname })
    return
  }

  await proxy(req, res, url.pathname)
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error: unknown) => {
    if (!res.headersSent) {
      json(res, 500, { ok: false, error: 'internal_error' })
    } else {
      res.destroy()
    }
    console.error('[gateway] 未捕获异常:', error)
  })
})

if (!API_KEY || !GATEWAY_TOKEN) {
  console.error('[gateway] 拒绝启动：必须同时配置 DEEPSEEK_API_KEY 与 GATEWAY_TOKEN')
  process.exit(1)
}

server.listen(PORT, HOST, () => {
  console.log(
    `[gateway] ${VERSION} 监听 http://${HOST}:${PORT}  上游 ${UPSTREAM}  上下文预算 ${CONTEXT_BUDGET_TOKENS} token`
  )
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[gateway] 收到 ${signal}，停止监听`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10_000).unref()
  })
}
