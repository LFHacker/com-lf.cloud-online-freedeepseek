import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */

/**
 * 导入阶段的粗粒度上报。
 *
 * 为什么需要：真实反馈是「上传后按钮变灰、什么都没有」—— 说明导入开始了但卡在早期，
 * 而按条目上报的进度那时还没开始触发，界面上就一直是空白，看不出卡在哪一步。
 */
export type ImportStage = 'check' | 'prepare' | 'copy' | 'read' | 'commit'

export const importHistory = (
  file: File,
  onProgress?: (done: number, total: number) => void,
  onStage?: (stage: ImportStage) => void,
  shouldCancel?: () => boolean
): Promise<{ count: number; imagesFailed: number; imagesStored: number }> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    const db = await import('./db.js')
    onStage?.('check')
    await checkArchiveFormat(file)
    onStage?.('prepare')

    /**
     * 先把源文件复制成稳定副本。
     *
     * 安卓给的是缓存里的临时副本，系统随时清理；实测两次分别在 1500 条和 100 条时被清，
     * 报 NotFoundError。而且我们往 IndexedDB 写得越多，缓存压力越大，源文件被清得越早。
     * 所以大文件先整份存进 IndexedDB（持久存储，不受缓存清理影响），后续全都读这份副本。
     */
    const SOURCE_COPY_ID = '__import_source__'
    let source: File = file
    let copied = false
    if (file.size > 32 * 1024 * 1024) {
      onStage?.('copy')
      try {
        await db.saveSourceCopy(SOURCE_COPY_ID, file)
        const blob = await db.loadSourceCopy(SOURCE_COPY_ID)
        if (blob) {
          source = new File([blob], file.name, { type: file.type })
          copied = true
        }
      } catch {
        // 复制失败就退回直接读原文件（至少还有机会）
        source = file
      }
    }

    let imagesFailed = 0
    let imagesStored = 0
    try {
      const count = await replaceHistory(async () => {
        onStage?.('read')
        const result = await importArchive(source, onProgress, () => onStage?.('commit'), shouldCancel)
        imagesFailed = result.imagesFailed
        imagesStored = result.imagesStored
      })
      /**
         * 导入成功 → 全量推送到云端（会话 + 全部附件）。
         *
         * 标准 App 的行为：用户导入完就不用管，换设备登录自然什么都在。
         * 这里**不 await**：推送可能要几分钟（191MB 图片），
         * 不该让导入按钮一直转；失败只影响"云端暂缺"，本地数据完好。
         */
        void import('../sync/full.js')
          .then((sync) => sync.pushEverything())
          .catch(() => undefined)
        return { count, imagesFailed, imagesStored }
    } finally {
      if (copied) {
        // 副本占着 200+ MB，无论成败都要删
        await db.deleteSourceCopy(SOURCE_COPY_ID).catch(() => {})
      }
    }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
