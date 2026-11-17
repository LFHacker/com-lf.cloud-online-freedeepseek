/**
 * OCR 管线 —— 网关侧的第 5 步。
 *
 * 为什么走 OCR 而不是官方 Files API 的 document 块：
 *  1. Files API 引用的文档会把**解析全文永久留在上下文里**，官方明确「不会静默截断，
 *     太长直接 400」，客户端无法控制；OCR 则是「把文本交给你，什么都不存」。
 *  2. 两者单价相同（$0.225 / 1000 页），但 OCR 的输出不计费，且返回逐页文本 + 坐标，
 *     控制权全在我们这边。
 *
 * 坐标 token 的价值：官方 `rich_layout_recognition` 会把文档里的图表裁出来按原位置喂给模型。
 * OCR 返回的 <box>[[x1,y1,x2,y2]]</box> 就是复刻这件事的依据——坐标归一化到 0-1000，
 * 实际像素 = 坐标 × 页宽/页高 ÷ 1000。
 */

/** 官方限额：单文件 100 MiB、最多 1000 页、整体 180 秒 */
export const OCR_LIMITS = {
  maxBytes: 100 * 1024 * 1024,
  maxPages: 1000,
  /** 上传 + 识别 + 返回的总时限；网关的 fetch 超时要比它再宽一点 */
  totalTimeoutMs: 180_000,
} as const

