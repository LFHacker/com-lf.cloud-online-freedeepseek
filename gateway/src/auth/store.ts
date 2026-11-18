/**
 * 账号与会话的存储层。
 *
 * 设计要点：
 *
 * 1. **密码用 scrypt，不用 argon2/bcrypt**
 *    那台 2C2G 的机器装原生模块是自找麻烦（node-gyp 编译、架构不匹配、升级 Node 就废）。
 *    `node:crypto` 的 scrypt 是内置的，内存可控，参数见下方 SCRYPT_*。
 *
 * 2. **令牌只存哈希**
 *    数据库里落的是 sha256(token)，即使库被拿走也还原不出可用令牌。
 *
 * 3. **邮箱不存在与密码错误返回同一个错误**
 *    否则接口就成了「批量探测某邮箱是否注册过」的工具。
 *
 * 4. 与记忆库分开：这是 auth.db，记忆是每用户一个 memory.db。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type UserRole = 'admin' | 'user'
export type UserStatus = 'active' | 'disabled'

export type User = {
  id: string
  email: string
  role: UserRole
  status: UserStatus
  createdAt: number
}

export type AuthError =
  | 'invalidEmail'
  | 'weakPassword'
  | 'emailTaken'
  | 'badCredentials'
  | 'disabled'
  | 'invalidToken'
  | 'badCode'
  | 'codeExpired'
  | 'codeTooManyAttempts'
  | 'tooManyCodes'

/** 认证失败：key 给前端做文案，不包含任何可用于探测的信息 */
export class AuthFailure extends Error {
  readonly key: AuthError
  constructor(key: AuthError) {
    super(key)
    this.name = 'AuthFailure'
    this.key = key
  }
}

// scrypt 参数：N=16384 在 2C2G 上单次约 40~60ms，足够慢、又不至于拖垮登录接口。
// 提高 N 会让老哈希失效，所以参数要和哈希一起存进库里。
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64
const SALT_BYTES = 16

/** 会话有效期：30 天；每次使用滑动续期 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** last_seen_at 最多每小时写一次，避免每个请求都写库 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000

const SCHEMA = `
create table if not exists users (
  id            text primary key,
  email         text not null unique,        -- 统一小写存储
  password_hash text not null,               -- base64
  password_salt text not null,               -- base64
  scrypt_n      integer not null,
  scrypt_r      integer not null,
  scrypt_p      integer not null,
  role          text not null default 'user' check (role in ('admin','user')),
  status        text not null default 'active' check (status in ('active','disabled')),
  created_at    integer not null,
  updated_at    integer not null
);

create table if not exists auth_sessions (
  token_hash   text primary key,             -- sha256(token) 的 hex
  user_id      text not null,
  device       text,                          -- 仅用于排查，不做校验
  created_at   integer not null,
  last_seen_at integer not null,
  expires_at   integer not null
);
create index if not exists idx_auth_sessions_user on auth_sessions(user_id);
create index if not exists idx_auth_sessions_exp on auth_sessions(expires_at);

/**
 * 邮箱验证码。只存 sha256(code)；主键 (email,purpose) 保证重发即覆盖，旧码立即失效。
 */
create table if not exists email_codes (
  email       text not null,
  purpose     text not null check (purpose in ('register','reset')),
  code_hash   text not null,
  expires_at  integer not null,
  attempts    integer not null default 0,
  created_at  integer not null,
  primary key (email, purpose)
);

/** 登录失败退避：按账号记，不按 IP（分布式撞库换 IP 就绕过了） */
create table if not exists login_guards (
  email         text primary key,
  failures      integer not null default 0,
  locked_until  integer not null default 0,
  last_failure  integer not null
);

/**
 * 用户绑定的官方 Key —— **只存指纹，不存 Key 本身**。
 *
 * 原始 Key 永远只存在于用户设备上：每次请求由客户端放在 x-deepseek-key 头里带来，
 * 网关转发完就随请求对象一起回收，不写库、不写日志。
 * 这里留一行指纹（sha256 前 16 位）只为了回答两个问题：
 *   · 这个账号配过 Key 没有
 *   · 有没有多个账号共用同一个 Key（泄漏/盗用的信号）
 * 指纹不可逆，也无法用于任何请求。
 */
