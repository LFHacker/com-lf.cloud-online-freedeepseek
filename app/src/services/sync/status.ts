/**
 * 同步状态的单一来源（阶段 2-3）：顶部状态条只读这里。
 *
 * 为什么单独一个 store：状态条与业务模块没有引用关系，
 * 谁都不该为了"让条子变色"去 import 聊天 store（那会把 cycle 引回来）。
 */
import { create } from 'zustand'

export type SyncPhase =
  /** 一切正常且没有待办 —— 状态条隐藏 */
  | 'idle'
  /** 正在拉清单 / 推送 */
  | 'syncing'
  /** 失败过，正在等退避重试 */
  | 'retrying'
  /** 明确知道离线（没有网络或请求根本没到服务端） */
  | 'offline'
  /** 不可重试的失败（401/413/数据异常），要用户处理 */
  | 'error'

export type SyncState = {
  phase: SyncPhase
  /** 上一次完整成功的时间戳 */
  lastSyncedAt: number | null
  /** 下一次自动重试的时间（0 = 没有排期） */
  retryAt: number
  /** 连续失败次数 */
  failures: number
  /** 给用户看的原因 */
  message: string | null
}

export const useSync = create<SyncState>(() => ({
  phase: 'idle',
  lastSyncedAt: null,
  retryAt: 0,
  failures: 0,
  message: null,
}))

export const setSync = (patch: Partial<SyncState>): void => {
  useSync.setState(patch)
}

/** 记录一次可重试失败：phase/retryAt/failures 一起更新，避免三处各写一遍写歪 */
export const markRetry = (failures: number, retryAt: number, message: string | null): void => {
  useSync.setState({
    phase: failures <= 1 ? 'retrying' : 'offline',
    retryAt,
    failures,
    message,
  })
}
