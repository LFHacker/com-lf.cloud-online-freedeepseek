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
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
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
import { AuthFailure, AuthStore, keyFingerprint, type User } from './auth/store.ts'
import { randomBytes } from 'node:crypto'
import { redactSecrets } from './redact.ts'
import { readSmtpConfig, sendMail, type SmtpConfig } from './mail/smtp.ts'
import { MEMORY_ADMIN_HTML } from './memory/admin.ts'
import { AssistantTextCollector, extractUserMessages, injectRecall } from './memory/wire.ts'
import { ensureProfile, readProfileConfig } from './memory/profile.ts'
import { estimateCost, isPeakNow, offPeakTable, readPriceTable } from './usage/cost.ts'

/**
 * 网关版本。1.2.x 起：会话同步进入「云端为主」阶段 2（分页游标 + pinned + 墓碑优先）
 * 与阶段 3（附件引用计数 + 回收）。/health 里能看到它，用来确认线上跑的是哪份代码。
 */
const VERSION = '1.2.2'
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
/**
 * 是否允许「没带自己 Key 的请求」回落到实例 Key。
 * 默认 **关闭**：用户配了自己的 Key 就必须用自己的，
 * 否则会出现「他以为在花自己的额度，其实在花你的」这种账目错乱。
 */
const ALLOW_INSTANCE_KEY = (process.env.ALLOW_INSTANCE_KEY ?? '0') === '1'

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

/** 稳定层（长期档案）配置；没有 API key 就等于不启用 */
/** 每账号每日 token 上限（命中+未命中+输出）。0 = 不限制 */
const DAILY_TOKEN_QUOTA = Number(process.env.DAILY_TOKEN_QUOTA ?? 2_000_000)

const PROFILE = readProfileConfig(process.env)

/**
 * GeoIP 读取器（延迟初始化，进程内复用）。
 *
 * 为什么要缓存：xdb 有 11MB，每次请求都读一遍盘既慢又浪费内存。
 * lookup 是纯函数式查表，可以安全共享。
 */
type GeoHit = {
  country?: { name?: string; code?: string }
  subdivisions?: Array<{ name?: string }>
  city?: { name?: string }
  isp?: string
}
let geoReader: { lookup(target: string): unknown; close?(): void } | null = null
let geoFailed = false

const lookupGeo = async (ip: string): Promise<GeoHit | null> => {
  if (geoFailed) {
    return null
  }
  try {
    if (!geoReader) {
      const specifier = ['ip2region', 'node'].join('/')
      const mod = (await import(specifier)) as unknown as {
        IP2Region: new () => { lookup(target: string): unknown; close?(): void }
      }
      geoReader = new mod.IP2Region()
    }
    return (geoReader.lookup(ip) as GeoHit | null) ?? null
  } catch (error) {
    // 只记录一次，避免每轮刷日志；后续直接跳过
    geoFailed = true
    console.warn('[gateway] GeoIP 初始化失败，位置信息将不再提供:', error instanceof Error ? error.message : error)
    return null
  }
}

/** 位置文本：'甘肃省兰州市'；查不到返回空串 */
const resolvePlaceLabel = async (ip: string): Promise<string> => {
  const hit = await lookupGeo(ip)
  if (!hit?.country) {
    return ''
  }
  const parts = [hit.subdivisions?.[0]?.name, hit.city?.name]
    .filter((part): part is string => Boolean(part) && part !== '0')
  return parts.join('')
}

/** 更新包与补丁目录（publish-update.mjs 写入） */
const UPDATES_DIR = process.env.UPDATES_DIR ?? '/opt/ds-gateway/updates'

/**
 * 用量与缓存统计。
 *
 * DeepSeek 返回 prompt_cache_hit_tokens / prompt_cache_miss_tokens，
 * 不记录就永远不知道缓存到底有没有命中——而这正是"多带原文"能不能成立的前提。
 */
/**
 * 每个会话「最近一轮回答是否写进记忆」。
 *
 * 为什么要记：写记忆发生在**流式响应结束之后**，那时响应头早就发出去了，
 * 没法用头告诉客户端。所以存在内存里，让 App 在回答结束后单独问一次。
 * 只保留最近一轮，重启即清空（够用：界面要显示的是"刚才这轮"）。
 */
const lastRecordBySession = new Map<string, { recorded: boolean; chunks: number; at: number }>()

const usageStats = {
  requests: 0,
  promptTokens: 0,
  cacheHit: 0,
  cacheMiss: 0,
  completionTokens: 0,
}

const recordUsage = (usage: unknown, context?: { userId: string; sessionId: string | null }): void => {
  if (!usage || typeof usage !== "object") {
    return
  }
  const record = usage as Record<string, unknown>
  /**
   * 两套字段都要认：
   *  · OpenAI 风格（/chat/completions）：prompt_tokens / prompt_cache_hit_tokens
   *  · Anthropic 风格（/anthropic/v1/messages）：input_tokens / cache_read_input_tokens
   * 只按其中一套解析，另一条链路就永远是 0（实测踩过）。
   */
  const details = record.prompt_tokens_details as Record<string, unknown> | undefined
  const anthropicStyle = record.input_tokens !== undefined && record.prompt_tokens === undefined
  const hit = Number(
    record.prompt_cache_hit_tokens ?? record.cache_read_input_tokens ?? details?.cached_tokens ?? 0
  )
  /**
   * ⚠️ Anthropic 格式里 input_tokens **只是未缓存的部分**，
   * 总 prompt = input_tokens + cache_read + cache_creation。
   * 按 OpenAI 的口径去读会把命中率算成 100%（实测踩过）。
   */
  const prompt = anthropicStyle
    ? Number(record.input_tokens) + hit + Number(record.cache_creation_input_tokens ?? 0)
    : Number(record.prompt_tokens ?? record.input_tokens ?? 0)
  const miss = anthropicStyle
    ? Number(record.input_tokens) + Number(record.cache_creation_input_tokens ?? 0)
    : Number(
        record.prompt_cache_miss_tokens ??
          record.cache_creation_input_tokens ??
          Math.max(0, prompt - hit)
      )
  usageStats.requests += 1
  usageStats.promptTokens += prompt
  usageStats.cacheHit += hit
  usageStats.cacheMiss += miss
  usageStats.completionTokens += Number(record.completion_tokens ?? record.output_tokens ?? 0)

  /**
   * 写账本：按请求追加，覆盖该 Key 下**所有会话**。
   * 设置页的「全部会话合计」与和官方后台对照都靠这张表。
   * 失败只记日志 —— 账本不该影响聊天。
   */
  if (context) {
    try {
      const outputTokens = Number(record.completion_tokens ?? record.output_tokens ?? 0)
      const estimate = estimateCost({ cacheHit: hit, cacheMiss: miss, output: outputTokens }, readPriceTable(process.env))
      authStore.recordUsageEvent({
        userId: context.userId,
        sessionId: context.sessionId,
        model: 'auto',
        promptHit: hit,
        promptMiss: miss,
        output: outputTokens,
        costCny: estimate.total,
        peak: estimate.peak,
      })
    } catch (error) {
      console.warn('[gateway] 写用量账本失败:', error instanceof Error ? error.message : error)
    }
  }
  if (hit > 0) {
    console.log(`[gateway] 缓存命中 ${hit} / 未命中 ${miss}（累计命中率 ${((usageStats.cacheHit / Math.max(1, usageStats.cacheHit + usageStats.cacheMiss)) * 100).toFixed(1)}%）`)
  }
}

