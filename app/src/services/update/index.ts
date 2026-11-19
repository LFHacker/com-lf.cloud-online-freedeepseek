/**
 * 应用内更新（JS 侧）：流程编排 + **网络 I/O**，真正的写盘/打补丁/安装都在原生插件里
 * （`android-app/.../update/AppUpdatePlugin.java`）。
 *
 * 为什么网络放在 WebView 而不是原生：
 *   真机上实测过「原生 HttpURLConnection 建连即被 reset，而 WebView 用同一个地址、
 *   同一个端口完全正常」（服务端访问日志里连一条 /update 请求都没有 → 请求死在 TLS 握手）。
 *   与其去和运营商指纹/中间盒较劲，不如直接用**已经证明能通的那个栈**：
 *   JS `fetch` 取字节 → 分块交给原生落盘 → 原生校验、打补丁、唤起安装。
 *   原生下载仍然先试一次：能通就用它（少一次桥接），不通自动切 WebView。
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
  /** 下载基址：<base>/update/file/ */
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
  download(options: { url: string; name: string; sha256?: string; size?: number }): Promise<FileResult>
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
  beginDownload(options: { name: string }): Promise<{ name: string; bytes: number }>
  partSize(options: { name: string }): Promise<{ name: string; bytes: number }>
  appendChunk(options: { name: string; data: string }): Promise<{ name: string; bytes: number }>
  finishDownload(options: {
    name: string
    sha256?: string
    size?: number
  }): Promise<FileResult>
  abortDownload(options: { name: string }): Promise<void>
  addListener(
    eventName: 'progress',
    listener: (event: UpdateProgress) => void
  ): Promise<{ remove: () => Promise<void> }>
}

const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate')

/** 桥接一块的字节数：512KB 折成 base64 约 683KB，够快也不至于把桥接压垮 */
const CHUNK_BYTES = 512 * 1024

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

/** 这个平台支持不支持应用内更新（只有 Android 原生壳有安装权限） */
export const isUpdateSupported = (): boolean =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

export const getAppInfo = async () => {
  if (!isUpdateSupported()) {
    return null
  }
  return AppUpdate.getInfo()
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

/** 用 WebView 的 fetch 拿清单（原生 TLS 被 reset 时的兜底） */
const fetchManifestViaWebView = async (channel: string): Promise<UpdateManifest> => {
  const base = apiOrigin().replace(/\/+$/, '')
  const response = await fetch(`${base}/update/manifest?channel=${encodeURIComponent(channel)}`)
  if (!response.ok) {
    throw new Error(`清单请求失败: HTTP ${response.status}`)
  }
  const body = (await response.json()) as Omit<UpdateManifest, 'fileBaseUrl'>
  return { ...body, fileBaseUrl: `${base}/update/file/` }
}

/** 拉清单：原生优先，失败自动走 WebView */
export const fetchManifest = async (channel: string): Promise<UpdateManifest> => {
  try {
    return await AppUpdate.checkManifest({ baseUrl: apiOrigin(), channel })
  } catch (nativeError) {
    try {
      return await fetchManifestViaWebView(channel)
    } catch (webError) {
      throw new Error(
        `拿不到更新清单。原生：${messageOf(nativeError)}；网页层：${messageOf(webError)}`
      )
    }
  }
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

/**
 * 用 WebView 的 fetch 下载，分块交给原生落盘（支持 Range 续传）。
 *
 * 这里不用 `response.arrayBuffer()` 一次性拿完：8MB 的包在手机上直接进 JS 堆
 * 很容易被系统杀掉；按 512KB 分块，内存峰值只有一块。
 */
const downloadViaWebView = async (
  url: string,
  name: string,
  sha256: string | undefined,
  size: number | undefined,
  onProgress?: (progress: UpdateProgress) => void
): Promise<FileResult> => {
  let offset = (await AppUpdate.partSize({ name })).bytes
  let response = await fetch(url, offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {})
  if (offset > 0 && response.status !== 206) {
    // 服务端没按 Range 回（或文件变了）：从头来，避免拼接出坏包
    await AppUpdate.beginDownload({ name })
    offset = 0
    response = await fetch(url)
  }
  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status}`)
  }
  if (!response.body) {
    throw new Error('当前环境不支持流式下载')
  }
  const reader = response.body.getReader()
  let received = offset
  let buffer = new Uint8Array(0)

  const flush = async (bytes: Uint8Array) => {
    if (bytes.length === 0) {
      return
    }
    await AppUpdate.appendChunk({ name, data: bytesToBase64(bytes) })
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    if (!value) {
      continue
    }
    const merged = new Uint8Array(buffer.length + value.length)
    merged.set(buffer)
    merged.set(value, buffer.length)
    buffer = merged
    while (buffer.length >= CHUNK_BYTES) {
      await flush(buffer.subarray(0, CHUNK_BYTES))
      buffer = buffer.subarray(CHUNK_BYTES)
      received += CHUNK_BYTES
      onProgress?.({ phase: 'download', name, received, total: size ?? 0 })
    }
  }
  // 最后一块
  const tail = buffer
  buffer = new Uint8Array(0)
  if (tail.length > 0) {
    await flush(tail)
    received += tail.length
  }
  onProgress?.({ phase: 'download', name, received, total: size ?? received })
  // 长度与 sha256 校验都在原生里做，通过才重命名
  return AppUpdate.finishDownload({ name, sha256, size })
}

/** 下载一个文件：原生先试，失败自动切 WebView 通道 */
const downloadFile = async (
  url: string,
  name: string,
  sha256: string | undefined,
  size: number | undefined,
  onProgress?: (progress: UpdateProgress) => void
): Promise<FileResult> => {
  let nativeError: unknown
  try {
    return await AppUpdate.download({ url, name, sha256, size })
  } catch (error) {
    nativeError = error
  }
  try {
    return await downloadViaWebView(url, name, sha256, size, onProgress)
  } catch (error) {
    throw new Error(`下载失败。原生：${messageOf(nativeError)}；网页层：${messageOf(error)}`)
  }
}

/**
 * 检查 + 下载 + 安装，一条链。
 *
 * @param onProgress 进度回调（补丁/全量都会报）
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
    const manifest = await fetchManifest(channel)
    if (!manifest || typeof manifest.versionCode !== 'number') {
      return { kind: 'failed', message: '更新清单格式不对' }
    }
    // 1) 版本比较用 versionCode（服务端由版本号推导，保证单调递增）
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
        await downloadFile(
          manifest.fileBaseUrl + patch.file,
          patch.file,
          patch.sha256,
          patch.size,
          onProgress
        )
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
      target = await downloadFile(
        manifest.fileBaseUrl + manifest.apk,
        manifest.apk,
        manifest.sha256,
        manifest.size,
        onProgress
      )
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
    return { kind: 'failed', message: messageOf(error) }
  } finally {
    await listener?.remove().catch(() => undefined)
  }
}
