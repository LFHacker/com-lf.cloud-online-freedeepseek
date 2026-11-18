/**
 * 记忆库的读写层。
 *
 * 两条铁律（对应「不幻觉」和「不丢失」）：
 *  1. **只存原文、只注入原文**。绝不把对话蒸馏成"事实"再注入——
 *     蒸馏必然丢细节，而且抽取错了会一直带着，那才是幻觉的来源。
 *  2. **低分不注入**。检索不到相关记忆时宁可什么都不给，
 *     让模型老实说"不记得"，也不要塞无关内容诱导它硬编。
 */
import { createHash } from 'node:crypto'
import { countRows, openMemoryDb, readSessionScope, type MemoryDb } from './db.ts'
import { splitIntoChunks } from './chunk.ts'
import { buildFallbackTerms, buildMatchExpression, buildSearchTerms } from './query.ts'
import {
  createEmbeddingClient,
  dot,
  fuseRanks,
  normalizeVector,
  readEmbeddingConfig,
  type EmbeddingClient,
} from './embed.ts'

export type MemoryScope = 'global' | 'local'

export type MemoryHit = {
  chunkId: string
  sessionId: string
  createdAt: number
  body: string
  /** 紧随其后的助手回答：只用于注入，不参与检索打分（索引仍只建在 body 上） */
  context?: string | null
  /** bm25 分数，越负越相关 */
  score: number
}

export type MemoryStats = {
  sessions: number
  messages: number
  chunks: number
  /** 最近一次检索命中的条数，便于观察 */
  lastHits: number
  /** 有使用痕迹的切片数（P4 增权数据） */
  usageRows: number
}

export type MemoryStoreOptions = {
  dbPath: string
  /** 低于「最佳成绩 × 该比例」的命中视为噪声丢掉。bm25 是负数，乘小数表示"差这么多倍" */
  scoreRatio?: number
  /** 单次最多注入几条片段 */
  maxHits?: number
  /** 单次注入的总字符上限 */
  maxChars?: number
  /** 注入的 embedding 客户端；不传则从环境变量读，再没有就只做词法检索 */
  embedding?: EmbeddingClient
  /** 查询向量化的等待上限：超时就先按词法返回，别让聊天卡在第三方接口上 */
  queryEmbedTimeoutMs?: number
  /** 向量全表扫描的条数上限，超过就告警（这个规模该上 sqlite-vec 了） */
  maxVectorScan?: number
  /** 批量向量化间隔（毫秒），默认 80 */
  embedDelayMs?: number
  /**
   * 向量命中所需的最低余弦相似度。
   *
   * ⚠️ 必须有下限：实测「今天天气怎么样」这种无关问题和任何记忆的余弦都接近 0，
   * 但 top-k 照样会把它返回，再被 RRF 融进结果——于是无关问题也注入了记忆。
   * 真实 embedding 模型同类查询的余弦常在 0.2~0.4，所以这个值需要按模型调。
   */
  minVectorScore?: number
  /** 记忆新鲜度半衰期（天）：90 天前的内容权重减半 */
  decayHalfLifeDays?: number
  /**
   * 新鲜度对最终排序的最大修正幅度。
   *
   * ⚠️ 必须很小：这个系数是用来在**相关性接近**的候选之间排先后，
   * 不是用来推翻相关性。给太大就会让"常被想起的旧记忆"盖过"真正命中的新内容"，
   * 那是比不衰减更严重的精度损失。
   */
  freshnessBoost?: number
}

const stableId = (...parts: string[]): string =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)

