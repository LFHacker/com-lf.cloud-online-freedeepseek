import { readFileSync } from 'node:fs'

/** 把 KEY=VALUE 文件灌进 process.env（不覆盖已有值）；缺文件就忽略 */
export const applyEnvFile = (path: string): void => {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const key = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1)
    if (!(key in process.env)) process.env[key] = value
  }
}
