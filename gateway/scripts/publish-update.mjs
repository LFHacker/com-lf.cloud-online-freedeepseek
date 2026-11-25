/**
 * 发布更新包：登记 APK + 生成增量补丁 + 写清单。
 *
 *   node publish-update.mjs --apk /path/app.apk --version 1.0.2 --channel release \
 *        --notes "本次更新内容" [--keep 5]
 *
 * 差分方案：zstd --patch-from（实测 4.23MB → 161KB，省 96%）
 *
 * 版本链策略 B：给**最近 N 个旧版本**各生成一个"到最新"的补丁。
 * 为什么不是链式 A（1.0.0→1.0.1→1.0.2 逐个打）：
 *  · 链式要求用户完整走过每一个中间版本，断一个就全量
 *  · 每级补丁都要校验签名，失败概率相乘
 *  · 服务器算力换用户流量，这里服务器只花 1.6 秒/个补丁，值
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const args = process.argv.slice(2)
const get = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const apkPath = get('apk')
const version = get('version')
const channel = get('channel', 'release')
const notes = get('notes', '')
const keep = Number(get('keep', 5))

if (!apkPath || !version) {
  console.error('用法: node publish-update.mjs --apk <路径> --version 1.0.2 [--channel release] [--notes 说明]')
  process.exit(1)
}
if (!existsSync(apkPath)) {
  console.error(`❌ APK 不存在: ${apkPath}`)
  process.exit(1)
}

const UPDATES_DIR = process.env.UPDATES_DIR ?? '/opt/ds-gateway/updates'
const MANIFEST_PATH = join(UPDATES_DIR, 'manifest.json')
mkdirSync(UPDATES_DIR, { recursive: true })

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const fileInfo = (path) => ({ size: statSync(path).size, sha256: sha256(path) })

// ---- 1) 登记新 APK ----
const apkName = `freedeepseek-v${version}.apk`
const target = join(UPDATES_DIR, apkName)
copyFileSync(apkPath, target)
const info = fileInfo(target)
const versionCode = deriveVersionCode(version)
console.log(`[publish] ${version} → ${apkName} (${(info.size / 1024 / 1024).toFixed(2)} MB)`)

// ---- 2) 读旧清单，为最近 N 个版本生成补丁 ----
// 清单结构：{ channels: { [通道]: { version, apk, sha256, patches: { 旧版本: {...} } } } }
let manifest = { channels: {} }
if (existsSync(MANIFEST_PATH)) {
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  } catch {
    console.warn('  清单损坏，重建')
  }
}

const previous = manifest.channels[channel]
const patches = {}

if (previous && previous.version !== version) {
  /**
   * 最近 N 个历史 APK —— **按 versionCode 排，不能按文件名字典序**。
   *
   * 字典序下 "1.0.18" / "1.0.19" 排在 "1.0.2" 前面（"1" < "2"），
   * 于是 `slice(-5)` 会漏掉真正最近的版本：发 1.0.19 时挑出来的候选是
   * 1.0.18/1.0.2/1.0.5/1.0.6/1.0.8，用户手机上的 1.0.17 反而没有补丁，
   * 只能整包下载 6.7 MB（真踩过，2026-11-25）。
   */
  const apks = readdirSync(UPDATES_DIR)
    .filter((name) => name.startsWith('freedeepseek-v') && name.endsWith('.apk'))
    .filter((name) => name !== apkName)
    .sort((a, b) => versionCodeOfFile(a) - versionCodeOfFile(b))
    .slice(-keep)

  for (const oldApk of apks) {
    const oldPath = join(UPDATES_DIR, oldApk)
    const oldVersion = oldApk.replace(/^freedeepseek-v/u, '').replace(/\.apk$/u, '')
    const patchName = `patch-${oldVersion}-to-${version}.zst`
    const patchPath = join(UPDATES_DIR, patchName)
    try {
      const started = Date.now()
      execFileSync('zstd', [
        `--patch-from=${oldPath}`,
        '-19',
        '-f',
        '-o',
        patchPath,
        target,
      ], { stdio: 'pipe' })
      const patchInfo = fileInfo(patchPath)
      patches[oldVersion] = { file: patchName, size: patchInfo.size, sha256: patchInfo.sha256 }
      const ratio = ((patchInfo.size / info.size) * 100).toFixed(1)
      console.log(
        `  补丁 ${oldVersion} → ${version}: ${(patchInfo.size / 1024).toFixed(0)} KB (${ratio}%)，${Date.now() - started}ms`
      )
    } catch (error) {
      console.error(`  补丁生成失败 ${oldVersion}:`, error instanceof Error ? error.message : error)
    }
  }
}

// ---- 3) 写清单 ----
manifest.channels[channel] = {
  version,
  versionCode,
  apk: apkName,
  size: info.size,
  sha256: info.sha256,
  notes,
  publishedAt: new Date().toISOString(),
  patches,
}
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8')
console.log(`[publish] 清单已更新：${channel} = ${version}（${Object.keys(patches).length} 个补丁）`)

/**
 * 与 build.gradle 同一套规则：major*1e6 + minor*1e4 + patch*100 + (字母? A=1..26 : 99)
 */
function deriveVersionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)([A-Z])?(?:-debug)?$/u.exec(version)
  if (!match) {
    throw new Error(`版本号格式不对: ${version}`)
  }
  const [, major, minor, patch, letter] = match
  const suffix = letter ? letter.charCodeAt(0) - 64 : 99
  return Number(major) * 1_000_000 + Number(minor) * 10_000 + Number(patch) * 100 + suffix
}

/** 从 APK 文件名取 versionCode；名字不合规的排到最后前面（当作最旧），不让它挤掉正常版本 */
function versionCodeOfFile(name) {
  try {
    return deriveVersionCode(name.replace(/^freedeepseek-v/u, '').replace(/\.apk$/u, ''))
  } catch {
    return 0
  }
}
