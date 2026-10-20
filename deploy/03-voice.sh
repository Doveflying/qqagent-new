#!/usr/bin/env bash
# 云端语音代理（:3910）：中文 -> 目标语言翻译 -> 云端 TTS -> 响度提升
# /lang 指令改的就是它读的 config/voice-proxy.json
#
#   sudo bash 03-voice.sh
set -e

DIR=/opt/qqagent
USER_NAME=qqagent

[ -f "$DIR/scripts/voice-boost.mjs" ] || { echo "先跑 02-agent.sh"; exit 1; }

cat >/etc/systemd/system/qqagent-voice.service <<'EOF'
[Unit]
Description=QQ Agent 语音代理（翻译 + TTS + 响度）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=qqagent
WorkingDirectory=/opt/qqagent
Environment=TZ=Asia/Shanghai
ExecStart=/usr/bin/node scripts/voice-boost.mjs
Restart=always
RestartSec=5
StandardOutput=append:/opt/qqagent/logs/voice.log
StandardError=append:/opt/qqagent/logs/voice.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now qqagent-voice
sleep 6

echo "=== 服务状态 ==="
systemctl is-active qqagent-voice

echo
echo "=== /health ==="
curl -s --max-time 10 http://127.0.0.1:3910/health | head -c 500
echo

echo
echo "=== 日志 ==="
tail -6 "$DIR/logs/voice.log" 2>/dev/null || true
