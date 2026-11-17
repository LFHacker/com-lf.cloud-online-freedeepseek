/**
 * 测试用的假 embedding 服务。
 *
 * 为什么需要它：真实 embedding API 要 key、要联网、结果还不确定，
 * 没法用来做断言。这里用一张**关键词分组表**人为决定向量：
 * 同一组的词落在同一个维度上，于是「服务器是 2C2G」和「家里那台机器什么配置」
 * 即使没有任何共同字词，余弦也接近——这样就能稳定验证"向量桥接语义鸿沟"这条能力。
 *
 * ⚠️ 它只用于测试，不代表真实 embedding 的语义能力。
 */
import { createServer } from 'node:http'

/** 同组词映射到同一维度 */
const GROUPS: readonly string[][] = [
  ['服务器', '机器', '主机', '配置', '内存', 'cpu', '2c2g', '阿里云', '跑着', '网关'],
  ['名字', '叫什么', '称呼', '我叫', '刘飞', '是谁'],
  ['证书', 'https', 'tls', '签发', '加密', '域名'],
  ['数据库', 'sqlite', '存储', '数据', '备份'],
  ['记忆', '回忆', '记住', '忘了'],
]

export const MOCK_DIM = 8

/** 按关键词命中数生成 8 维向量；未命中任何组时落在最后一维（"其它"） */
export const mockEmbed = (text: string): number[] => {
  const lower = text.toLowerCase()
  const vector = new Array<number>(MOCK_DIM).fill(0)
  GROUPS.forEach((group, index) => {
    for (const word of group) {
      if (lower.includes(word)) {
        vector[index] += 1
      }
    }
  })
  if (vector.slice(0, GROUPS.length).every((value) => value === 0)) {
    vector[MOCK_DIM - 1] = 1
  }
  return vector
}

export type MockEmbeddingClient = {
  enabled: boolean
  config: null
  embed(texts: readonly string[]): Promise<number[][] | null>
  calls: number
}

/** 直接给单测用的客户端（不走 HTTP） */
export const createMockEmbeddingClient = (): MockEmbeddingClient => {
  const client: MockEmbeddingClient = {
    enabled: true,
    config: null,
    calls: 0,
    async embed(texts) {
      client.calls += 1
      return texts.map((text) => mockEmbed(text))
    },
  }
  return client
}

/** 作为独立进程跑：OpenAI 兼容的 POST /embeddings */
const serve = () => {
  const port = Number(process.env.MOCK_EMBED_PORT ?? 9998)
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/embeddings')) {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let input: string[] = []
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: unknown }
        input = Array.isArray(parsed.input)
          ? parsed.input.map((item) => String(item))
          : [String(parsed.input ?? '')]
      } catch {
        res.writeHead(400).end('{"error":"bad json"}')
        return
      }
      const body = JSON.stringify({
        data: input.map((text, index) => ({ index, embedding: mockEmbed(text) })),
        model: 'mock-embed',
      })
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(body)
    })
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`mock-embed 监听 http://127.0.0.1:${port}  维度 ${MOCK_DIM}`)
  })
}

if (process.argv[1]?.includes('mock-embed')) {
  serve()
}
