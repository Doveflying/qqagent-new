#!/usr/bin/env bash
# 只更新代码：解包（跳过 data）-> 编译 -> 重启
set -e
DIR=/opt/qqagent

tar xzf /root/qqagent-deploy.tar.gz -C "$DIR" --exclude='./data/*'
chown -R qqagent:qqagent "$DIR"

echo "=== 编译 ==="
sudo -u qqagent bash -lc 'cd /opt/qqagent && npm run build' 2>&1 | tail -3

echo
echo "=== 重启 ==="
systemctl restart qqagent
sleep 8
systemctl is-active qqagent

echo
echo "=== 新代码是否在（audioSeconds 应该存在）==="
node -e "
const s=require('/opt/qqagent/dist/src/llm/speech.js');
console.log('audioSeconds:', typeof s.audioSeconds, '| splitVoiceText:', typeof s.splitVoiceText);
const t='今天下课以后。风很大。走到路口灯亮了。买了瓶水。天快黑了。';
console.log('二分示例:', s.splitVoiceText(t,2).map(x=>x.length).join(' / '));
"

echo
echo "=== health ==="
curl -s --max-time 10 http://127.0.0.1:3081/api/health | head -c 200
echo
