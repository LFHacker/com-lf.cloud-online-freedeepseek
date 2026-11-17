/**
 * OCR 管线单测。
 *
 * 重点盯三处最容易静默出错的地方：
 *  1. 坐标 token 用的是全角竖线 <｜box｜>，写死半角会导致坐标永远解析不出来
 *  2. 识别开始后 HTTP 已经是 200，失败信息藏在 body 的 error 字段里
 *  3. 文档 id 来自上游，直接拼路径 = 路径穿越
 */
import assert from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OCR_LIMITS,
  boxToPixels,
  cleanOcrText,
  extractBoxes,
  extractElements,
  extractRefs,
  parseOcrResponse,
  pickFigureElements,
  summarizeDocument,
} from '../src/ocr.ts'
import { createOcrStore, isSafeId } from '../src/store.ts'

/**
 * 这段 raw 是**从真实 DeepSeek OCR 响应里原样摘下来的**（rich_layout_recognition，
 * 一张写着 "OCR PIPELINE TEST / invoice no 12345" 的 PNG）。
 * 用真实样本而不是手搓样本，才能验证到全角竖线、ref 类型标签这些真实形态。
 */
const REAL_RAW =
  '<｜ref｜>title<｜/ref｜><｜box｜>[[42,202,440,341]]<｜/box｜> OCR PIPELINE TEST\n' +
  '<｜ref｜>title<｜/ref｜><｜box｜>[[42,484,359,593]]<｜/box｜> invoice no 12345'

