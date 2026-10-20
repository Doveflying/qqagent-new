#!/usr/bin/env bash
# 再部署一套独立实例（给朋友用）：独立 QQ 号、独立数据库、独立 API Key、独立面板
#
#   sudo bash 05-instance.sh <序号> <面板密码> [管理员QQ]
#   例：sudo bash 05-instance.sh 2 'friendpass' 123456789
#
# 序号 2 => 目录 /opt/qqagent2，端口：OneBot 3002 / WebUI 6100 / 面板 8444
# 序号 3 => /opt/qqagent3，3003 / 6101 / 8445 …
set -e

N="${1:?用法：05-instance.sh <序号> <面板密码> [管理员QQ]}"
PASS="${2:?缺少面板密码}"
ADMIN_QQ="${3:-}"
BASE=/opt/qqagent
DIR="/opt/qqagent$N"
OB_PORT=$((3000 + N))
WEBUI_PORT=$((6099 + N))   # 6100, 6101 …
PANEL_SSL_PORT=$((8443 + N)) # 8444, 8445 …
PANEL_PORT=$((3080 + N))   # 3082, 3083 …
CONTAINER="napcat$N"

[ -d "$BASE" ] || { echo "先装好第一套（$BASE 不存在）"; exit 1; }
[ -d "$DIR" ] && { echo "$DIR 已存在，先备份/删除再重跑"; exit 1; }

echo "== 1/6 复制代码 =="
mkdir -p "$DIR"
tar -C "$BASE" -cf - \
  --exclude='./data' --exclude='./logs' --exclude='./runtime' \
  --exclude='./config/providers.local.yaml' \
  --exclude='./config/*.state.json' --exclude='./config/*.local.json' \
  --exclude='./config/roleplay.json' --exclude='./deploy/_*.sh' . | tar -C "$DIR" -xf -
mkdir -p "$DIR/data" "$DIR/logs"
: > "$DIR/config/providers.local.yaml"

echo "== 2/6 改配置（端口 / 管理员 / 关掉本地语音）=="
node - "$DIR" "$OB_PORT" "$PANEL_PORT" "$ADMIN_QQ" <<'JS'
const fs = require('fs'), path = require('path'), YAML = require(process.argv[2] + '/node_modules/yaml');
const [dir, obPort, panelPort, adminQq] = process.argv.slice(2);
const file = path.join(dir, 'config', 'app.yaml');
const cfg = YAML.parse(fs.readFileSync(file, 'utf8')) || {};
// 真正的键是 server(host/port) 和 napcat.url；写成 web/onebot 会被忽略（踩过）
cfg.server = { ...(cfg.server || {}), host: '127.0.0.1', port: Number(panelPort) };
cfg.napcat = { ...(cfg.napcat || {}), url: `ws://127.0.0.1:${obPort}` };
if (adminQq) {
  cfg.access = cfg.access || {};
  cfg.access.lists = { ...(cfg.access.lists || {}), admins: [Number(adminQq)] };
}
// 这套没有语音代理，先关掉 TTS，免得每句话都在等超时
cfg.speech = cfg.speech || {};
cfg.speech.tts = { ...(cfg.speech.tts || {}), enabled: false };
fs.writeFileSync(file, YAML.stringify(cfg), 'utf8');
// 脚本里的地址一起改
for (const f of ['self-post.json', 'proactive.json', 'model-schedule.json', 'watchdog.json', 'speech-backend.json']) {
  const p = path.join(dir, 'config', f);
  if (!fs.existsSync(p)) continue;
  const raw = fs.readFileSync(p, 'utf8')
    .replace(/127\.0\.0\.1:3081/g, `127.0.0.1:${panelPort}`)
    .replace(/127\.0\.0\.1:3001/g, `127.0.0.1:${obPort}`);
  try { JSON.parse(raw); fs.writeFileSync(p, raw, 'utf8'); } catch { /* 忽略 */ }
}
console.log('   server.port =', panelPort, '| napcat.url = ws://127.0.0.1:' + obPort, adminQq ? '| admins = ' + adminQq : '');
JS

