/**
 * 把 DeepSeek 官方数据导出（deepseek_data-YYYY-MM-DD.zip）转成导入器能吃的中间格式。
 *
 * 官方导出的真实结构（export_format_version: 3）：
 *   manifest.json            {"export_format_version":3}
 *   user.json                账号信息
 *   chat_sessions/<uuid>.json 每个会话一个文件：
 *       { id, title, pinned, current_message_id, inserted_at, updated_at, messages: [...] }
 *   chat_sessions/<uuid>_files/  附件图片（导入不需要）
 *
 * 消息结构：
 *   { id, parent_id, role: USER|ASSISTANT, status, thinking_enabled,
 *     search_enabled, accumulated_token_usage, inserted_at, fragments: [{type, content}] }
 *
 * ⚠️ 两个必须做对的点：
 * 1. **只有 `REQUEST` 类型的 fragment 才是用户亲口说的话**。
 *    一条消息里还可能有 THINK(思考)、TOOL_OPEN(工具调用)、TOOL_SEARCH(联网结果)、
 *    FILE(附件)、CONTENT_RISK(风控提示)、RESPONSE(助手回答)、TEMPLATE_RESPONSE(系统模板)。
 *    把这些混进记忆，等于往"我说过的话"里注入噪声。
 * 2. **时间格式是 MM/DD/YYYY**（月在前）。经取样验证：第二段最大到 31、第一段只到 11，
 *    所以 `02/03/2025` 是 2 月 3 日。按 DD/MM 解析会让整批记忆的时间错位。
 *
 * 用法：
 *   node scripts/convert-official-export.ts --dir <解压后的 chat_sessions 目录> --out normalized.json
 *   node scripts/convert-official-export.ts --dir <...> --out x.json --include-assistant
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Normalized = {
  conversations: Array<{
    id: string
    title: string
    createdAt: number
    messages: Array<{ role: 'user' | 'assistant'; text: string; createdAt: number }>
  }>
}

const parseArgs = (argv: string[]) => {
  const get = (name: string) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  return {
    dir: get('--dir'),
    out: get('--out'),
    includeAssistant: argv.includes('--include-assistant'),
    limit: Number(get('--limit') ?? 0) || 0,
  }
}

/** MM/DD/YYYY HH:mm:ss → 毫秒时间戳（月在前，见文件头注释） */
const parseOfficialTime = (value: unknown): number => {
  if (typeof value !== 'string') {
    return 0
  }
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!match) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  const [, month, day, year, hour = '0', minute = '0', second = '0'] = match
  // 用本地时间构造，与导出文件展示的时区一致
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )
  return date.getTime()
}

type Fragment = { type?: string; content?: unknown }
type Message = {
  role?: string
  fragments?: Fragment[]
  inserted_at?: string
}
type Session = {
  id?: string
  title?: string
  inserted_at?: string
  updated_at?: string
  messages?: Message[]
}

/** 从一条消息里取出用户真正输入的文本（只认 REQUEST） */
const requestText = (message: Message): string => {
  const fragments = Array.isArray(message.fragments) ? message.fragments : []
  return fragments
    .filter((fragment) => fragment && fragment.type === 'REQUEST')
    .map((fragment) => (typeof fragment.content === 'string' ? fragment.content : ''))
    .join('')
    .trim()
}

/** 助手回答（RESPONSE），仅在 --include-assistant 时使用 */
const responseText = (message: Message): string => {
  const fragments = Array.isArray(message.fragments) ? message.fragments : []
  return fragments
    .filter((fragment) => fragment && fragment.type === 'RESPONSE')
    .map((fragment) => (typeof fragment.content === 'string' ? fragment.content : ''))
    .join('')
    .trim()
}

const main = () => {
  const options = parseArgs(process.argv.slice(2))
  if (!options.dir || !options.out) {
    console.error('用法: --dir <chat_sessions 目录> --out <输出.json> [--include-assistant] [--limit N]')
    process.exit(1)
  }

  const files = readdirSync(options.dir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort()
  console.log(`  会话文件: ${files.length} 个`)

  const result: Normalized = { conversations: [] }
  const fragmentTypes = new Map<string, number>()
  let skippedNoRequest = 0
  let parseErrors = 0
  let totalUserChars = 0
  let totalAssistantChars = 0

  for (const [index, name] of files.entries()) {
    if (options.limit > 0 && result.conversations.length >= options.limit) {
      break
    }
    let session: Session
    try {
      session = JSON.parse(readFileSync(join(options.dir, name), 'utf8')) as Session
    } catch {
      parseErrors += 1
      continue
    }
    if (!Array.isArray(session.messages)) {
      continue
    }

    const messages: Normalized['conversations'][number]['messages'] = []
    for (const message of session.messages) {
      if (!message || !Array.isArray(message.fragments)) {
        continue
      }
      for (const fragment of message.fragments) {
        if (fragment && typeof fragment.type === 'string') {
          fragmentTypes.set(fragment.type, (fragmentTypes.get(fragment.type) ?? 0) + 1)
        }
      }
      const isUser = String(message.role ?? '').toUpperCase() === 'USER'
      if (isUser) {
        const text = requestText(message)
        if (text) {
          messages.push({
            role: 'user',
            text,
            createdAt: parseOfficialTime(message.inserted_at),
          })
          totalUserChars += text.length
        }
      } else if (options.includeAssistant) {
        const text = responseText(message)
        if (text) {
          messages.push({
            role: 'assistant',
            text,
            createdAt: parseOfficialTime(message.inserted_at),
          })
          totalAssistantChars += text.length
        }
      }
    }

    if (!messages.some((message) => message.role === 'user')) {
      skippedNoRequest += 1
      continue
    }

    result.conversations.push({
      id: session.id ?? name.replace(/\.json$/i, ''),
      title: session.title ?? '',
      createdAt: parseOfficialTime(session.inserted_at) || messages[0].createdAt || Date.now(),
      messages,
    })

    if ((index + 1) % 200 === 0) {
      console.log(`    已处理 ${index + 1}/${files.length}`)
    }
  }

  writeFileSync(options.out, JSON.stringify(result), 'utf8')

  console.log('\n  === 转换结果 ===')
  console.log(`  会话 ${result.conversations.length} 个（跳过无用户消息的 ${skippedNoRequest} 个，解析失败 ${parseErrors} 个）`)
  console.log(`  用户消息 ${result.conversations.reduce((sum, c) => sum + c.messages.filter((m) => m.role === 'user').length, 0)} 条，${totalUserChars.toLocaleString()} 字`)
  if (options.includeAssistant) {
    console.log(`  助手消息 ${result.conversations.reduce((sum, c) => sum + c.messages.filter((m) => m.role === 'assistant').length, 0)} 条，${totalAssistantChars.toLocaleString()} 字`)
  }
  console.log('\n  fragment 类型分布（供核对是否正确过滤）:')
  for (const [type, count] of [...fragmentTypes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(20)} ${count}`)
  }
  console.log(`\n  已写出: ${options.out}`)
}

main()
