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
  /** 内部 id：只用于服务端（记忆库目录、外键），**不下发给客户端** */
  id: string
  /** 对外 id：随机分配、无序，替代内部 id 暴露给客户端 */
  publicId: string
  /** 显示名；可改，可重名策略由业务决定（这里要求唯一，防冒充） */
  username: string | null
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
  | 'badUsername'
  | 'usernameTaken'
  | 'usernameReserved'
  | 'usernameTooSoon'

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
  public_id     text,                        -- 对外 id，随机无序；老库迁移时补
  username      text,                        -- 显示名，可空；唯一（不区分大小写）
  username_changed_at integer not null default 0,
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

/** 改名记录：用于限频（24h 内最多 3 次） */
/**
 * 会话云端同步。
 *
 * 只存**整条会话的 JSON**（payload），不拆字段：
 *  · 会话结构还会变（分支、附件、引用），拆成列每改一次都要迁移
 *  · 服务端不需要理解会话内容，只需要"按 id 存取 + 按时间比对"
 *
 * 放在 auth.db 而不是记忆库：会话属于账号，不属于记忆；
 * 而且备份脚本已经覆盖 auth.db，跟着一起进备份。
 */
create table if not exists user_sessions (
  user_id    text not null,
  session_id text not null,
  title      text,
  created_at integer not null,
  updated_at integer not null,
  pinned     integer not null default 0,
  payload    text not null,
  primary key (user_id, session_id)
);
create index if not exists idx_user_sessions_time on user_sessions(user_id, updated_at desc);

/**
 * 附件引用计数（阶段 3）。
 *
 * 一个附件可以同时被多条会话引用（编辑提问、重新生成、导入都会复用同一个 id），
 * 所以删除会话时**不能直接删文件**：得先知道还有没有别的会话在用它。
 *
 * 表结构就是「谁引用了谁」的边表，计数天然可查（count(*)），
 * 也天然可全量重建（从 user_sessions.payload 里重新抽一遍 id）。
 * 为什么不存一个 count 列：多一台设备重复推送就会多算一次，边表主键去重后天然幂等。
 */
create table if not exists file_refs (
  user_id    text not null,
  file_id    text not null,
  session_id text not null,
  updated_at integer not null,
  primary key (user_id, file_id, session_id)
);
create index if not exists idx_file_refs_file on file_refs(user_id, file_id);
create index if not exists idx_file_refs_session on file_refs(user_id, session_id);

/** 一次性迁移标记（如引用表首次全量重建），避免每次启动都重算 */
create table if not exists store_meta (
  key   text primary key,
  value text
);

/**
 * 软删除（墓碑）。
 *
 * 为什么不能直接 DELETE：另一台设备离线时还留着这条会话，
 * 上线后会把"本地版本"推回来，删掉的东西又活了。
 * 留一行墓碑，同步时告诉各端"这条已删"，才是可传播的删除。
 */
create table if not exists session_tombstones (
  user_id    text not null,
  session_id text not null,
  deleted_at integer not null,
  primary key (user_id, session_id)
);

/**
 * 用量账本。
 *
 * 为什么落在服务端：手机端只在消息里存 usage，重装/换设备就没了，
 * 也没法回答"这个 Key 下所有会话一共多少"。账本按请求追加，
 * 天然覆盖全部会话，可供设置页合计与官方后台对照。
 *
 * 只记数字，不记内容 —— 账本不是日志，不该成为隐私面。
 */
create table if not exists usage_events (
  id            text primary key,
  user_id       text not null,
  session_id    text,
  model         text,
  prompt_hit    integer not null default 0,
  prompt_miss   integer not null default 0,
  output_tokens integer not null default 0,
  cost_cny      real not null default 0,
  peak          integer not null default 0,
  created_at    integer not null
);
create index if not exists idx_usage_user_time on usage_events(user_id, created_at desc);

create table if not exists username_changes (
  user_id text not null,
  at      integer not null
);

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

