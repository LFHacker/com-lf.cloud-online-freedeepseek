/**
 * OCR 结果的本地落盘存储。
 *
 * 为什么不用数据库：第 5 步只需要"存下来、能按 id 取回"，文件足够；
 * 第 6 步做切块检索时再引入 SQLite/向量库，那时迁移也只是换一层读写实现。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OcrDocument, OcrSummary } from './ocr.ts'
import { summarizeDocument } from './ocr.ts'

/**
 * 只允许安全字符，并显式拒绝 `..`。
 * 文档 id 来自上游响应，直接拼进路径等于把路径穿越的入口交给别人。
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const isSafeId = (id: string): boolean => SAFE_ID.test(id) && !id.includes('..')

export type OcrStore = {
  save(document: OcrDocument): Promise<void>
  load(id: string): Promise<OcrDocument | null>
  list(): Promise<OcrSummary[]>
  remove(id: string): Promise<boolean>
  dir: string
}

export const createOcrStore = (dir: string): OcrStore => {
  const pathOf = (id: string) => join(dir, `${id}.json`)

  return {
    dir,

    async save(document) {
      if (!isSafeId(document.id)) {
        throw new Error(`不安全的文档 id: ${document.id}`)
      }
      await mkdir(dir, { recursive: true })
      await writeFile(pathOf(document.id), JSON.stringify(document), 'utf8')
    },

    async load(id) {
      if (!isSafeId(id)) {
        return null
      }
      try {
        const text = await readFile(pathOf(id), 'utf8')
        return JSON.parse(text) as OcrDocument
      } catch {
        return null
      }
    },

    async list() {
      let files: string[]
      try {
        files = await readdir(dir)
      } catch {
        // 目录还不存在属于正常情况（一次都没上传过）
        return []
      }
      const summaries: OcrSummary[] = []
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue
        }
        const id = file.slice(0, -'.json'.length)
        if (!isSafeId(id)) {
          continue
        }
        // 逐条容错：单条记录损坏或来自旧版本（缺字段）不能连累整个列表
        try {
          const document = await this.load(id)
          if (document) {
            summaries.push(summarizeDocument(document))
          }
        } catch {
          continue
        }
      }
      // 新的在前
      return summaries.sort((a, b) => b.createdAt - a.createdAt)
    },

    async remove(id) {
      if (!isSafeId(id)) {
        return false
      }
      try {
        await rm(pathOf(id))
        return true
      } catch {
        return false
      }
    },
  }
}
