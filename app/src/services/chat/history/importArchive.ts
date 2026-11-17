import * as db from '../db.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import { reportStep } from '../../diagnostics.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (file: File): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    for await (const entry of readArchive(file)) {
      if (entry.path !== MANIFEST_PATH) {
        fail('backupUnrecognized')
      }
      checkManifest(await readJson(entry))
      return
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  fail('backupUnrecognized')
}

/**
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → 全部图片。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
 * 会话读完立即暂存，只保留图片路径映射；图片全部读完后逐会话回填 MIME，不改变图片身份。
 * 写入导入暂存存储；调用方负责先清空暂存，成功后替换正式数据，失败时清理暂存。
 */
/** 进度回调：导入过程中按条目数上报，供界面显示"正在导入 N/M" */
export type ImportProgress = (done: number, total: number) => void

export const importArchive = async (
  file: File,
  onProgress?: ImportProgress,
  onCommit?: () => void,
  /** 取消检查：每个条目之间调用一次，返回 true 就中止 */
  shouldCancel?: () => boolean
): Promise<{ imagesFailed: number }> => {
  reportStep('archive:start', { name: file.name, size: file.size })
  if (!(await isZipFile(file))) {
    reportStep('archive:not-zip')
    fail('backupUnrecognized')
  }
  reportStep('archive:zip-ok')
  const imported = new Set<string>()
  /**
   * 图片读失败的计数。
   *
   * 为什么不让它整体失败：真机实测跑到 1500/1823 时，来源临时文件被系统回收，
   * 之后每次读都抛 NotFoundError —— 如果直接抛，前面 3 分多钟的导入全部作废。
   * 图片是"锦上添花"，对话文本才是记忆的主体，所以这里容忍图片失败并计数上报。
   */
  let imagesFailed = 0
  const images = new Map<string, string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined

  /**
   * 批量写图片。
   *
   * 原来是"读一张 → 开一个 IndexedDB 事务写一张"，810 张图就是 810 个事务。
   * 真机日志显示每 100 个条目要 10~15 秒，而且读到第 1500 条时来源临时文件
   * 被系统回收（Chrome: "A requested file or directory could not be found"）——
   * 导入越慢越容易被回收，所以这里攒够一批再一次性写。
   */
  const IMAGE_BATCH = 8
  const pendingFiles: Array<{ id: string; blob: Blob }> = []
  const flushImages = async () => {
    if (pendingFiles.length === 0) {
      return
    }
    const batch = pendingFiles.splice(0, pendingFiles.length)
    await db.saveStagingFiles(batch)
  }

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const data = await readEntry(entry)
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    pendingFiles.push({ id, blob: new Blob([data], { type }) })
    stored.set(id, type)
    if (pendingFiles.length >= IMAGE_BATCH) {
      await flushImages()
    }
  }

  try {
    let seen = 0
    for await (const entry of readArchive(file, onProgress)) {
      seen += 1
      if (shouldCancel?.()) {
        reportStep('archive:cancelled', { seen })
        fail('backupCancelled')
      }
      // 只报关键节点：第一条证明"确实开始读了"，之后每 100 条一次心跳
      if (seen === 1) {
        reportStep('archive:first-entry', { path: entry.path })
      } else if (seen % 100 === 0) {
        reportStep('archive:progress', { seen })
      }
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        currentSessionId = sessionId
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
        }
        await db.addStagingSession(local.session)
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
      } else if (
        index
          ? imported.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(path)
        if (id === undefined) {
          // 未被引用的图片只走一遍校验；源文件没了也不必中断
          try {
            await skipEntry(entry)
          } catch {
            // 忽略：这张图本来就不保存
          }
        } else {
          try {
            await saveImage(entry, id)
          } catch (error) {
            imagesFailed += 1
            if (imagesFailed <= 3) {
              reportStep('archive:image-error', {
                path,
                message: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
      } else {
        fail('backupIncomplete')
      }
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // index 只列出成功写出的会话，与会话文件一一对应。
  //
  // ⚠️ 官方导出（export_format_version 3）**没有 chat_session_index.json**。
  // 原来这里写的是 `if (!index || ...) fail('backupIncomplete')`，
  // 于是官方包永远在最后一步被判「备份不完整」—— 这正是"点导入没反应"的根因。
  // 现在：有 index 就按它校验一致性；没有就以实际导入到的会话为准。
  if (index) {
    const listed = new Set(index.map((entry) => entry.id))
    if (
      listed.size !== index.length ||
      listed.size !== imported.size ||
      [...imported].some((id) => !listed.has(id))
    ) {
      fail('backupIncomplete')
    }
  }
  // 把最后不足一批的图片刷进暂存
  await flushImages()
  reportStep('archive:done', { sessions: imported.size, images: images.size, imagesFailed })
  await db.updateStagingFileTypes(stored)
  onCommit?.()
  return { imagesFailed }
}
