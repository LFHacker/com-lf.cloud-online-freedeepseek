#!/usr/bin/env bash
#
# 把网关数据迁移到 LUKS 加密盘（不停机）。
#
# 为什么这样迁移：
#   · 网关运行时数据必须可读 → 先挂新盘、拷数据、切挂载点、重启，最后才删旧数据
#   · 每步都可独立验证，任何一步失败都停在"旧数据完好"的状态
#
# 前置（用户操作）：
#   阿里云控制台 → 云盘 → 创建云盘（勾选"加密"，选 KMS 密钥）→ 挂载到本实例
#   挂载后设备名通常是 /dev/vdb（可用 lsblk 确认）
#
# 用法：
#   bash migrate-encrypted-volume.sh --device /dev/vdb --size-check
#   bash migrate-encrypted-volume.sh --device /dev/vdb --apply
#
set -euo pipefail

DEVICE=""
APPLY=0
MOUNT_POINT="/var/lib/ds-gateway"
MAPPER="ds-data"
DATA_SRC="/var/lib/ds-gateway"
ENV_FILE="/etc/ds-gateway.env"
FSTAB_LINE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --size-check) APPLY=0; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

[[ -z "$DEVICE" ]] && { echo "用法: $0 --device /dev/vdb [--apply]"; exit 1; }
[[ -b "$DEVICE" ]] || { echo "❌ $DEVICE 不是块设备"; exit 1; }

echo "=== 1) 环境检查 ==="
command -v cryptsetup >/dev/null || { echo "❌ 缺少 cryptsetup（apt install cryptsetup）"; exit 1; }
echo "  设备: $DEVICE ($(lsblk -dno SIZE "$DEVICE"))"
echo "  数据源: $DATA_SRC ($(du -sh "$DATA_SRC" | cut -f1))"
echo "  文件系统: $(lsblk -no FSTYPE "$DEVICE" || echo 空)"
if lsblk -no FSTYPE "$DEVICE" | grep -q .; then
  echo "⚠️  设备上已有文件系统——为防误操作，本脚本拒绝继续。请确认这是一块空盘。"
  exit 1
fi

USED_KB=$(du -sk "$DATA_SRC" | cut -f1)
DEV_KB=$(( $(blockdev --getsize64 "$DEVICE") / 1024 ))
echo "  容量: 数据 ${USED_KB}KB / 盘 ${DEV_KB}KB"
if (( DEV_KB < USED_KB * 2 )); then
  echo "❌ 盘太小（至少要数据量的 2 倍）"
  exit 1
fi

echo
echo "=== 2) 加密 + 文件系统 ==="
if [[ $APPLY -eq 0 ]]; then
  echo "  [干跑] 将执行："
  echo "    cryptsetup luksFormat $DEVICE"
  echo "    cryptsetup open $DEVICE $MAPPER"
  echo "    mkfs.ext4 /dev/mapper/$MAPPER"
  echo "    mount /dev/mapper/$MAPPER /mnt/ds-encrypted"
  echo "    rsync -aHAX --delete $DATA_SRC/ /mnt/ds-encrypted/"
  echo
  echo "  加 --apply 才真的执行。"
  exit 0
fi

# LUKS 密码从文件读，避免进 shell 历史/进程列表
KEY_FILE="/root/.ds-luks.key"
if [[ ! -f "$KEY_FILE" ]]; then
  umask 077
  head -c 48 /dev/urandom | base64 > "$KEY_FILE"
  echo "  已生成 LUKS 密钥文件: $KEY_FILE（权限 600，务必备份到密码管理器）"
fi

cryptsetup luksFormat --batch-mode --key-file "$KEY_FILE" "$DEVICE"
cryptsetup open --key-file "$KEY_FILE" "$DEVICE" "$MAPPER"
mkfs.ext4 -m 0 -L ds-data "/dev/mapper/$MAPPER"

echo
echo "=== 3) 挂载并拷贝（不清源）==="
mkdir -p /mnt/ds-encrypted
mount "/dev/mapper/$MAPPER" /mnt/ds-encrypted
# 网关在跑，WAL 可能有写入；先停服务保证一致
systemctl stop ds-gateway
rsync -aHAX --delete "$DATA_SRC"/ /mnt/ds-encrypted/
echo "  拷贝完成: $(du -sh /mnt/ds-encrypted | cut -f1)"

echo
echo "=== 4) 校验（新旧逐一对比大小）==="
DIFF=$(diff <(cd "$DATA_SRC" && find . -type f | sort) <(cd /mnt/ds-encrypted && find . -type f | sort) || true)
if [[ -n "$DIFF" ]]; then
  echo "❌ 文件清单不一致，已停止（旧数据未动）:"
  echo "$DIFF" | head -10
  systemctl start ds-gateway
  exit 1
fi
echo "  ✅ 文件清单一致（$(cd "$DATA_SRC" && find . -type f | wc -l) 个文件）"

echo
echo "=== 5) 切挂载点 ==="
umount /mnt/ds-encrypted
# 旧目录只在本次运行时腾开，数据仍在（改名而不是删除）
rm -rf "${DATA_SRC}.old" 2>/dev/null || true
mv "$DATA_SRC" "${DATA_SRC}.old"
mkdir -p "$DATA_SRC"
mount "/dev/mapper/$MAPPER" "$DATA_SRC"

# /etc/crypttab + fstab：重启后自动解锁并挂载
if ! grep -q "$MAPPER" /etc/crypttab 2>/dev/null; then
  echo "$MAPPER UUID=$(cryptsetup luksUUID "$DEVICE") $KEY_FILE luks" >> /etc/crypttab
fi
if ! grep -q "/dev/mapper/$MAPPER" /etc/fstab 2>/dev/null; then
  echo "/dev/mapper/$MAPPER $DATA_SRC ext4 defaults 0 2" >> /etc/fstab
fi
chown -R dsgateway:dsgateway "$DATA_SRC"
echo "  已写入 /etc/crypttab 与 /etc/fstab"

echo
echo "=== 6) 启动并验证 ==="
systemctl start ds-gateway
sleep 5
systemctl is-active ds-gateway
curl -s -m 5 -o /dev/null -w "  /health: %{http_code}\n" http://127.0.0.1:8787/health

echo
echo "=== 7) 结果 ==="
echo "  加密卷: $(cryptsetup status "$MAPPER" | head -1)"
echo "  挂载: $(findmnt -no SOURCE,TARGET "$DATA_SRC")"
echo "  旧数据保留在: ${DATA_SRC}.old（确认无误后手动删除：rm -rf ${DATA_SRC}.old）"
echo
echo "⚠️  请备份 /root/.ds-luks.key —— 丢了它，加密盘永久无法解锁。"
