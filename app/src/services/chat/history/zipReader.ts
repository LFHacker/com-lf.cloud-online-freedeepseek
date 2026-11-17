import { Inflate } from 'fflate'

const READ_CHUNK_BYTES = 256 * 1024
// 控制每轮同步解压的工作量；输出交给调用方保存后才继续读取。
const INFLATE_CHUNK_BYTES = 8 * 1024

/** ZIP 结构损坏或使用了不支持的特性 */
export class ArchiveError extends Error {
  constructor() {
    super('Invalid or unsupported history archive')
    this.name = 'ArchiveError'
  }
}

const invalid = (): never => {
  throw new ArchiveError()
}

/** 本地文件头签名 PK\x03\x04，用于在解析前区分 ZIP 与其他文件。 */
import { reportStep } from '../../diagnostics.js'

export const isZipFile = async (file: File) => {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return bytes.length === 4 && bytes.every((byte, index) => byte === [0x50, 0x4b, 3, 4][index])
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const readBytes = async (file: File, start: number, length: number) => {
  if (start < 0 || length < 0 || start + length > file.size) {
    invalid()
  }
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer())
  if (bytes.length !== length) {
    invalid()
  }
  return bytes
}

/** ZIP64、分卷与加密文件不属于导出格式，一律拒绝。 */
const checkExtra = (bytes: Uint8Array) => {
  const view = viewOf(bytes)
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length || view.getUint16(offset, true) === 1) {
      invalid()
    }
    offset += 4 + view.getUint16(offset + 2, true)
    if (offset > bytes.length) {
      invalid()
    }
  }
}

const decodePath = (bytes: Uint8Array, flags: number) => {
  // 非 UTF-8 编码的 ZIP 文件名仅接受 ASCII，确保附件路径解码准确。
  if (!(flags & 0x800) && bytes.some((byte) => byte > 0x7f)) {
    invalid()
  }
  const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
  if (!path || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) {
    invalid()
  }
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    invalid()
  }
  return path
}

type Entry = {
  path: string
  name: Uint8Array
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
}

const readDirectory = async (file: File): Promise<{ entries: Entry[]; offset: number }> => {
  if (file.size < 22) {
    invalid()
  }
  const tailStart = Math.max(0, file.size - 22 - 0xffff)
  const tail = await readBytes(file, tailStart, file.size - tailStart)
  const tailView = viewOf(tail)
  let end = tail.length - 22
  while (
    end >= 0 &&
    (tailView.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + tailView.getUint16(end + 20, true) !== tail.length)
  ) {
    end--
  }
  if (end < 0) {
    invalid()
  }
  const count = tailView.getUint16(end + 10, true)
  const size = tailView.getUint32(end + 12, true)
  const offset = tailView.getUint32(end + 16, true)
  if (
    tailView.getUint16(end + 4, true) !== 0 ||
    tailView.getUint16(end + 6, true) !== 0 ||
    tailView.getUint16(end + 8, true) !== count ||
    count === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    offset + size !== tailStart + end
  ) {
    invalid()
  }
  const entries: Entry[] = []
  const paths = new Set<string>()
  let cursor = 0
  /**
   * ⚠️ 一次性读完整份中央目录，而不是每条目读 3 次。
   *
   * 原来是每条目做 3 次 `file.slice().arrayBuffer()`（46 字节头 + 文件名 + extra），
   * 1823 个条目 ≈ 5400 次 blob 读。桌面每次不到 1ms 所以从没暴露；
   * 真机（Android WebView）每次十几毫秒，光读目录就要几十秒 ——
   * 实测日志里 `zip:read-directory-start` 之后 41 秒没有任何后续打点，看起来就像卡死。
   * 中央目录通常只有几百 KB，一次读完最省。
   */
  const directoryBytes = await readBytes(file, offset, size)
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size) {
      invalid()
    }
    const view = viewOf(directoryBytes.subarray(cursor, cursor + 46))
    if (view.getUint32(0, true) !== 0x02014b50) {
      invalid()
    }
    const flags = view.getUint16(8, true)
    const method = view.getUint16(10, true)
    const compressedSize = view.getUint32(20, true)
    const entrySize = view.getUint32(24, true)
    const nameLength = view.getUint16(28, true)
    const extraLength = view.getUint16(30, true)
    const next = cursor + 46 + nameLength + extraLength + view.getUint16(32, true)
    const entryOffset = view.getUint32(42, true)
    // 只允许 deflate 选项、data descriptor 与 UTF-8 标志。
    if (
      flags & ~0x80e ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      entrySize === 0xffffffff ||
      (method === 0 && compressedSize !== entrySize) ||
      entryOffset >= offset ||
      view.getUint16(34, true) !== 0 ||
      ((view.getUint32(38, true) >>> 16) & 0xf000) === 0xa000 ||
      next > size
    ) {
      invalid()
    }
    const name = directoryBytes.slice(cursor + 46, cursor + 46 + nameLength)
    const path = decodePath(name, flags)
    // 目录和同名文件也不能互相覆盖。
    const identity = path.endsWith('/') ? path.slice(0, -1) : path
    if (paths.has(identity) || (path.endsWith('/') && entrySize !== 0)) {
      invalid()
    }
    paths.add(identity)
    checkExtra(directoryBytes.slice(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength))
    entries.push({
      path,
      name,
      flags,
      method,
      crc: view.getUint32(16, true),
      compressedSize,
      size: entrySize,
      offset: entryOffset,
    })
    cursor = next
  }
  if (cursor !== size) {
    invalid()
  }
  return { entries: entries.sort((a, b) => a.offset - b.offset), offset }
}

