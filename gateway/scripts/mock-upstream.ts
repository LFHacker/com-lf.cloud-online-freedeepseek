/**
 * 本地 mock 上游：冒充 api.deepseek.com，用来验证网关的转发、鉴权替换与上下文裁剪。
 *
 * 为什么需要它：真实上游只能告诉你"成功/失败"，看不到网关到底转发了几条消息、
 * 鉴权头换成了什么、有没有加裁剪提示。mock 把这三样都**回显进 SSE**，让测试能断言。
 */
import { createServer, type ServerResponse } from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 9999)
const HOST = '127.0.0.1'
/** OCR 故意慢一点：否则并发测试里两个请求永远不重叠，测不出并发上限 */
const OCR_DELAY_MS = Number(process.env.MOCK_OCR_DELAY_MS ?? 800)
/** 记录最近一次 OCR 收到的鉴权头，供测试断言网关确实换了真 Key */
let lastOcrAuth: string | null = null

const send = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 一次性读完请求体 */
const readAll = async (req: import('node:http').IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`)

  if (req.method === 'GET' && url.pathname === '/models') {
    send(res, 200, { object: 'list', data: [], auth: req.headers.authorization ?? null })
    return
  }

  if (req.method === 'POST' && url.pathname === '/anthropic/v1/messages') {
    void (async () => {
      const raw = await readAll(req)
      let parsed: Record<string, unknown> | null = null
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch {
        parsed = null
      }
      const messages = Array.isArray(parsed?.messages) ? (parsed!.messages as unknown[]) : []
      const roles = messages.map((m) =>
        m && typeof m === 'object' && 'role' in m ? String((m as { role: unknown }).role) : '?'
      )
      const system = typeof parsed?.system === 'string' ? parsed.system : ''
      // 取出最后一条 user 消息的文本，用来验证「记忆注入」是否真的拼进去了
      const lastUser = [...messages].reverse().find(
        (m) => m && typeof m === 'object' && (m as { role?: unknown }).role === 'user'
      ) as { content?: unknown } | undefined
      const lastUserText = (() => {
        const content = lastUser?.content
        if (typeof content === 'string') {
          return content
        }
        if (!Array.isArray(content)) {
          return ''
        }
        return content
          .map((block) =>
            block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
              ? String((block as { text?: unknown }).text ?? '')
              : ''
          )
          .join('\n')
      })()
      const echo = {
        // 鉴权：验证网关把令牌换成了真 Key
        'x-api-key': req.headers['x-api-key'] ?? null,
        authorization: req.headers.authorization ?? null,
        'anthropic-beta': req.headers['anthropic-beta'] ?? null,
        // 上下文：验证网关真的裁剪了历史
        messageCount: messages.length,
        firstRole: roles[0] ?? null,
        lastRole: roles.at(-1) ?? null,
        bodyBytes: Buffer.byteLength(raw),
        systemTail: system.slice(-60),
        hasTrimNotice: system.includes('[网关提示]'),
        // 记忆：验证回忆块被拼进了最后一条消息
        lastUserText: lastUserText.slice(0, 600),
        hasRecall: lastUserText.includes('<回忆>'),
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Mock-Transport': 'sse',
      })
      const events: [string, unknown][] = [
        ['message_start', { type: 'message_start', message: { id: 'mock-1', model: 'mock' }, echo }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '收到' } }],
        ['message_stop', { type: 'message_stop' }],
      ]
      let i = 0
      const tick = () => {
        if (i >= events.length) {
          res.end()
          return
        }
        const [name, payload] = events[i++] as [string, unknown]
        res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
        // 拉开间隔，验证网关是真流式转发而不是攒完再发
        setTimeout(tick, 100)
      }
      tick()
    })().catch(() => {
      send(res, 500, { error: 'mock_failed' })
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/tools/ocr') {
    void (async () => {
      const raw = await readAll(req)
      const auth = req.headers.authorization ?? ''
      lastOcrAuth = auth
      await new Promise((resolve) => setTimeout(resolve, OCR_DELAY_MS))
      // 文件名里带 FAILME 就模拟"HTTP 200 但 body 是错误对象"这种真实失败形态
      const wantFail = raw.includes('FAILME')
      const ocrBody = wantFail
        ? { error: { message: 'OCR did not finish in time', type: 'gateway_timeout_error' } }
        : {
            id: 'ocr-mock-1',
            object: 'ocr.result',
            purpose: 'text_recognition',
            page_count: 2,
            pages: [
              {
                index: 0,
                text: '<｜ref｜>标题<｜/ref｜><｜box｜>[[52, 40, 948, 96]]<｜/box｜>第一页正文内容',
                finish_reason: 'stop',
              },
              { index: 1, text: '第二页正文内容', finish_reason: 'length' },
            ],
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          }
      send(res, 200, {
        ...ocrBody,
        // 让测试能断言网关确实用了真 Key 而不是网关令牌
        mockAuth: { authorization: auth, bytesReceived: Buffer.byteLength(raw) },
      })
    })().catch(() => send(res, 500, { error: 'mock_ocr_failed' }))
    return
  }

  if (req.method === 'GET' && url.pathname === '/_last-auth') {
    send(res, 200, { ocrAuthorization: lastOcrAuth })
    return
  }

  send(res, 404, { error: 'mock_not_found', path: url.pathname })
})

server.listen(PORT, HOST, () => {
  console.log(`[mock] 冒充上游，监听 http://${HOST}:${PORT}`)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
