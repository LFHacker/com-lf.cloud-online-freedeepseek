/**
 * 推送分片规则（纯函数，方便单测）。
 *
 * 为什么需要：服务端单次请求上限 8 MB，而**条数不等于体积**。
 * 官方导出的会话带思考块与工具结果，单条常见 200~400 KB ——
 * 按"50 条一批"就是 10~20 MB，整批 413；客户端又只看条数，
 * 于是每一批都超，最终**一条都推不上去**（真实事故：导入 1000 会话后云端 0 条）。
 */
/** 单批字节上限：服务端 8 MB，客户端留到 3.5 MB（JSON 包装 + 二分重试的余量） */
export const SPLIT_MAX_BYTES = 3.5 * 1024 * 1024
/** 单批条数上限：体积很小时也别一次几百条 */
export const SPLIT_MAX_ITEMS = 50

export type Sized = { payload: string }

/**
 * 按字节上限 + 条数上限切分，**顺序不变、一条不丢**。
 * 单条自己就超上限时独占一批（交给服务端明确拒绝并计入失败，
 * 而不是把它塞进别的批里连带拖垮一批正常的会话）。
 */
export const splitByBytes = <T extends Sized>(
  items: readonly T[],
  maxBytes = SPLIT_MAX_BYTES,
  maxItems = SPLIT_MAX_ITEMS
): T[][] => {
  const batches: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const item of items) {
    const size = item.payload.length
    if (current.length > 0 && bytes + size > maxBytes) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(item)
    bytes += size
    if (current.length >= maxItems) {
      batches.push(current)
      current = []
      bytes = 0
    }
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}
