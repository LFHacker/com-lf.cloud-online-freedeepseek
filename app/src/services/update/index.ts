/**
 * 应用内更新（JS 侧）：只做流程编排与协议转换，真正的下载/补丁/安装都在原生插件里
 * （`android-app/.../update/AppUpdatePlugin.java`）。
 *
 * 为什么流程放在 JS 而不是原生：
 *  · 版本比较、补丁优先级、失败回退这些是**产品逻辑**，用 TS 改起来快、可单测
 *  · 原生只管四件不依赖业务的事：查清单、下载、打补丁、唤起安装
 *
 * 失败策略（BACKLOG 里定的硬要求）：
 *   补丁下载失败 / 打补丁失败 / 产物哈希不符 / 签名不符 → **自动改下全量**。
 *   绝不允许出现"打完补丁装不上"把用户卡死在旧版本。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { apiOrigin } from '../api/client.js'

export type PatchInfo = { file: string; size: number; sha256: string }

export type UpdateManifest = {
  channel: string
  version: string
  versionCode: number
  apk: string
  size: number
  sha256: string
  notes?: string
  publishedAt?: string
  /** 旧版本 → 补丁（服务端只给最近几个版本生成） */
  patches?: Record<string, PatchInfo>
  /** 原生插件补上的下载基址：<base>/update/file/ */
  fileBaseUrl: string
}

export type UpdateProgress = {
  phase: 'download' | 'patch'
  name: string
  received: number
  total: number
}

export type UpdateOutcome =
  | { kind: 'unsupported' }
  | { kind: 'up-to-date'; version: string }
  | { kind: 'launched'; version: string; viaPatch: boolean; savedBytes: number }
  | { kind: 'needs-permission'; version: string }
  | { kind: 'failed'; message: string }

type FileResult = { name: string; path: string; size: number; sha256: string }

type AppUpdatePlugin = {
  getInfo(): Promise<{
    versionName: string
    versionCode: number
    packageName: string
    apkPath: string
    cacheDir: string
    canInstall: boolean
    sdk: number
  }>
  checkManifest(options: { baseUrl: string; channel: string }): Promise<UpdateManifest>
  download(options: {
    url: string
    name: string
    sha256?: string
    size?: number
  }): Promise<FileResult>
  applyPatch(options: {
    patchName: string
    targetName: string
    sha256?: string
    size?: number
  }): Promise<FileResult>
  install(options: { name: string }): Promise<{ launched: boolean; needsPermission: boolean }>
  openInstallPermission(): Promise<void>
  cancel(): Promise<void>
  clearCache(): Promise<{ removed: number }>
  addListener(
    eventName: 'progress',
    listener: (event: UpdateProgress) => void
  ): Promise<{ remove: () => Promise<void> }>
}

const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate')

/** 这个平台支持不支持应用内更新（只有 Android 原生壳有安装权限） */
export const isUpdateSupported = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

/** 本机安装信息（版本、能否安装未知来源） */
export const getAppInfo = async () => {
  if (!isUpdateSupported()) {
    return null
  }
  return AppUpdate.getInfo()
}

/** 拉清单（原生请求，绕开 WebView 的 CORS 与网络限制） */
export const fetchManifest = async (channel: string): Promise<UpdateManifest | null> => {
  if (!isUpdateSupported()) {
    return null
  }
  return AppUpdate.checkManifest({ baseUrl: apiOrigin(), channel })
}

export const openInstallPermission = async (): Promise<void> => {
  if (isUpdateSupported()) {
    await AppUpdate.openInstallPermission()
  }
}

export const clearUpdateCache = async (): Promise<void> => {
  if (isUpdateSupported()) {
    await AppUpdate.clearCache().catch(() => undefined)
  }
}

/**
 * 检查 + 下载 + 安装，一条链。
 *
 * @param onProgress 进度回调（下载补丁/下载全量都会报）
 */
export const runUpdate = async (
  channel: string,
  onProgress?: (progress: UpdateProgress) => void
): Promise<UpdateOutcome> => {
  if (!isUpdateSupported()) {
    return { kind: 'unsupported' }
  }
  let listener: { remove: () => Promise<void> } | undefined
  try {
    const info = await AppUpdate.getInfo()
    const manifest = await AppUpdate.checkManifest({ baseUrl: apiOrigin(), channel })
    if (!manifest || typeof manifest.versionCode !== 'number') {
      return { kind: 'failed', message: '更新清单格式不对' }
    }
    // 1) 版本号比较用 versionCode（服务端由版本号推导，保证单调递增）
    if (manifest.versionCode <= info.versionCode) {
      return { kind: 'up-to-date', version: info.versionName }
    }
    if (onProgress) {
      listener = await AppUpdate.addListener('progress', onProgress)
    }

    let viaPatch = false
    let target: FileResult | null = null
    const patch = manifest.patches?.[info.versionName]
    if (patch) {
      try {
        // 2) 有对应补丁就先下补丁（通常是全量的 3~4%）
        await AppUpdate.download({
          url: manifest.fileBaseUrl + patch.file,
          name: patch.file,
          sha256: patch.sha256,
          size: patch.size,
        })
        // 3) 打补丁 + 长度/哈希校验（原生里做，产物必须与全量一致）
        target = await AppUpdate.applyPatch({
          patchName: patch.file,
          targetName: manifest.apk,
          sha256: manifest.sha256,
          size: manifest.size,
        })
        viaPatch = true
      } catch {
        // 4) 任何一步失败都回退全量 —— 不能把用户卡在旧版本
        target = null
      }
    }
    if (!target) {
      target = await AppUpdate.download({
        url: manifest.fileBaseUrl + manifest.apk,
        name: manifest.apk,
        sha256: manifest.sha256,
        size: manifest.size,
      })
    }

    // 5) 签名不符在这里就会被拦下（否则点安装必然失败）
    const result = await AppUpdate.install({ name: manifest.apk })
    if (!result.launched && result.needsPermission) {
      return { kind: 'needs-permission', version: manifest.version }
    }
    return {
      kind: 'launched',
      version: manifest.version,
      viaPatch,
      savedBytes: viaPatch ? manifest.size - (patch?.size ?? 0) : 0,
    }
  } catch (error) {
    return {
      kind: 'failed',
      message: error instanceof Error && error.message ? error.message : '更新失败',
    }
  } finally {
    await listener?.remove().catch(() => undefined)
  }
}
