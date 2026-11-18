/**
 * 账号系统与「每用户一个记忆库」的自动化测试。
 *
 * 重点不是「功能能跑」，而是**串数据不可能发生**：
 * 一旦隔离失效，用户 A 能看到用户 B 的历史，属于最严重的一类 bug，
 * 且很难靠手测发现（你得记得去用另一个账号试）。
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AuthFailure, AuthStore, keyFingerprint, maskKey } from '../src/auth/store.ts'
import { redactSecrets, REDACTED } from '../src/redact.ts'
import { MemoryRegistry } from '../src/memory/registry.ts'

let pass = 0
let fail = 0

const check = (name: string, condition: boolean, detail = '') => {
  if (condition) {
    pass += 1
  } else {
    fail += 1
    console.log(`  ❌ ${name}${detail ? `：${detail}` : ''}`)
  }
}

const expectFailure = (name: string, key: string, run: () => unknown) => {
  try {
    run()
    check(name, false, '应当抛错但没有')
  } catch (error) {
    check(name, error instanceof AuthFailure && error.key === key, `实际 ${String(error)}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'ds-auth-test-'))
try {
  // ── 1. 注册校验 ────────────────────────────────────────
  const auth = new AuthStore(join(dir, 'auth.db'))

  expectFailure('邮箱格式非法被拒', 'invalidEmail', () => auth.createUser('not-an-email', 'password123'))
  expectFailure('密码太短被拒', 'weakPassword', () => auth.createUser('a@b.com', 'short'))

  const alice = auth.createUser('Alice@Example.COM', 'alicepassword', 'admin')
  check('邮箱统一小写存储', alice.email === 'alice@example.com', alice.email)
  check('角色可设为 admin', alice.role === 'admin')

  expectFailure('重复邮箱被拒', 'emailTaken', () => auth.createUser('alice@example.com', 'anotherpass'))

  const bob = auth.createUser('bob@example.com', 'bobpassword')
  check('用户 id 可用于目录名', /^u_[0-9a-f]{16}$/.test(bob.id), bob.id)
  check('用户数正确', auth.countUsers() === 2)

  // ── 2. 密码校验 ────────────────────────────────────────
  check('正确密码通过', auth.verifyPassword('alice@example.com', 'alicepassword').id === alice.id)
  check('大小写邮箱都能登录', auth.verifyPassword('ALICE@example.com', 'alicepassword').id === alice.id)
  expectFailure('错误密码被拒', 'badCredentials', () => auth.verifyPassword('alice@example.com', 'wrongpass'))
  expectFailure('不存在的邮箱被拒（且与密码错同一个 key）', 'badCredentials', () =>
    auth.verifyPassword('nobody@example.com', 'whatever')
  )

  // ── 3. 会话 ────────────────────────────────────────────
  const s1 = auth.createSession(alice.id, 'test-device')
  check('令牌有足够长度', s1.token.length >= 40, String(s1.token.length))
  check('令牌能换回用户', auth.resolveToken(s1.token)?.id === alice.id)
  check('乱写的令牌换不到用户', auth.resolveToken('not-a-real-token') === null)
  check('空令牌换不到用户', auth.resolveToken('') === null)
  check('会话计数正确', auth.sessionCount(alice.id) === 1)

  const s2 = auth.createSession(alice.id)
  check('同一用户可以有多个会话', auth.sessionCount(alice.id) === 2)
  auth.revokeToken(s1.token)
  check('吊销后令牌失效', auth.resolveToken(s1.token) === null)
  check('另一个会话不受影响', auth.resolveToken(s2.token)?.id === alice.id)

  // 改密码应踢掉所有会话
  auth.setPassword(alice.id, 'newalicepassword')
  check('改密码后旧会话全部失效', auth.resolveToken(s2.token) === null)
  check('新密码可登录', auth.verifyPassword('alice@example.com', 'newalicepassword').id === alice.id)
  check('旧密码失效', (() => {
    try {
      auth.verifyPassword('alice@example.com', 'alicepassword')
      return false
    } catch {
      return true
    }
  })())

  // ── 4. 停用账号 ────────────────────────────────────────
  const disabled = auth.createUser('carol@example.com', 'carolpassword')
  const carolSession = auth.createSession(disabled.id)
  const db = new DatabaseSync(join(dir, 'auth.db'))
  db.prepare("update users set status = 'disabled' where id = ?").run(disabled.id)
  check('停用账号的会话立即失效', auth.resolveToken(carolSession.token) === null)
  db.close()
  auth.close()

  // ── 5. 每用户一个记忆库：跨用户隔离 ────────────────────
  const registry = new MemoryRegistry({
    dataDir: join(dir, 'users'),
    maxHits: 4,
    maxChars: 1500,
  })

  const aliceStore = registry.get(alice.id)
  const bobStore = registry.get(bob.id)
  check('两个用户的库文件路径不同', registry.pathFor(alice.id) !== registry.pathFor(bob.id))
  check('库文件确实建出来了', existsSync(registry.pathFor(alice.id)) && existsSync(registry.pathFor(bob.id)))

  aliceStore.ensureSession('session-alpha', 'global', Date.now())
  aliceStore.recordMessage({
    sessionId: 'session-alpha',
    scope: 'global',
    role: 'user',
    body: '我的秘密暗号是紫色河马',
    now: Date.now(),
  })
  bobStore.ensureSession('session-beta', 'global', Date.now())
  bobStore.recordMessage({
    sessionId: 'session-beta',
    scope: 'global',
    role: 'user',
    body: '我的秘密暗号是绿色长颈鹿',
    now: Date.now(),
  })

  check('A 的库里有自己的数据', aliceStore.stats().chunks > 0, JSON.stringify(aliceStore.stats()))
  check('B 的库里有自己的数据', bobStore.stats().chunks > 0)

  const aliceHits = await aliceStore.search({ text: '紫色河马', excludeSessionId: '', limit: 5 })
  const bobHits = await bobStore.search({ text: '紫色河马', excludeSessionId: '', limit: 5 })
  check('A 能搜到自己的内容', aliceHits.some((h) => h.body.includes('紫色河马')))
  check('B 搜不到 A 的内容（关键隔离断言）', !bobHits.some((h) => h.body.includes('紫色河马')))

  const bobOwn = await bobStore.search({ text: '绿色长颈鹿', excludeSessionId: '', limit: 5 })
  const aliceCross = await aliceStore.search({ text: '绿色长颈鹿', excludeSessionId: '', limit: 5 })
  check('B 能搜到自己的内容', bobOwn.some((h) => h.body.includes('绿色长颈鹿')))
  check('A 搜不到 B 的内容（关键隔离断言）', !aliceCross.some((h) => h.body.includes('绿色长颈鹿')))

  // ── 6. 老单库迁移 ──────────────────────────────────────
  registry.closeAll()
  const legacyPath = join(dir, 'legacy-memory.db')
  // 造一个「改造前」的单库
  const legacyRegistry = new MemoryRegistry({
    dataDir: join(dir, 'legacy-users'),
    maxHits: 4,
    maxChars: 1500,
  })
  const legacyStore = legacyRegistry.get('u_legacy00000000')
  legacyStore.ensureSession('old-session', 'global', Date.now())
  legacyStore.recordMessage({
    sessionId: 'old-session',
    scope: 'global',
    role: 'user',
    body: '迁移前的老记忆：我喜欢喝乌龙茶',
    now: Date.now(),
  })
  legacyStore.close()
  legacyRegistry.closeAll()
  // 把那个文件当作「老库」
  const { copyFileSync } = await import('node:fs')
  copyFileSync(join(dir, 'legacy-users', 'u_legacy00000000', 'memory.db'), legacyPath)

  const freshRegistry = new MemoryRegistry({
    dataDir: join(dir, 'users2'),
    maxHits: 4,
    maxChars: 1500,
    legacyPath,
  })
  const adopted = freshRegistry.adoptLegacy(alice.id)
  check('老库被成功吸收', adopted.adopted === true, JSON.stringify(adopted))
  check('迁移后老库文件被改名留档', !existsSync(legacyPath))
  const migrated = freshRegistry.get(alice.id)
  const migratedHit = await migrated.search({ text: '乌龙茶', excludeSessionId: '', limit: 5 })
  check('迁移后的数据能搜到', migratedHit.some((h) => h.body.includes('乌龙茶')))

  const second = freshRegistry.adoptLegacy(bob.id)
  check('不会重复迁移（目标已有库）', second.adopted === false, JSON.stringify(second))
  freshRegistry.closeAll()
} finally {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows 上偶发占用，忽略
  }
}

// ── 7. 官方 Key：只留指纹 ──────────────────────────────
  {
    const store = new AuthStore(join(dir, 'auth-key.db'))
    const user = store.createUser('keyuser@example.com', 'keypassword123')
    // ⚠️ 假 Key 必须运行时拼出来：源码里出现 sk-<长串> 会被 GitHub 推送保护拦下
    const fakeKey = ['sk', 'a1b2c3d4'.repeat(8)].join('-')

    check('未绑定前查不到 Key 信息', store.getUpstreamKey(user.id) === null)

    const info = store.setUpstreamKey(user.id, fakeKey)
    check('指纹长度 16', info.fingerprint.length === 16, info.fingerprint)
    check('指纹是 sha256 前缀', keyFingerprint(fakeKey).slice(0, 16) === info.fingerprint)
    check('掩码只露首尾', info.masked.startsWith('sk-') && info.masked.includes('…'), info.masked)
    check('掩码不含完整 Key', !info.masked.includes(fakeKey.slice(6, 20)))

    const read = store.getUpstreamKey(user.id)
    check('能读回绑定信息', read?.fingerprint === info.fingerprint)
    check('读回的信息里没有原始 Key', !JSON.stringify(read).includes(fakeKey))

    // 关键断言：整个库文件里都不应出现原始 Key
    const { readFileSync: rf } = await import('node:fs')
    const dbBytes = rf(join(dir, 'auth-key.db')).toString('latin1')
    check('数据库文件里搜不到原始 Key', !dbBytes.includes(fakeKey))
    check('数据库文件里搜不到 Key 的正文片段', !dbBytes.includes(fakeKey.slice(10, 30)))

    // 同一个 Key 被两个账号绑定 → 指纹计数 2
    const other = store.createUser('keyuser2@example.com', 'keypassword123')
    store.setUpstreamKey(other.id, fakeKey)
    check('同一指纹被两个账号使用会被发现', store.fingerprintOwners(info.fingerprint) === 2)

    // 换 Key 后指纹变化
    const second = store.setUpstreamKey(user.id, ['sk', 'ffffffff'.repeat(8)].join('-'))
    check('换 Key 后指纹更新', second.fingerprint !== info.fingerprint)

    store.clearUpstreamKey(user.id)
    check('删除后查不到', store.getUpstreamKey(user.id) === null)
    check('另一个账号不受影响', store.getUpstreamKey(other.id) !== null)
    store.close()
  }

  // ── 8. 日志脱敏 ────────────────────────────────────────
  {
    const fake = ['sk', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')
    const raw = `Bearer ${fake}`
    check('裸 Key 被脱敏', redactSecrets(raw).includes(REDACTED) && !redactSecrets(raw).includes('abcdefghijklmnop'))
    check('带字段名的被脱敏', !redactSecrets(`x-deepseek-key: ${fake}`).includes('abcdefghijklmnop'))
    check('JSON 里的 key 被脱敏', !redactSecrets(`{"key":"${fake}"}`).includes('abcdefghijklmnop'))
    check('普通文本不受影响', redactSecrets('我今天想学 Python') === '我今天想学 Python')
    check('空串安全', redactSecrets('') === '')
  }

  console.log(`\n=== PASS=${pass}  FAIL=${fail} ===`)
if (fail > 0) {
  process.exitCode = 1
}