const readEntryOffset = async (file: File, entry: Entry, boundary: number) => {
  if (entry.offset + 30 > boundary) {
    invalid()
  }
  const view = viewOf(await readBytes(file, entry.offset, 30))
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  const start = entry.offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(6, true) !== entry.flags ||
    view.getUint16(8, true) !== entry.method ||
    nameLength !== entry.name.length ||
    end > boundary
  ) {
    invalid()
  }
  for (const [position, expected] of [
    [14, entry.crc],
    [18, entry.compressedSize],
    [22, entry.size],
  ]) {
    const actual = view.getUint32(position, true)
    if (actual !== expected && (!(entry.flags & 8) || actual !== 0)) {
      invalid()
    }
  }
  const metadata = await readBytes(file, entry.offset + 30, nameLength + extraLength)
  if (entry.name.some((byte, index) => byte !== metadata[index])) {
    invalid()
  }
  checkExtra(metadata.subarray(nameLength))
  if (entry.flags & 8) {
    if (end + 12 > boundary) {
      invalid()
    }
    const descriptor = viewOf(await readBytes(file, end, Math.min(16, boundary - end)))
    const shift = descriptor.getUint32(0, true) === 0x08074b50 ? 4 : 0
    if (
      shift + 12 > descriptor.byteLength ||
      descriptor.getUint32(shift, true) !== entry.crc ||
      descriptor.getUint32(shift + 4, true) !== entry.compressedSize ||
      descriptor.getUint32(shift + 8, true) !== entry.size
    ) {
      invalid()
    }
  }
  return start
}

export type ArchiveEntry = {
  path: string
  size: number
  stream: AsyncIterable<Uint8Array>
}

/**
 * 按条目在文件中的物理顺序逐条、逐块解压，跳过目录条目。
 * 调用方必须消费完当前条目的数据，再请求下一个条目。
 */
/**
 * 逐个产出条目（流式，不会把整个包读进内存）。
 *
 * `onProgress(done, total)` 用于大包（官方导出 224 MB / 1800+ 条目）的进度显示 ——
 * 没有进度的话，手机上导 190 MB 图片会长时间黑屏等待，用户只会以为"卡死了"。
 */
