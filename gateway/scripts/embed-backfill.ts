/**
 * 存量回填：给库里已有的切片补向量。
 *
 * 什么时候要跑：
 *  - 刚配上 embedding 接口时（此前所有切片都没有向量）
 *  - 换了 embedding 模型（维度变了，旧向量会被检索跳过，需要重算）
 *
 * 用法：
 *   MEMORY_EMBED_BASE_URL=... MEMORY_EMBED_API_KEY=... MEMORY_EMBED_MODEL=... \
 *   node scripts/embed-backfill.ts [每批条数]
 *
 * 特性：分批、可中断（已写入的不会重算）、失败不破坏已有数据。
 */
import { MemoryStore } from '../src/memory/store.ts'

const BATCH = Number(process.argv[2] ?? 16)

const main = async () => {
  const store = new MemoryStore({
    dbPath: process.env.MEMORY_DB_PATH ?? '/var/lib/ds-gateway/memory.db',
  })
  if (!store.vectorEnabled) {
    console.error(
      '❌ 未配置 embedding：请设置 MEMORY_EMBED_BASE_URL / MEMORY_EMBED_API_KEY / MEMORY_EMBED_MODEL'
    )
    store.close()
    process.exitCode = 1
    return
  }

  const result = await store.backfillVectors(BATCH, (done, total) => {
    console.log(`  进度 ${done}/${total}`)
  })
  console.log('回填完成：', JSON.stringify(result))
  console.log('统计：', JSON.stringify(store.stats()))
  store.close()
}

await main()
