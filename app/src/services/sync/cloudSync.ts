/**
 * 云端全量同步的**运行状态**（不在任何组件里）。
 *
 * 为什么必须离开组件：
 *   设置弹窗是 `open ? <Modal> : null`，一关就卸载，`useState` 全丢。
 *   而同步是个几分钟的活儿（1000 条会话 + 800 张图），它不会因为弹窗关掉就停 ——
 *   于是回来之后界面显示"没在跑"，再点一次又因为旧锁还在而毫无反应（真实现象）。
 *
 * 所以：运行状态放这里（模块级 zustand），组件只做投影。
 * 关掉设置、切到别的会话、甚至切到后台再回来，看到的都是同一份进度。
 */
import { create } from 'zustand'
import type { FullSyncProgress } from './full.js'

export type CloudSyncState = {
  running: boolean
  /** null = 还没开始过 */
  progress: FullSyncProgress | null
  /** 最近一次完成的结果；running 时为 null */
  result: import('./full.js').FullSyncResult | null
  error: string | null
  startedAt: number
}

export const useCloudSync = create<CloudSyncState>(() => ({
  running: false,
  progress: null,
  result: null,
  error: null,
  startedAt: 0,
}))

/**
 * 开始一次全量同步。
 *
 * 重入保护放在这里（而不是组件里）：无论从哪触发、组件是否还活着，
 * 同一时刻只允许一个同步在跑。
 */
export const startCloudSync = async (): Promise<void> => {
  if (useCloudSync.getState().running) {
    return
  }
  useCloudSync.setState({
    running: true,
    progress: { phase: 'sessions', done: 0, total: 0 },
    result: null,
    error: null,
    startedAt: Date.now(),
  })
  try {
    // 动态 import：避免启动时就加载整条推送链路
    const { pushEverything } = await import('./full.js')
    const result = await pushEverything((progress) => {
      useCloudSync.setState({ progress })
    })
    useCloudSync.setState({ running: false, result, progress: null })
  } catch (error) {
    useCloudSync.setState({
      running: false,
      progress: null,
      error: error instanceof Error && error.message ? error.message : '同步失败',
    })
  }
}