export async function* readArchive(
  file: File,
  onProgress?: (done: number, total: number) => void
): AsyncGenerator<ArchiveEntry> {
  // 读中央目录是导入第一步，也最容易在真机上卡住（大文件 + 受限的文件句柄）
  reportStep('zip:read-directory-start', { size: file.size })
  const directory = await readDirectory(file)
  reportStep('zip:read-directory-ok', { entries: directory.entries.length })
  const total = directory.entries.reduce((sum, item) => (item.path.endsWith('/') ? sum : sum + 1), 0)
  let done = 0
  for (const [index, entry] of directory.entries.entries()) {
    const boundary = directory.entries[index + 1]?.offset ?? directory.offset
    const start = await readEntryOffset(file, entry, boundary)
    if (entry.path.endsWith('/')) {
      continue
    }
    done += 1
    onProgress?.(done, total)
    let completed = false
    const stream = async function* (): AsyncGenerator<Uint8Array> {
      let written = 0
      let crc = 0xffffffff
      const pending: Uint8Array[] = []
      const append = (chunk: Uint8Array) => {
        written += chunk.length
        if (written > entry.size) {
          invalid()
        }
        for (const byte of chunk) {
          crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
        }
        if (chunk.length) {
          pending.push(chunk)
        }
      }
      const inflate = entry.method === 8 ? new Inflate(append) : null
      /**
       * 单次读取上限。
       *
       * 原来是固定 256 KB 分块：一张 235 KB 的图片要 1 次读、1 MB 的会话要 4 次读。
       * 真机日志显示每 100 个条目要 10~15 秒，而导入跑到第 1500 条时
       * 来源临时文件被系统回收（Chrome: "A requested file or directory could not be found"）。
       * **速度直接决定成败**：读得越快，越不容易在半路被回收。
       * 所以常见体积（<8 MB）改为一次读完，把每条读取次数压到 1 次。
       */
      const SINGLE_READ_LIMIT = 8 * 1024 * 1024
      if (entry.compressedSize > 0 && entry.compressedSize <= SINGLE_READ_LIMIT) {
        const whole = await readBytes(file, start, entry.compressedSize)
        if (!inflate) {
          append(whole)
          yield* pending.splice(0)
        } else {
          for (let cursor = 0; cursor < whole.length; cursor += INFLATE_CHUNK_BYTES) {
            const end = Math.min(cursor + INFLATE_CHUNK_BYTES, whole.length)
            inflate.push(whole.subarray(cursor, end), end === whole.length)
            yield* pending.splice(0)
          }
        }
      } else {
        for (let offset = 0; offset < entry.compressedSize; offset += READ_CHUNK_BYTES) {
          const chunk = await readBytes(
            file,
            start + offset,
            Math.min(READ_CHUNK_BYTES, entry.compressedSize - offset)
          )
          if (!inflate) {
            append(chunk)
            yield* pending.splice(0)
            continue
          }
          for (let cursor = 0; cursor < chunk.length; cursor += INFLATE_CHUNK_BYTES) {
            const end = Math.min(cursor + INFLATE_CHUNK_BYTES, chunk.length)
            inflate.push(chunk.subarray(cursor, end), offset + end === entry.compressedSize)
            // yield 暂停解压，等待调用方完成异步写入；不缓存整个条目。
            yield* pending.splice(0)
          }
        }
      }
      if (inflate && entry.compressedSize === 0) {
        inflate.push(new Uint8Array(), true)
        yield* pending.splice(0)
      }
      if (written !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
        invalid()
      }
      completed = true
    }
    yield { path: entry.path, size: entry.size, stream: stream() }
    if (!completed) {
      invalid()
    }
  }
}

/** 读出整个条目：会话 JSON 需要完整解析，图片需要识别类型后整张保存。 */
export const readEntry = async (entry: ArchiveEntry): Promise<Blob> => {
  const parts: Blob[] = []
  for await (const chunk of entry.stream) {
    parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]))
  }
  return new Blob(parts)
}

/** 不需要的条目也要读完，以校验大小与 CRC。 */
export const skipEntry = async (entry: ArchiveEntry): Promise<void> => {
  const reader = entry.stream[Symbol.asyncIterator]()
  while (!(await reader.next()).done) {
    // 丢弃数据。
  }
}