echo "== 3/6 清空实例专属状态（人格/记忆沿用，私有状态重建）=="
rm -f "$DIR"/config/*.state.json "$DIR"/config/*.local.json "$DIR"/config/roleplay.json
rm -f "$DIR/data"/*.db "$DIR/data"/*.db-*

echo "== 4/6 NapCat 容器（MODE=ws 自动生成 WS 配置）=="
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "   $CONTAINER 已存在，直接启动"
  docker start "$CONTAINER" >/dev/null
else
  docker run -d --name "$CONTAINER" --restart=always \
    -e MODE=ws \
    -e TZ=Asia/Shanghai \
    -p 127.0.0.1:$OB_PORT:3001 \
    -p 127.0.0.1:$WEBUI_PORT:6099 \
    -v "$CONTAINER-config:/app/napcat/config" \
    -v "$CONTAINER-qq:/app/.config/QQ" \
    mlikiowa/napcat-docker:latest >/dev/null
fi

echo "== 5/6 systemd =="
cat >"/etc/systemd/system/qqagent$N.service" <<EOF
[Unit]
Description=QQ Agent 实例 $N
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=qqagent
WorkingDirectory=$DIR
Environment=NODE_ENV=production
Environment=TZ=Asia/Shanghai
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=5
StandardOutput=append:$DIR/logs/stdout.log
StandardError=append:$DIR/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF

cat >"$DIR/deploy/cron$N.sh" <<EOF
#!/usr/bin/env bash
set -u
cd "$DIR" || exit 1
mkdir -p logs
echo "=== \$(date '+%F %T') ==="
node scripts/self-post.mjs >> logs/self-post.log 2>&1
node scripts/proactive-dm.mjs >> logs/proactive.log 2>&1
EOF
chmod +x "$DIR/deploy/cron$N.sh"

cat >"/etc/systemd/system/qqagent$N-cron.service" <<EOF
[Unit]
Description=QQ Agent 实例 $N 例行任务
After=qqagent$N.service

[Service]
Type=oneshot
User=qqagent
WorkingDirectory=$DIR
Environment=TZ=Asia/Shanghai
ExecStart=/usr/bin/bash $DIR/deploy/cron$N.sh
EOF

cat >"/etc/systemd/system/qqagent$N-cron.timer" <<EOF
[Unit]
Description=每 10 分钟跑一次实例 $N 的例行任务

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

chown -R qqagent:qqagent "$DIR"
systemctl daemon-reload
systemctl enable --now "qqagent$N"

echo "== 6/6 面板（$PANEL_SSL_PORT，独立密码）=="
htpasswd -bc /etc/nginx/.htpasswd-$N "friend$N" "$PASS" >/dev/null
chmod 640 /etc/nginx/.htpasswd-$N
chown root:nginx /etc/nginx/.htpasswd-$N 2>/dev/null || true
cat >"/etc/nginx/conf.d/qqagent-panel$N.conf" <<EOF
server {
    listen $PANEL_SSL_PORT ssl;
    server_name _;
    ssl_certificate     /etc/nginx/certs/panel.crt;
    ssl_certificate_key /etc/nginx/certs/panel.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    auth_basic           "QQ Agent $N";
    auth_basic_user_file /etc/nginx/.htpasswd-$N;
    client_max_body_size 32m;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 3600s;
    location / { proxy_pass http://127.0.0.1:$PANEL_PORT; }
}
EOF
nginx -t >/dev/null && systemctl reload nginx
setsebool -P httpd_can_network_connect 1 2>/dev/null || true

echo
echo "=== 状态 ==="
systemctl is-active "qqagent$N"
docker ps --filter "name=$CONTAINER" --format "{{.Names}} {{.Status}} {{.Ports}}"
echo
echo "目录：$DIR"
echo "面板：https://<公网IP>:$PANEL_SSL_PORT   用户名 friend$N   密码 $PASS"
echo "WebUI（扫码）：ssh -L $WEBUI_PORT:127.0.0.1:$WEBUI_PORT root@<公网IP> 后开 http://127.0.0.1:$WEBUI_PORT/webui"
echo "或直接看二维码：docker exec $CONTAINER cat /app/napcat/cache/qrcode.png > /tmp/qr$N.png"
echo
echo "API Key 还没配：登录面板后「模型供应商」里加他自己那家的 key，或者把 key 发我。"
