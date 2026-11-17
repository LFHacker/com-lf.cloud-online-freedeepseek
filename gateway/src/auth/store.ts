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
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
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
`

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex')

/** 新建用户 id：`u_` + 16 位十六进制，可安全用作目录名 */
const newUserId = (): string => `u_${randomBytes(8).toString('hex')}`

const normalizeEmail = (email: string): string => email.trim().toLowerCase()

/** 邮箱校验：够用即可（不追求 RFC 5322 全集，那种正则通常写错） */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/

const MIN_PASSWORD = 8
const MAX_PASSWORD = 200

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
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
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
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
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
