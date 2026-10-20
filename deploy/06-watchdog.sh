#!/usr/bin/env bash
# 重建 NapCat 容器（带 ACCOUNT 以便快速登录）+ 装会话看门狗
#
#   sudo bash 06-watchdog.sh <机器人QQ号>
#
# 看门狗本体在 deploy/napcat-watchdog.sh，这里只负责安装与启用。
set -e

UIN="${1:?用法：06-watchdog.sh <机器人QQ号>}"

echo "== 1/4 重建容器（保留配置和 QQ 数据卷）=="
if docker ps -a --format '{{.Names}}' | grep -qx napcat; then
  docker rm -f napcat >/dev/null
fi
docker run -d --name napcat --restart=always \
  -e MODE=ws -e ACCOUNT="$UIN" -e TZ=Asia/Shanghai \
  -p 127.0.0.1:3001:3001 -p 127.0.0.1:6099:6099 \
  -v napcat-config:/app/napcat/config \
  -v napcat-qq:/app/.config/QQ \
  mlikiowa/napcat-docker:latest >/dev/null
echo "   容器已重建，启动参数：MODE=ws ACCOUNT=$UIN"

echo "== 2/4 等它出码或快速登录 =="
for i in $(seq 1 25); do
  sleep 3
  if docker logs napcat 2>&1 | grep -qa '二维码已保存\|已上线\|登录成功'; then break; fi
done
docker logs napcat 2>&1 | grep -aE '快速登录|二维码解码URL|已上线|Login Error' | tail -4

echo "== 3/4 装看门狗 =="
SRC=/opt/qqagent/deploy/napcat-watchdog.sh
if [ -f "$SRC" ]; then
  chmod +x "$SRC"
  chown qqagent:qqagent "$SRC"
  echo "   脚本：$SRC"
else
  echo "   [warn] 找不到 $SRC —— 先把部署包解压到 /opt/qqagent"
fi

cat >/etc/systemd/system/napcat-watchdog.service <<'EOF'
[Unit]
Description=NapCat 会话看门狗

[Service]
Type=oneshot
ExecStart=/usr/bin/bash /opt/qqagent/deploy/napcat-watchdog.sh
EOF

cat >/etc/systemd/system/napcat-watchdog.timer <<'EOF'
[Unit]
Description=每 2 分钟检查一次 QQ 会话

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=20s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now napcat-watchdog.timer
echo "   看门狗已启用（每 2 分钟；连续 2 次失败重启容器；重启也没救则 30 分钟冷却）"

echo "== 4/4 状态 =="
systemctl list-timers napcat-watchdog.timer --no-pager | head -3
docker logs napcat 2>&1 | grep -a '二维码解码URL' | tail -1
docker cp napcat:/app/napcat/cache/qrcode.png /root/qr-inst1.png 2>/dev/null && stat -c '%y' /root/qr-inst1.png || true
