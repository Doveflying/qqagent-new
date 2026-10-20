#!/usr/bin/env bash
# QQ 会话看门狗：bkn 是唯一可信的登录态（get_status.online 会假在线）
#
#   systemd timer 每 2 分钟跑一次；也可以手动：bash deploy/napcat-watchdog.sh
#
# 顺序很重要：先探测，探测成功就直接清冷却退出；
# 否则人工扫码恢复之后，会因为冷却期还没过而继续报"需要人工扫码"。

LOG=/opt/qqagent/logs/watchdog.log
STAMP=/opt/qqagent/runtime/watchdog.fails
BACKOFF=/opt/qqagent/runtime/watchdog.backoff
mkdir -p /opt/qqagent/runtime "$(dirname "$LOG")"

probe() {
  timeout 15 node -e '
const ws = new WebSocket("ws://127.0.0.1:3001");
const done = (ok) => { try { ws.close(); } catch {} process.exit(ok ? 0 : 1); };
const t = setTimeout(() => done(false), 12000);
ws.onopen = () => ws.send(JSON.stringify({ action: "get_cookies", params: { domain: "qzone.qq.com" }, echo: "w" }));
ws.onmessage = (e) => { let d; try { d = JSON.parse(e.data); } catch { return; }
  if (d.echo !== "w") return; clearTimeout(t); done(String((d.data || {}).bkn || "").length > 0); };
ws.onerror = () => { clearTimeout(t); done(false); };
' 2>/dev/null
}

# ---- 先探测：好了就收工，顺手清掉冷却 ----
if probe; then
  echo "[$(date '+%F %T')] OK 会话有效" >> "$LOG"
  echo 0 > "$STAMP"
  rm -f "$BACKOFF"
  exit 0
fi

# ---- 探测失败：冷却期内不重复重启 ----
if [ -f "$BACKOFF" ]; then
  last=$(cat "$BACKOFF" 2>/dev/null || echo 0)
  left=$(( 1800 - ( $(date +%s) - last ) ))
  if [ "$left" -gt 0 ]; then
    echo "[$(date '+%F %T')] FAIL 冷却期中（约 $(( left / 60 )) 分钟后才会再尝试重启；需人工扫码）" >> "$LOG"
    exit 0
  fi
fi

fails=$(( $(cat "$STAMP" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STAMP"
echo "[$(date '+%F %T')] FAIL 第 $fails 次探测失败" >> "$LOG"

if [ "$fails" -ge 2 ]; then
  echo "[$(date '+%F %T')] 连续失败，重启 napcat 容器" >> "$LOG"
  docker restart napcat >> "$LOG" 2>&1
  echo 0 > "$STAMP"
  sleep 70
  if probe; then
    echo "[$(date '+%F %T')] 重启后恢复" >> "$LOG"
    rm -f "$BACKOFF"
  else
    echo "[$(date '+%F %T')] 重启后仍未登录 —— 需要人工扫码；进入 30 分钟冷却" >> "$LOG"
    date +%s > "$BACKOFF"
  fi
fi
