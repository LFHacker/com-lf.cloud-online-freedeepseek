import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 12

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/**
 * 云端会话清单缓存（阶段 2-1）。
 *
 * 会话列表**以服务端为准**，这份只是"离线时也能把列表画出来"的副本，
 * 不作为真相来源：联网后一律由 `/sync/sessions` 覆盖。
 */
export type CloudSessionMeta = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
}

/**
 * 待发送消息队列（阶段 2-2）。
 *
 * 一条记录 = 一条"已经打在屏幕上、但服务端还没确认"的用户消息。
 * 存在 IndexedDB 而不是内存：关掉 App / 手机重启之后，这条消息还得能自己发出去，
 * 否则离线期间的输入会静默消失 —— 那比"发送失败"更糟。
 */
export type OutboxRecord = {
  /** = 用户消息 id，天然幂等：同一条消息不会因为重试进入队列两次 */
  id: string
  sessionId: string
  createdAt: number
  /** 已失败的次数，退避时长由它算 */
  attempts: number
  /** 下次允许尝试的时间戳（0 = 立即） */
  nextAttemptAt: number
  /** queued：等待重试；sending：正在发；failed：不可重试（如 401） */
  status: 'queued' | 'sending' | 'failed'
  error?: string
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  /** 云端会话清单的离线副本（阶段 2-1） */
  sessionIndex: { key: string; value: CloudSessionMeta }
  /** 待发送消息队列（阶段 2-2） */
  outbox: { key: string; value: OutboxRecord }
  /** 同步小状态（lastSyncedAt 之类），只存字符串 */
  syncMeta: { key: string; value: { key: string; value: string } }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  /**
   * 附件引用要统计**所有消息**，不能只统计用户消息：
   * 导出的历史里助手消息也会带附件（生成图、工具产物），漏掉它们会导致
   * ① 上传清单少一大半（810 个原件传不上去）② 删会话时误删仍被别的会话引用的原件。
   */
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) => {
        const files = (message as { files?: Array<{ id?: string }> }).files
        return Array.isArray(files) ? files.map((file) => file?.id).filter((id): id is string => typeof id === 'string') : []
      })
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of [
        'sessions',
        'files',
        'sessionsStaging',
        'filesStaging',
        'sessionIndex',
        'outbox',
      ] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      // 同步小状态用 key 作主键（不是 id），单独建
      if (!db.objectStoreNames.contains('syncMeta')) {
        db.createObjectStore('syncMeta', { keyPath: 'key' })
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {

  /**
   * 落库后排队推送到云端（5 秒防抖）。
   * 挂在 saveSession 上是刻意的：一次对话会多次保存（流式增量、标题、置顶），
   * 一个钩子就覆盖全部路径，不会因为新增保存点而漏同步。
   * 推到队列里只是排个定时器，这里不等待，也不影响落库。
   */
  void import('../sync/queue.js')
    .then((queue) => queue.queuePushSession(session.id))
    .catch(() => undefined)
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/**
 * 把**从云端下载**的会话写进缓存。
 *
 * 刻意不复用 saveSession：那个函数会在落库后排队"推回云端"，
 * 而这个正文本来就是云端来的 —— 推回去是纯浪费，
 * 而且会额外制造一批无意义的请求（每次点开会话就一条）。
 */
export const cacheSessionOnly = async (session: Session): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
/** 置顶/取消置顶：会话与摘要两处都要更新，列表才立刻反映。 */
export const setSessionPinned = async (id: string, pinned: boolean): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.pinned = pinned
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/**
 * 本地所有会话引用的附件 id（并集）。
 *
 * 从 **sessionSummaries** 取，不读正文：摘要里已经存了 fileIds，
 * 而 1000 条会话的正文加起来上百 MB —— 为了一个 id 集合去读它不划算。
 */
export const loadSessionFileIds = async (): Promise<Set<string>> => {
  const rows = await (await getDB()).getAll('sessionSummaries')
  const ids = new Set<string>()
  for (const row of rows) {
    for (const id of row.fileIds ?? []) {
      ids.add(id)
    }
  }
  return ids
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

/**
 * 取附件：本地优先，缺失时从云端懒加载并写回本地。
 *
 * 为什么懒加载而不是登录时全下：你的导出包图片有 191 MB，
 * 登录时全下会在移动网络里等很久；而图片只在具体某条消息里才需要。
 */
export const loadFileOrFetch = async (id: string): Promise<Blob | undefined> => {
  const local = await loadFile(id)
  if (local) {
    return local
  }
  const sync = await import('../sync/index.js').catch(() => null)
  if (!sync) {
    return undefined
  }
  const blob = await sync.fetchAttachment(id)
  if (blob) {
    await saveFiles([{ id, blob, name: id } as StoredFile]).catch(() => undefined)
  }
  return blob
}

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 本机实际存了多少个附件原件（用来回答"附件为什么传不上去"） */
export const countStoredFiles = async (): Promise<number> => (await getDB()).count('files')

/**
 * 本机所有附件原件的 id。
 *
 * ⚠️ 为什么不用"会话引用了哪些 id"来推导：官方导出的附件很多挂在**助手消息**上
 * （生成图、工具产物），而摘要里的 fileIds 只统计用户消息 —— 用它做上传清单，
 * 810 个已存在的原件会一个都不被上传（真实事故）。
 * 上传的语义本来就该是"本机有的原件都推上去"，不需要经过会话。
 */
export const listStoredFileIds = async (): Promise<string[]> =>
  (await getDB()).getAllKeys('files') as Promise<string[]>

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

/**
 * 导入源文件的稳定副本。
 *
 * 为什么必须复制：安卓文件选择器给的是缓存里的临时副本，系统随时会清。
 * 实测两次：一次跑到 1500/1823 被清、一次跑到 100/1823 就被清
 * （Chrome 报 NotFoundError: A requested file or directory could not be found）。
 * 而且**我们往 IndexedDB 写得越多，缓存压力越大，源文件被清得越早** —— 恶性循环。
 * 所以先把整份 zip 存进 IndexedDB（持久存储，不受缓存清理影响），
 * 之后所有读取都走这份副本。
 */
export const saveSourceCopy = (id: string, blob: Blob): Promise<void> =>
  putFiles('files', [{ id, blob }])

export const loadSourceCopy = (id: string): Promise<Blob | undefined> => loadFile(id)

export const deleteSourceCopy = async (id: string): Promise<void> => {
  await (await getDB()).delete('files', id)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}

// ── 云端清单缓存 / 待发送队列 / 同步状态（阶段 2） ──────────────

/** 读出上一次拿到的云端清单（离线时先把列表画出来，不要空着等网络） */
export const loadCloudIndex = async (): Promise<CloudSessionMeta[]> =>
  (await getDB()).getAll('sessionIndex')

/** 用最新一份云端清单整体替换缓存；已经不在云端的条目随之消失 */
export const replaceCloudIndex = async (list: CloudSessionMeta[]): Promise<void> => {
  const tx = (await getDB()).transaction('sessionIndex', 'readwrite')
  const store = tx.store
  // 所有请求同步发出，事务才不会在 await 之间被判为空闲而提前提交
  await Promise.all([store.clear(), ...list.map((item) => store.put(item)), tx.done])
}

export const removeCloudIndex = async (ids: readonly string[]): Promise<void> => {
  if (ids.length === 0) {
    return
  }
  const tx = (await getDB()).transaction('sessionIndex', 'readwrite')
  await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
}

export const loadOutbox = async (): Promise<OutboxRecord[]> => (await getDB()).getAll('outbox')

export const putOutbox = async (record: OutboxRecord): Promise<void> => {
  await (await getDB()).put('outbox', record)
}

export const removeOutbox = async (id: string): Promise<void> => {
  await (await getDB()).delete('outbox', id)
}

export const loadSyncMeta = async (): Promise<Record<string, string>> => {
  const rows = await (await getDB()).getAll('syncMeta')
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

export const saveSyncMeta = async (patch: Record<string, string>): Promise<void> => {
  const entries = Object.entries(patch)
  if (entries.length === 0) {
    return
  }
  const tx = (await getDB()).transaction('syncMeta', 'readwrite')
  await Promise.all([
    ...entries.map(([key, value]) => tx.store.put({ key, value })),
    tx.done,
  ])
}