/** 邮件通道；没配就退化成"验证码只能打印到日志"（仅开发用） */
const SMTP: SmtpConfig | null = readSmtpConfig(process.env)
const MAIL_ENABLED = SMTP !== null
if (!MAIL_ENABLED) {
  console.warn('[gateway] 未配置 SMTP_*，邮箱验证码将无法发送（注册/找回不可用）')
}

/** 验证码有效期与重发冷却 */
const CODE_TTL_MS = Number(process.env.CODE_TTL_MS ?? 10 * 60_000)
const CODE_COOLDOWN_MS = Number(process.env.CODE_COOLDOWN_MS ?? 60_000)
/** 每邮箱每小时最多发几次（内存计数，重启清零；够挡住手滑与轻度滥用） */
const CODE_HOURLY_LIMIT = Number(process.env.CODE_HOURLY_LIMIT ?? 5)
const codeHourly = new Map<string, number[]>()

/**
 * 每账号限流与每日配额。
 *
 * 全局限流只能挡住"一个 IP 刷"，挡不住"一个账号被刷爆影响所有人"。
 * 这里按 user_id 再压一层：
 *   · 每分钟请求数上限（默认 30）
 *   · 每日请求数上限（默认 2000）
 * 计数放内存（重启清零）：配额是防滥用，不是计费依据。
 */
const USER_RATE_MAX = Number(process.env.USER_RATE_MAX ?? 30)
const USER_DAILY_MAX = Number(process.env.USER_DAILY_MAX ?? 2000)
type UsageBucket = { minuteStart: number; minuteCount: number; day: string; dayCount: number }
const usageByUser = new Map<string, UsageBucket>()

const checkUserQuota = (userId: string): { allowed: boolean; reason?: 'minute' | 'daily'; retryAfterSeconds?: number } => {
  const now = Date.now()
  const day = new Date(now).toISOString().slice(0, 10)
  let bucket = usageByUser.get(userId)
  if (!bucket) {
    bucket = { minuteStart: now, minuteCount: 0, day, dayCount: 0 }
    usageByUser.set(userId, bucket)
  }
  if (now - bucket.minuteStart >= 60_000) {
    bucket.minuteStart = now
    bucket.minuteCount = 0
  }
  if (bucket.day !== day) {
    bucket.day = day
    bucket.dayCount = 0
  }
  if (bucket.minuteCount >= USER_RATE_MAX) {
    return { allowed: false, reason: 'minute', retryAfterSeconds: Math.ceil((bucket.minuteStart + 60_000 - now) / 1000) }
  }
  if (bucket.dayCount >= USER_DAILY_MAX) {
    return { allowed: false, reason: 'daily' }
  }
  bucket.minuteCount += 1
  bucket.dayCount += 1
  return { allowed: true }
}

const allowCodeSend = (email: string): boolean => {
  const now = Date.now()
  const list = (codeHourly.get(email) ?? []).filter((at) => now - at < 3_600_000)
  if (list.length >= CODE_HOURLY_LIMIT) {
    codeHourly.set(email, list)
    return false
  }
  list.push(now)
  codeHourly.set(email, list)
  return true
}

