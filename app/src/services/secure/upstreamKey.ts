/**
 * DeepSeek 官方 Key 的本地存储。
 *
 * ## 为什么这样设计
 *
 * 用户要求：「官方 Key 只在本地，不上传，服务端不留任何可解出它的东西」。
 * 于是分工是：
 *   · 本地：加密保存原文，每次请求放进 `x-deepseek-key` 头带给网关
 *   · 服务端：转发完成后立刻丢弃，只留一个不可逆指纹
 *
 * ## 加密强度要诚实
 *
 * 主密钥（MasterKey）也在这台设备的 IndexedDB 里，所以这层加密
 * **能挡住**：换一台设备拷走数据库、别的网页脚本偷读 localStorage、随手翻看导出文件
 * **挡不住**：设备被 root / 系统备份被整体导走
 *
 * 真要硬件级不可导出，得把主密钥放进 Android Keystore（需要原生插件）。
 * 这里刻意把读写收敛到这一个模块，将来换成 Keystore 只改实现、不动调用方。
 */

const DB_NAME = 'chat-demo-vault'
const STORE = 'kv'
const MASTER_ID = 'master-key'
const KEY_ID = 'deepseek-key'

/** 解密后的明文只在内存里存在，供请求头同步取用 */
let cached: string | null = null

type Vault = { iv: ArrayBuffer; data: ArrayBuffer }

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const idbGet = async <T,>(id: string): Promise<T | undefined> => {
  const db = await openDb()
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const request = tx.objectStore(STORE).get(id)
      request.onsuccess = () => resolve(request.result as T | undefined)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

const idbPut = async (id: string, value: unknown): Promise<void> => {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

const idbDelete = async (id: string): Promise<void> => {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

const getMasterKey = async (create: boolean): Promise<CryptoKey | null> => {
  const existing = await idbGet<ArrayBuffer>(MASTER_ID)
  if (existing) {
    return crypto.subtle.importKey('raw', existing, 'AES-GCM', false, ['encrypt', 'decrypt'])
  }
  if (!create) {
    return null
  }
  const raw = crypto.getRandomValues(new Uint8Array(32))
  await idbPut(MASTER_ID, raw.buffer)
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** 启动时调用：把 Key 解出来放进内存，供请求头直接取用 */
export const loadUpstreamKey = async (): Promise<string | null> => {
  try {
    const vault = await idbGet<Vault>(KEY_ID)
    if (!vault) {
      cached = null
      return null
    }
    const master = await getMasterKey(false)
    if (!master) {
      cached = null
      return null
    }
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: vault.iv }, master, vault.data)
    cached = new TextDecoder().decode(plain)
    return cached
  } catch {
    // 主密钥丢了（清过站点数据）或密文损坏：当作没配过，让用户重填
    cached = null
    return null
  }
}

/** 保存：加密后写库，同时更新内存缓存 */
export const saveUpstreamKey = async (key: string): Promise<void> => {
  const trimmed = key.trim()
  const master = await getMasterKey(true)
  if (!master) {
    throw new Error('无法创建本地密钥')
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, master, new TextEncoder().encode(trimmed))
  await idbPut(KEY_ID, { iv: iv.buffer, data } satisfies Vault)
  cached = trimmed
}

export const clearUpstreamKey = async (): Promise<void> => {
  await idbDelete(KEY_ID)
  cached = null
}

/** 同步取用：请求头拼装时调用 */
export const cachedUpstreamKey = (): string | null => cached

/** 仅用于界面显示"是否已配置"，不返回原文 */
export const hasUpstreamKey = (): boolean => Boolean(cached)