let pass = 0
let fail = 0
const test = (name: string, fn: () => void) => {
  try {
    fn()
    pass += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('=== 坐标解析 ===')
test('全角竖线的 <｜box｜> 能解析', () => {
  const raw = '<｜ref｜>标题<｜/ref｜><｜box｜>[[52, 40, 948, 96]]<｜/box｜>'
  const boxes = extractBoxes(raw)
  assert.strictEqual(boxes.length, 1)
  assert.deepStrictEqual(boxes[0], { x1: 52, y1: 40, x2: 948, y2: 96 })
})
test('半角竖线的 <|box|> 也能解析', () => {
  const boxes = extractBoxes('<|box|>[[10, 20, 300, 400]]<|/box|>')
  assert.strictEqual(boxes.length, 1)
  assert.deepStrictEqual(boxes[0], { x1: 10, y1: 20, x2: 300, y2: 400 })
})
test('同一页多个框按顺序全部取出', () => {
  const raw = '<|box|>[[0,0,100,100]]<|/box|> 中间文字 <|box|>[[200,200,900,900]]<|/box|>'
  assert.strictEqual(extractBoxes(raw).length, 2)
})
test('★ 坐标越界（>1000）被丢弃，不产出畸形裁剪框', () => {
  assert.strictEqual(extractBoxes('<|box|>[[0,0,1500,100]]<|/box|>').length, 0)
})
test('★ 反向坐标（x2<=x1）被丢弃', () => {
  assert.strictEqual(extractBoxes('<|box|>[[500,0,100,100]]<|/box|>').length, 0)
})
test('没有框时返回空数组而不是报错', () => {
  assert.deepStrictEqual(extractBoxes('纯文字没有坐标'), [])
})

console.log('\n=== 元素配对（boxes 与 refs 必须同源对齐）===')
test('★ 真实返回的 rich_layout 输出能成对解析', () => {
  const elements = extractElements(REAL_RAW)
  assert.strictEqual(elements.length, 2)
  assert.strictEqual(elements[0]?.ref, 'title')
  assert.deepStrictEqual(elements[0]?.box, { x1: 42, y1: 202, x2: 440, y2: 341 })
  assert.strictEqual(elements[1]?.ref, 'title')
  assert.deepStrictEqual(elements[1]?.box, { x1: 42, y1: 484, x2: 359, y2: 593 })
})
test('★ 没有 ref 的框不会导致后续错位', () => {
  const raw =
    '<|box|>[[0,0,10,10]]<|/box|>无标签 <|ref|>figure<|/ref|><|box|>[[100,100,500,500]]<|/box|>图'
  const elements = extractElements(raw)
  assert.strictEqual(elements.length, 2)
  assert.strictEqual(elements[0]?.ref, null)
  assert.strictEqual(elements[1]?.ref, 'figure')
  // 派生数组必须等长且索引对应——这正是分开解析会崩的地方
  assert.strictEqual(extractBoxes(raw).length, extractRefs(raw).length)
  assert.strictEqual(extractRefs(raw)[0], '')
  assert.strictEqual(extractRefs(raw)[1], 'figure')
})
test('只有 ref 没有 box 时不算元素', () => {
  assert.deepStrictEqual(extractElements('<|ref|>孤立标签<|/ref|>正文'), [])
})
test('图表类元素能被单独筛出', () => {
  const raw =
    '<|ref|>title<|/ref|><|box|>[[0,0,100,100]]<|/box|>标题 ' +
    '<|ref|>figure<|/ref|><|box|>[[200,200,600,600]]<|/box|>图'
  const figures = pickFigureElements(extractElements(raw))
  assert.strictEqual(figures.length, 1)
  assert.deepStrictEqual(figures[0]?.box, { x1: 200, y1: 200, x2: 600, y2: 600 })
})
test('清理后正文不含任何 token', () => {
  const raw = '<|ref|>标题<|/ref|><|box|>[[1,2,3,4]]<|/box|>这里是正文'
  const text = cleanOcrText(raw)
  assert.ok(!/[|｜]/.test(text), `仍含竖线: ${text}`)
  assert.ok(!text.includes('[['), `仍含坐标: ${text}`)
  assert.ok(text.includes('这里是正文'), text)
})
test('★ ref 里的类型标签不进入正文（否则每个元素前都多一个 title）', () => {
  const text = cleanOcrText('<|ref|>title<|/ref|><|box|>[[1,2,3,4]]<|/box|>真正的正文')
  assert.ok(!text.includes('title'), `标签泄漏进正文: ${text}`)
  assert.strictEqual(text, '真正的正文')
})
test('★ 真实 raw 清理后得到干净正文', () => {
  assert.strictEqual(cleanOcrText(REAL_RAW), 'OCR PIPELINE TEST\ninvoice no 12345')
})

console.log('\n=== 坐标换算像素 ===')
test('归一化坐标正确换算到像素', () => {
  // 1000 宽 × 2000 高，框为 (500,500)-(1000,1000)
  const rect = boxToPixels({ x1: 500, y1: 500, x2: 1000, y2: 1000 }, 1000, 2000)
  assert.deepStrictEqual(rect, { left: 500, top: 1000, width: 500, height: 1000 })
})
test('退化尺寸至少 1 像素，避免裁出 0 宽图', () => {
  const rect = boxToPixels({ x1: 0, y1: 0, x2: 1000, y2: 1000 }, 1, 1)
  assert.ok(rect.width >= 1 && rect.height >= 1)
})

console.log('\n=== 响应解析 ===')
const okBody = JSON.stringify({
  id: 'ocr-abc',
  object: 'ocr.result',
  purpose: 'text_recognition',
  page_count: 2,
  pages: [
    { index: 0, text: '<|ref|>标题<|/ref|><|box|>[[10,10,900,90]]<|/box|>正文一', finish_reason: 'stop' },
    { index: 1, text: '正文二', finish_reason: 'length' },
  ],
  usage: { input_tokens: 1536, output_tokens: 412, total_tokens: 1948 },
})
test('正常响应解析出页数、正文、坐标、用量', () => {
  const r = parseOcrResponse(okBody, 1000)
  assert.ok(r.ok)
  assert.strictEqual(r.document.pageCount, 2)
  assert.strictEqual(r.document.pages[0]?.boxes.length, 1)
  // ref 里的类型标签会被剥离，正文只剩真正的内容
  assert.strictEqual(r.document.pages[0]?.text, '正文一')
  assert.strictEqual(r.document.pages[1]?.truncated, true, 'finish_reason=length 应标为截断')
  assert.strictEqual(r.document.usage?.totalTokens, 1948)
  assert.strictEqual(r.document.createdAt, 1000)
})
test('★ HTTP 200 但 body 带 error 时判为失败', () => {
  const r = parseOcrResponse(
    JSON.stringify({ error: { message: 'OCR did not finish in time', type: 'gateway_timeout_error' } })
  )
  assert.strictEqual(r.ok, false)
  if (!r.ok) {
    assert.strictEqual(r.reason, 'error_object')
    assert.ok(r.message.includes('did not finish'), r.message)
  }
})
test('非 JSON 响应判为 bad_shape', () => {
  const r = parseOcrResponse('<html>502</html>')
  assert.strictEqual(r.ok, false)
  if (!r.ok) assert.strictEqual(r.reason, 'bad_shape')
})
test('缺少 pages 判为 bad_shape', () => {
  const r = parseOcrResponse(JSON.stringify({ id: 'x' }))
  assert.strictEqual(r.ok, false)
})
test('★ 超过 1000 页被拒绝', () => {
  const pages = Array.from({ length: OCR_LIMITS.maxPages + 1 }, (_, i) => ({
    index: i,
    text: 'x',
    finish_reason: 'stop',
  }))
  const r = parseOcrResponse(JSON.stringify({ id: 'big', page_count: pages.length, pages }))
  assert.strictEqual(r.ok, false)
})
test('摘要统计正确', () => {
  const r = parseOcrResponse(okBody, 1)
  assert.ok(r.ok)
  const s = summarizeDocument(r.document)
  assert.strictEqual(s.pageCount, 2)
  assert.strictEqual(s.totalBoxes, 1)
  assert.strictEqual(s.truncatedPages, 1)
  assert.ok(s.totalChars > 0)
})

console.log('\n=== 存储与安全 ===')
test('★ 路径穿越的 id 被拒绝', () => {
  assert.strictEqual(isSafeId('../../etc/passwd'), false)
  assert.strictEqual(isSafeId('..'), false)
  assert.strictEqual(isSafeId('a/b'), false)
  assert.strictEqual(isSafeId(''), false)
  assert.strictEqual(isSafeId('ocr-9b2f4c1e-abc'), true)
})

const run = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-store-'))
  try {
    const store = createOcrStore(dir)
    const parsed = parseOcrResponse(okBody, 123)
    assert.ok(parsed.ok)
    await store.save(parsed.document)

    const loaded = await store.load('ocr-abc')
    assert.ok(loaded, '应能按 id 取回')
    assert.strictEqual(loaded?.pageCount, 2)

    const list = await store.list()
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0]?.id, 'ocr-abc')

    const missing = await store.load('nope')
    assert.strictEqual(missing, null)

    const removed = await store.remove('ocr-abc')
    assert.strictEqual(removed, true)
    assert.strictEqual((await store.list()).length, 0)
    pass += 1
    console.log('  PASS  存取/列举/删除 往返正确')

    // 旧版本记录（没有 elements 字段）不能让整个列表崩掉
    const legacy = {
      id: 'ocr-legacy',
      purpose: 'text_recognition',
      pageCount: 1,
      pages: [{ index: 0, text: '旧数据', raw: '旧数据', boxes: [], refs: [], finishReason: 'stop', truncated: false }],
      usage: null,
      createdAt: 1,
    }
    await writeFile(join(dir, 'ocr-legacy.json'), JSON.stringify(legacy), 'utf8')
    const mixed = await store.list()
    assert.strictEqual(mixed.length, 1, '旧记录应被正常列出而不是拖垮列表')
    assert.strictEqual(mixed[0]?.id, 'ocr-legacy')
    assert.strictEqual(mixed[0]?.totalFigures, 0, '缺失 elements 时图表数应为 0')
    pass += 1
    console.log('  PASS  ★ 旧版本记录（缺 elements）不拖垮列表')
  } catch (error) {
    fail += 1
    console.log(`  FAIL  存取往返`)
    console.log(`        ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  console.log(`\n=== PASS=${pass}  FAIL=${fail} ===`)
  if (fail > 0) {
    process.exitCode = 1
  }
}

await run()