create table if not exists user_upstream_keys (
  user_id       text primary key,
  fingerprint   text not null,
  masked        text not null,        -- 形如 sk-…a1b2，仅用于界面回显
  validated_at  integer not null,
  created_at    integer not null
);
`

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')

/** 新建用户 id：`u_` + 16 位十六进制，可安全用作目录名 */
const newUserId = (): string => `u_${randomBytes(8).toString('hex')}`

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

/** 邮箱校验：够用即可（不追求 RFC 5322 全集，那种正则通常写错） */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

const MIN_PASSWORD = 10
const MAX_PASSWORD = 200
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'password123',
  'qwertyuiop', 'qwerty123', '11111111', '00000000', 'abc123456', 'iloveyou',
  'admin123', 'letmein1', 'welcome1', 'passw0rd', 'zxcvbnm123', 'asdfghjkl',
])

/** 只查长度不够：12345678 能过等于没规则。额外拒绝弱口令/单字符重复/序列/与邮箱雷同 */
const isWeakPassword = (password: string, email?: string): boolean => {
  const lower = password.toLowerCase()
  if (COMMON_PASSWORDS.has(lower)) {
    return true
  }
  if (/^(.)\1+$/.test(password)) {
    return true
  }
  if (/^(0123456789|abcdefghij|qwertyuiop|asdfghjkl)/i.test(password)) {
    return true
  }
  if (email) {
    const local = email.split('@')[0]?.toLowerCase() ?? ''
    if (local.length >= 3 && lower.includes(local)) {
      return true
    }
  }
  return false
}

const toUser = (row: Record<string, unknown>): User => ({
  id: String(row.id),
  email: String(row.email),
  role: row.role === 'admin' ? 'admin' : 'user',
  status: row.status === 'disabled' ? 'disabled' : 'active',
  createdAt: Number(row.created_at),
})

const hashPassword = (password: string, salt: Buffer) =>
  scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  })

export type UpstreamKeyInfo = {
  fingerprint: string
  masked: string
  validatedAt: number
}

/** 指纹：sha256 前 16 位十六进制。不可逆、不可用于请求 */
export const keyFingerprint = (key: string): string => sha256Hex(key).slice(0, 16)

/** 掩码：只露前 3 位和后 4 位，够用户确认是不是自己那把 */
export const maskKey = (key: string): string => {
  const trimmed = key.trim()
  return trimmed.length <= 8 ? 'sk-…' : `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`
}

export class AuthStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('pragma journal_mode = WAL;')
    this.db.exec('pragma synchronous = NORMAL;')
    this.db.exec('pragma busy_timeout = 3000;')
    this.db.exec(SCHEMA)
    // 过期会话不必等到被访问才清
    this.db.prepare('delete from auth_sessions where expires_at < ?').run(Date.now())
  }

  close(): void {
    this.db.close()
  }

  countUsers(): number {
    return Number((this.db.prepare('select count(*) n from users').get() as { n: number }).n)
  }

  listUsers(): User[] {
    return (this.db.prepare('select * from users order by created_at asc').all() as Record<string, unknown>[]).map(toUser)
  }

  findByEmail(email: string): User | null {
    const row = this.db
      .prepare('select * from users where email = ?')
      .get(normalizeEmail(email)) as Record<string, unknown> | undefined
    return row ? toUser(row) : null
  }

  findById(id: string): User | null {
    const row = this.db.prepare('select * from users where id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? toUser(row) : null
  }

  createUser(email: string, password: string, role: UserRole = 'user'): User {
    const normalized = normalizeEmail(email)
    if (!EMAIL_RE.test(normalized)) {
      throw new AuthFailure('invalidEmail')
    }
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD || isWeakPassword(password, normalized)) {
      throw new AuthFailure('weakPassword')
    }
    if (this.findByEmail(normalized)) {
      throw new AuthFailure('emailTaken')
    }
    const salt = randomBytes(SALT_BYTES)
    const hash = hashPassword(password, salt)
    const id = newUserId()
    const now = Date.now()
    this.db
      .prepare(
        `insert into users (id, email, password_hash, password_salt, scrypt_n, scrypt_r, scrypt_p, role, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(
        id,
        normalized,
        hash.toString('base64'),
        salt.toString('base64'),
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        role,
        now,
        now
      )
    return { id, email: normalized, role, status: 'active', createdAt: now }
  }

  /** 改密码：同时踢掉该用户所有会话（改密码意味着旧令牌应当失效） */
  setPassword(userId: string, password: string): void {
    const owner = this.findById(userId)
    if (
      password.length < MIN_PASSWORD ||
      password.length > MAX_PASSWORD ||
      isWeakPassword(password, owner?.email)
    ) {
      throw new AuthFailure('weakPassword')
    }
    const salt = randomBytes(SALT_BYTES)
    const hash = hashPassword(password, salt)
    this.db
      .prepare(
        `update users set password_hash = ?, password_salt = ?, scrypt_n = ?, scrypt_r = ?, scrypt_p = ?, updated_at = ? where id = ?`
      )
      .run(
        hash.toString('base64'),
        salt.toString('base64'),
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        Date.now(),
        userId
      )
    this.db.prepare('delete from auth_sessions where user_id = ?').run(userId)
  }

  /** 校验邮箱 + 密码；失败一律抛 badCredentials（不区分邮箱不存在/密码错） */
  verifyPassword(email: string, password: string): User {
    const row = this.db
      .prepare('select * from users where email = ?')
      .get(normalizeEmail(email)) as Record<string, unknown> | undefined
    if (!row) {
      // 即使邮箱不存在也跑一次 scrypt，避免通过响应时间判断邮箱是否注册
      hashPassword(password, randomBytes(SALT_BYTES))
      throw new AuthFailure('badCredentials')
    }
    const salt = Buffer.from(String(row.password_salt), 'base64')
    const expected = Buffer.from(String(row.password_hash), 'base64')
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(row.scrypt_n),
      r: Number(row.scrypt_r),
      p: Number(row.scrypt_p),
      maxmem: 256 * 1024 * 1024,
    })
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AuthFailure('badCredentials')
    }
    const user = toUser(row)
    if (user.status === 'disabled') {
      throw new AuthFailure('disabled')
    }
    return user
  }

  /** 发新会话令牌；返回明文令牌（只在此刻存在一次） */
  createSession(userId: string, device?: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    const expiresAt = now + SESSION_TTL_MS
    this.db
      .prepare(
        `insert into auth_sessions (token_hash, user_id, device, created_at, last_seen_at, expires_at)
         values (?, ?, ?, ?, ?, ?)`
      )
      .run(sha256Hex(token), userId, device?.slice(0, 120) ?? null, now, now, expiresAt)
    return { token, expiresAt }
  }

  /** 用令牌换用户；顺带滑动续期 */
  resolveToken(token: string): User | null {
    if (!token) {
      return null
    }
    const row = this.db
      .prepare('select user_id, last_seen_at, expires_at from auth_sessions where token_hash = ?')
      .get(sha256Hex(token)) as
      | { user_id: string; last_seen_at: number; expires_at: number }
      | undefined
    if (!row) {
      return null
    }
    const now = Date.now()
    if (row.expires_at < now) {
      this.db.prepare('delete from auth_sessions where token_hash = ?').run(sha256Hex(token))
      return null
    }
    if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
      this.db
        .prepare('update auth_sessions set last_seen_at = ?, expires_at = ? where token_hash = ?')
        .run(now, now + SESSION_TTL_MS, sha256Hex(token))
    }
    const user = this.findById(row.user_id)
    if (!user || user.status === 'disabled') {
      return null
    }
    return user
  }

  revokeToken(token: string): void {
    this.db.prepare('delete from auth_sessions where token_hash = ?').run(sha256Hex(token))
  }

  revokeAll(userId: string): void {
    this.db.prepare('delete from auth_sessions where user_id = ?').run(userId)
  }

  // ── 邮箱验证码 ────────────────────────────────────────

  /** 生成并落库一个验证码，返回明文供发送；冷却期内抛 tooManyCodes */
  issueEmailCode(
    email: string,
    purpose: 'register' | 'reset',
    options: { cooldownMs: number; ttlMs: number }
  ): string {
    const normalized = normalizeEmail(email)
    if (!EMAIL_RE.test(normalized)) {
      throw new AuthFailure('invalidEmail')
    }
    const now = Date.now()
    const existing = this.db
      .prepare('select created_at from email_codes where email = ? and purpose = ?')
      .get(normalized, purpose) as { created_at: number } | undefined
    if (existing && now - existing.created_at < options.cooldownMs) {
      throw new AuthFailure('tooManyCodes')
    }
    // 6 位数字：用 crypto 的均匀随机，Math.random 在并发下不均匀
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.db
      .prepare(
        `insert into email_codes (email, purpose, code_hash, expires_at, attempts, created_at)
         values (?, ?, ?, ?, 0, ?)
         on conflict(email, purpose) do update set
           code_hash = excluded.code_hash,
           expires_at = excluded.expires_at,
           attempts = 0,
           created_at = excluded.created_at`
      )
      .run(normalized, purpose, sha256Hex(code), now + options.ttlMs, now)
    return code
  }

  /** 校验验证码；失败抛 badCode / codeExpired / codeTooManyAttempts。成功后不消费，由调用方决定 */
  verifyEmailCode(email: string, purpose: 'register' | 'reset', code: string): void {
    const normalized = normalizeEmail(email)
    const row = this.db
      .prepare('select code_hash, expires_at, attempts from email_codes where email = ? and purpose = ?')
      .get(normalized, purpose) as
      | { code_hash: string; expires_at: number; attempts: number }
      | undefined
    if (!row) {
      throw new AuthFailure('badCode')
    }
    if (row.attempts >= 5) {
      throw new AuthFailure('codeTooManyAttempts')
    }
    if (row.expires_at < Date.now()) {
      throw new AuthFailure('codeExpired')
    }
    if (row.code_hash !== sha256Hex(code.trim())) {
      this.db
        .prepare('update email_codes set attempts = attempts + 1 where email = ? and purpose = ?')
        .run(normalized, purpose)
      throw new AuthFailure('badCode')
    }
  }

  /** 用掉验证码（成功后调用），防止同一个码被重放 */
  consumeEmailCode(email: string, purpose: 'register' | 'reset'): void {
    this.db
      .prepare('delete from email_codes where email = ? and purpose = ?')
      .run(normalizeEmail(email), purpose)
  }

  // ── 登录失败退避 ──────────────────────────────────────

  /** 该邮箱当前是否处于退避期；是则返回剩余秒数 */
  loginRetryAfter(email: string): number {
    const row = this.db
      .prepare('select locked_until from login_guards where email = ?')
      .get(normalizeEmail(email)) as { locked_until: number } | undefined
    if (!row || row.locked_until <= Date.now()) {
      return 0
    }
    return Math.ceil((row.locked_until - Date.now()) / 1000)
  }

  /**
   * 记一次失败。前 4 次不锁；第 5 次起按 1/2/4/8… 分钟退避（上限 1 小时）。
   * 指数退避优于此前的永久锁定：既挡住撞库，也不会因为别人恶意失败把你锁死。
   */
  noteLoginFailure(email: string): { failures: number; retryAfterSeconds: number } {
    const normalized = normalizeEmail(email)
    const now = Date.now()
    const row = this.db
      .prepare('select failures from login_guards where email = ?')
      .get(normalized) as { failures: number } | undefined
    const failures = (row?.failures ?? 0) + 1
    let lockedUntil = 0
    if (failures >= 5) {
      const minutes = Math.min(60, 2 ** (failures - 5))
      lockedUntil = now + minutes * 60_000
    }
    this.db
      .prepare(
        `insert into login_guards (email, failures, locked_until, last_failure)
         values (?, ?, ?, ?)
         on conflict(email) do update set
           failures = excluded.failures,
           locked_until = excluded.locked_until,
           last_failure = excluded.last_failure`
      )
      .run(normalized, failures, lockedUntil, now)
    return { failures, retryAfterSeconds: lockedUntil ? Math.ceil((lockedUntil - now) / 1000) : 0 }
  }

  clearLoginFailures(email: string): void {
    this.db.prepare('delete from login_guards where email = ?').run(normalizeEmail(email))
  }
  /** 记录（或更新）指纹；同一次调用不写两次 */
  setUpstreamKey(userId: string, key: string, validatedAt = Date.now()): UpstreamKeyInfo {
    const info: UpstreamKeyInfo = {
      fingerprint: keyFingerprint(key),
      masked: maskKey(key),
      validatedAt,
    }
    this.db
      .prepare(
        `insert into user_upstream_keys (user_id, fingerprint, masked, validated_at, created_at)
         values (?, ?, ?, ?, ?)
         on conflict(user_id) do update set
           fingerprint = excluded.fingerprint,
           masked = excluded.masked,
           validated_at = excluded.validated_at`
      )
      .run(userId, info.fingerprint, info.masked, info.validatedAt, Date.now())
    return info
  }

  getUpstreamKey(userId: string): UpstreamKeyInfo | null {
    const row = this.db
      .prepare('select fingerprint, masked, validated_at from user_upstream_keys where user_id = ?')
      .get(userId) as { fingerprint: string; masked: string; validated_at: number } | undefined
    return row
      ? { fingerprint: row.fingerprint, masked: row.masked, validatedAt: row.validated_at }
      : null
  }

  clearUpstreamKey(userId: string): void {
    this.db.prepare('delete from user_upstream_keys where user_id = ?').run(userId)
  }

  /** 同一个指纹被几个账号使用（>1 = 可能在共用或泄漏） */
  fingerprintOwners(fingerprint: string): number {
    return Number(
      (
        this.db
          .prepare('select count(*) n from user_upstream_keys where fingerprint = ?')
          .get(fingerprint) as { n: number }
      ).n
    )
  }

  sessionCount(userId: string): number {
    return Number(
      (
        this.db
          .prepare('select count(*) n from auth_sessions where user_id = ? and expires_at > ?')
          .get(userId, Date.now()) as { n: number }
      ).n
    )
  }
}
