import { readFileSync, writeFileSync } from 'node:fs'

const P = 'src/index.ts'
let s = readFileSync(P, 'utf8')
if (s.includes('\r\n')) s = s.replace(/\r\n/g, '\n')

// ── 1) 在模块级定义两个独立的注入器 ────────────────────────────
const helperAnchor = "/** 更新包与补丁目录（publish-update.mjs 写入） */"
if (!s.includes(helperAnchor)) {
  console.error('❌ 找不到 helper 锚点')
  process.exit(1)
}

const helpers = `/**
 * 通用运行上下文：当前时间 + 大致位置。
 *
 * ⚠️ 这一层**与账号、记忆完全无关**。
 * 曾经的错误是把时间/位置写进了"长期记忆/档案"那段逻辑里，
 * 结果账号没有记忆（新用户、清空记忆后）连时间和位置一起消失 ——
 * 用户看到的就是"模型说它不知道时间也不知道位置"。
 *
 * 通用上下文就该每个请求都算，只要用户没关总开关。
 */
const buildRuntimeContext = async (req: IncomingMessage): Promise<string> => {
  const localTime = readHeader(req, 'x-ds-local-time')
  if (!localTime) {
    // 总开关关闭：时间和位置都不提供（客户端不带时间头即视为关闭）
    return ''
  }
  const place = await resolvePlaceLabel(clientIpOf(req))
  return [
    ['<当前时间>', localTime, '</当前时间>'].join('\\n'),
    place
      ? ['<当前位置>', place, '（按网络出口 IP 推断，仅到城市，可能有偏差）</当前位置>'].join('\\n')
      : '',
  ]
    .filter(Boolean)
    .join('\\n\\n')
}

/**
 * 账号记忆：最近原话 + 长期档案（+ 调用方传入的回忆）。
 *
 * 这一层**允许为空**，而且为空时不能影响任何其它内容 ——
 * 新账号第一次说话时它必然是空的。
 */
const buildMemoryContext = async (
  memory: MemoryStore | null,
  config: ProfileConfig,
  prefix?: string
): Promise<string> => {
  if (!memory) {
    return prefix ?? ''
  }
  try {
    const profile = await ensureProfile(memory, config)
    const recent = memory
      .recentUserMessages(config.recentMessages)
      .reverse()
      .map(
        (item) =>
          \`- [\${new Date(item.createdAt).toISOString().slice(0, 16).replace('T', ' ')}] \${item.body.slice(0, 200)}\`
      )
      .join('\\n')
    return [
      recent ? ['<最近你说过>', recent, '</最近你说过>'].join('\\n') : '',
      profile.body ? ['<长期记忆>', profile.body, '</长期记忆>'].join('\\n') : '',
      prefix,
    ]
      .filter(Boolean)
      .join('\\n\\n')
  } catch (error) {
    console.warn(
      \`[gateway] 记忆上下文构建失败：\${error instanceof Error ? error.message : String(error)}\`
    )
    return prefix ?? ''
  }
}

`
s = s.replace(helperAnchor, helpers + helperAnchor)

// ── 2) 把代理里那一大坨替换成两次调用 ──────────────────────────
const startMarker = "    /**\n     * 时间与位置**独立于记忆**注入。"
const startIdx = s.indexOf(startMarker)
if (startIdx < 0) {
  console.error('❌ 找不到注入块起点')
  process.exit(1)
}
const tailMarker = "\n    }  } else {\n    body = Readable.toWeb(req) as unknown as FetchBody\n  }"
const tailIdx = s.indexOf(tailMarker, startIdx)
if (tailIdx < 0) {
  console.error('❌ 找不到注入块终点')
  process.exit(1)
}

const replacement = `    /**
     * 尾部注入分两层，互不依赖：
     *  ① buildRuntimeContext —— 通用上下文（时间/位置），每个请求都有
     *  ② buildMemoryContext  —— 账号记忆（最近原话/长期档案），有则加、无则跳过
     *
     * 分层的原因：通用信息和账号数据混在一起写，
     * 就会出现"账号没记忆 → 连时间和位置都没了"这种荒唐结果。
     */
    const [runtimeContext, memoryContext] = await Promise.all([
      buildRuntimeContext(req),
      buildMemoryContext(memory, PROFILE, prefix),
    ])
    const injected = [runtimeContext, memoryContext].filter(Boolean)
    if (injected.length > 0) {
      body = injectRecall(body, injected.join('\\n\\n'))
    }`

s = s.slice(0, startIdx) + replacement + s.slice(tailIdx)

// 需要 ProfileConfig 类型
if (!s.includes('import { ensureProfile, readProfileConfig, type ProfileConfig }')) {
  s = s.replace(
    "import { ensureProfile, readProfileConfig } from './memory/profile.ts'",
    "import { ensureProfile, readProfileConfig, type ProfileConfig } from './memory/profile.ts'"
  )
}

writeFileSync(P, s, 'utf8')
console.log('✅ 已拆成两个独立注入器')