const formatDay = (ms: number): string => {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * SQLite 的 BLOB 不保证 4 字节对齐，直接 new Float32Array(buffer) 可能抛
 * "start offset of Float32Array should be a multiple of 4"。所以复制一份再解释。
 */
const toFloat32 = (blob: Uint8Array): Float32Array => {
  const out = new Float32Array(Math.floor(blob.byteLength / 4))
  new Uint8Array(out.buffer).set(blob.subarray(0, out.byteLength))
  return out
}

/**
 * 判断某条记忆是不是「查询回声」——即它本身就是用户这次问的那句话。
 *
 * 为什么要过滤：用户以前问过「我叫什么」，那句话被存成记忆；
 * 这次再问同一句时它会被精确匹配到，占掉一个注入名额却没有提供任何信息，
 * 反而会挤压真正含答案的条目。
 */
const isEcho = (body: string, query: string): boolean => {
  const b = body.replace(/\s+/gu, '')
  const q = query.replace(/\s+/gu, '')
  if (!b || !q) {
    return false
  }
  // 完全相同，或者是一条很短的、被查询完整包含的碎片
  return b === q || (b.length <= 40 && q.includes(b))
}

export class MemoryStore {
  private readonly db: MemoryDb
  private readonly scoreRatio: number
  private readonly maxHits: number
  private readonly maxChars: number
  private readonly embedding: EmbeddingClient
  private readonly queryEmbedTimeoutMs: number
  private readonly maxVectorScan: number
  /** 批量向量化之间的间隔；硅基流动按 TPM 限流，无间隔连续批处理会撞 429 */
  private readonly embedDelayMs: number
  private readonly minVectorScore: number
  private readonly decayHalfLifeDays: number
  private readonly freshnessBoost: number
  /** 重排（cross-encoder）：把融合后的候选再排一次，显著提升第一名准确率 */
  private readonly rerankEnabled: boolean
  private readonly rerankModel: string
  private readonly rerankTimeoutMs: number
  private readonly rerankPoolSize: number
  /**
   * 邻块扩展：命中的切片前后各带一块进来。
   *
   * 只提"检索指标"是没用的 —— 用户要的是模型能看懂那段话。
   * 一个切片是 500 字内的片段，命中它但缺前后文时，模型看到的是半句话。
   */
  private readonly neighborExpand: boolean
  /** 注入时给多少条命中带上下文（实测全带会把注入块撑到 2600 字，反而降分） */
  private readonly contextHits: number
  /** 每条上下文最多多少字 */
  private readonly contextChars: number
  private lastHits = 0
  /** 后台向量化任务，测试与关停时用 */
  private readonly pending = new Set<Promise<void>>()

  constructor(options: MemoryStoreOptions) {
    this.db = openMemoryDb(options.dbPath)
    this.scoreRatio = options.scoreRatio ?? 0.4
    this.maxHits = options.maxHits ?? 4
    this.maxChars = options.maxChars ?? 1500
    this.embedding = options.embedding ?? createEmbeddingClient(readEmbeddingConfig(process.env))
    this.queryEmbedTimeoutMs = options.queryEmbedTimeoutMs ?? 1500
    this.maxVectorScan = options.maxVectorScan ?? 50_000
    this.embedDelayMs = options.embedDelayMs ?? Number(process.env.MEMORY_EMBED_DELAY_MS ?? 80)
    this.minVectorScore =
      options.minVectorScore ?? Number(process.env.MEMORY_VECTOR_MIN_SCORE ?? 0.3)
    this.decayHalfLifeDays =
      options.decayHalfLifeDays ?? Number(process.env.MEMORY_DECAY_HALF_LIFE_DAYS ?? 90)
    // 0.25 表示最多 ±25%。宁可欠一点，也不要让权重压过相关性
    this.rerankEnabled =
      (process.env.MEMORY_RERANK ?? '1') !== '0' && Boolean(process.env.MEMORY_EMBED_API_KEY)
    this.rerankModel = process.env.MEMORY_RERANK_MODEL ?? 'BAAI/bge-reranker-v2-m3'
    this.rerankTimeoutMs = Number(process.env.MEMORY_RERANK_TIMEOUT_MS ?? 2500)
    // 14 是实测的平衡点：@4 92.5% 与 pool=20 持平，但 p95 延迟从 1162ms 降到 727ms
    this.rerankPoolSize = Number(process.env.MEMORY_RERANK_POOL ?? 14)
    /**
     * 默认关：回答级评测（40 条）显示 1.45 → 1.50，在噪声内，而上下文多 50%。
     * 想试试就设 MEMORY_NEIGHBORS=1。
     */
    this.neighborExpand = (process.env.MEMORY_NEIGHBORS ?? '0') !== '0'
    this.contextHits = Number(process.env.MEMORY_CONTEXT_HITS ?? 2)
    this.contextChars = Number(process.env.MEMORY_CONTEXT_CHARS ?? 300)
    this.freshnessBoost =
      options.freshnessBoost ?? Number(process.env.MEMORY_FRESHNESS_BOOST ?? 0.25)
  }

  get vectorEnabled(): boolean {
    return this.embedding.enabled
  }

  /**
   * 登记会话。**scope 一经创建不可更改**——
   * 半路改模式会导致"哪些内容进了索引"变得不可解释，
   * 所以如果客户端传来不同的 scope，以**首次登记**的为准并返回 false。
   */
  ensureSession(id: string, scope: MemoryScope, now: number): { created: boolean; scope: MemoryScope } {
    const existing = readSessionScope(this.db, id)
    if (existing) {
      if (existing !== scope) {
        console.warn(
          `[memory] 会话 ${id.slice(0, 8)} 已登记为 ${existing}，忽略请求传来的 ${scope}（模式不可变更）`
        )
      }
      this.db.prepare('update sessions set last_seen = ? where id = ?').run(now, id)
      return { created: false, scope: existing as MemoryScope }
    }
    this.db
      .prepare('insert into sessions (id, scope, first_seen, last_seen) values (?, ?, ?, ?)')
      .run(id, scope, now, now)
    return { created: true, scope }
  }

  /**
   * 存一条消息并（全局会话才）建索引。
   *
   * 用内容哈希做 id：App 每轮都发完整历史，同一句话可能被反复送来，
   * 哈希去重天然幂等，不会把自己重复入库撑爆。
   */
  recordMessage(params: {
    sessionId: string
    scope: MemoryScope
    role: string
    body: string
    now: number
    /** false 表示只落库、不进检索索引（如仅附件消息的占位） */
    index?: boolean
    /**
     * 同一段文本在本会话里第几次出现（从 0 开始）。
     *
     * 为什么需要：App 每轮重发全量历史，同一条消息会被反复送来，
     * 靠内容哈希去重才能幂等。但用户**真的重复说同一句话**时（两次「继续」），
     * 内容完全相同，会被误当成重发而丢掉。
     * 用「第几次出现」参与哈希就能区分：重发时序号一致，真重复时序号不同。
     */
    occurrence?: number
  }): { stored: boolean; chunks: number } {
    const body = params.body.trim()
    if (!body) {
      return { stored: false, chunks: 0 }
    }
    const id = stableId(params.sessionId, params.role, body, String(params.occurrence ?? 0))
    const inserted = this.db
      .prepare(
        'insert or ignore into messages (id, session_id, role, body, created_at) values (?, ?, ?, ?, ?)'
      )
      .run(id, params.sessionId, params.role, body, params.now)
    if (Number(inserted.changes) === 0) {
      return { stored: false, chunks: 0 }
    }

    // 只有全局会话、且**只有用户自己说的话**进检索索引。
    //
    // 为什么不索引助手回答（实测踩过）：把模型旧输出也当记忆，等于让它把自己的话
    // 当事实来源。实测现象——库里有一条助手说过的「我叫DeepSeek」，
    // 用户问「我叫什么」时它被召回，模型于是顺着自我介绍，把真正的「我叫刘飞」顶掉。
    // 这是自我强化的幻觉回路，比"少召回一条"危险得多。
    //
    // 助手回答仍然全量落库（P1 要求不丢数据），只是不参与跨会话召回。
    if (params.scope !== 'global' || params.role !== 'user' || params.index === false) {
      return { stored: true, chunks: 0 }
    }

    const chunks = splitIntoChunks(body)
    const insertChunk = this.db.prepare(
      'insert into chunks (id, session_id, message_id, body, created_at) values (?, ?, ?, ?, ?)'
    )
    const insertFts = this.db.prepare(
      'insert into chunks_fts (body, chunk_id, session_id, created_at) values (?, ?, ?, ?)'
    )
    const newChunks: Array<{ id: string; text: string }> = []
    chunks.forEach((text, index) => {
      const chunkId = stableId(id, String(index))
      insertChunk.run(chunkId, params.sessionId, id, text, params.now)
      insertFts.run(text, chunkId, params.sessionId, params.now)
      newChunks.push({ id: chunkId, text })
    })
    // 向量化放后台：它要调第三方接口（几十到几百毫秒），
    // 绝不能挡在聊天请求前面，否则首字延迟立刻就变差。
    this.scheduleEmbedding(newChunks, params.sessionId)
    return { stored: true, chunks: chunks.length }
  }

  /**
   * 检索其他会话的全局记忆。
   *
   * 排除自己的会话：本会话的历史本来就在上下文里，再召回来只会重复占 token。
   * 启用 embedding 时走「词法 + 向量」RRF 融合；否则纯词法。
   */
  /**
   * 重排：用 cross-encoder 把「查询 + 候选原文」一起打分。
   *
   * 为什么值得多花 ~270ms：向量检索擅长"大致相关"，但排序常把语义相近但
   * 并非答案的片段排前面。实测（40 条真实历史题）第一名准确率 47.5% → 72.5%，
   * 前四 77.5% → 92.5%。
   *
   * 失败必须**静默退回**融合顺序：记忆是增强功能，不能因为它让聊天报错。
   */
  private async rerankHits(query: string, hits: MemoryHit[]): Promise<MemoryHit[] | null> {
    if (!this.rerankEnabled || hits.length < 2) {
      return null
    }
    const config = this.embedding?.config
    if (!config) {
      return null
    }
    const pool = hits.slice(0, Math.min(hits.length, this.rerankPoolSize))
    try {
      const response = await fetch(`${config.baseUrl}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: this.rerankModel,
          query,
          documents: pool.map((hit) => hit.body),
          top_n: pool.length,
          return_documents: false,
        }),
        signal: AbortSignal.timeout(this.rerankTimeoutMs),
      })
      if (!response.ok) {
        console.warn(`[memory] 重排接口返回 ${response.status}，本次退回融合顺序`)
        return null
      }
      const payload = (await response.json()) as { results?: Array<{ index: number }> }
      const results = payload.results ?? []
      if (results.length === 0) {
        return null
      }
      const reordered = results
        .map((item) => pool[item.index])
        .filter((hit): hit is MemoryHit => Boolean(hit))
      // 池子外的候选原样接在后面，避免丢内容
      return [...reordered, ...hits.slice(pool.length)]
    } catch (error) {
      console.warn(
        `[memory] 重排失败，本次退回融合顺序：${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }

  async search(params: { text: string; excludeSessionId: string; limit?: number }): Promise<MemoryHit[]> {
    return this.searchMulti({ texts: [params.text], excludeSessionId: params.excludeSessionId, limit: params.limit })
  }

  /**
   * 多查询融合检索（查询改写的落点）。
   *
   * 每个变体各自跑词法 + 向量，再用 RRF 把**所有**结果列融合成一条。
   * 为什么变体之间要融合而不是取并集：并集会让"在某个变体里排第一"和
   * "在所有变体里都排中游"等价，RRF 正好惩罚后者、奖励前者。
   *
   * ⚠️ 重排只用原始问题做一次（用变体去打分没有意义，我们要回答的是原问题）。
   */
  async searchMulti(params: {
    texts: string[]
    excludeSessionId: string
    limit?: number
  }): Promise<MemoryHit[]> {
    const limit = params.limit ?? this.maxHits
    // 多取一些候选，留出按新鲜度重排的空间
    const poolSize = Math.max(limit * 2, limit + 2)
    const texts = params.texts.map((t) => t.trim()).filter(Boolean)
    if (texts.length === 0) {
      this.lastHits = 0
      return []
    }

    const lists: MemoryHit[][] = []
    // 变体之间并行：embedding 是网络请求，串行会线性拖长延迟
    const perText = await Promise.all(
      texts.map(async (text) => {
        const lexical = this.collectLexical(text, params.excludeSessionId, poolSize)
        let vector: MemoryHit[] = []
        if (this.embedding.enabled) {
          const queryVector = await this.embedQuery(text)
          if (queryVector) {
            vector = this.searchByVector(queryVector, params.excludeSessionId, poolSize)
          }
        }
        return { lexical, vector }
      })
    )
    for (const entry of perText) {
      if (entry.lexical.length > 0) lists.push(entry.lexical)
      if (entry.vector.length > 0) lists.push(entry.vector)
    }
    if (lists.length === 0) {
      this.lastHits = 0
      return []
    }

    // RRF 只看名次，免疫 BM25 与余弦的量纲差异
    const merged = lists.length === 1
      ? lists[0]
      : fuseRanks(lists, (hit) => hit.chunkId).map((entry) => entry.item)

    // 去掉「查询回声」：把用户自己刚问过的同一句话再喂回去没有任何信息量
    const primary = texts[0]
    const meaningful = merged.filter((hit) => !isEcho(hit.body, primary))
    if (meaningful.length === 0) {
      this.lastHits = 0
      return []
    }

    // P4：按「相关性为主 + 新鲜度小幅调制」重排
    const now = Date.now()
    const usage = this.readUsage(meaningful.map((hit) => hit.chunkId))
    const ranked = meaningful
      .map((hit, index) => {
        const stat = usage.get(hit.chunkId)
        const factor = this.freshnessFactor(hit.createdAt, stat, now)
        // 相关性用**名次**表达：bm25 是负数且量纲随语料变化，名次更稳定。
        // 1/(rank+1) 让相邻名次拉开明显差距（1.0 / 0.5 / 0.33…），
        // 新鲜度（0.7~1.3）只能在**接近**的候选之间决定先后，翻不掉真正相关的第一名。
        //
        // ⚠️ 这里原来是 `.sort((a, b) => b.factor - a.factor)` —— 只按新鲜度排序，
        // 把相关性整个丢掉了。实测后果：导入 7747 条历史切片后，
        // 用切片原文查它自己会被近期无关内容顶掉，排名第 1 只有 3%。
        // 注释写的是"小幅重排"，实现却成了"完全以时间为准"。
        const relevance = 1 / (index + 1)
        return { hit, score: relevance * factor }
      })
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.hit)

    /**
     * 最后一道：cross-encoder 重排。
     *
     * 只对「候选池」重排，再截到 limit —— 先截断再重排是没意义的
     * （真正相关的那条可能排在第 8，截到 4 就再也进不来）。
     * 重排失败返回 null，这里自动退回融合顺序，聊天不受影响。
     */
    const reranked = await this.rerankHits(primary, ranked)
    const selected = (reranked ?? ranked).slice(0, limit)
    // 记录命中：被召回过的记忆会因此"刷新新鲜度"，下次更容易被想起
    this.recordHits(selected.map((hit) => hit.chunkId), now)
    this.lastHits = selected.length
    return selected
  }

  /**
   * 新鲜度系数（P4 核心）。
   *
   * 设计上刻意做成**小幅修正**（默认 ±25%）：
   * 它的职责是在相关性接近的候选之间决定先后，**不是**让老记忆盖过真正命中的内容。
   * 半衰期 90 天：三个月前的内容权重减半；被召回过的会刷新计时（用得越多越"新鲜"）。
   */
  private freshnessFactor(
    createdAt: number,
    stat: { hits: number; lastHitAt: number } | undefined,
    now: number
  ): number {
    // 用「创建时间」与「上次被召回时间」中较晚的那个来算年龄：
    // 频繁被想起的记忆会不断刷新，符合记忆规律
    const lastTouch = Math.max(createdAt, stat?.lastHitAt ?? 0)
    const ageDays = Math.max(0, (now - lastTouch) / 86_400_000)
    const decay = Math.pow(0.5, ageDays / this.decayHalfLifeDays)
    // decay ∈ (0,1]；映射到 [-boost, +boost]
    const decayTerm = this.freshnessBoost * (decay - 0.5) * 2
    // 频率加成用对数，避免热点记忆无限膨胀；最多再加 0.1
    const freqTerm = stat && stat.hits > 0 ? Math.min(0.1, 0.05 * Math.log(1 + stat.hits)) : 0
    return Math.min(1.3, Math.max(0.7, 1 + decayTerm + freqTerm))
  }

  /** 批量读使用痕迹 */
  private readUsage(ids: readonly string[]): Map<string, { hits: number; lastHitAt: number }> {
    const result = new Map<string, { hits: number; lastHitAt: number }>()
    if (ids.length === 0) {
      return result
    }
    const placeholders = ids.map(() => '?').join(',')
    try {
      const rows = this.db
        .prepare(
          `select chunk_id, hits, last_hit_at from chunk_usage where chunk_id in (${placeholders})`
        )
        .all(...(ids as never[])) as Array<{ chunk_id: string; hits: number; last_hit_at: number }>
      for (const row of rows) {
        result.set(row.chunk_id, { hits: Number(row.hits), lastHitAt: Number(row.last_hit_at) })
      }
    } catch {
      // 读不到就当没有痕迹，不影响检索
    }
    return result
  }

  /** 记录被召回（增权） */
  private recordHits(ids: readonly string[], now: number): void {
    if (ids.length === 0) {
      return
    }
    try {
      const statement = this.db.prepare(
        `insert into chunk_usage (chunk_id, hits, last_hit_at) values (?, 1, ?)
         on conflict(chunk_id) do update set hits = hits + 1, last_hit_at = excluded.last_hit_at`
      )
      for (const id of ids) {
        statement.run(id, now)
      }
    } catch (error) {
      console.warn(
        `[memory] 记录命中失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** 纯词法检索：trigram 优先，不足 limit 条时用 2 字子串补齐 */
  private collectLexical(text: string, excludeSessionId: string, limit: number): MemoryHit[] {
    const hits = this.searchByTrigram(text, excludeSessionId, limit)

    // ⚠️ 只在「零命中」时回退是不够的——实测踩过：
    // 用户以前问过同一句话，FTS 会自己匹配到自己那句提问（弱匹配），
    // 有结果就不回退，于是真正含答案的「我叫刘飞」永远查不到。
    // 所以改成：**FTS 结果不足 limit 条时补上回退结果**。
    if (hits.length >= limit) {
      return hits
    }
    const seen = new Set(hits.map((hit) => hit.chunkId))
    for (const extra of this.searchBySubstring(text, excludeSessionId, limit)) {
      if (seen.has(extra.chunkId)) {
        continue
      }
      seen.add(extra.chunkId)
      hits.push(extra)
    }
    return hits
  }

  /**
   * 把助手这一轮的回答，挂到本会话**最近一条用户消息**的切片上。
   *
   * 为什么在写入时就挂：记忆只索引用户说的话（防自我强化幻觉），
   * 但只给问题不给答案，模型看到「Flutter 找不到 Chrome」这种报错就没法回答，
   * 只能复述。挂上回答既保留原有索引口径，又让注入资料成对。
   *
   * 幂等：已经有 context 的切片不覆盖（重复调用不会把旧回答换掉）。
   */
  attachLastAssistantReply(sessionId: string, reply: string, maxChars = 600): number {
    const text = reply.trim()
    if (!text) {
      return 0
    }
    const lastUser = this.db
      .prepare(
        `select id, created_at from messages
          where session_id = ? and role = 'user'
          order by created_at desc, id desc limit 1`
      )
      .get(sessionId) as { id: string; created_at: number } | undefined
    if (!lastUser) {
      return 0
    }
    const result = this.db
      .prepare(
        `update chunks set context = ?
          where message_id = ?
            and (context is null or context = '')`
      )
      .run(text.slice(0, maxChars), lastUser.id)
    return Number(result.changes)
  }

  /** 读长期档案（稳定层） */
  getProfile(): { body: string; sourceChunks: number; updatedAt: number } | null {
    const row = this.db
      .prepare("select body, source_chunks, updated_at from memory_profile where id = 'stable'")
      .get() as { body: string; source_chunks: number; updated_at: number } | undefined
    return row ? { body: row.body, sourceChunks: row.source_chunks, updatedAt: row.updated_at } : null
  }

  /** 写长期档案（整行替换） */
  saveProfile(body: string, sourceChunks: number, now: number): void {
    this.db
      .prepare(
        "insert into memory_profile (id, body, source_chunks, updated_at) values ('stable', ?, ?, ?) " +
          'on conflict(id) do update set body = excluded.body, source_chunks = excluded.source_chunks, updated_at = excluded.updated_at'
      )
      .run(body, sourceChunks, now)
  }

  /**
   * 取一批代表性切片给档案生成用。
   * 优先"被召回过"的（说明真的有用），再按时间补最近的，覆盖近期变化。
   */
  sampleForProfile(limit: number): string[] {
    const used = this.db
      .prepare(
        `select c.body from chunk_usage u join chunks c on c.id = u.chunk_id
          order by u.hits desc, u.last_hit_at desc limit ?`
      )
      .all(Math.ceil(limit / 2)) as Array<{ body: string }>
    const recent = this.db
      .prepare('select body from chunks order by created_at desc limit ?')
      .all(limit - used.length) as Array<{ body: string }>
    const seen = new Set<string>()
    const out: string[] = []
    for (const row of [...used, ...recent]) {
      const text = row.body.trim()
      if (!text || seen.has(text)) continue
      seen.add(text)
      out.push(text.slice(0, 300))
    }
    return out
  }

  /** 按 id 取切片原文（评测与调试用） */
  chunkBody(chunkId: string): string | null {
    const row = this.db.prepare('select body from chunks where id = ?').get(chunkId) as
      | { body: string }
      | undefined
    return row?.body ?? null
  }

  /**
   * 取同一会话里紧邻的一块（dir=-1 前一块，dir=1 后一块）。
   *
   * 没有显式顺序列，用 (created_at, id) 定序：同一毫秒内写入的切片靠 id 稳定排序，
   * 否则相邻两块可能顺序颠倒，拼出来是倒装的句子。
   */
  private neighborOf(hit: MemoryHit, dir: -1 | 1): MemoryHit | null {
    const sql =
      dir === 1
        ? `select id, session_id, body, created_at from chunks
            where session_id = ? and (created_at > ? or (created_at = ? and id > ?))
            order by created_at asc, id asc limit 1`
        : `select id, session_id, body, created_at from chunks
            where session_id = ? and (created_at < ? or (created_at = ? and id < ?))
            order by created_at desc, id desc limit 1`
    const row = this.db.prepare(sql).get(hit.sessionId, hit.createdAt, hit.createdAt, hit.chunkId) as
      | { id: string; session_id: string; body: string; created_at: number }
      | undefined
    if (!row) {
      return null
    }
    return {
      chunkId: row.id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      body: row.body,
      score: hit.score,
    }
  }

  /**
   * 把命中切片展开成「前块 + 本体 + 后块」的连续段落。
   *
   * 顺序很重要：模型按顺序读，相邻内容必须贴在一起，
   * 否则它会把两段不相干的话当成一段。
   */
  expandNeighbors(hits: readonly MemoryHit[]): MemoryHit[] {
    if (!this.neighborExpand || hits.length === 0) {
      return [...hits]
    }
    const seen = new Set<string>()
    const out: MemoryHit[] = []
    for (const hit of hits) {
      const prev = this.neighborOf(hit, -1)
      if (prev && !seen.has(prev.chunkId)) {
        seen.add(prev.chunkId)
        out.push(prev)
      }
      if (!seen.has(hit.chunkId)) {
        seen.add(hit.chunkId)
        out.push(hit)
      }
      const next = this.neighborOf(hit, 1)
      if (next && !seen.has(next.chunkId)) {
        seen.add(next.chunkId)
        out.push(next)
      }
    }
    return out
  }

  /** 后台向量化：失败只记日志，不影响已经完成的写入 */
  private scheduleEmbedding(
    chunks: ReadonlyArray<{ id: string; text: string }>,
    sessionId: string
  ): void {
    if (!this.embedding.enabled || chunks.length === 0) {
      return
    }
    let task: Promise<void>
    task = (async () => {
      const vectors = await this.embedding.embed(chunks.map((chunk) => chunk.text))
      if (!vectors) {
        return
      }
      const insert = this.db.prepare(
        'insert or replace into chunk_vec (chunk_id, session_id, dim, vec) values (?, ?, ?, ?)'
      )
      chunks.forEach((chunk, index) => {
        const raw = vectors[index]
        if (!raw) {
          return
        }
        const normalized = normalizeVector(raw)
        insert.run(
          chunk.id,
          sessionId,
          normalized.length,
          Buffer.from(normalized.buffer, normalized.byteOffset, normalized.byteLength)
        )
      })
    })().catch((error: unknown) => {
      console.warn(
        `[memory] 向量写入失败：${error instanceof Error ? error.message : String(error)}`
      )
    })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }

  /** 等后台向量化结束（测试与关停时用） */
  async flushEmbeddings(): Promise<void> {
    await Promise.all([...this.pending])
  }

  /**
   * 给还没有向量的切片补向量（刚配上 embedding、或换了模型维度变了之后跑）。
   * 分批处理，可中断：已写入的不会重算。
   */
  async backfillVectors(
    batch = 16,
    onProgress?: (done: number, total: number) => void
  ): Promise<{ total: number; embedded: number; failed: number }> {
    const rows = this.db
      .prepare(
        `select c.id, c.body, c.session_id
           from chunks c
           left join chunk_vec v on v.chunk_id = c.id
          where v.chunk_id is null
          order by c.created_at asc`
      )
      .all() as Array<{ id: string; body: string; session_id: string }>

    const total = rows.length
    let embedded = 0
    let failed = 0
    const insert = this.db.prepare(
      'insert or replace into chunk_vec (chunk_id, session_id, dim, vec) values (?, ?, ?, ?)'
    )

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    for (let i = 0; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch)
      let vectors = await this.embedding.embed(slice.map((row) => row.body))
      if (!vectors) {
        // 429（TPM 限流）和 503（模型过载）都是临时错误：退避后重试一次再放弃
        await sleep(1500)
        vectors = await this.embedding.embed(slice.map((row) => row.body))
      }
      if (!vectors) {
        // 仍然失败：这些切片因为没有向量，下次运行会被重新捡起（可续跑）
        failed += slice.length
        await sleep(3000)
        continue
      }
      // 批间留间隔，避免连续请求撞上 TPM 限流
      if (this.embedDelayMs > 0) {
        await sleep(this.embedDelayMs)
      }
      slice.forEach((row, index) => {
        const raw = vectors[index]
        if (!raw) {
          failed += 1
          return
        }
        const normalized = normalizeVector(raw)
        insert.run(
          row.id,
          row.session_id,
          normalized.length,
          Buffer.from(normalized.buffer, normalized.byteOffset, normalized.byteLength)
        )
        embedded += 1
      })
      onProgress?.(Math.min(i + batch, total), total)
    }
    return { total, embedded, failed }
  }

  /**
   * 查询向量化，带**硬超时**。
   *
   * 为什么必须限时：检索发生在转发上游之前，第三方 embedding 慢一秒，
   * 用户感受就是"AI 一秒才开始说话"。超时就直接按词法结果返回。
   */
  private async embedQuery(text: string): Promise<Float32Array | null> {
    if (!this.embedding.enabled) {
      return null
    }
    const work = (async () => {
      const vectors = await this.embedding.embed([text])
      const vector = vectors?.[0]
      return vector ? normalizeVector(vector) : null
    })()
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), this.queryEmbedTimeoutMs).unref?.()
    })
    return Promise.race([work, timeout])
  }

  /** 向量全表扫描取 top-k。条数超过上限会告警（那时该上 sqlite-vec 了） */
  private searchByVector(
    queryVector: Float32Array,
    excludeSessionId: string,
    limit: number
  ): MemoryHit[] {
    let total = 0
    try {
      total = Number((this.db.prepare('select count(*) n from chunk_vec').get() as { n: number }).n)
    } catch {
      return []
    }
    if (total === 0) {
      return []
    }
    if (total > this.maxVectorScan) {
      console.warn(
        `[memory] 向量条数 ${total} 超过扫描上限 ${this.maxVectorScan}，检索会变慢；建议改用 sqlite-vec`
      )
    }
    const rows = this.db
      .prepare(
        `select v.chunk_id, v.vec, c.session_id, c.body, c.created_at
           from chunk_vec v join chunks c on c.id = v.chunk_id
          where c.session_id <> ?`
      )
      .all(excludeSessionId) as Array<{
      chunk_id: string
      vec: Uint8Array
      session_id: string
      body: string
      created_at: number
    }>

    const scored: Array<{
      score: number
      body: string
      chunk_id: string
      session_id: string
      created_at: number
    }> = []
    for (const row of rows) {
      const vector = toFloat32(row.vec)
      // 维度不一致（换过 embedding 模型）→ 跳过，不要静默算出一个错的相似度
      if (vector.length !== queryVector.length) {
        continue
      }
      scored.push({
        score: dot(queryVector, vector),
        body: row.body,
        chunk_id: row.chunk_id,
        session_id: row.session_id,
        created_at: Number(row.created_at),
      })
    }
    scored.sort((a, b) => b.score - a.score)
    // 低于阈值的一律丢弃：无关查询的余弦接近 0，不设下限就会把噪声当记忆注入
    const relevant = scored.filter((row) => row.score >= this.minVectorScore)
    if (relevant.length === 0) {
      return []
    }
    return this.pack(
      relevant.slice(0, limit).map((row) => ({ ...row, s: row.score }))
    )
  }

  private searchByTrigram(text: string, excludeSessionId: string, limit: number): MemoryHit[] {
    const terms = buildSearchTerms(text)
    if (terms.length === 0) {
      return []
    }
    const expression = buildMatchExpression(terms)
    let rows: Array<{ body: string; chunk_id: string; session_id: string; created_at: number; s: number }>
    try {
      rows = this.db
        .prepare(
          `select body, chunk_id, session_id, created_at, bm25(chunks_fts) as s
             from chunks_fts
            where chunks_fts match ? and session_id <> ?
            order by s
            limit ?`
        )
        .all(expression, excludeSessionId, limit) as typeof rows
    } catch (error) {
      // 查询语法错误（例如全是特殊字符）不应让整个对话失败
      console.warn('[memory] 检索失败：', error instanceof Error ? error.message : error)
      return []
    }
    if (rows.length === 0) {
      return []
    }
    // 相对阈值：bm25 是负数，把明显差一档的丢掉，避免噪声挤进上下文
    const best = rows[0]?.s ?? 0
    return this.pack(rows.filter((row) => (best < 0 ? row.s <= best * this.scoreRatio : true)))
  }

  /**
   * 2 字子串回退。
   *
   * 代价是一次表扫描，所以：只在 trigram 零命中时走；最多取 3 个词、每词 20 条候选。
   * 精度靠 STOP_BIGRAMS 过滤「什么/我们/可以」这类高频词保证。
   */
  private searchBySubstring(text: string, excludeSessionId: string, limit: number): MemoryHit[] {
    const grams = buildFallbackTerms(text)
    if (grams.length === 0) {
      return []
    }
    const clauses = grams.map(() => 'body like ?').join(' or ')
    const args: unknown[] = grams.map((gram) => `%${gram}%`)
    args.push(excludeSessionId, limit)
    let rows: Array<{ body: string; chunk_id: string; session_id: string; created_at: number; s: number }>
    try {
      rows = this.db
        .prepare(
          `select body, id as chunk_id, session_id, created_at, 0 as s
             from chunks
            where (${clauses}) and session_id <> ?
            order by created_at desc
            limit ?`
        )
        .all(...(args as never[])) as typeof rows
    } catch (error) {
      console.warn('[memory] 回退检索失败：', error instanceof Error ? error.message : error)
      return []
    }
    // 回退结果没有 bm25 分数，不做相对阈值过滤，直接按字符预算打包
    return this.pack(rows)
  }

  /** 按字符预算打包命中，避免一次注入过长 */
  private pack(
    rows: Array<{ body: string; chunk_id: string; session_id: string; created_at: number; s: number }>
  ): MemoryHit[] {
    const hits: MemoryHit[] = []
    let used = 0
    // 上下文批量取，避免每命中一条就查一次库
    const contextOf = this.db.prepare('select context from chunks where id = ?')
    for (const row of rows) {
      const context = (contextOf.get(row.chunk_id) as { context: string | null } | undefined)?.context
      /**
       * ⚠️ 预算只算正文，**不算上下文**。
       * 把上下文也算进来会让"能塞几条"变少（实测召回@4 从 82% 掉到 70%），
       * 而上下文的作用是让模型读懂**已经命中的**那几条，不该挤掉别的命中。
       * 注入总长度的上限由 buildRecallBlock 统一控制。
       */
      if (used + row.body.length > this.maxChars) {
        continue
      }
      used += row.body.length
      hits.push({
        chunkId: row.chunk_id,
        sessionId: row.session_id,
        createdAt: Number(row.created_at),
        body: row.body,
        context: context ?? null,
        score: row.s,
      })
    }
    return hits
  }

  /**
   * 把命中片段包成注入文本。
   *
   * 三条设计：
   *  1. 标明来源（日期 + 会话号）→ 模型能引用，用户能核对
   *  2. 明确允许忽略 → 减少"硬套不相关记忆"导致的跑题
   *  3. 明确禁止编造 → 记忆里没有的事不许补
   */
  buildRecallBlock(hits: readonly MemoryHit[]): string {
    if (hits.length === 0) {
      return ''
    }
    /**
     * 命中是把「用户当时说的话」和「助手当时的回答」一起给模型。
     * 带上回答的原因：用户问「Flutter 找不到 Chrome 怎么办」时，
     * 他这句话里只有报错，解法在回答里——只给问题，模型只能复述报错。
     */
    const blockBudget = Number(process.env.MEMORY_BLOCK_CHARS ?? 1800)
    const lines: string[] = []
    let usedChars = 0
    hits.forEach((hit, index) => {
      const head = `[${formatDay(hit.createdAt)} · 会话 ${hit.sessionId.slice(0, 8)}]`
      /**
       * 只给**最相关的前几条**带上下文，且每条截断。
       * 实测全带会把注入块从 690 字撑到 2600 字，回答级分数反而从 1.45 掉到 1.25 ——
       * 相关信息被淹没在无关的回答里了。
       */
      const context = index < this.contextHits ? hit.context?.trim() : null
      if (!context) {
        const line = `${head} ${hit.body}`
        if (usedChars + line.length > blockBudget) {
          return
        }
        usedChars += line.length
        lines.push(line)
        return
      }
      const trimmed = context.length > this.contextChars ? `${context.slice(0, this.contextChars)}…` : context
      const line = `${head} 用户说：${hit.body}\n（当时助手的回答：${trimmed}）`
      // 总长上限：宁可少给一条，也不要把整个上下文预算吃光
      if (usedChars + line.length > blockBudget) {
        return
      }
      usedChars += line.length
      lines.push(line)
    })
    return [
      '<回忆>',
      '以下是你在「其他对话」中与用户聊过的内容，按时间从近到远。',
      '只有确实与本轮问题相关时才引用；不相关就完全忽略，不要硬套。',
      '这些是原文摘录，不要补充其中没有的信息，也不要编造。',
      '',
      ...lines,
      '</回忆>',
    ].join('\n')
  }

  /** 管理页面用：列出可召回的切片（带命中次数） */
  listChunks(params: { q?: string; limit?: number }): Array<{
    id: string
    sessionId: string
    createdAt: number
    body: string
    hits: number
  }> {
    const limit = Math.min(Math.max(params.limit ?? 200, 1), 500)
    const keyword = (params.q ?? '').trim()
    const base = `select c.id, c.session_id, c.created_at, c.body, coalesce(u.hits, 0) as hits
                    from chunks c left join chunk_usage u on u.chunk_id = c.id`
    const rows = keyword
      ? (this.db
          .prepare(`${base} where c.body like ? order by c.created_at desc limit ?`)
          .all(`%${keyword}%`, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`${base} order by c.created_at desc limit ?`)
          .all(limit) as Array<Record<string, unknown>>)
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      createdAt: Number(row.created_at),
      body: String(row.body),
      hits: Number(row.hits),
    }))
  }

  /**
   * 删除指定切片（管理页面用）。
   * 四处都要删：主表、全文索引、向量、使用痕迹 —— 漏一处就会留下孤儿数据。
   */
  deleteChunks(ids: readonly string[]): number {
    const valid = ids.filter((id) => /^[0-9a-f]{8,64}$/u.test(id))
    if (valid.length === 0) {
      return 0
    }
    const run = this.db.prepare('delete from chunks where id = ?')
    const runFts = this.db.prepare('delete from chunks_fts where chunk_id = ?')
    const runVec = this.db.prepare('delete from chunk_vec where chunk_id = ?')
    const runUsage = this.db.prepare('delete from chunk_usage where chunk_id = ?')
    let deleted = 0
    for (const id of valid) {
      const result = run.run(id)
      runFts.run(id)
      runVec.run(id)
      runUsage.run(id)
      deleted += Number(result.changes)
    }
    return deleted
  }

  /** 管理页面用：只做召回演示（会记录命中痕迹，和真实召回一致，便于观察增权效果） */
  async previewRecall(
    text: string,
    limit = 4
  ): Promise<Array<{ body: string; createdAt: number; sessionId: string; score: number }>> {
    const hits = await this.search({ text, excludeSessionId: '', limit })
    return hits.map((hit) => ({
      body: hit.body,
      createdAt: hit.createdAt,
      sessionId: hit.sessionId,
      score: hit.score,
    }))
  }

  stats(): MemoryStats {
    let usage = 0
    try {
      usage = Number((this.db.prepare('select count(*) n from chunk_usage').get() as { n: number }).n)
    } catch {
      usage = 0
    }
    return { ...countRows(this.db), lastHits: this.lastHits, usageRows: usage }
  }

  /**
   * 相似记忆合并（P4 的"固化"环节）。
   *
   * 只在维护脚本里跑，不进请求路径：它要两两比较，O(n²) 级别。
   * 做法：按首三元组分桶，桶内算字符三元组的 Jaccard 相似度，
   * 超过阈值视为重复 → 保留最早那条、命中次数相加、其余删除。
   *
   * 为什么用 Jaccard 而不是向量：没有配置 embedding 时也要能用；
   * 向量相似更适合语义合并，但那是可选项。
   */
  consolidate(threshold = 0.85, maxChunks = 20_000): {
    scanned: number
    groups: number
    removed: number
  } {
    const rows = this.db
      .prepare('select id, session_id, body, created_at from chunks order by created_at asc limit ?')
      .all(maxChunks) as Array<{ id: string; session_id: string; body: string; created_at: number }>

    const normalize = (text: string): string =>
      text
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '')

    const trigrams = (text: string): Set<string> => {
      const set = new Set<string>()
      for (let i = 0; i + 3 <= text.length; i += 1) {
        set.add(text.slice(i, i + 3))
      }
      return set
    }

    const jaccard = (a: Set<string>, b: Set<string>): number => {
      if (a.size === 0 || b.size === 0) {
        return 0
      }
      let shared = 0
      for (const item of a) {
        if (b.has(item)) {
          shared += 1
        }
      }
      return shared / (a.size + b.size - shared)
    }

    // 只对不太长的切片做相似合并：长切片即便相似，合并也会丢失细节
    const prepared = rows
      .map((row) => {
        const text = normalize(row.body)
        return { ...row, text, grams: text.length <= 200 ? trigrams(text) : null }
      })
      .filter((row) => row.grams !== null && row.text.length >= 6)

    // 按首三元组分桶，把比较限制在可能相似的范围内
    const buckets = new Map<string, typeof prepared>()
    for (const row of prepared) {
      const key = row.text.slice(0, 3)
      const list = buckets.get(key)
      if (list) {
        list.push(row)
      } else {
        buckets.set(key, [row])
      }
    }

    let groups = 0
    let removed = 0
    const deleteChunk = this.db.prepare('delete from chunks where id = ?')
    const deleteFts = this.db.prepare('delete from chunks_fts where chunk_id = ?')
    const deleteVec = this.db.prepare('delete from chunk_vec where chunk_id = ?')
    const readHits = this.db.prepare('select hits from chunk_usage where chunk_id = ?')
    const upsertHits = this.db.prepare(
      `insert into chunk_usage (chunk_id, hits, last_hit_at) values (?, ?, ?)
       on conflict(chunk_id) do update set hits = chunk_usage.hits + excluded.hits`
    )

    for (const list of buckets.values()) {
      if (list.length < 2) {
        continue
      }
      const kept: typeof list = []
      for (const row of list) {
        const survivor = kept.find(
          (candidate) => jaccard(candidate.grams as Set<string>, row.grams as Set<string>) >= threshold
        )
        if (!survivor) {
          kept.push(row)
          continue
        }
        // 命中次数累加到保留者身上
        const survivorHits = Number(
          (readHits.get(survivor.id) as { hits: number } | undefined)?.hits ?? 0
        )
        const rowHits = Number(
          (readHits.get(row.id) as { hits: number } | undefined)?.hits ?? 0
        )
        if (survivorHits + rowHits > 0) {
          upsertHits.run(survivor.id, survivorHits + rowHits, Date.now())
        }
        deleteFts.run(row.id)
        deleteVec.run(row.id)
        deleteChunk.run(row.id)
        removed += 1
        groups += 1
      }
    }
    return { scanned: rows.length, groups, removed }
  }

  /**
   * 用 chunks 表重建全文索引。
   *
   * 用途：清理脚本出错、或导入历史时只写了主表，都可能留下**孤儿 FTS 行**
   * （索引里有、主表里没有）。精灵条目会被检索出来但拿不到内容，
   * 表现为「召回了却注入不了」或注入了错误内容。重建是最稳的修复方式。
   */
  rebuildIndex(): { chunks: number; indexed: number } {
    const rows = this.db
      .prepare('select id, session_id, body, created_at from chunks order by created_at asc')
      .all() as Array<{ id: string; session_id: string; body: string; created_at: number }>
    this.db.exec('delete from chunks_fts')
    const insert = this.db.prepare(
      'insert into chunks_fts (body, chunk_id, session_id, created_at) values (?, ?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(row.body, row.id, row.session_id, row.created_at)
    }
    return { chunks: rows.length, indexed: rows.length }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // 关闭失败不影响进程退出
    }
  }
}
