#!/usr/bin/env bash
# 只更新代码：解包（跳过 data 和 config）-> 编译 -> 重启
#
# 为什么不覆盖 config：线上配置会和本机分叉（云端 TTS 音色、管理员、server 段）。
# 代码更新顺手把 config 写回去会静默改掉线上行为，所以排除；要同步配置走 02-agent.sh。
set -e
DIR=/opt/qqagent

tar xzf /root/qqagent-deploy.tar.gz -C "$DIR" --exclude='./data/*' --exclude='./config/*'
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
