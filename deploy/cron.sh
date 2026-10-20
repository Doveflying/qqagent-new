#!/usr/bin/env bash
# 云端每 10 分钟的例行任务（对应 Windows 上的 model-schedule-loop.cmd）
#
#   systemd timer 调用；也可以手动跑：bash deploy/cron.sh

set -u
DIR=/opt/qqagent
cd "$DIR" || { echo "找不到 $DIR"; exit 1; }
mkdir -p logs

echo "=== $(date '+%F %T') ==="

# 自发说说：每天最多一条，随机时段，自带间隔与失败退避
node scripts/self-post.mjs >> logs/self-post.log 2>&1

# 主动私聊：每天最多一条；你在聊天就不打扰
node scripts/proactive-dm.mjs >> logs/proactive.log 2>&1

# 回复空间动态：watch 白名单里的人发新说说就评论一句
node scripts/qzone-reply.mjs >> logs/qzone.log 2>&1

# 注意：以下这些在云端不需要
#   obsidian-sync  → config/obsidian.json 是 Windows 路径，vault 没搬上来
#   speech-backend → 云端没有 VoiceStudio，siliconflow 复刻音色直接就是主 TTS
#   watchdog       → Windows 的 bkn 探针 + 扫码修复，Linux 上由 docker restart 策略兜底
