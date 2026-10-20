#!/usr/bin/env bash
# QQ Agent 本体：装 Node、解包、systemd 常驻
#
#   sudo bash 02-agent.sh /root/qqagent-deploy.zip
#
# 假设包里有：src config data package.json package-lock.json tsconfig.json
# 装到 /opt/qqagent，以 qqagent 用户运行。

set -euo pipefail

ZIP="${1:-/root/qqagent-deploy.tar.gz}"
DIR=/opt/qqagent
USER_NAME=qqagent

[ -f "$ZIP" ] || { echo "找不到部署包：$ZIP"; exit 1; }

echo "== 1/5 装 Node 22 =="
if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 22 ]; then
  echo "   已有 node $(node -v)"
else
  dnf -y module reset nodejs 2>/dev/null || true
  dnf -y module disable nodejs 2>/dev/null || true
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf -y install nodejs
fi
node -v

echo "== 2/5 建用户和解包 =="
id "$USER_NAME" >/dev/null 2>&1 || useradd -r -m -d /home/$USER_NAME -s /bin/bash "$USER_NAME"
mkdir -p "$DIR"
case "$ZIP" in
  *.tar.gz|*.tgz) tar xzf "$ZIP" -C "$DIR" ;;
  *.zip) dnf -y install unzip >/dev/null 2>&1 || true; unzip -oq "$ZIP" -d "$DIR" ;;
  *) echo "不认识的包格式：$ZIP"; exit 1 ;;
esac
chown -R "$USER_NAME":"$USER_NAME" "$DIR"

echo "== 3/5 装依赖并编译 =="
cd "$DIR"
sudo -u "$USER_NAME" bash -lc 'cd /opt/qqagent && npm ci --ignore-scripts && npm run build'

echo "== 4/5 时区、本地覆盖、systemd =="
# 主动私聊按 10:30-23:00 选时间，服务器不是东八区就会半夜发消息
timedatectl set-timezone Asia/Shanghai 2>/dev/null || true

# 目标 QQ 不进版本库，用环境变量传：PROACTIVE_UID=2731758714 bash 02-agent.sh ...
if [ -n "${PROACTIVE_UID:-}" ]; then
  printf '{\n  "target": { "users": [%s] }\n}\n' "$PROACTIVE_UID" > "$DIR/config/proactive.local.json"
  printf '{\n  "target": { "users": [%s] }\n}\n' "$PROACTIVE_UID" > "$DIR/config/self-post.local.json"
  chown "$USER_NAME":"$USER_NAME" "$DIR/config/proactive.local.json" "$DIR/config/self-post.local.json"
  echo "   已写入目标 QQ：$PROACTIVE_UID"
else
  echo "   [i] 没给 PROACTIVE_UID，主动私聊和说说私聊回落会跳过（私聊目标为空）"
fi

cat >/etc/systemd/system/qqagent.service <<'EOF'
[Unit]
Description=QQ Agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=qqagent
WorkingDirectory=/opt/qqagent
Environment=NODE_ENV=production
Environment=TZ=Asia/Shanghai
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5
StandardOutput=append:/opt/qqagent/logs/stdout.log
StandardError=append:/opt/qqagent/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/qqagent-cron.service <<'EOF'
[Unit]
Description=QQ Agent 例行任务（说说 / 主动私聊）
After=qqagent.service

[Service]
Type=oneshot
User=qqagent
WorkingDirectory=/opt/qqagent
Environment=TZ=Asia/Shanghai
ExecStart=/usr/bin/bash /opt/qqagent/deploy/cron.sh
EOF

cat >/etc/systemd/system/qqagent-cron.timer <<'EOF'
[Unit]
Description=每 10 分钟跑一次 QQ Agent 例行任务

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

mkdir -p "$DIR/logs" && chown -R "$USER_NAME":"$USER_NAME" "$DIR/logs"
systemctl daemon-reload
systemctl enable --now qqagent
systemctl enable --now qqagent-cron.timer

echo "== 5/5 状态 =="
sleep 6
systemctl --no-pager --lines=15 status qqagent || true
echo "--- 例行任务 ---"
systemctl list-timers qqagent-cron.timer --no-pager || true
echo
echo "面板只在 127.0.0.1:3081，从本机连隧道看："
echo "  ssh -L 3081:127.0.0.1:3081 <user>@<server>"
echo "  然后浏览器开 http://127.0.0.1:3081"
echo
echo "日志：journalctl -u qqagent -f   （或 tail -f /opt/qqagent/logs/stdout.log）"
echo "说说/主动私聊：tail -f /opt/qqagent/logs/self-post.log /opt/qqagent/logs/proactive.log"
