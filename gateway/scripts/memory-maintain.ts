/**
 * 记忆维护：相似合并 + 现状报告。
 *
 * 为什么不放在请求路径里：相似比较是 O(n²) 级别，跑在对话里会拖慢每一轮。
 * 做成手动/定期脚本，一次性做完即可。
 *
 * 用法：
 *   node scripts/memory-maintain.ts            # 只报告
 *   node scripts/memory-maintain.ts --merge    # 报告 + 执行相似合并
 *   node scripts/memory-maintain.ts --merge 0.9  # 指定相似度阈值
 */
import { MemoryStore } from '../src/memory/store.ts'

const args = process.argv.slice(2)
const doMerge = args.includes('--merge')
const thresholdArg = args.find((arg) => /^0\.\d+$/.test(arg))
const threshold = thresholdArg ? Number(thresholdArg) : 0.85

const main = () => {
  const store = new MemoryStore({
    dbPath: process.env.MEMORY_DB_PATH ?? '/var/lib/ds-gateway/memory.db',
  })

  const before = store.stats()
  console.log('=== 当前状态 ===')
  console.log('  会话:', before.sessions, ' 消息:', before.messages, ' 切片:', before.chunks)
  console.log('  有使用痕迹的切片:', before.usageRows)
  console.log('  向量检索:', store.vectorEnabled ? '已启用' : '未配置')

  if (!doMerge) {
    console.log('\n（只报告。要执行相似合并请加 --merge）')
    store.close()
    return
  }

  console.log(`\n=== 执行相似合并（阈值 ${threshold}）===`)
  const started = Date.now()
  const result = store.consolidate(threshold)
  console.log('  扫描切片:', result.scanned)
  console.log('  合并组数:', result.groups)
  console.log('  删除重复:', result.removed)
  console.log('  耗时:', Date.now() - started, 'ms')

  const after = store.stats()
  console.log('\n=== 合并后 ===')
  console.log('  切片:', after.chunks, `（减少 ${before.chunks - after.chunks}）`)
  console.log('  使用痕迹:', after.usageRows)
  store.close()
}

main()
