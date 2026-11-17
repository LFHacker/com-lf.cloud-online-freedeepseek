/**
 * 把用户的一句话变成 FTS5 能用的检索表达式。
 *
 * ⚠️ 这里是整个 P2 最关键、也最反直觉的一段，纯实测得出：
 *
 *   MATCH '这个项目用什么状态管理'  → 0 条
 *   MATCH '状态管理'               → 命中
 *
 * 原因：trigram 分词器会把查询串切成三元组并**默认 AND**，
 * 一句正常的中文问句要求所有三元组同时出现，必然 0 命中。
 *
 * 所以必须拆成短词再 OR。但还有一个坑：口语开场白会造成假命中——
 *   「我记得你之前提过用什么数据库」里的「我记得」会命中过去某条「我记得你说过…」，
 *   把真正相关的数据库那条挤下去。所以拆词前要先剥离口语套话。
 *
 * 已验证的边界（不要指望 P2 能跨过）：
 *   原文「证书用 … 签发」 vs 提问「证书怎么签的」→ 查不到。
 *   词形不同就是不同，只有向量（P3）能解决语义相近。
 */

/** 口语套话：不携带检索意图，留着只会制造假命中 */
const FILLER: readonly RegExp[] = [
  /我(?:还)?记得/gu,
  /你(?:之前|上次|上回|以前)/gu,
  /我(?:之前|上次|上回|以前)/gu,
  /(?:之前|上次|上回)(?:说|提|聊)(?:过|的|到)?/gu,
  /来着/gu,
  /(?:是什么|是啥|是多少|怎么|怎么样|为什么|为啥|怎么办)/gu,
  /告诉(?:我|你)?/gu,
  /请问/gu,
  /(?:帮|给)我/gu,
  /一下/gu,
  /(?:那个|这个|这些|那些)/gu,
  /有(?:没有|没有)/gu,
  /(?:能不能|可不可以|行不行)/gu,
  /我想(?:问|知道|了解)/gu,
]

/** 句末语气词：切出来会污染最后一个三元组（「…签的」里的「的」） */
const TRAILING_PARTICLE = /[的了呢吧啊呀嘛哦哈]+$/u

/**
 * 生成检索词时只看文本的**末尾**这么多个字符。
 *
 * 为什么不是全文：真实提问经常是「贴一大段内容 + 最后问一句」。
 * 若对全文取三元组再截断到 40 个，取到的全是开头那段背景文字，
 * 结尾真正的问题被截掉 —— 表现为**长消息永远检索不到**（实测踩过）。
 *
 * 取末尾也符合直觉：要问的东西几乎总在最后。
 */
const QUERY_TAIL_CHARS = 300

const queryTail = (text: string): string =>
  text.length > QUERY_TAIL_CHARS ? text.slice(-QUERY_TAIL_CHARS) : text

/**
 * 归一化：只保留「字母 + 数字」。
 *
 * ⚠️ 原来写的是 `[^\p{Script=Han}a-zA-Z0-9]` —— 只认汉字和英数，
 * **俄文/日文假名/韩文/带重音的拉丁字母会被整个删掉**，
 * 于是这些语言的查询切出 0 个词、永远查不到。
 * 实测：历史记录里的俄语会话，用原句检索直接返回空。
 */
const normalize = (raw: string): string => raw.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * 拆出检索词：
 *  - 中文按滑窗取三元组（trigram 分词器的最小单位）
 *  - 英文/数字整词作为独立词（trigram 对英文也能工作，但整词更准）
 */