/** 首次部署：没有账号就建一个管理员，密码随机并打印一次 */
const bootstrapAdmin = (): User => {
  const existing = authStore.findByEmail(ADMIN_EMAIL)
  if (existing) {
    // 确保配置的管理员账号确实是管理员：把 ADMIN_EMAIL 指向自己注册的账号后，
    // 不需要手工改库，重启即生效
    if (existing.role !== 'admin') {
      authStore.setRole(existing.id, 'admin')
      console.log('[gateway] 已把', existing.email, '提升为管理员')
      return { ...existing, role: 'admin' }
    }
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

/**
 * 管理员自举只在显式配置了 ADMIN_EMAIL 时执行。
 *
 * 为什么改成条件式：原来无条件执行，意味着"删掉管理员账号"这件事
 * 在重启后会被自动撤销 —— 想从零开始干净启用时做不到。
 * 现在留空 ADMIN_EMAIL 就不会自举，改由"首位注册者成为管理员"。
 */
const adminUser = ADMIN_EMAIL ? bootstrapAdmin() : null

// 多用户改造之前的数据都在单库里，归到管理员账号下（只做一次）
if (adminUser) {
  const adopted = registry?.adoptLegacy(adminUser.id)
  if (adopted?.adopted) {
    console.log(`[gateway] 已把改造前的单库迁移到管理员账号 ${adminUser.email} 名下`)
  }
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

/**
 * 客户端 IP 的别名。
 *
 * 为什么需要别名：代理处理函数内部有一个局部变量也叫 clientKey
 * （存的是用户的 DeepSeek Key 字符串），它会把上面那个取 IP 的函数遮蔽掉 ——
 * 在 proxy 里写 clientKey(req) 会被 TS 判成"String 不可调用"，运行时也会崩。
 */
const clientIpOf = (req: IncomingMessage): string => clientKey(req)

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
  /**
   * ⚠️ 这里踩过一次大的：原来只有 GET/POST/DELETE。附件上传走的是
   * `PUT /sync/files/:id`，而 **PUT 一定会触发预检**（简单方法只有 GET/HEAD/POST），
   * 于是浏览器在预检那一步就把请求拒了 —— 服务端**一个字节都没收到**，
   * 网关日志里连记录都没有。表现是：会话同步一切正常、附件永远 0 个。
   * 所以这里必须把服务端真正支持的方法全列上。
   */
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
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

const upstreamHeaders = (req: IncomingMessage, style: AuthStyle, apiKey: string): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string' && value) {
      headers[name] = value
    }
  }
  // 关键一步：用真 Key 替换掉客户端的网关令牌，鉴权风格跟随客户端
  if (style === 'x-api-key') {
    headers['x-api-key'] = apiKey
  } else {
    headers.authorization = `Bearer ${apiKey}`
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
  // 每账号限流 / 每日配额：放在最前面，配额满了连上游都不碰
  const quota = checkUserQuota(user.id)
  if (!quota.allowed) {
    if (quota.retryAfterSeconds) {
      res.setHeader('Retry-After', String(quota.retryAfterSeconds))
    }
    json(res, 429, {
      ok: false,
      error: 'user_quota',
      message:
        quota.reason === 'daily'
          ? '今日请求数已达上限，明天再来'
          : `请求过于频繁，请 ${quota.retryAfterSeconds ?? 60} 秒后再试`,
    })
    return
  }
  /**
   * 每日 token 配额。
   *
   * 限流按"次"算，防不住一次长上下文就烧掉几块钱；
   * 配额按 token 算，才是真正兜住成本的闸门。数据来自 usage_events 账本。
   */
  if (DAILY_TOKEN_QUOTA > 0) {
    try {
      const used = authStore.todayTokenUsage(user.id)
      if (used >= DAILY_TOKEN_QUOTA) {
        json(res, 429, {
          ok: false,
          error: 'token_quota',
          message: `今日 token 用量已达上限（${DAILY_TOKEN_QUOTA.toLocaleString()}），明天再来`,
        })
        return
      }
    } catch {
      // 统计失败不阻断聊天
    }
  }
  const inbound = readGatewayToken(req)
  /**
   * 官方 Key 来自**客户端请求头**，不是服务器配置。
   * 它只在本次请求的内存里存在：转发完随请求对象回收，
   * 不写库、不写日志、不进响应。
   */
  const clientKey = (readHeader(req, 'x-deepseek-key') ?? '').trim()
  const upstreamKey = clientKey.length >= 20 ? clientKey : ALLOW_INSTANCE_KEY ? API_KEY : ''
  if (!upstreamKey) {
    json(res, 409, {
      ok: false,
      error: 'no_upstream_key',
      message: '还没有填写 DeepSeek 官方 Key，请在设置里填入后重试',
    })
    return
  }
  // 指纹只在变化时写一次，用于判断「这个账号配过 Key 没有」
  const fingerprint = keyFingerprint(upstreamKey)
  const known = authStore.getUpstreamKey(user.id)
  if (!known || known.fingerprint !== fingerprint) {
    try {
      authStore.setUpstreamKey(user.id, upstreamKey)
    } catch (error) {
      console.warn('[gateway] 记录 Key 指纹失败（不影响本次请求）:', error instanceof Error ? error.message : error)
    }
  }
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
        lastRecordBySession.set(sessionId, {
          recorded: recorded.stored,
          chunks: recorded.chunks,
          at: Date.now(),
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

    /**
     * 稳定层：长期档案拼进 system。
     *
     * 它一天最多重建一次，所以是"逐字节稳定"的前缀 → 吃 1/10 缓存价。
     * 动态召回必须留在尾部（见 injectRecall 的注释）：把会变的东西放进前缀，
     * 等于每轮让整段缓存作废。实测稳定前缀 6009 token 时，
     * 第二次调用命中 5760、只有 249 全价。
     */
    if (PROFILE && memory) {
      try {
        const profile = await ensureProfile(memory, PROFILE)
        if (profile.body) {
          /**
           * ⚠️ 档案**不放 system**，改成和回忆一起进尾部。
           *
           * 原因：档案里是会变的事实（年级、专业、在做什么）。
           * 放 system 想省缓存，就只能靠"别刷新"保住前缀 —— 那必然记错。
           * 放尾部则前缀（system + 历史）保持稳定，缓存照旧命中；
           * 尾部这几百 token 按未命中价算，可以忽略。
           *
           * 顺序：档案在前（结论），回忆在后（证据）。
           */
          /**
           * 三段内容，按可信度从高到低排：
           *  ① 最近你说过的原话（未经摘要，一定最新）
           *  ② 长期档案（摘要，可能滞后）
           *  ③ 跨会话回忆（证据，可能已过时）
           * 用户明确要求"记忆的更新应该是即时的"，所以原话必须原样带上。
           */
          const recent = memory
            .recentUserMessages(PROFILE.recentMessages)
            .reverse()
            .map((item) => `- [${new Date(item.createdAt).toISOString().slice(0, 16).replace('T', ' ')}] ${item.body.slice(0, 200)}`)
            .join('\n')
          /**
           * 客户端本地时间（精确到分钟）。
           *
           * 为什么由网关拼：latest_reminder 字段只接受 YYYY-MM-DD，
           * 带时分会被上游整条拒绝；塞进用户正文又会污染历史与缓存。
           * 放在尾部则两全：既让模型知道现在几点，又不改动任何历史消息。
           */
          const localTime = readHeader(req, 'x-ds-local-time')
          /**
           * 位置由网关按来源 IP 推断，不经客户端。
           *
           * 为什么不让客户端传：客户端要先拿名字再换代码，链路上任何一步出错
           * 位置就变成空的（实测就是这样：模型答"不知道你在哪"）。
           * 网关这条路径已经在服务器上验证过，直接用它最可靠。
           *
           * 开关跟随客户端：只有开了"时间与位置"总开关，客户端才会带时间头。
           */
          const place = localTime ? await resolvePlaceLabel(clientIpOf(req)) : ''
          const blocks = [
            recent ? ['<最近你说过>', recent, '</最近你说过>'].join('\n') : '',
            localTime ? ['<当前时间>', localTime, '</当前时间>'].join('\n') : '',
            place ? ['<当前位置>', place, '（按网络出口 IP 推断，仅到城市，可能有偏差）</当前位置>'].join('\n') : '',
            ['<长期记忆>', profile.body, '</长期记忆>'].join('\n'),
            prefix,
          ].filter(Boolean)
          body = injectRecall(body, blocks.join('\n\n'))
        }
      } catch (error) {
        console.warn(
          `[gateway] 长期档案注入失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
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
        /**
         * 把这一轮的回答挂到上一条用户消息的切片上。
         * 记忆只索引用户说的话，但只给问题不给答案，模型就只能复述报错。
         * 失败不影响聊天：context 只是锦上添花。
         */
        try {
          memory.attachLastAssistantReply(sessionId, text)
        } catch (error) {
          console.error(
            `[gateway] 挂接助手回答失败：${error instanceof Error ? error.message : String(error)}`
          )
        }
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
      headers: upstreamHeaders(req, inbound?.style ?? `x-api-key`, upstreamKey),
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

  /**
   * 记录用量与缓存命中。
   * 非流式响应可以整段解析；流式的 usage 只在 SSE 末尾出现，交给下面的 tap 处理。
   */
  const contentType = upstream.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      const cloned = upstream.clone()
      void cloned
        .json()
        .then((payload: unknown) => {
          const usage = (payload as { usage?: unknown } | null)?.usage
          recordUsage(usage, { userId: user.id, sessionId })
        })
        .catch(() => {
          // 解析失败不影响转发
        })
    } catch {
      // clone 失败（已被消费）时静默跳过
    }
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
    /**
     * ⚠️ 令牌**不能**放查询串：Caddy 的访问日志会记录完整 URL，
     * 实测泄漏了 97 条带令牌的记录。现在改成两种都不进日志的方式：
     *   ① 请求头 x-api-key（会触发 CORS 预检，但顺序正常时没问题）
     *   ② 请求体首行 `x-ds-token: <令牌>`（text/plain 简单请求，无预检）
     */
    const body = await readBodyCapped(req, 16 * 1024)
    if (!body.ok) {
      json(res, 413, { ok: false, error: 'too_large' })
      return
    }
    const rawText = body.buffer.toString('utf8')
    /**
     * 令牌来源（两者都不进访问日志）：
     *  ① 请求头 x-api-key
     *  ② 请求体首行 `x-ds-token: <令牌>` —— 给「用 text/plain 发简单请求、无预检」的场景
     */
    const headerToken = readGatewayToken(req)?.token ?? ''
    const firstLine = rawText.split('\n', 1)[0] ?? ''
    const bodyToken = /^x-ds-token:\s*\S+$/.test(firstLine.trim())
      ? firstLine.trim().replace(/^x-ds-token:\s*/, '')
      : ''
    const text = bodyToken ? rawText.slice(firstLine.length + 1) : rawText
    const token = headerToken || bodyToken
    if (!token || !userFromToken(token)) {
      json(res, 401, { ok: false, error: 'unauthorized' })
      return
    }
    const line = JSON.stringify({
      at: new Date().toISOString(),
      ip: (typeof req.headers['x-forwarded-for'] === 'string'
            ? req.headers['x-forwarded-for'].split(',')[0].trim()
            : '') || req.socket.remoteAddress || '',
      // 用户可能把官方 Key 贴进任何地方；落盘前一律脱敏
      entry: redactSecrets(text.length > 4000 ? `${text.slice(0, 4000)}…` : text),
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

  /**
   * 账户余额：用**用户自己的 Key** 去问上游，网关不保存任何 Key。
   * 这个接口只是"带鉴权的转发"，余额数据不落库。
   */
  if (req.method === 'GET' && url.pathname === '/usage/balance') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    const key = (readHeader(req, 'x-deepseek-key') ?? '').trim()
    if (key.length < 20) {
      json(res, 409, { ok: false, error: 'no_upstream_key', message: '还没有填写 DeepSeek API Key' })
      return
    }
    try {
      const upstreamBalance = await fetch(`${UPSTREAM}/user/balance`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      const payload = (await upstreamBalance.json()) as Record<string, unknown>
      if (!upstreamBalance.ok) {
        json(res, 502, { ok: false, error: 'balance_failed', message: '查询余额失败，请检查 Key 是否有效' })
        return
      }
      json(res, 200, { ok: true, ...payload })
    } catch (error) {
      console.warn('[gateway] 余额查询失败:', error instanceof Error ? error.message : error)
      json(res, 502, { ok: false, error: 'balance_failed', message: '查询余额失败，请稍后重试' })
    }
    return
  }

  /**
   * 查询本会话最近一轮回答有没有写进记忆。
   * App 在回答结束后调一次，用于显示「已存入记忆 / 未存入」。
   */
  if (req.method === 'GET' && url.pathname === '/memory/last-turn') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    const session = (url.searchParams.get('session') ?? '').trim()
    if (!session || !SESSION_ID_RE.test(session)) {
      json(res, 400, { ok: false, error: 'bad_session', message: '缺少有效的会话 id' })
      return
    }
    const record = lastRecordBySession.get(session)
    json(res, 200, {
      ok: true,
      /** null = 这一轮还没走到写记忆那一步（例如还在流式中） */
      recorded: record ? record.recorded : null,
      chunks: record?.chunks ?? 0,
      at: record?.at ?? 0,
      /** 本会话是否属于"会记忆"的范围（local 范围只记本会话，不跨会话召回） */
      memoryEnabled: Boolean(user),
    })
    return
  }

  /**
   * 附件（图片）云端同步。
   *
   * 为什么单独存文件而不是塞进会话 JSON：
   *  · 191 MB 的图片 base64 进 JSON 会膨胀 33%，而且每次同步整条会话都要重传
   *  · 图片是不可变内容（id 即内容哈希），天然可以按 id 增量同步
   *
   * 目录：users/<userId>/files/<fileId>（没有扩展名，类型由 App 侧记录）
   */
  if (url.pathname === '/sync/files' && req.method === 'GET') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    try {
      const dir = join(MEMORY_DATA_DIR, user.id, 'files')
      const names = await readdir(dir).catch(() => [] as string[])
      /** 引用计数：客户端据此知道哪些附件是孤儿（阶段 3） */
      const refs = authStore.fileRefCounts(user.id)
      const files: Array<{ id: string; size: number; updatedAt: number; refs: number }> = []
      for (const name of names) {
        if (name.endsWith('.tmp')) continue
        const info = await stat(join(dir, name)).catch(() => null)
        if (info && info.isFile()) {
          files.push({
            id: name,
            size: info.size,
            updatedAt: Math.round(info.mtimeMs),
            refs: refs.get(name) ?? 0,
          })
        }
      }
      json(res, 200, { ok: true, files })
    } catch (error) {
      console.warn('[gateway] 附件列表失败:', error instanceof Error ? error.message : error)
      json(res, 500, { ok: false, error: 'list_failed', message: '读取附件列表失败' })
    }
    return
  }

  if (url.pathname.startsWith('/sync/files/') && req.method === 'PUT') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    const id = decodeURIComponent(url.pathname.slice('/sync/files/'.length))
    // id 来自客户端，必须挡住路径穿越
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
      json(res, 400, { ok: false, error: 'bad_id', message: '附件 id 不合法' })
      return
    }
    const read = await readBodyCapped(req, 20 * 1024 * 1024)
    if (!read.ok) {
      json(res, 413, { ok: false, error: 'too_large', message: '单个附件最大 20MB' })
      return
    }
    try {
      const dir = join(MEMORY_DATA_DIR, user.id, 'files')
      await mkdir(dir, { recursive: true })
      // 先写临时文件再改名：中途断开不会留下半个文件被当成"已同步"
      const target = join(dir, id)
      await writeFile(`${target}.tmp`, read.buffer)
      await rename(`${target}.tmp`, target)
      json(res, 200, { ok: true, id, size: read.buffer.length })
    } catch (error) {
      console.warn('[gateway] 附件写入失败:', error instanceof Error ? error.message : error)
      json(res, 500, { ok: false, error: 'write_failed', message: '附件写入失败' })
    }
    return
  }

  if (url.pathname.startsWith('/sync/files/') && req.method === 'GET') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    const id = decodeURIComponent(url.pathname.slice('/sync/files/'.length))
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
      json(res, 400, { ok: false, error: 'bad_id', message: '附件 id 不合法' })
      return
    }
    try {
      const data = await readFile(join(MEMORY_DATA_DIR, user.id, 'files', id))
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(data.length) })
      res.end(data)
    } catch {
      json(res, 404, { ok: false, error: 'not_found', message: '云端没有这个附件' })
    }
    return
  }

  /**
   * 附件回收（阶段 3）：删掉「零引用且超过宽限期」的附件。
   *
   * 默认 dryRun —— 真删不可逆，默认必须是安全的那一侧，不能指望调用方记得传 dryRun。
   * 宽限期存在的理由：附件上传与"引用它的会话推上来"之间有真实的时间差，
   * 刚上传但会话还没同步完的图片，在引用表里就是零引用。
   */
  if (req.method === 'POST' && url.pathname === '/sync/files/gc') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    const read = await readBodyCapped(req, 64 * 1024)
    let body: Record<string, unknown> = {}
    if (read.ok && read.buffer.length > 0) {
      try {
        body = JSON.parse(read.buffer.toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
    }
    const dryRun = body.dryRun !== false
    const graceDays = Math.min(Math.max(Number(body.graceDays ?? 7) || 0, 0), 3650)
    const refs = authStore.fileRefCounts(user.id)
    const sessionCount = authStore.countSessions(user.id)
    /**
     * 安全护栏：引用表没建起来时，一个文件都不许删。
     *
     * 注意判断的是"重建跑过没有"，不是"引用表空不空" ——
     * 用户删掉最后一条引用附件的会话之后，引用表本来就该是空的，
     * 那恰恰是需要回收的时刻。只有重建没跑过（迁移失败）时，
     * 所有文件才会看起来都是零引用，真删一次就清空用户的全部图片。
     */
    if (!authStore.refsTrusted()) {
      json(res, 409, {
        ok: false,
        error: 'refs_not_ready',
        message: '附件引用表尚未建立，已拒绝回收；请先调用 /sync/files/refs/rebuild',
      })
      return
    }
    try {
      const dir = join(MEMORY_DATA_DIR, user.id, 'files')
      const names = await readdir(dir).catch(() => [] as string[])
      const now = Date.now()
      const cutoff = now - graceDays * 86_400_000
      const candidates: Array<{ id: string; size: number; ageDays: number }> = []
      for (const name of names) {
        // 只认合法附件 id：.tmp 之类的半截文件不是附件，不该走这条路径
        if (!/^[A-Za-z0-9_-]{8,80}$/.test(name)) continue
        if ((refs.get(name) ?? 0) > 0) continue
        const info = await stat(join(dir, name)).catch(() => null)
        if (!info?.isFile() || Math.round(info.mtimeMs) > cutoff) continue
        candidates.push({
          id: name,
          size: info.size,
          ageDays: Math.floor((now - info.mtimeMs) / 86_400_000),
        })
      }
      if (!dryRun) {
        for (const item of candidates) {
          await unlink(join(dir, item.id)).catch(() => undefined)
        }
      }
      json(res, 200, {
        ok: true,
        dryRun,
        graceDays,
        sessions: sessionCount,
        referencedFiles: refs.size,
        candidates,
        removed: dryRun ? 0 : candidates.length,
      })
    } catch (error) {
      console.warn('[gateway] 附件回收失败:', error instanceof Error ? error.message : error)
      json(res, 500, { ok: false, error: 'gc_failed', message: '附件回收失败' })
    }
    return
  }

  /** 全量重建该账号的附件引用（从会话 payload 重算），修好"计数偏小 → 误删"的前提 */
  if (req.method === 'POST' && url.pathname === '/sync/files/refs/rebuild') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    try {
      json(res, 200, { ok: true, ...authStore.rebuildRefs(user.id) })
    } catch (error) {
      console.warn('[gateway] 引用重建失败:', error instanceof Error ? error.message : error)
      json(res, 500, { ok: false, error: 'rebuild_failed', message: '引用重建失败' })
    }
    return
  }

  /**
   * 会话云端同步：把手机上的会话推到服务器。
   *
   * body: { sessions: [{ id, title, createdAt, updatedAt, payload }] }
   * 返回写入/跳过条数；服务端按 updatedAt 取较新者，旧数据不会覆盖新数据。
   *
   * 为什么整条会话存成 JSON：会话结构还会变（分支、附件、引用），
   * 拆成列每改一次都要迁移，而服务端并不需要理解内容。
   */
  if (req.method === 'POST' && url.pathname === '/sync/sessions') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    /**
     * 会话正文可能很大（一条长对话几百 KB），所以这里用 8MB 上限，
     * 并自己解析 —— 不能复用 auth 路由里那个 16KB 的 readJsonBody。
     */
    const read = await readBodyCapped(req, 8 * 1024 * 1024)
    if (!read.ok) {
      json(res, 413, { ok: false, error: 'too_large', message: '单次同步体积过大' })
      return
    }
    let body: Record<string, unknown>
    try {
      body = JSON.parse(read.buffer.toString('utf8')) as Record<string, unknown>
    } catch {
      json(res, 400, { ok: false, error: 'bad_json', message: '请求体不是合法 JSON' })
      return
    }
    const list = Array.isArray(body.sessions)
      ? ((body as { sessions: unknown[] }).sessions as Array<Record<string, unknown>>)
      : []
    if (list.length === 0) {
      json(res, 200, { ok: true, written: 0, skipped: 0 })
      return
    }
    // 单次上限：防止有人一次推 10 万条把库撑爆（正常批量是 50 条/次）
    if (list.length > 500) {
      json(res, 413, { ok: false, error: 'too_many', message: '一次最多同步 500 条会话' })
      return
    }
    try {
      const result = authStore.upsertSessions(
        user.id,
        list
          .filter((item) => typeof item.id === 'string' && typeof item.payload === 'string')
          .map((item) => ({
            id: String(item.id),
            title: typeof item.title === 'string' ? item.title : '',
            createdAt: Number(item.createdAt ?? Date.now()),
            updatedAt: Number(item.updatedAt ?? Date.now()),
            pinned: item.pinned === true,
            /**
             * 客户端本地算好的附件引用。服务端还会自己从 payload 抽一遍作为兜底，
             * 但优先用客户端这份：它已经有摘要里的 fileIds，不必再解析几百 KB 的 JSON。
             */
            fileIds: Array.isArray(item.fileIds)
              ? (item.fileIds as unknown[])
                  .filter((id): id is string => typeof id === 'string')
                  .slice(0, 200)
              : undefined,
            payload: String(item.payload),
          }))
      )
      json(res, 200, { ok: true, ...result })
    } catch (error) {
      console.warn('[gateway] 会话同步失败:', error instanceof Error ? error.message : error)
      json(res, 500, { ok: false, error: 'sync_failed', message: '同步失败，请稍后重试' })
    }
    return
  }

  /**
   * 会话清单（不含正文）：App 列表**以它为准**（阶段 2-1），本地只是缓存。
   *
   * 分页用复合游标（时间 + id）：同一毫秒可能有多条会话，
   * 只用时间做游标跨页时会漏掉并列的那几条，而客户端翻完最后一页就当拿到全量。
   */
  if (req.method === 'GET' && url.pathname === '/sync/sessions') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    const since = Number(url.searchParams.get('since') ?? 0) || 0
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 0) || 500, 1), 500)
    const before = Number(url.searchParams.get('before') ?? 0) || 0
    const beforeId = url.searchParams.get('beforeId') ?? ''
    const deletedBefore = Number(url.searchParams.get('deletedBefore') ?? 0) || 0
    const deletedBeforeId = url.searchParams.get('deletedBeforeId') ?? ''
    // 多取一条用来判断"还有没有下一页"，比再发一次 count 查询便宜
    const pagePlusOne = authStore.listSessions(user.id, {
      since,
      before,
      beforeId,
      limit: limit + 1,
    })
    const hasMore = pagePlusOne.length > limit
    const sessions = pagePlusOne.slice(0, limit)
    const deletedPlusOne = authStore.listTombstones(user.id, {
      since,
      before: deletedBefore,
      beforeId: deletedBeforeId,
      limit: limit + 1,
    })
    const deletedHasMore = deletedPlusOne.length > limit
    const deleted = deletedPlusOne.slice(0, limit)
    const last = sessions.at(-1)
    const lastDeleted = deleted.at(-1)
    json(res, 200, {
      ok: true,
      sessions,
      /** 墓碑：这些会话已被删除，客户端要删掉本地副本 */
      deleted,
      hasMore,
      nextBefore: hasMore && last ? last.updatedAt : 0,
      nextBeforeId: hasMore && last ? last.id : '',
      deletedHasMore,
      nextDeletedBefore: deletedHasMore && lastDeleted ? lastDeleted.deletedAt : 0,
      nextDeletedBeforeId: deletedHasMore && lastDeleted ? lastDeleted.id : '',
      /** 客户端用它做增量同步的 since（避免用本机时钟，那台手机可能不准） */
      serverTime: Date.now(),
    })
    return
  }

  /** 删除会话（软删除 + 墓碑，保证能在其它设备上传播） */
  if (req.method === 'DELETE' && url.pathname === '/sync/session') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    const id = (url.searchParams.get('id') ?? '').trim()
    if (!id) {
      json(res, 400, { ok: false, error: 'bad_session', message: '缺少会话 id' })
      return
    }
    try {
      authStore.deleteSession(user.id, id)
      json(res, 200, { ok: true })
    } catch (error) {
      console.warn('[gateway] 删除会话失败:', error instanceof Error ? error.message : error)
      json(res, 500, { ok: false, error: 'delete_failed', message: '删除失败，请稍后重试' })
    }
    return
  }

  /** 单条会话全文 */
  if (req.method === 'GET' && url.pathname === '/sync/session') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    const id = (url.searchParams.get('id') ?? '').trim()
    if (!id) {
      json(res, 400, { ok: false, error: 'bad_session', message: '缺少会话 id' })
      return
    }
    const found = authStore.readSession(user.id, id)
    if (!found) {
      json(res, 404, { ok: false, error: 'not_found', message: '云端没有这条会话' })
      return
    }
    json(res, 200, { ok: true, updatedAt: found.updatedAt, payload: found.payload })
    return
  }

  /**
   * 该账号（= 它绑定的那个 Key）下**所有会话**的用量合计。
   *
   * 数据来自服务端账本（usage_events），所以重装、换设备都不会丢，
   * 覆盖范围是"这个 Key 经本网关发出的全部请求"。
   * 与官方后台的差别：官方按 Key 汇总、含任何客户端的调用；这里只含经本网关的。
   */
  if (req.method === 'GET' && url.pathname === '/usage/total') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    const range = (url.searchParams.get('range') ?? 'all').toLowerCase()
    const now = Date.now()
    const since =
      range === 'today'
        ? new Date(new Date(now).getTime() + 8 * 3_600_000).setUTCHours(0, 0, 0, 0) - 8 * 3_600_000
        : range === '7d'
          ? now - 7 * 86_400_000
          : range === '30d'
            ? now - 30 * 86_400_000
            : 0
    const totals = authStore.usageTotals(user.id, since)
    json(res, 200, {
      ok: true,
      range,
      since,
      currency: 'CNY',
      totals,
      note: '统计范围：本 Key 经本网关发出的全部请求；官方后台含任何客户端的调用',
    })
    return
  }

  /**
   * 按来源 IP 推断大致位置（离线库 ip2region，不外发你的 IP）。
   *
   * 为什么要服务端做：客户端拿不到自己的公网 IP（拿到的是内网地址或运营商中转地址），
   * 而且让第三方在线接口去查，等于把用户 IP 交给别人 —— 这里用本地离线库。
   *
   * 只精确到**省/市**，返回给客户端后由客户端决定是否塞进给模型的环境信息。
   */
  if (req.method === 'GET' && url.pathname === '/geo') {
    const ip = clientKey(req)
    try {
      /**
       * 必须用 "ip2region/node" 子路径：它会自动加载包内自带的 xdb 数据。
       * 走包根的 IP2Region 需要自己传 source，反而更啰嗦。
       *
       * 用变量拼接 specifier 是为了让 TS 不去解析这个子路径的
       * 类型声明（该包没提供），否则类型检查会报"找不到模块"。
       */
      const specifier = ['ip2region', 'node'].join('/')
      const mod = (await import(specifier)) as unknown as {
        IP2Region: new () => {
          lookup(target: string): unknown
          close?(): void
        }
      }
      const searcher = new mod.IP2Region()
      const hit = searcher.lookup(ip) as {
        country?: { name?: string; code?: string }
        subdivisions?: Array<{ name?: string }>
        city?: { name?: string }
        isp?: string
      } | null
      searcher.close?.()
      if (!hit?.country) {
        json(res, 200, { ok: true, found: false, ip })
        return
      }
      json(res, 200, {
        ok: true,
        found: true,
        // 不回传 IP 本身：客户端只需要位置，没必要知道/保存自己的公网地址
        country: hit.country.code ?? '',
        countryName: hit.country.name ?? '',
        region: hit.subdivisions?.[0]?.name ?? '',
        city: hit.city?.name ?? '',
        isp: hit.isp ?? '',
      })
    } catch (error) {
      console.warn('[gateway] 位置推断失败:', error instanceof Error ? error.message : error)
      json(res, 200, { ok: true, found: false, ip })
    }
    return
  }

  /**
   * 更新清单（公开接口，不需要登录）。
   *
   * 为什么公开：App 启动时可能还没登录就要检查更新；
   * 清单里只有版本号与文件哈希，没有用户数据。
   *
   * 返回里带 patches：{ "旧版本": {file,size,sha256} }，
   * 客户端据此决定"下补丁"还是"下全量"。
   */
  if (req.method === 'GET' && url.pathname === '/update/manifest') {
    const channel = (url.searchParams.get('channel') ?? 'release').toLowerCase()
    try {
      const raw = await readFile(join(UPDATES_DIR, 'manifest.json'), 'utf8')
      const manifest = JSON.parse(raw) as { channels?: Record<string, unknown> }
      const entry = manifest.channels?.[channel]
      if (!entry) {
        json(res, 404, { ok: false, error: 'no_channel', message: '没有这个更新通道' })
        return
      }
      json(res, 200, { ok: true, channel, ...(entry as Record<string, unknown>) })
    } catch {
      json(res, 404, { ok: false, error: 'no_manifest', message: '尚未发布任何更新' })
    }
    return
  }

  /**
   * 下载更新文件（APK 或补丁），支持 Range 断点续传。
   *
   * Range 不只是"省流量"：移动网络下大文件下载中断很常见，
   * 不能续传就等于每次从头再来。
   */
  if (req.method === 'GET' && url.pathname.startsWith('/update/file/')) {
    const name = decodeURIComponent(url.pathname.slice('/update/file/'.length))
    // 只允许清单目录下的白名单文件名，挡住路径穿越
    if (!/^[A-Za-z0-9._-]{4,120}$/u.test(name)) {
      json(res, 400, { ok: false, error: 'bad_name', message: '文件名不合法' })
      return
    }
    const filePath = join(UPDATES_DIR, name)
    let info
    try {
      info = await stat(filePath)
    } catch {
      json(res, 404, { ok: false, error: 'not_found', message: '文件不存在' })
      return
    }
    const range = req.headers.range
    const contentType = name.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/octet-stream'
    if (typeof range === 'string' && /^bytes=[0-9]*-[0-9]*$/u.test(range)) {
      const [startText, endText] = range.replace('bytes=', '').split('-')
      const start = Number(startText || 0)
      const end = endText ? Math.min(Number(endText), info.size - 1) : info.size - 1
      if (start > end || start >= info.size) {
        res.writeHead(416, { 'content-range': `bytes */${info.size}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'content-type': contentType,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${info.size}`,
        'accept-ranges': 'bytes',
      })
      createReadStream(filePath, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': String(info.size),
      'accept-ranges': 'bytes',
    })
    createReadStream(filePath).pipe(res)
    return
  }

  /** 登录审计（仅管理员）：排查异地登录/撞库 */
  if (req.method === 'GET' && url.pathname === '/auth/audit') {
    const user = userFromRequest(req)
    if (!user) {
      json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
      return
    }
    if (user.role !== 'admin') {
      json(res, 403, { ok: false, error: 'forbidden', message: '仅管理员可查看审计' })
      return
    }
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500)
    const email = url.searchParams.get('email') ?? undefined
    json(res, 200, { ok: true, entries: authStore.listAudit(limit, email) })
    return
  }

  /** 价格表 + 当前是否峰时（前端据此算费用，价格不写死在 App 里） */
  if (req.method === 'GET' && url.pathname === '/usage/pricing') {
    const peak = readPriceTable(process.env)
    const now = new Date()
    json(res, 200, {
      ok: true,
      currency: peak.currency,
      unit: '元 / 1M tokens',
      peak: isPeakNow(now),
      peakTable: peak,
      offPeakTable: offPeakTable(peak),
      peakWindows: '北京时间 周一至周五 9:00–12:00、14:00–18:00',
      note: '估算值，以平台实际扣费为准',
    })
    return
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, {
      ok: true,
      version: VERSION,
      node: process.version,
      upstream: UPSTREAM,
      defaultModel: DEFAULT_MODEL,
      /** 实例 Key 仅作可选兜底；用户自带 Key 时永不使用 */
      instanceKey: ALLOW_INSTANCE_KEY ? (API_KEY.length > 0 ? 'allowed' : 'missing') : 'disabled',
      hasGatewayToken: GATEWAY_TOKEN.length > 0,
      contextBudgetTokens: CONTEXT_BUDGET_TOKENS,
      allowedOrigins: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : 'any (echo)',
      auth: {
        users: authStore.countUsers(),
        signupAllowed: ALLOW_SIGNUP,
        legacyTokenWorks: GATEWAY_TOKEN.length > 0,
        admin: adminUser?.email ?? null,
      },
      memory: registry
        ? {
            enabled: true,
            /** 每用户一个库；这里报的是管理员那份作为概览 */
            dataDir: MEMORY_DATA_DIR,
            dbPath: adminUser ? registry.pathFor(adminUser.id) : null,
            localReadsGlobal: MEMORY_LOCAL_READS_GLOBAL,
            maxHits: MEMORY_MAX_HITS,
            /** 向量检索是否已启用（配了 embedding 接口才为 true） */
            vectors: adminUser ? (memoryFor(adminUser)?.vectorEnabled ?? false) : false,
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
      /**
       * 上游用量与缓存命中。
       * 用来验证「多带原文靠缓存摊薄成本」是否真的成立——
       * 实测稳定前缀 926 token 时，重复请求命中 768、只有 158 全价。
       */
      usage: {
        ...usageStats,
        cacheHitRate:
          usageStats.cacheHit + usageStats.cacheMiss > 0
            ? Number(
                ((usageStats.cacheHit / (usageStats.cacheHit + usageStats.cacheMiss)) * 100).toFixed(1)
              )
            : 0,
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
        badCode: [400, '验证码不正确或已过期'],
        codeExpired: [400, '验证码已过期，请重新获取'],
        codeTooManyAttempts: [429, '这条验证码试错次数过多，请重新获取'],
        tooManyCodes: [429, '发送太频繁，请稍后再试'],
        mail_failed: [502, '验证码邮件发送失败，请稍后重试'],
        badUsername: [400, '用户名需 2–20 个字符，只能包含字母/数字/下划线/连字符'],
        usernameTaken: [409, '这个用户名已被占用'],
        usernameReserved: [400, '这个用户名被系统保留，请换一个'],
        usernameTooSoon: [429, '改名太频繁：24 小时内最多 3 次'],
        // 真实规则：10–200 位，且不能包含邮箱名、常见弱密码、连续重复或键盘序列
  weakPassword: [400, '密码需 10 位以上，且不能包含邮箱名、常见密码或连续字符'],
        emailTaken: [409, '该邮箱已注册'],
        badCredentials: [401, '邮箱或密码不正确'],
        disabled: [403, '账号已被停用'],
        invalidToken: [401, '登录状态已失效，请重新登录'],
      }
      const [status, message] = map[error.key] ?? [400, '请求无法处理']
      fail(status, error.key, message)
    }
    /**
     * 对外用户信息：**不含内部 id**。
     * 内部 id 是记忆库目录名与外键，暴露出去只会给探测提供线索；
     * 客户端需要"用户标识"时用 publicId（随机、无序）。
     */
    const payloadUser = (user: User) => ({
      publicId: user.publicId,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    })

    /** 发验证码。用途决定邮件文案，也决定"邮箱是否已注册"要不要报错 */
    if (req.method === 'POST' && url.pathname === '/auth/send-code') {
      const body = await readJsonBody()
      if (!body) {
        return
      }
      const email = str(body.email).trim()
      const purpose = str(body.purpose) === 'reset' ? 'reset' : 'register'
      if (purpose === 'register' && authStore.findByEmail(email)) {
        fail(409, 'emailTaken', '该邮箱已注册，直接登录或找回密码')
        return
      }
      // ⚠️ 重置密码时无论邮箱是否存在都回 ok，避免被用来探测哪些邮箱注册过
      const exists = Boolean(authStore.findByEmail(email))
      if (purpose === 'reset' && !exists) {
        json(res, 200, { ok: true, cooldownSeconds: Math.ceil(CODE_COOLDOWN_MS / 1000) })
        return
      }
      if (!allowCodeSend(email.toLowerCase())) {
        fail(429, 'tooManyCodes', '这个邮箱发送太频繁，请稍后再试')
        return
      }
      let code = ''
      try {
        code = authStore.issueEmailCode(email, purpose, {
          cooldownMs: CODE_COOLDOWN_MS,
          ttlMs: CODE_TTL_MS,
        })
      } catch (error) {
        authError(error)
        return
      }
      if (!SMTP) {
        console.log(`[gateway] 未配置邮件通道，验证码（${purpose}）: ${email} -> ${code}`)
        json(res, 200, {
          ok: true,
          cooldownSeconds: Math.ceil(CODE_COOLDOWN_MS / 1000),
          delivered: false,
        })
        return
      }
      try {
        await sendMail(SMTP, {
          to: email,
          subject:
            purpose === 'register' ? '【自由的deepseek】注册验证码' : '【自由的deepseek】重置密码验证码',
          text: [
            purpose === 'register' ? '你正在注册 自由的deepseek。' : '你正在重置 自由的deepseek 的密码。',
            '',
            `验证码：${code}`,
            '',
            `有效期为 ${Math.round(CODE_TTL_MS / 60_000)} 分钟。`,
            '如果这不是你本人的操作，请忽略这封邮件，你的账号不会发生任何变化。',
          ].join('\n'),
        })
      } catch (error) {
        console.warn('[gateway] 验证码邮件发送失败:', error instanceof Error ? error.message : error)
        fail(502, 'mail_failed', '验证码邮件发送失败，请稍后重试')
        return
      }
      console.log(`[gateway] 已发送 ${purpose} 验证码到 ${email}`)
      json(res, 200, { ok: true, cooldownSeconds: Math.ceil(CODE_COOLDOWN_MS / 1000), delivered: true })
      return
    }

    /** 重置密码：申请 → 校验码 → 改密并吊销所有会话 */
    if (req.method === 'POST' && url.pathname === '/auth/reset') {
      const body = await readJsonBody()
      if (!body) {
        return
      }
      const email = str(body.email).trim()
      const code = str(body.code).trim()
      const newPassword = str(body.newPassword)
      const user = authStore.findByEmail(email)
      if (!user) {
        // 与"码不对"同一个错误，不泄露邮箱是否存在
        fail(400, 'badCode', '验证码不正确或已过期')
        return
      }
      try {
        authStore.verifyEmailCode(email, 'reset', code)
        authStore.setPassword(user.id, newPassword)
        authStore.consumeEmailCode(email, 'reset')
        authStore.clearLoginFailures(email)
      } catch (error) {
        authError(error)
        return
      }
      // 改密码会吊销全部会话；给当前设备发一个新的，避免用户"改完就被踢"
      const session = authStore.createSession(user.id, device())
      console.log(`[gateway] ${user.email} 通过邮箱验证码重置了密码`)
      json(res, 200, {
        ok: true,
        token: session.token,
        expiresAt: session.expiresAt,
        user: payloadUser(user),
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/auth/register') {
      if (!ALLOW_SIGNUP) {
        fail(403, 'signup_disabled', '本实例未开放注册，请联系管理员')
        return
      }
      const body = await readJsonBody()
      if (!body) {
        return
      }
      const email = str(body.email).trim()
      const code = str(body.code).trim()
      if (!code) {
        fail(400, 'badCode', '请输入邮箱收到的验证码')
        return
      }
      try {
        // 先验码再建号：验证码错误时不要留下半个账号
        authStore.verifyEmailCode(email, 'register', code)
        /**
 * 首位注册者成为管理员。
 *
 * "干净环境正式启用"需要这个语义：没有预置账号、也没有自举，
 * 谁先注册谁是管理员；之后注册的一律是普通用户。
 */
const firstUserAdmin = authStore.countUsers() === 0
const user = authStore.createUser(
  email,
  str(body.password),
  firstUserAdmin ? 'admin' : 'user',
  str(body.username) || undefined
)
if (firstUserAdmin) {
  console.log(`[gateway] 首位注册者 ${user.email} 已设为管理员`)
}
        authStore.consumeEmailCode(email, 'register')
        const session = authStore.createSession(user.id, device())
        authStore.recordAudit({ email, userId: user.id, ip: clientKey(req), action: 'register', ok: true })
        console.log(`[gateway] 新注册（邮箱已验证）：${user.email}`)
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
      const email = str(body.email)
      // 退避期内即使密码正确也拒绝 —— 否则撞库方仍能靠"是否返回 401"区分密码对错
      const retryAfter = authStore.loginRetryAfter(email)
      if (retryAfter > 0) {
        res.setHeader('Retry-After', String(retryAfter))
        fail(429, 'loginBackoff', `失败次数过多，请 ${retryAfter} 秒后再试`)
        return
      }
      try {
        const user = authStore.verifyPassword(email, str(body.password))
        authStore.recordAudit({ email, userId: user.id, ip: clientKey(req), action: 'login', ok: true })
        authStore.clearLoginFailures(email)
        const session = authStore.createSession(user.id, device())
        json(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt, user: payloadUser(user) })
      } catch (error) {
        if (error instanceof AuthFailure && error.key === 'badCredentials') {
          authStore.recordAudit({
            email,
            ip: clientKey(req),
            action: 'login',
            ok: false,
            detail: 'bad credentials',
          })
          const guard = authStore.noteLoginFailure(email)
          if (guard.retryAfterSeconds > 0) {
            res.setHeader('Retry-After', String(guard.retryAfterSeconds))
            fail(429, 'loginBackoff', `失败次数过多，请 ${guard.retryAfterSeconds} 秒后再试`)
            return
          }
        }
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
        json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
        return
      }
      const store = memoryFor(user)
      const bound = authStore.getUpstreamKey(user.id)
      json(res, 200, {
        ok: true,
        user: payloadUser(user),
        /** 只回掩码与指纹；原始 Key 只在设备上 */
        upstreamKey: bound
          ? { bound: true, masked: bound.masked, fingerprint: bound.fingerprint, validatedAt: bound.validatedAt }
          : { bound: false },
        /** 旧网关令牌登录时是 true：提示前端可以引导去设置密码 */
        legacyToken: ((inbound: string) => Boolean(inbound) && sameToken(inbound, GATEWAY_TOKEN))(
          readGatewayToken(req)?.token ?? ''
        ),
        memory: store ? store.stats() : null,
    /** 上游用量与缓存命中（用来验证"多带原文靠缓存摊薄成本"是否成立） */
    usage: {
      ...usageStats,
      cacheHitRate:
        usageStats.cacheHit + usageStats.cacheMiss > 0
          ? Number(
              ((usageStats.cacheHit / (usageStats.cacheHit + usageStats.cacheMiss)) * 100).toFixed(1)
            )
          : 0,
    },
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/auth/password') {
      const user = userFromRequest(req)
      if (!user) {
        json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
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

    /**
     * 绑定官方 Key。
     *
     * 处理完这个请求之后，**服务端只剩一个不可逆指纹**：
     * 原始 Key 立刻离开内存，不写库、不进日志、不回响应。
     */
    if (req.method === 'POST' && url.pathname === '/auth/upstream-key') {
      const user = userFromRequest(req)
      if (!user) {
        json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
        return
      }
      const body = await readJsonBody()
      if (!body) {
        return
      }
      const key = str(body.key).trim()
      if (key.length < 20 || !/^sk-/.test(key)) {
        fail(400, 'invalid_key', '看起来不是有效的 DeepSeek Key（应以 sk- 开头）')
        return
      }
      // 用它真调一次上游：能列出模型才算有效
      let valid = false
      try {
        const probe = await fetch(`${UPSTREAM}/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(12_000),
        })
        valid = probe.ok
        await probe.text()
      } catch (error) {
        console.warn('[gateway] 校验官方 Key 时网络失败:', error instanceof Error ? error.message : error)
        fail(502, 'upstream_unreachable', '暂时联系不上 DeepSeek，请稍后重试')
        return
      }
      if (!valid) {
        fail(400, 'invalid_key', 'DeepSeek 拒绝了这把 Key（可能已失效或输错）')
        return
      }
      const info = authStore.setUpstreamKey(user.id, key)
      const shared = authStore.fingerprintOwners(info.fingerprint)
      if (shared > 1) {
        console.warn(`[gateway] 指纹 ${info.fingerprint} 被 ${shared} 个账号使用，可能存在共用/泄露`)
      }
      console.log(`[gateway] ${user.email} 绑定了官方 Key（指纹 ${info.fingerprint}）`)
      json(res, 200, {
        ok: true,
        upstreamKey: { bound: true, masked: info.masked, fingerprint: info.fingerprint, validatedAt: info.validatedAt },
        /** 同一把 Key 被多个账号用着，前端可提示 */
        sharedAccounts: shared,
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/auth/upstream-key') {
      const user = userFromRequest(req)
      if (!user) {
        json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
        return
      }
      const info = authStore.getUpstreamKey(user.id)
      json(res, 200, {
        ok: true,
        upstreamKey: info
          ? { bound: true, masked: info.masked, fingerprint: info.fingerprint, validatedAt: info.validatedAt }
          : { bound: false },
      })
      return
    }

    if (req.method === 'DELETE' && url.pathname === '/auth/upstream-key') {
      const user = userFromRequest(req)
      if (!user) {
        json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
        return
      }
      authStore.clearUpstreamKey(user.id)
      console.log(`[gateway] ${user.email} 删除了官方 Key 指纹`)
      json(res, 200, { ok: true })
      return
    }

    /** 修改显示名（限频 3 次/24 小时） */
    if (req.method === 'PATCH' && url.pathname === '/auth/profile') {
      const user = userFromRequest(req)
      if (!user) {
        json(res, 401, { ok: false, error: 'unauthorized', message: '登录状态已失效，请重新登录' })
        return
      }
      const body = await readJsonBody()
      if (!body) {
        return
      }
      try {
        const updated = authStore.setUsername(user.id, str(body.username))
        json(res, 200, { ok: true, user: payloadUser(updated) })
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
    const message = error instanceof Error ? error.message : String(error)
    /**
     * 客户端中途断开（手机切网、被系统杀进程、用户退出）是常态，
     * 但它会让**整批请求静默作废** —— 所以必须带上方法与路径记下来。
     * 没有路径的话日志里只有一句 "aborted"，根本查不出是哪一步丢的
     * （真实事故：导入 1000 条会话后云端 0 条，日志里全是没有上下文的 aborted）。
     */
    if (message === 'aborted' || message === 'ECONNRESET') {
      console.warn(`[gateway] 请求中断 ${req.method} ${req.url}: ${message}`)
    } else {
      console.error(`[gateway] 未捕获异常 ${req.method} ${req.url}:`, error)
    }
  })
})

if (!GATEWAY_TOKEN) {
  console.error('[gateway] 拒绝启动：必须配置 GATEWAY_TOKEN（管理员令牌）')
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
