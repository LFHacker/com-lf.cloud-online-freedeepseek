import * as db from '../db.js'
import type { Session } from '../types.js'
import { EXPORT_FORMAT_VERSION, type Manifest, type SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, imagePath, sessionPath } from './paths.js'
import { toIndexEntry, toSessionFile } from './toArchive.js'
import { writeArchive } from './zipWriter.js'

const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

/**
 * 按导出格式生成 ZIP：manifest → 全部会话 JSON → index → 全部图片。没有账号信息，不写 user.json。
 * 只写出本地有原件的图片，每个会话目录各写一份；其他附件只有元数据。
 */
export const exportArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>
): Promise<Blob> => {
  /**
   * 隐式标识：在导出包的元信息里写明"内容由 AI 生成"与生成工具。
   * 文件离开应用后（发给别人、归档），接收方仍能判断来源。
   */
  const manifest: Manifest = {
    export_format_version: EXPORT_FORMAT_VERSION,
    generated_by: 'freedeepseek',
    generated_at: new Date().toISOString(),
    content_notice: 'AI 生成内容：本包中的助手回复由人工智能模型生成，可能不准确。',
  }
  const entries = [{ name: MANIFEST_PATH, blob: json(manifest) }]
  const imageEntries: { name: string; blob: Blob }[] = []
  const index: SessionIndexEntry[] = []
  const originals = new Map<string, Blob | undefined>()
  for await (const session of sessions) {
    for (const message of session.messages) {
      if (message.role === 'user') {
        for (const file of message.files) {
          if (file.isImage && !originals.has(file.id)) {
            originals.set(file.id, await db.loadFile(file.id))
          }
        }
      }
    }
    const images = new Map<string, Blob>()
    const data = toSessionFile(session, ({ id, name, isImage }) => {
      const blob = originals.get(id)
      if (!blob || !isImage) {
        return null
      }
      const path = imagePath(session.id, id, name)
      images.set(path, blob)
      return path
    })
    entries.push({ name: sessionPath(session.id), blob: json(data) })
    for (const [name, blob] of images) {
      imageEntries.push({ name, blob })
    }
    index.push(toIndexEntry(data))
  }
  entries.push({ name: INDEX_PATH, blob: json(index) })
  return writeArchive(entries.concat(imageEntries))
}
