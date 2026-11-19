/**
 * 更新提示的状态机。
 *
 * 为什么单独放一个 store（而不是塞进 SettingsDialog）：
 *  · 提示窗要在**任何页面**都能弹出（启动即检查），不能依赖设置页是否挂载
 *  · 关闭弹窗后状态还要保留（避免同一次启动反复弹）
 *
 * 三条克制的规则：
 *  1. 只在**启动**时检查一次，不轮询 —— 更新不是实时需求，轮询只费流量
 *  2. 用户选"稍后"就记住这个版本，同一版本不再骚扰（下次启动才提醒）
 *  3. 检查失败完全静默 —— 网络不好不该给用户添堵
 */
import { create } from 'zustand'
import {
  fetchManifest,
  getAppInfo,
  isUpdateSupported,
  runUpdate,
  type UpdateManifest,
  type UpdateProgress,
} from './index.js'

const DISMISSED_KEY = 'chat-demo:update-dismissed'
/** 正式通道：用户装的是 release 包就走 release 清单 */
const CHANNEL = 'release'

type UpdateStore = {
  /** 有可用更新时的清单；null 表示没有或还没查到 */
  manifest: UpdateManifest | null
  /** 当前安装的版本名，用于弹窗里"1.0.8 → 1.0.11"的对比 */
  currentVersion: string | null
  dialogOpen: boolean
  updating: boolean
  progress: UpdateProgress | null
  /** 更新失败的原因（展示在弹窗里，不弹单独的 alert） */
  error: string | null
  checkOnStart: () => Promise<void>
  openDialog: () => void
  closeDialog: () => void
  start: () => Promise<void>
}

const readDismissed = (): string | null => {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

const writeDismissed = (version: string): void => {
  try {
    localStorage.setItem(DISMISSED_KEY, version)
  } catch {
    // 存不了就算了，最多下次再提醒一次
  }
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  manifest: null,
  currentVersion: null,
  dialogOpen: false,
  updating: false,
  progress: null,
  error: null,

  checkOnStart: async () => {
    // 只有 Android 原生壳能装包；Web/PWA 没有意义的检查就别发请求
    if (!isUpdateSupported()) {
      return
    }
    try {
      const [info, manifest] = await Promise.all([getAppInfo(), fetchManifest(CHANNEL)])
      if (!info || !manifest || typeof manifest.versionCode !== 'number') {
        return
      }
      // 版本比较只认 versionCode：服务端由版本号推导，保证单调递增
      if (manifest.versionCode <= info.versionCode) {
        set({ manifest: null, currentVersion: info.versionName })
        return
      }
      set({ manifest, currentVersion: info.versionName })
      // 用户已对"这个版本"点过稍后 → 本次启动不再弹
      if (readDismissed() === manifest.version) {
        return
      }
      set({ dialogOpen: true })
    } catch {
      // 检查失败静默：更新提示不该因为网络问题变成报错
    }
  },

  openDialog: () => {
    if (get().manifest) {
      set({ dialogOpen: true, error: null })
    }
  },

  closeDialog: () => {
    const version = get().manifest?.version
    if (version) {
      writeDismissed(version)
    }
    set({ dialogOpen: false })
  },

  start: async () => {
    if (get().updating) {
      return
    }
    set({ updating: true, error: null, progress: null })
    try {
      const outcome = await runUpdate(CHANNEL, (progress) => set({ progress }))
      if (outcome.kind === 'failed') {
        set({ updating: false, error: outcome.message })
        return
      }
      if (outcome.kind === 'unsupported') {
        set({ updating: false, error: '当前环境不支持应用内更新' })
        return
      }
      // 成功时会拉起系统安装器，弹窗留着让用户看到"正在安装"
      set({ updating: false, dialogOpen: false })
    } catch (error) {
      set({
        updating: false,
        error: error instanceof Error ? error.message : '更新失败，请稍后再试',
      })
    }
  },
}))
