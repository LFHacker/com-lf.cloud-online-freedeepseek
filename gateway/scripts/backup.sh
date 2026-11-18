#!/usr/bin/env bash
# 记忆库 + 账号库备份：一致性快照 + 完整性校验 + 本地轮转 + 异地推送
#
# 为什么不用 cp：
#   memory.db 是 WAL 模式，新数据可能还在 -wal 文件里，
#   直接 cp 拿到的是**旧快照**（实测因此误判过一次"清理失败"）。
#   这里用 SQLite 的 VACUUM INTO，它会把当前已提交状态写成一个干净的独立文件。
#
# 为什么密钥不推异地：
#   异地那台机器一旦被入侵，等于把 DeepSeek Key / 网关令牌 / 阿里云 AccessKey 全送出去。
#   而密钥丢失只需重新签发（几分钟），数据库丢失不可恢复 —— 所以只把数据推出去。
#
# ⚠️ 2026-11-18 修正（重要）：
#   引入用户系统后，真实记忆库搬到了 users/<userId>/memory.db，
#   而本脚本仍然只备 $MEMORY_DB_PATH（老的单库路径）——
#   结果每天产出一个 4 KB 的空备份，日志还写着"成功"。
#   实测：真实库 80 MB，备份产物 4 KB，连续多天如此却一直没人发现。
#   现在改成**遍历 users/ 下每个用户库**，并且「一个都没备到」直接以非零码退出。

set -euo pipefail

DATA_DIR="${MEMORY_DATA_DIR:-/var/lib/ds-gateway/users}"
AUTH_DB="${AUTH_DB_PATH:-/var/lib/ds-gateway/auth.db}"
DEST="/var/backups/ds-gateway"
KEEP=14
STAMP="$(date +%Y%m%d-%H%M%S)"
OFFSITE_HOST="root@183.66.27.22"
OFFSITE_PORT=43043
OFFSITE_DIR="/var/backups/ds-gateway"
OFFSITE_KEY="/root/.ssh/dsbackup"

mkdir -p "$DEST"

echo "[backup] $(date '+%F %T') 开始"

snapshot() {
  local source="$1"
  local target="$2"
  node - "$source" "$target" <<'NODE_EOF'
const { DatabaseSync } = require('node:sqlite')
const [source, target] = process.argv.slice(2)
const db = new DatabaseSync(source)
// VACUUM INTO 生成的副本不含 -wal/-shm，且是事务一致的
db.exec(`vacuum into '${target.replace(/'/g, "''")}'`)
db.close()
NODE_EOF
}

verify() {
  local file="$1"
  local label="$2"
  node - "$file" "$label" <<'NODE_EOF'
const { DatabaseSync } = require('node:sqlite')
const [file, label] = process.argv.slice(2)
const db = new DatabaseSync(file)
const integrity = db.prepare('pragma integrity_check').get()
const value = Object.values(integrity ?? {})[0]
if (String(value).toLowerCase() !== 'ok') {
  console.error(`[backup] ${label} 完整性校验失败:`, JSON.stringify(integrity))
  process.exit(1)
}
const count = (sql) => {
  try {
    return db.prepare(sql).get().n
  } catch {
    return '-'
  }
}
console.log(
  `[backup] ${label} 校验通过 会话=${count('select count(*) n from sessions')} ` +
    `消息=${count('select count(*) n from messages')} 切片=${count('select count(*) n from chunks')}`
)
db.close()
NODE_EOF
}

# ---- 1) 账号库（登录态、指纹；丢了所有人都要重新登录）----
if [ -f "$AUTH_DB" ]; then
  AUTH_SNAP="$DEST/auth-$STAMP.db"
  snapshot "$AUTH_DB" "$AUTH_SNAP"
  verify "$AUTH_SNAP" "账号库"
  gzip -9 -f "$AUTH_SNAP"
  echo "[backup] 账号库: auth-$STAMP.db.gz ($(du -h "$DEST/auth-$STAMP.db.gz" | cut -f1))"
else
  echo "[backup] ⚠️ 账号库不存在: $AUTH_DB"
fi

# ---- 2) 每个用户的记忆库 ----
BACKED_UP=0
TOTAL=0
for db in "$DATA_DIR"/*/memory.db; do
  [ -e "$db" ] || continue
  TOTAL=$((TOTAL + 1))
  user="$(basename "$(dirname "$db")")"
  snap="$DEST/memory-$user-$STAMP.db"
  size_kb=$(du -k "$db" | cut -f1)
  snapshot "$db" "$snap"
  verify "$snap" "记忆库 $user"
  gzip -9 -f "$snap"
  BACKED_UP=$((BACKED_UP + 1))
  echo "[backup] 记忆库 $user: 源 ${size_kb}KB → memory-$user-$STAMP.db.gz ($(du -h "$DEST/memory-$user-$STAMP.db.gz" | cut -f1))"
done

if [ "$BACKED_UP" -eq 0 ]; then
  echo "[backup] ❌ 没有找到任何用户记忆库（$DATA_DIR/*/memory.db），请检查 MEMORY_DATA_DIR"
  exit 1
fi
echo "[backup] 小计：备份 $BACKED_UP/$TOTAL 个用户记忆库"

# ---- 3) 配置归档（不含 /etc/*.env 里的密钥）----
CONFIG_TAR="$DEST/config-$STAMP.tar.gz"
tar czf "$CONFIG_TAR" \
  -C / \
  etc/caddy/Caddyfile \
  etc/systemd/system/ds-gateway.service \
  etc/systemd/system/caddy.service \
  etc/systemd/system/ds-gateway-backup.service \
  etc/systemd/system/ds-gateway-backup.timer \
  opt/ds-gateway/src \
  opt/ds-gateway/scripts \
  opt/ds-gateway/shared 2>/dev/null || true

# ---- 4) 本地轮转 ----
rotate() {
  local pattern="$1"
  # shellcheck disable=SC2012
  ls -1t $pattern 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
  done
}
rotate "$DEST/memory-*.db.gz"
rotate "$DEST/auth-*.db.gz"
rotate "$DEST/config-*.tar.gz"

# ---- 5) 推异地（失败不算整体失败：本地备份已经有效）----
if [ -f "$OFFSITE_KEY" ] && command -v scp >/dev/null 2>&1; then
  PUSHED=0
  for f in "$DEST"/*-"$STAMP".db.gz; do
    [ -e "$f" ] || continue
    if scp -q -i "$OFFSITE_KEY" -P "$OFFSITE_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
        "$f" "$OFFSITE_HOST:$OFFSITE_DIR/" 2>/dev/null; then
      PUSHED=$((PUSHED + 1))
    fi
  done
  if [ "$PUSHED" -gt 0 ]; then
    echo "[backup] 异地推送成功 $PUSHED 个文件"
    ssh -i "$OFFSITE_KEY" -p "$OFFSITE_PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
      "$OFFSITE_HOST" "ls -1t $OFFSITE_DIR/*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f" \
      >/dev/null 2>&1 || true
  else
    echo "[backup] ⚠️ 异地推送全部失败（本地备份仍然有效）"
  fi
else
  echo "[backup] 未配置异地密钥，跳过推送"
fi

echo "[backup] 完成。本地保留:"
ls -1t "$DEST"/*.db.gz 2>/dev/null | head -5 | sed 's/^/  /'
