#!/usr/bin/env bash
# 云端重登：重启 NapCat 容器，回到扫码登录状态
#
#   bash relogin.sh [容器名]      # 默认 napcat
#
# 为什么是重启容器：容器里没有可用的快速登录令牌（镜像重启后令牌就没了），
# 所以 `docker restart` 之后必然重新生成二维码 —— 效果等同本机的
# scripts/repair-login.ps1 -NoOpen。
#
# 代价：重启 = 当前登录掉线。已经登录着的时候不要点「重新生成二维码」。
# 由管理面板「扫码登录」页的按钮触发，输出被重定向到 runtime/login-repair.log。

set -uo pipefail

CONTAINER="${1:-napcat}"
QR=/app/napcat/cache/qrcode.png

echo "== 目标容器: $CONTAINER =="
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "找不到容器 $CONTAINER，可用：$(docker ps --format '{{.Names}}' | tr '\n' ' ')"
  exit 2
fi

before="$(docker exec "$CONTAINER" stat -c %Y "$QR" 2>/dev/null || echo 0)"
echo "旧二维码时间戳: $before"

echo "== 重启容器（当前会话会掉线）=="
docker restart "$CONTAINER" >/dev/null 2>&1 || { echo "docker restart 失败"; exit 3; }

echo "== 等新二维码（最多 180 秒）=="
for i in $(seq 1 90); do
  sleep 2
  now="$(docker exec "$CONTAINER" stat -c %Y "$QR" 2>/dev/null || echo 0)"
  if [ "$now" != "0" ] && [ "$now" != "$before" ]; then
    echo "二维码已更新（约 $((i * 2)) 秒）: $QR"
    echo "请在管理面板「扫码登录」页刷新查看并扫码。"
    exit 0
  fi
done

echo "超时：容器没有生成新二维码。看日志：docker logs --tail 40 $CONTAINER"
exit 4