/**
 * 附件 id 的形状（与 /sync/files/:id 的校验同一条规则）。
 * 引用表里的 file_id 会直接用来拼磁盘路径，所以入表前必须过这一关 ——
 * 否则一条 `../..` 的会话 payload 就能往库外写引用。
 */
const FILE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/

/**
 * 从会话 payload 里抽附件 id。
 *
 * 这是**兼容兜底**：新客户端推送时会直接带 fileIds（它本地算好了），
 * 老客户端没有这个字段，服务端就得自己从 JSON 里找。
 * 解析失败一律返回空数组 —— 抽不到顶多是引用偏少，由 rebuildRefs 兜底；
 * 抛异常会把整批同步打回。
 */
const collectPayloadFileIds = (payload: string): string[] => {
  if (!payload || payload.length > 8 * 1024 * 1024) {
    return []
  }
  try {
    const parsed = JSON.parse(payload) as { messages?: unknown }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const ids = new Set<string>()
    for (const message of messages) {
      const files = (message as { files?: unknown }).files
      if (!Array.isArray(files)) {
        continue
      }
      for (const file of files) {
        const id = (file as { id?: unknown }).id
        if (typeof id === 'string' && FILE_ID_RE.test(id)) {
          ids.add(id)
        }
      }
    }
    return [...ids]
  } catch {
    return []
  }
}

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

/**
 * 对外用户 id 的字母表：去掉 0/O/1/I 这些容易看错的字符。
 * 10 位 ≈ 32^10 ≈ 1.1e15 种，碰撞概率可忽略，但仍然会查库确认。
 */
const PUBLIC_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const PUBLIC_ID_LENGTH = 10

const randomPublicId = (): string => {
  let out = ''
  for (let i = 0; i < PUBLIC_ID_LENGTH; i += 1) {
    out += PUBLIC_ID_ALPHABET[randomInt(0, PUBLIC_ID_ALPHABET.length)]
  }
  return out
}

/**
 * 保留名：防止冒充官方或系统身份（admin / root / support / deepseek …）。
 * 比对前统一小写，避免 Admin、ADMIN 绕过。
 */
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'root', 'system', 'sys', 'support', 'service', 'staff',
  'official', 'owner', 'master', 'superuser', 'moderator', 'mod', 'security', 'ops',
  'api', 'bot', 'guest', 'test', 'demo', 'null', 'undefined', 'anonymous', 'me', 'self',
  'deepseek', 'freedeepseek', 'dsfree', 'lfhacker',
])

/**
 * 用户名规则：2–20 个字符，允许字母/数字/下划线/连字符/中日韩字符。
 * 不允许首尾是 _ 或 -（看起来像系统保留格式），也不允许纯数字（容易和 id 混淆）。
 */
const normalizeUsername = (raw: string): string => raw.trim()

const validateUsername = (raw: string, options: { allowReserved?: boolean } = {}): string => {
  const name = normalizeUsername(raw)
  if (name.length < 2 || name.length > 20) {
    throw new AuthFailure('badUsername')
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(name)) {
    throw new AuthFailure('badUsername')
  }
  if (/^[_-]|[_-]$/.test(name)) {
    throw new AuthFailure('badUsername')
  }
  if (/^\d+$/.test(name)) {
    throw new AuthFailure('badUsername')
  }
  if (!options.allowReserved && RESERVED_USERNAMES.has(name.toLowerCase())) {
    throw new AuthFailure('usernameReserved')
  }
  return name
}

