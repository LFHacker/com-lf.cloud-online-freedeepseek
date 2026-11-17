/**
 * 记忆库的 SQLite 层。
 *
 * 为什么用 node:sqlite 而不是 better-sqlite3：
 *  1. 零依赖、零原生编译（那台 2C2G 的机器上装 node-gyp 是自找麻烦）
 *  2. 只需要一个进程访问，不需要连接池
 *  3. 实测 Node 22.20 的 node:sqlite 自带 FTS5 + trigram 分词器，中文能直接全文检索
 *
 * 代价：node:sqlite 标记为实验特性，启动会有一条 ExperimentalWarning。
 * 这是可接受的——它比一个需要编译的原生依赖稳定得多。
 */
import { DatabaseSync } from 'node:sqlite'

export type MemoryDb = DatabaseSync

const SCHEMA = `
create table if not exists sessions (
  id           text primary key,
  scope        text not null check (scope in ('global','local')),
  first_seen   integer not null,
  last_seen    integer not null
);

create table if not exists messages (
  id           text primary key,
  session_id   text not null,
  role         text not null,
  body         text not null,
  created_at   integer not null
);
create index if not exists idx_messages_session on messages(session_id, created_at desc);

create table if not exists chunks (
  id           text primary key,
  session_id   text not null,
  message_id   text not null,
  body         text not null,
  created_at   integer not null
);
create index if not exists idx_chunks_session on chunks(session_id);

/**
 * 只有「全局记忆」会话的内容会进这张表。
 * session_id / created_at 设为 UNINDEXED：它们的值不从全文索引里查，
 * 但检索命中后要立刻拿到，避免再回主表 join。
 */
create virtual table if not exists chunks_fts using fts5(
  body,
  chunk_id   unindexed,
  session_id unindexed,
  created_at unindexed,
  tokenize = 'trigram'
);

/**
 * 向量表。只存**已归一化**的 float32，检索时点积即为余弦。
 * 单独建表而不是加到 chunks 上：没有 embedding 配置时这张表就是空的，
 * 检索会自动退回纯词法，不影响主表结构。
 */
create table if not exists chunk_vec (
  chunk_id   text primary key,
  session_id text not null,
  dim        integer not null,
  vec        blob not null
);
create index if not exists idx_chunk_vec_session on chunk_vec(session_id);

/**
 * 使用痕迹（P4 记忆衰减与增权的数据基础）。
 * 单独建表而不是给 chunks 加列：create table if not exists 不会给已存在的表补列，
 * 老库会缺字段，检索时静默读不到值。独立表新老库都能建。
 */
create table if not exists chunk_usage (
  chunk_id    text primary key,
  hits        integer not null default 0,
  last_hit_at integer not null
);
`

export const openMemoryDb = (path: string): MemoryDb => {
  const db = new DatabaseSync(path)
  // WAL：读不阻塞写。网关会「一边检索一边写入」，默认的 rollback journal 会互相等锁。
  db.exec('pragma journal_mode = WAL;')
  db.exec('pragma synchronous = NORMAL;')
  // 2C2G 的机器，别让 SQLite 自己乱吃缓存
  db.exec('pragma cache_size = -8000;')
  db.exec('pragma busy_timeout = 3000;')
  db.exec(SCHEMA)
  return db
}

/** 是否已存在某个会话（用于判断 scope 冲突） */
export const readSessionScope = (db: MemoryDb, id: string): string | null => {
  const row = db.prepare('select scope from sessions where id = ?').get(id) as
    | { scope: string }
    | undefined
  return row?.scope ?? null
}

export const countRows = (db: MemoryDb): { sessions: number; messages: number; chunks: number } => {
  const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n)
  return {
    sessions: one('select count(*) n from sessions'),
    messages: one('select count(*) n from messages'),
    chunks: one('select count(*) n from chunks'),
  }
}
