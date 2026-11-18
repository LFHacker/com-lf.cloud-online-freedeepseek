/**
 * 每用户一个记忆库文件。
 *
 * 为什么不在六张表上加 user_id：
 *   加列意味着**每一次查询**都要记得带 `where user_id = ?`，
 *   漏一处就是跨用户数据泄露，而且这种漏洞在测试里很容易被现有用例掩盖。
 *   一个用户一个 SQLite 文件则是**结构上不可能串**：
 *   即使某处查询写错，它也只可能读到同一个用户的数据。
 *
 * 代价：用户多了以后文件多、备份要遍历目录（备份脚本已相应调整）。
 * 对「自用 + 少数几个账号」这个规模，安全性远比那点开销重要。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MemoryStore } from './store.ts'

export type RegistryOptions = {
  /** 每个用户一个子目录，路径为 <dataDir>/<userId>/memory.db */
  dataDir: string
  maxHits: number
  maxChars: number
  /** 多用户改造之前的单库；首次启动时会被吸收到管理员账号下 */
  legacyPath?: string
}

const safeUserId = (id: string): string => {
  // id 由服务端生成（u_ + hex），这里再挡一层：任何非法字符都不许进入路径
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(id)) {
    throw new Error(`非法的用户 id：${id}`)
  }
  return id
}

export class MemoryRegistry {
  private readonly stores = new Map<string, MemoryStore>()

  private readonly options: RegistryOptions

  constructor(options: RegistryOptions) {
    this.options = options
    mkdirSync(options.dataDir, { recursive: true })
  }

  pathFor(userId: string): string {
    return join(this.options.dataDir, safeUserId(userId), 'memory.db')
  }

  /** 取（并缓存）某个用户的记忆库；不存在就建一个空库 */
  get(userId: string): MemoryStore {
    const cached = this.stores.get(userId)
    if (cached) {
      return cached
    }
    const path = this.pathFor(userId)
    mkdirSync(dirname(path), { recursive: true })
    const store = new MemoryStore({
      dbPath: path,
      maxHits: this.options.maxHits,
      maxChars: this.options.maxChars,
    })
    this.stores.set(userId, store)
    return store
  }

  /** 该用户是否已经有自己的库文件（迁移判断用） */
  exists(userId: string): boolean {
    return existsSync(this.pathFor(userId))
  }

  /**
   * 把改造前的单库吸收到某个用户名下。
   *
   * 用 `VACUUM INTO` 而不是直接 mv：
   *  - WAL 模式下数据库其实是 .db + -wal + -shm 三个文件，直接搬主文件会丢最近的写入
   *  - VACUUM INTO 产出一个干净、已合并 WAL 的单文件
   * 原库改名保留（不删），万一迁移有问题还能退回去。
   */
  adoptLegacy(userId: string): { adopted: boolean; reason?: string } {
    const legacy = this.options.legacyPath
    if (!legacy) {
      return { adopted: false, reason: '未配置旧库路径' }
    }
    if (!existsSync(legacy)) {
      return { adopted: false, reason: '旧库不存在' }
    }
    const target = this.pathFor(userId)
    if (existsSync(target)) {
      return { adopted: false, reason: '目标库已存在，不覆盖' }
    }
    mkdirSync(dirname(target), { recursive: true })
    const legacyDb = new DatabaseSync(legacy)
    try {
      legacyDb.exec(`vacuum into '${target.replace(/'/g, "''")}'`)
    } finally {
      legacyDb.close()
    }
    // 原库留档，避免迁移后发现有缺失却无从对比
    const backup = `${legacy}.migrated-${Date.now()}`
    try {
      renameSync(legacy, backup)
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${legacy}${suffix}`)) {
          renameSync(`${legacy}${suffix}`, `${backup}${suffix}`)
        }
      }
    } catch {
      // 改名失败不影响已生成的副本
    }
    return { adopted: true }
  }

  /** 概览：用户数、总大小（管理接口用） */
  stats(userIds: string[]): { users: number; bytes: number } {
    let bytes = 0
    for (const id of userIds) {
      try {
        bytes += statSync(this.pathFor(id)).size
      } catch {
        // 没有库文件的用户不计
      }
    }
    return { users: userIds.length, bytes }
  }

  closeAll(): void {
    for (const store of this.stores.values()) {
      try {
        store.close()
      } catch {
        // 关闭失败不影响进程退出
      }
    }
    this.stores.clear()
  }
}