const toUser = (row: Record<string, unknown>): User => ({
  id: String(row.id),
  publicId: String(row.public_id ?? ''),
  username: row.username === null || row.username === undefined ? null : String(row.username),
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
    this.migrate()
    // 过期会话不必等到被访问才清
    this.db.prepare('delete from auth_sessions where expires_at < ?').run(Date.now())
  }

  /**
   * 幂等迁移：老库没有 public_id / username 列时补上，并给存量用户分配 public_id。
   * 用 pragma table_info 判断，而不是靠 try/catch —— ALTER 失败的原因很多，
   * 把"列已存在"和"真出错"混在一起会掩盖问题。
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare('pragma table_info(users)').all() as Array<{ name: string }>).map((c) => c.name)
    )
    if (!columns.has('public_id')) {
      this.db.exec('alter table users add column public_id text')
    }
    if (!columns.has('username')) {
      this.db.exec('alter table users add column username text')
    }
    if (!columns.has('username_changed_at')) {
      this.db.exec('alter table users add column username_changed_at integer not null default 0')
    }
    // 存量用户补 public_id
    const pending = this.db
      .prepare('select id from users where public_id is null or public_id = ?')
      .all('') as Array<{ id: string }>
    for (const row of pending) {
      let candidate = randomPublicId()
      let tries = 0
      while (this.db.prepare('select 1 from users where public_id = ?').get(candidate)) {
        candidate = randomPublicId()
        if ((tries += 1) > 20) {
          throw new Error('无法生成唯一的 public_id')
        }
      }
      this.db.prepare('update users set public_id = ? where id = ?').run(candidate, row.id)
    }
    this.db.exec('create unique index if not exists idx_users_public_id on users(public_id)')
    this.db.exec(
      'create unique index if not exists idx_users_username on users(lower(username)) where username is not null'
    )

    /**
     * 会话表后来才加 pinned：列表要按置顶排序，而列表读的是服务端（阶段 2-1），
     * 所以置顶必须成为服务端字段，不能只留在会话 payload 里。
     */
    const sessionColumns = new Set(
      (this.db.prepare('pragma table_info(user_sessions)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    )
    if (!sessionColumns.has('pinned')) {
      this.db.exec('alter table user_sessions add column pinned integer not null default 0')
    }

    /**
     * 引用表首次启用时全量重建一次：老库里的会话早就存在，
     * 不重建的话它们的附件永远"零引用"，第一次跑 GC 就会把还在用的文件删掉。
     */
    const rebuilt = this.db
      .prepare('select value from store_meta where key = ?')
      .get('file_refs_rebuilt_v1') as { value: string } | undefined
    if (!rebuilt) {
      try {
        this.rebuildRefs()
        this.db
          .prepare(
            'insert into store_meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value'
          )
          .run('file_refs_rebuilt_v1', String(Date.now()))
      } catch (error) {
        // 重建失败不该让网关起不来：引用表为空时 GC 会被安全护栏挡住（见 listGcCandidates）
        console.warn(
          '[gateway] 附件引用重建失败，GC 已暂停:',
          error instanceof Error ? error.message : error
        )
      }
    }
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

  createUser(
    email: string,
    password: string,
    role: UserRole = 'user',
    rawUsername?: string
  ): User {
    const normalized = normalizeEmail(email)
    const username = rawUsername && rawUsername.trim() ? validateUsername(rawUsername) : null
    if (username && this.findByUsername(username)) {
      throw new AuthFailure('usernameTaken')
    }
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
    // public_id 随机且查库确认唯一（碰撞概率极低，但错了很难查，所以宁可多查一次）
    let publicId = randomPublicId()
    let tries = 0
    while (this.db.prepare('select 1 from users where public_id = ?').get(publicId)) {
      publicId = randomPublicId()
      if ((tries += 1) > 20) {
        throw new Error('无法生成唯一的 public_id')
      }
    }
    this.db
      .prepare(
        `insert into users (id, public_id, username, email, password_hash, password_salt, scrypt_n, scrypt_r, scrypt_p, role, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(
        id,
        publicId,
        username,
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
    return { id, publicId, username, email: normalized, role, status: 'active', createdAt: now }
  }

  /** 按显示名查（不区分大小写） */
  findByUsername(name: string): User | null {
    const row = this.db
      .prepare('select * from users where lower(username) = lower(?)')
      .get(normalizeUsername(name)) as Record<string, unknown> | undefined
    return row ? toUser(row) : null
  }

  /** 改角色（提权/降权）。只允许服务端引导流程调用，没有对外接口。 */
  setRole(userId: string, role: UserRole): void {
    this.db.prepare('update users set role = ?, updated_at = ? where id = ?').run(role, Date.now(), userId)
  }

  findByPublicId(publicId: string): User | null {
    const row = this.db.prepare('select * from users where public_id = ?').get(publicId) as
      | Record<string, unknown>
      | undefined
    return row ? toUser(row) : null
  }

  /**
   * 改显示名。限频：24 小时内最多 3 次 —— 否则可以被用来反复抢注/骚扰。
   */
  setUsername(userId: string, rawUsername: string): User {
    const owner = this.findById(userId)
    if (!owner) {
      throw new AuthFailure('invalidToken')
    }
    /**
     * 保留名是防"别人冒充官方"，不是防站长自己。
     * 管理员（owner）可以用任何保留名；普通用户仍然一律拦。
     */
    const username = validateUsername(rawUsername, { allowReserved: owner.role === 'admin' })
    const existing = this.findByUsername(username)
    if (existing && existing.id !== userId) {
      throw new AuthFailure('usernameTaken')
    }
    const row = this.db
      .prepare('select username_changed_at from users where id = ?')
      .get(userId) as { username_changed_at: number } | undefined
    const lastChange = row?.username_changed_at ?? 0
    const DAY = 86_400_000
    if (lastChange > 0) {
      const recent = this.db
        .prepare('select count(*) n from username_changes where user_id = ? and at > ?')
        .get(userId, Date.now() - DAY) as { n: number }
      if (recent.n >= 3) {
        throw new AuthFailure('usernameTooSoon')
      }
    }
    this.db
      .prepare('update users set username = ?, username_changed_at = ?, updated_at = ? where id = ?')
      .run(username, Date.now(), Date.now(), userId)
    this.db.prepare('insert into username_changes (user_id, at) values (?, ?)').run(userId, Date.now())
    return { ...owner, username }
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

  // ── 会话云端同步 ──────────────────────────────────────

  /**
   * 批量写入会话。
   *
   * 用"取较新者"的 upsert：两台设备都改过同一个会话时，
   * 保留 updatedAt 更大的那份，避免旧数据把新数据覆盖掉。
   */
  upsertSessions(
    userId: string,
    sessions: Array<{
      id: string
      title: string
      createdAt: number
      updatedAt: number
      pinned?: boolean
      /** 本条会话引用的附件 id；缺省时从 payload 里抽（兼容还没升级的客户端） */
      fileIds?: string[]
      payload: string
    }>
  ): { written: number; skipped: number; refs: number } {
    const statement = this.db.prepare(
      `insert into user_sessions (user_id, session_id, title, created_at, updated_at, pinned, payload)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict(user_id, session_id) do update set
         title = excluded.title,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         pinned = excluded.pinned,
         payload = excluded.payload
       where excluded.updated_at > user_sessions.updated_at`
    )
    let written = 0
    /**
     * 墓碑优先：会话被删过之后，任何"旧设备重推"都不能把它复活。
     *
     * 这是"云端为主"要付的代价里最重要的一条：离线设备带着旧副本上线时，
     * 它手里的 payload 看起来比墓碑更"新"（本地时钟），但用户的删除意图更明确。
     * 复活的后果是"删了又出现"，用户会以为删除功能坏了。
     */
    const tombstone = this.db.prepare(
      'select 1 as hit from session_tombstones where user_id = ? and session_id = ?'
    )
    /**
     * 只有真的写进去的会话才更新引用。
     * 被"取较新者"拒绝的旧 payload 带的是旧附件列表，拿它去覆盖引用，
     * 会把仍被新版本引用的附件记成零引用 —— 随后 GC 就会删还在用的文件。
     */
    const accepted: Array<{ id: string; fileIds: string[] }> = []
    this.db.exec('begin')
    try {
      for (const session of sessions) {
        if (tombstone.get(userId, session.id)) {
          continue
        }
        const result = statement.run(
          userId,
          session.id,
          session.title,
          session.createdAt,
          session.updatedAt,
          session.pinned ? 1 : 0,
          session.payload
        )
        if (Number(result.changes) > 0) {
          written += 1
          accepted.push({
            id: session.id,
            fileIds: session.fileIds ?? collectPayloadFileIds(session.payload),
          })
        }
      }
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
    const refs = accepted.length > 0 ? this.writeRefs(userId, accepted) : 0
    return { written, skipped: sessions.length - written, refs }
  }

  /** 重写若干条会话的引用边（先删该会话的旧边、再插新边，幂等） */
  private writeRefs(userId: string, sessions: Array<{ id: string; fileIds: string[] }>): number {
    const remove = this.db.prepare('delete from file_refs where user_id = ? and session_id = ?')
    const insert = this.db.prepare(
      `insert into file_refs (user_id, file_id, session_id, updated_at) values (?, ?, ?, ?)
       on conflict(user_id, file_id, session_id) do update set updated_at = excluded.updated_at`
    )
    const now = Date.now()
    let count = 0
    this.db.exec('begin')
    try {
      for (const session of sessions) {
        remove.run(userId, session.id)
        for (const fileId of new Set(session.fileIds)) {
          if (!FILE_ID_RE.test(fileId)) {
            continue
          }
          insert.run(userId, fileId, session.id, now)
          count += 1
        }
      }
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
    return count
  }

  /** 软删除：记墓碑，并把会话行与它的引用边删掉（正文没必要留） */
  deleteSession(userId: string, sessionId: string): void {
    const now = Date.now()
    this.db.exec('begin')
    try {
      this.db
        .prepare('delete from user_sessions where user_id = ? and session_id = ?')
        .run(userId, sessionId)
      // 引用边跟着走：删完这条会话，它引用的附件可能就零引用了（GC 时才会真删）
      this.db
        .prepare('delete from file_refs where user_id = ? and session_id = ?')
        .run(userId, sessionId)
      this.db
        .prepare(
          `insert into session_tombstones (user_id, session_id, deleted_at) values (?, ?, ?)
           on conflict(user_id, session_id) do update set deleted_at = excluded.deleted_at`
        )
        .run(userId, sessionId, now)
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }

  /**
   * 墓碑清单：各端据此删除本地副本。
   * 分页与 listSessions 同构（deleted_at desc + 复合游标），否则删得多了就翻不到后面的。
   */
  listTombstones(
    userId: string,
    options: { since?: number; before?: number; beforeId?: string; limit?: number } = {}
  ): Array<{ id: string; deletedAt: number }> {
    const since = options.since ?? 0
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000)
    const before = options.before && options.before > 0 ? options.before : Number.MAX_SAFE_INTEGER
    const beforeId = options.beforeId ?? '\uffff'
    const rows = this.db
      .prepare(
        `select session_id id, deleted_at from session_tombstones
          where user_id = ? and deleted_at >= ?
            and (deleted_at < ? or (deleted_at = ? and session_id < ?))
          order by deleted_at desc, session_id desc limit ?`
      )
      .all(userId, since, before, before, beforeId, limit + 1) as Array<{
      id: string
      deleted_at: number
    }>
    return rows.slice(0, limit).map((row) => ({ id: row.id, deletedAt: row.deleted_at }))
  }

  /**
   * 会话列表（不含 payload）。
   *
   * 分页用**复合游标**（updated_at, session_id）：只用 updated_at 做 `before` 会在
   * 同一毫秒创建的会话上把跨页的那几条漏掉，而客户端是"翻完所有页就当拿到全量"。
   */
  listSessions(
    userId: string,
    options: { since?: number; before?: number; beforeId?: string; limit?: number } = {}
  ): Array<{ id: string; title: string; createdAt: number; updatedAt: number; pinned: boolean }> {
    const since = options.since ?? 0
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000)
    const before = options.before && options.before > 0 ? options.before : Number.MAX_SAFE_INTEGER
    const beforeId = options.beforeId ?? '\uffff'
    const rows = this.db
      .prepare(
        `select session_id id, title, created_at, updated_at, pinned from user_sessions
          where user_id = ? and updated_at >= ?
            and (updated_at < ? or (updated_at = ? and session_id < ?))
          order by updated_at desc, session_id desc limit ?`
      )
      .all(userId, since, before, before, beforeId, limit + 1) as Array<{
      id: string
      title: string | null
      created_at: number
      updated_at: number
      pinned: number
    }>
    return rows.slice(0, limit).map((row) => ({
      id: row.id,
      title: row.title ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      pinned: row.pinned === 1,
    }))
  }

  /** 单条会话全文 */
  readSession(userId: string, sessionId: string): { payload: string; updatedAt: number } | null {
    const row = this.db
      .prepare('select payload, updated_at from user_sessions where user_id = ? and session_id = ?')
      .get(userId, sessionId) as { payload: string; updated_at: number } | undefined
    return row ? { payload: row.payload, updatedAt: row.updated_at } : null
  }

  // ── 附件引用与回收（阶段 3） ──────────────────────────

  /** 附件引用计数：file_id → 被多少条会话引用 */
  fileRefCounts(userId: string): Map<string, number> {
    const rows = this.db
      .prepare('select file_id, count(*) n from file_refs where user_id = ? group by file_id')
      .all(userId) as Array<{ file_id: string; n: number }>
    return new Map(rows.map((row) => [row.file_id, Number(row.n)]))
  }

  /** 某条会话引用的附件 id */
  sessionFileIds(userId: string, sessionId: string): string[] {
    return (
      this.db
        .prepare('select file_id from file_refs where user_id = ? and session_id = ?')
        .all(userId, sessionId) as Array<{ file_id: string }>
    ).map((row) => row.file_id)
  }

  /** 该账号还有多少条会话（GC 报告用） */
  countSessions(userId: string): number {
    return Number(
      (this.db
        .prepare('select count(*) n from user_sessions where user_id = ?')
        .get(userId) as { n: number }).n
    )
  }

  /**
   * 引用表可不可信（GC 的前置条件）。
   *
   * 不能用"引用表为空"来判断 —— 用户把最后一条引用附件的会话删掉之后，
   * 引用表本来就该是空的，那正是需要回收的时刻。
   * 真正的信号是"重建跑过没有"：跑过就说明表是从真实 payload 算出来的。
   */
  refsTrusted(): boolean {
    const row = this.db
      .prepare('select value from store_meta where key = ?')
      .get('file_refs_rebuilt_v1') as { value: string } | undefined
    return Boolean(row)
  }

  /**
   * 全量重建引用表：从每条会话的 payload 里重新抽附件 id。
   *
   * 为什么需要它：引用表是"运行时维护"的派生数据，一旦某次写入漏了
   * （老客户端没传 fileIds、手改过库、迁移中断），计数就会偏小 ——
   * 而计数偏小的后果是 GC 删掉还在用的文件。所以必须能一键重算。
   */
  rebuildRefs(userId?: string): { sessions: number; refs: number } {
    if (userId) {
      this.db.prepare('delete from file_refs where user_id = ?').run(userId)
    } else {
      this.db.exec('delete from file_refs')
    }
    const pageStmt = userId
      ? this.db.prepare(
          'select rowid rid, user_id, session_id, payload from user_sessions where user_id = ? and rowid > ? order by rowid limit 200'
        )
      : this.db.prepare(
          'select rowid rid, user_id, session_id, payload from user_sessions where rowid > ? order by rowid limit 200'
        )
    let cursor = 0
    let sessions = 0
    let refs = 0
    // 分批读：payload 单条可达几百 KB，一次性 all() 会把整库拉进内存
    for (;;) {
      const rows = (
        userId ? pageStmt.all(userId, cursor) : pageStmt.all(cursor)
      ) as Array<{ rid: number; user_id: string; session_id: string; payload: string }>
      if (rows.length === 0) {
        break
      }
      const byUser = new Map<string, Array<{ id: string; fileIds: string[] }>>()
      for (const row of rows) {
        cursor = Number(row.rid)
        const list = byUser.get(row.user_id) ?? []
        list.push({ id: row.session_id, fileIds: collectPayloadFileIds(row.payload) })
        byUser.set(row.user_id, list)
      }
      for (const [userId, list] of byUser) {
        refs += this.writeRefs(userId, list)
        sessions += list.length
      }
    }
    return { sessions, refs }
  }

  // ── 用量账本 ──────────────────────────────────────────

  /** 追加一条用量（每次上游调用一条） */
  recordUsageEvent(params: {
    userId: string
    sessionId: string | null
    model: string
    promptHit: number
    promptMiss: number
    output: number
    costCny: number
    peak: boolean
    now?: number
  }): void {
    const now = params.now ?? Date.now()
    const id = createHash('sha256')
      .update([params.userId, params.sessionId ?? '', String(now), String(Math.random())].join('|'))
      .digest('hex')
      .slice(0, 24)
    this.db
      .prepare(
        `insert into usage_events
           (id, user_id, session_id, model, prompt_hit, prompt_miss, output_tokens, cost_cny, peak, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.userId,
        params.sessionId,
        params.model,
        params.promptHit,
        params.promptMiss,
        params.output,
        params.costCny,
        params.peak ? 1 : 0,
        now
      )
  }

  /** 汇总：since 之后的合计 + 按天分组 + 按会话分组 */
  usageTotals(userId: string, since = 0): {
    requests: number
    promptHit: number
    promptMiss: number
    output: number
    costCny: number
    byDay: Array<{ day: string; requests: number; hit: number; miss: number; output: number; costCny: number }>
    bySession: Array<{ sessionId: string; requests: number; hit: number; miss: number; output: number; costCny: number }>
  } {
    const row = this.db
      .prepare(
        `select count(*) requests,
                coalesce(sum(prompt_hit), 0) hit,
                coalesce(sum(prompt_miss), 0) miss,
                coalesce(sum(output_tokens), 0) out,
                coalesce(sum(cost_cny), 0) cost
           from usage_events where user_id = ? and created_at >= ?`
      )
      .get(userId, since) as { requests: number; hit: number; miss: number; out: number; cost: number }

    const byDay = (
      this.db
        .prepare(
          `select date(created_at / 1000, 'unixepoch', '+8 hours') day,
                  count(*) requests,
                  coalesce(sum(prompt_hit), 0) hit,
                  coalesce(sum(prompt_miss), 0) miss,
                  coalesce(sum(output_tokens), 0) out,
                  coalesce(sum(cost_cny), 0) cost
             from usage_events where user_id = ? and created_at >= ?
            group by day order by day desc limit 31`
        )
        .all(userId, since) as Array<{ day: string; requests: number; hit: number; miss: number; out: number; cost: number }>
    ).map((d) => ({ day: d.day, requests: d.requests, hit: d.hit, miss: d.miss, output: d.out, costCny: d.cost }))

    const bySession = (
      this.db
        .prepare(
          `select session_id, count(*) requests,
                  coalesce(sum(prompt_hit), 0) hit,
                  coalesce(sum(prompt_miss), 0) miss,
                  coalesce(sum(output_tokens), 0) out,
                  coalesce(sum(cost_cny), 0) cost
             from usage_events where user_id = ? and created_at >= ? and session_id is not null
            group by session_id order by cost desc limit 20`
        )
        .all(userId, since) as Array<{ session_id: string; requests: number; hit: number; miss: number; out: number; cost: number }>
    ).map((s) => ({ sessionId: s.session_id, requests: s.requests, hit: s.hit, miss: s.miss, output: s.out, costCny: s.cost }))

    return {
      requests: row.requests,
      promptHit: row.hit,
      promptMiss: row.miss,
      output: row.out,
      costCny: row.cost,
      byDay,
      bySession,
    }
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