export type OcrBox = {
  /** 归一化坐标，0-1000，相对页面左上角 */
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * 页面上的一个元素：坐标 + 可选类型标签。
 *
 * 必须**成对**解析。早先是 boxes 和 refs 各扫一遍、按下标对齐，
 * 一旦某个 <box> 前面没有 <ref>，后续全部错位——错位不会报错，
 * 只会让你裁到完全无关的区域，属于最难发现的 bug 类型。
 */
export type OcrElement = {
  /** <ref>…</ref> 的内容，如 title / figure / table；没有时为 null */
  ref: string | null
  box: OcrBox
}

export type OcrPage = {
  index: number
  /** 去掉坐标/引用 token 后的可读正文 */
  text: string
  /** 原始输出（含 token），留档用；排查解析问题时很关键 */
  raw: string
  /** 页内元素（坐标 + 类型），按出现顺序 */
  elements: OcrElement[]
  /** 页内检出的区域坐标，按出现顺序（由 elements 派生，保证与 refs 严格对齐） */
  boxes: OcrBox[]
  /** 引用标签，与 boxes 一一对应（无标签的位置为 ''） */
  refs: string[]
  /** finish_reason 为 length 表示该页输出被截断、文本不完整 */
  finishReason: string
  truncated: boolean
}

export type OcrDocument = {
  id: string
  purpose: string
  pageCount: number
  pages: OcrPage[]
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null
  createdAt: number
}

/**
 * 官方文档里的 token 用的是**全角竖线** <｜ref｜>，但不同版本/不同页面可能写成半角 |。
 * 两种都兼容——这种细节一旦漏了，解析会静默返回空坐标，排查起来非常费劲。
 */
const PIPE = '[|｜]'
const NUM = '-?\\d+(?:\\.\\d+)?'
/**
 * 成对匹配「可选 <ref>类型</ref> + <box>[[x1,y1,x2,y2]]</box>」。
 * 真实输出形如：<｜ref｜>title<｜/ref｜><｜box｜>[[42,202,440,341]]<｜/box｜> 正文
 */
const ELEMENT_RE = new RegExp(
  `(?:<${PIPE}ref${PIPE}>([\\s\\S]*?)<${PIPE}\\/ref${PIPE}>\\s*)?` +
    `<${PIPE}box${PIPE}>\\s*\\[\\[\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*,\\s*(${NUM})\\s*\\]\\]\\s*<${PIPE}\\/box${PIPE}>`,
  'g'
)
/** 清理正文时要去掉的所有特殊 token */
const TOKEN_RE = new RegExp(
  `<${PIPE}ref${PIPE}>|<${PIPE}\\/ref${PIPE}>|<${PIPE}box${PIPE}>|<${PIPE}\\/box${PIPE}>|\\[\\[\\s*-?\\d+(?:\\.\\d+)?\\s*,\\s*-?\\d+(?:\\.\\d+)?\\s*,\\s*-?\\d+(?:\\.\\d+)?\\s*,\\s*-?\\d+(?:\\.\\d+)?\\s*\\]\\]`,
  'g'
)

/**
 * 整个 <ref>…</ref> 块（**含内容**）。
 * ⚠️ 必须先删这个再删其它 token：<ref> 里装的是元素类型标签（title/figure/表…），
 * 不是文档正文。只删标签符号会把标签内容留在正文里，
 * 表现为每段文字前多一个 "title"，污染后续切块与检索。
 */
const REF_BLOCK_RE = new RegExp(`<${PIPE}ref${PIPE}>[\\s\\S]*?<${PIPE}\\/ref${PIPE}>`, 'g')

/** 去掉所有 token 与多余空白，得到可读正文 */
export const cleanOcrText = (raw: string): string =>
  raw
    .replace(REF_BLOCK_RE, ' ')
    .replace(TOKEN_RE, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()

/** 成对解析页面元素；坐标越界或反向的整条丢弃 */
export const extractElements = (raw: string): OcrElement[] => {
  const elements: OcrElement[] = []
  for (const match of raw.matchAll(ELEMENT_RE)) {
    const [, ref, a, b, c, d] = match
    const box = { x1: Number(a), y1: Number(b), x2: Number(c), y2: Number(d) }
    // 官方声明归一化到 0-1000；越界说明服务端格式变了，宁可丢掉也不要算出奇怪的裁剪框
    if (
      !Number.isFinite(box.x1) ||
      !Number.isFinite(box.y1) ||
      !Number.isFinite(box.x2) ||
      !Number.isFinite(box.y2) ||
      box.x1 < 0 ||
      box.y1 < 0 ||
      box.x2 > 1000 ||
      box.y2 > 1000 ||
      box.x2 <= box.x1 ||
      box.y2 <= box.y1
    ) {
      continue
    }
    const label = ref ? cleanOcrText(ref) : ''
    elements.push({ ref: label || null, box })
  }
  return elements
}

export const extractBoxes = (raw: string): OcrBox[] => extractElements(raw).map((item) => item.box)

/** 与 extractBoxes 严格同源，保证下标一一对应 */
export const extractRefs = (raw: string): string[] =>
  extractElements(raw).map((item) => item.ref ?? '')

/**
 * 这些 ref 是"图"类元素。rich_layout_recognition 下裁图就从这里筛，
 * 而不是把整页所有文字块都裁一遍。
 */
export const FIGURE_REFS: ReadonlySet<string> = new Set([
  'figure',
  'image',
  'chart',
  'table',
  'picture',
  'diagram',
])

/**
 * 容忍缺失/畸形的 elements。
 * 旧版本存下来的文档没有 elements 字段，直接 .filter 会抛错；
 * 如果这个错误被列表接口的外层 catch 吞掉，表现就是「一条坏记录让整个列表返回空」。
 */
export const pickFigureElements = (elements: readonly OcrElement[] | undefined): OcrElement[] =>
  Array.isArray(elements)
    ? elements.filter((item) => item.ref !== null && FIGURE_REFS.has(item.ref.toLowerCase()))
    : []

/** 把归一化坐标换算成像素矩形，供裁图使用 */
export const boxToPixels = (
  box: OcrBox,
  pageWidth: number,
  pageHeight: number
): { left: number; top: number; width: number; height: number } => ({
  left: Math.round((box.x1 * pageWidth) / 1000),
  top: Math.round((box.y1 * pageHeight) / 1000),
  width: Math.max(1, Math.round(((box.x2 - box.x1) * pageWidth) / 1000)),
  height: Math.max(1, Math.round(((box.y2 - box.y1) * pageHeight) / 1000)),
})

const toNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export type ParseResult =
  | { ok: true; document: OcrDocument }
  | { ok: false; reason: 'error_object' | 'bad_shape'; message: string }

/**
 * 解析 OCR API 的响应体。
 *
 * ⚠️ OCR 接口有个反直觉之处：**识别开始后 HTTP 状态就已经是 200**，
 * 之后失败是把错误对象塞在 body 里返回的（官方文档 Errors 一节写明）。
 * 所以只看 HTTP 状态会把失败当成功，必须检查 body 里有没有 error。
 */
export const parseOcrResponse = (text: string, now = Date.now()): ParseResult => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'bad_shape', message: text.slice(0, 300) }
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'bad_shape', message: '响应不是对象' }
  }
  const record = body as Record<string, unknown>

  if (record.error && typeof record.error === 'object') {
    const err = record.error as Record<string, unknown>
    return {
      ok: false,
      reason: 'error_object',
      message: typeof err.message === 'string' ? err.message : JSON.stringify(err),
    }
  }

  if (!Array.isArray(record.pages)) {
    return { ok: false, reason: 'bad_shape', message: '缺少 pages 数组' }
  }

  const pages: OcrPage[] = record.pages.map((item, index) => {
    const page = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const raw = typeof page.text === 'string' ? page.text : ''
    const finishReason = typeof page.finish_reason === 'string' ? page.finish_reason : 'unknown'
    // 一次解析出元素，boxes/refs 由它派生 —— 三者永远对齐
    const elements = extractElements(raw)
    return {
      index: typeof page.index === 'number' ? page.index : index,
      text: cleanOcrText(raw),
      raw,
      elements,
      boxes: elements.map((element) => element.box),
      refs: elements.map((element) => element.ref ?? ''),
      finishReason,
      truncated: finishReason === 'length',
    }
  })

  if (pages.length > OCR_LIMITS.maxPages) {
    return {
      ok: false,
      reason: 'bad_shape',
      message: `页数 ${pages.length} 超过上限 ${OCR_LIMITS.maxPages}`,
    }
  }

  const usageRaw = (record.usage && typeof record.usage === 'object' ? record.usage : null) as
    | Record<string, unknown>
    | null

  return {
    ok: true,
    document: {
      id: typeof record.id === 'string' ? record.id : `ocr-${now}`,
      purpose: typeof record.purpose === 'string' ? record.purpose : 'unknown',
      pageCount: typeof record.page_count === 'number' ? record.page_count : pages.length,
      pages,
      usage: usageRaw
        ? {
            inputTokens: toNumber(usageRaw.input_tokens),
            outputTokens: toNumber(usageRaw.output_tokens),
            totalTokens: toNumber(usageRaw.total_tokens),
          }
        : null,
      createdAt: now,
    },
  }
}

/** 列表/摘要场景用：不带全文，避免把几 MB 的文本塞进日志或前端 */
export type OcrSummary = {
  id: string
  pageCount: number
  createdAt: number
  totalChars: number
  totalBoxes: number
  /** 图表类元素数量（rich_layout_recognition 下才有意义） */
  totalFigures: number
  truncatedPages: number
}

export const summarizeDocument = (document: OcrDocument): OcrSummary => ({
  id: document.id,
  pageCount: document.pageCount,
  createdAt: document.createdAt,
  totalChars: document.pages.reduce((sum, page) => sum + page.text.length, 0),
  totalBoxes: document.pages.reduce((sum, page) => sum + page.boxes.length, 0),
  totalFigures: document.pages.reduce(
    (sum, page) => sum + pickFigureElements(page.elements).length,
    0
  ),
  truncatedPages: document.pages.filter((page) => page.truncated).length,
})