export const buildSearchTerms = (raw: string): string[] => {
  let text = normalize(queryTail(raw))
  if (!text) {
    return []
  }
  for (const pattern of FILLER) {
    text = text.replace(pattern, ' ')
  }
  text = TRAILING_PARTICLE.test(text.trim()) ? text.trim().replace(TRAILING_PARTICLE, '') : text

  const terms = new Set<string>()

  // 任何文字的整词（英文/数字/俄文/韩文…）。
  // FTS5 的 trigram 分词器会把整词再切成三元组匹配，所以整词更准、也省词数。
  for (const word of text.split(/\s+/u)) {
    if (/^[\p{L}\p{N}]{3,}$/u.test(word)) {
      terms.add(word.toLowerCase())
    }
  }

  // 汉字滑窗三元组。
  // ⚠️ 必须**先去掉空格**再滑窗：FILLER 去词会在句中留下空格，
  // 例如「记忆库怎么部署」会变成「记忆库 部署」；若按空格分段滑窗，
  // 只剩「记忆库」一个词，「部署」这种 2 字词彻底丢失 → 中文召回明显退化（实测踩过）。
  // 去掉空格后是「记忆库部署」，能同时得到 记忆库 / 忆库部 / 库部署。
  // 而拉丁字母不是汉字，不会被粘进来，所以不会重现 "deployment" 被拆成噪声三元组的问题。
  const compacted = text.replace(/\s+/gu, '')
  for (const run of compacted.match(/\p{Script=Han}+/gu) ?? []) {
    for (let i = 0; i + 3 <= run.length; i += 1) {
      terms.add(run.slice(i, i + 3))
    }
  }

  // 词太多会让 OR 表达式过长且引入噪声，留前 40 个
  return [...terms].slice(0, 40)
}

/**
 * 构造 FTS5 的 MATCH 表达式。
 * 每个词都用双引号包成字符串字面量——否则 `OR`、`*`、`-` 这类字符会被当语法解析，
 * 直接抛 `fts5: syntax error`。
 */
export const buildMatchExpression = (terms: readonly string[]): string =>
  terms
    .map((term) => term.replace(/"/gu, ''))
    .filter(Boolean)
    .map((term) => `"${term}"`)
    .join(' OR ')

/**
 * 没有实际检索价值的高频二字组合。
 * 用作 LIKE 回退时的过滤，避免 `LIKE '%什么%'` 命中全库。
 */
const STOP_BIGRAMS: ReadonlySet<string> = new Set([
  '什么', '怎么', '多少', '多久', '哪里', '哪个', '哪些', '我们', '你们', '他们',
  '这个', '那个', '这些', '那些', '一个', '可以', '没有', '就是', '不是', '还是',
  '已经', '现在', '时候', '知道', '觉得', '因为', '所以', '但是', '而且', '如果',
  '然后', '这样', '那样', '一下', '的话', '是不', '不了', '什么', '告诉', '请问',
])

/**
 * 回退用的二字词。
 *
 * 为什么需要它：trigram 最少要 3 个字符，而真实提问经常只剩 2 个字——
 * 「我叫刘飞」被问成「我叫什么」时，去掉疑问词后只剩「我叫」，trigram 一个都凑不出来，
 * 于是完全查不到（这是实测真实失败案例，不是假设）。
 * 2 字用 LIKE 做子串匹配能救回这类，代价是一次表扫描，所以只在 trigram 零命中时才走。
 */
export const buildFallbackTerms = (raw: string): string[] => {
  let text = normalize(queryTail(raw))
  if (!text) {
    return []
  }
  for (const pattern of FILLER) {
    text = text.replace(pattern, ' ')
  }
  text = TRAILING_PARTICLE.test(text.trim()) ? text.trim().replace(TRAILING_PARTICLE, '') : text

  const cjk = text.replace(/\s+/gu, '')
  const grams: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i + 2 <= cjk.length; i += 1) {
    const gram = cjk.slice(i, i + 2)
    if (STOP_BIGRAMS.has(gram) || seen.has(gram)) {
      continue
    }
    seen.add(gram)
    grams.push(gram)
  }
  // 取前 3 个即可：OR 太多会放大噪声，也会拖慢扫描
  return grams.slice(0, 3)
}
