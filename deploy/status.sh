#!/usr/bin/env bash
# 云端一键体检（在本机跑：powershell -File deploy/run-remote.ps1 deploy/status.sh）
echo "=== 服务 ==="
systemctl is-active qqagent         | sed 's/^/qqagent:        /'
systemctl is-active qqagent-cron.timer | sed 's/^/cron timer:     /'
docker ps --filter name=napcat --format 'napcat:         {{.Status}}'

echo
echo "=== OneBot（真登录看 bkn，不看 online）==="
node -e '
const ws = new WebSocket("ws://127.0.0.1:3001");
const done=(c,m)=>{try{ws.close()}catch{};console.log(m);process.exit(c)};
const t=setTimeout(()=>done(2,"超时"),12000);
ws.onopen=()=>ws.send(JSON.stringify({action:"get_cookies",params:{domain:"qzone.qq.com"},echo:"p"}));
ws.onmessage=e=>{let d;try{d=JSON.parse(e.data)}catch{return}if(d.echo!=="p")return;clearTimeout(t);
  const bkn=String((d.data||{}).bkn||"");done(bkn?0:1,`retcode=${d.retcode} bkn长度=${bkn.length} `+(bkn?"（会话有效）":"（会话失效）"));};
ws.onerror=()=>{clearTimeout(t);done(1,"WS 连不上 3001")};
'

echo
echo "=== health ==="
curl -s --max-time 10 http://127.0.0.1:3081/api/health | head -c 260
echo

echo
echo "=== 资源 ==="
free -h | head -3
df -h / | tail -1

echo
echo "=== 最近一轮例行任务 ==="
tail -2 /opt/qqagent/logs/self-post.log 2>/dev/null
tail -2 /opt/qqagent/logs/proactive.log 2>/dev/null
