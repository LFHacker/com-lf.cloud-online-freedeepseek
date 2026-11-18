/**
 * 会话推送队列（防抖）。
 *
 * 为什么需要队列而不是直接推：
 * 一次对话里 `saveSession` 会被调用多次（流式增量、标题更新、置顶），
 * 每次都发请求会把网关和网络打满。这里合并成"最后一次保存后 5 秒推一次"。
 *
 * 为什么单独一个文件：db.ts 需要调用它，而 sync/index.ts 又 import 了 db.ts，
 * 直接互相 import 会形成循环。队列只依赖 sync 的推送函数，单向依赖。
 */
const pending = new Map<string, ReturnType<typeof setTimeout>>()
const DEBOUNCE_MS = 5000

export const queuePushSession = (sessionId: string): void => {
  const existing = pending.get(sessionId)
  if (existing) {
    clearTimeout(existing)
  }
  const timer = setTimeout(() => {
    pending.delete(sessionId)
    // 动态 import：避免启动时就加载整个同步模块
    void import('./index.js')
      .then((sync) => sync.pushSession(sessionId))
      .catch(() => undefined)
  }, DEBOUNCE_MS)
  pending.set(sessionId, timer)
}

/** 立即推一批（导入完成后用），返回成功写入的条数 */
export const pushAllSessions = async (): Promise<number> => {
  const sync = await import('./index.js')
  const { loadSessionSummaries, loadSession } = await import('../chat/db.js')
  const summaries = await loadSessionSummaries()
  const sessions = []
  for (const summary of summaries) {
    const session = await loadSession(summary.id)
    if (session) {
      sessions.push(session)
    }
  }
  return sync.pushSessions(sessions)
}
