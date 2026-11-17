/**
 * 记忆切片。
 *
 * 为什么不能整条消息存：一条长回复可能几千字，检索命中后整段塞进上下文太浪费。
 * 为什么要重叠：避免把一句话从中间切断，导致「问 A 能看到前半句、问 B 只看到后半句」。
 */

/** 单个切片的目标上限（字符）。中文 1 字 ≈ 1 token，500 字约 500 token */
export const CHUNK_MAX_CHARS = 500
/** 相邻切片的重叠长度 */
export const CHUNK_OVERLAP_CHARS = 80
/** 太短的碎片没有独立价值，直接并到上一个切片里 */
export const CHUNK_MIN_CHARS = 40

/** 句子边界：中英文标点、换行。切在这里语义最完整 */
const BOUNDARY = /(?<=[。！？；：\n!?;:])/u

/**
 * 把文本切成带重叠的片段。
 *
 * 策略：先按句子边界切，再贪心拼接直到接近上限。
 * 不用固定窗口硬切——那会把「数据库选了 SQLite，因为……」切断，
 * 导致检索到半句话，模型看到的也是半句话。
 */
export const splitIntoChunks = (text: string): string[] => {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) {
    return []
  }
  if (clean.length <= CHUNK_MAX_CHARS) {
    return [clean]
  }

  const sentences = clean.split(BOUNDARY).filter((part) => part.length > 0)
  const chunks: string[] = []
  let buffer = ''

  const flush = () => {
    const trimmed = buffer.trim()
    if (trimmed) {
      chunks.push(trimmed)
    }
    // 下一块从上一块的尾部开始，保留上下文衔接
    buffer = trimmed.length > CHUNK_OVERLAP_CHARS ? trimmed.slice(-CHUNK_OVERLAP_CHARS) : trimmed
  }

  for (const sentence of sentences) {
    // 单句就超上限（例如一整段代码）：只能硬切，但保留重叠
    if (sentence.length > CHUNK_MAX_CHARS) {
      if (buffer.trim()) {
        flush()
      }
      for (let i = 0; i < sentence.length; i += CHUNK_MAX_CHARS - CHUNK_OVERLAP_CHARS) {
        chunks.push(sentence.slice(i, i + CHUNK_MAX_CHARS))
      }
      buffer = ''
      continue
    }
    if (buffer.length + sentence.length > CHUNK_MAX_CHARS) {
      flush()
    }
    buffer += sentence
  }

  const tail = buffer.trim()
  // 尾部如果只是上一块的重叠部分，不要重复存
  if (tail && tail.length >= CHUNK_MIN_CHARS && !chunks.at(-1)?.endsWith(tail)) {
    chunks.push(tail)
  }
  return chunks
}
