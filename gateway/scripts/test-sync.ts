/**
 * 附件回收脚本（阶段 3）。
 *
 * 规则只有一条：**零引用 + 超过宽限期** 才删。两条缺一不可。
 *
 *   · 零引用：没有任何一条会话的 payload 里还引用它
 *   · 宽限期：附件上传与"引用它的会话推上来"之间有真实时间差，
 *     刚上传还没同步完的图片在引用表里就是零引用
 *
 * 为什么做成独立脚本而不是只在 HTTP 接口里：真删是不可逆的，
 * 运维要能先 dry-run 看清单、确认后再跑；也能挂 cron 定期清。
 *
 * 用法：
 *   node scripts/gc-files.ts                      # 只报告（默认就是 dry-run）
 *   node scripts/gc-files.ts --apply              # 真删
 *   node scripts/gc-files.ts --apply --grace-days 30
 *   node scripts/gc-files.ts --user u_1234abcd    # 只处理一个账号
 *   node scripts/gc-files.ts --rebuild-refs       # 先全量重建引用再判断
 *
 * 环境变量与网关一致：AUTH_DB_PATH / MEMORY_DATA_DIR
 */
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { AuthStore } from '../src/auth/store.ts'

const AUTH_DB_PATH = process.env.AUTH_DB_PATH ?? '/var/lib/ds-gateway/auth.db'
const MEMORY_DATA_DIR = process.env.MEMORY_DATA_DIR ?? '/var/lib/ds-gateway/users'
const FILE_ID_RE = /^[A-Za-z0-9_-]{8,80}$/

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : fallback
}
const flag = (name: string): boolean => process.argv.includes(name)

const apply = flag('--apply')
const graceDays = Number(arg('--grace-days', '7'))
const onlyUser = arg('--user', '')

const store = new AuthStore(AUTH_DB_PATH)

if (flag('--rebuild-refs')) {
  const result = store.rebuildRefs(onlyUser || undefined)
  console.log(`重建引用：${result.sessions} 条会话 / ${result.refs} 条引用`)
}

const users = store.listUsers()
const refsTrusted = store.refsTrusted()
if (!refsTrusted) {
  console.log('⚠️ 引用表还没建起来（file_refs_rebuilt_v1 缺失）：先跑 --rebuild-refs，本次不删任何文件')
}

const summary = { scanned: 0, candidates: 0, removed: 0, bytes: 0, skipped: 0 }

for (const user of users) {
  if (onlyUser && user.id !== onlyUser) {
    continue
  }
  const refs = store.fileRefCounts(user.id)
  const sessionCount = store.countSessions(user.id)
  /**
   * 护栏：判断"重建跑过没有"，不是"引用表空不空"。
   * 删掉最后一条引用附件的会话后引用表就该是空的 —— 那正是要回收的时刻。
   */
  if (!refsTrusted) {
    console.log(`[跳过] ${user.id}：引用表未建立（${sessionCount} 条会话 / ${refs.size} 条引用）`)
    summary.skipped += 1
    continue
  }
  const dir = join(MEMORY_DATA_DIR, user.id, 'files')
  const names = await readdir(dir).catch(() => [] as string[])
  const now = Date.now()
  const cutoff = now - graceDays * 86_400_000
  for (const name of names) {
    if (!FILE_ID_RE.test(name)) {
      continue
    }
    summary.scanned += 1
    if ((refs.get(name) ?? 0) > 0) {
      continue
    }
    const info = await stat(join(dir, name)).catch(() => null)
    if (!info?.isFile() || Math.round(info.mtimeMs) > cutoff) {
      continue
    }
    summary.candidates += 1
    summary.bytes += info.size
    console.log(
      `${apply ? '删除' : '待删'} ${user.id}/${name}  ${(info.size / 1024).toFixed(0)} KB  ${Math.floor(
        (now - info.mtimeMs) / 86_400_000
      )} 天未动`
    )
    if (apply) {
      await unlink(join(dir, name)).catch(() => undefined)
      summary.removed += 1
    }
  }
}

console.log(
  `\n扫描 ${summary.scanned} 个附件，零引用候选 ${summary.candidates} 个（${(
    summary.bytes /
    1024 /
    1024
  ).toFixed(1)} MB），实际${apply ? '删除' : '未删除（dry-run）'} ${summary.removed} 个，跳过账号 ${summary.skipped} 个`
)
if (!apply && summary.candidates > 0) {
  console.log('确认清单无误后加 --apply 真删')
}
store.close()
