#!/usr/bin/env bash
# NapCat + QQ（Linux 无头运行，二维码登录一次后长期在线）
#
#   sudo bash 01-napcat.sh
#
# 之后打开 http://<服务器IP>:6099/webui 扫码登录。
# Agent 通过 ws://127.0.0.1:3001 连它。

set -euo pipefail

echo "== 1/3 检查 docker =="
if ! command -v docker >/dev/null 2>&1; then
  echo "   未安装，从 docker-ce 官方仓库装"
  dnf -y install dnf-plugins-core
  dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  # 国内服务器直连 download.docker.com 可能慢，必要时换成阿里云镜像：
  #   sed -i 's#download.docker.com#mirrors.aliyun.com/docker-ce#' /etc/yum.repos.d/docker-ce.repo
  dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
else
  echo "   已有 docker: $(docker --version)"
fi

echo "== 2/3 启动 NapCat =="
if docker ps -a --format '{{.Names}}' | grep -qx napcat; then
  echo "   容器已存在，直接启动"
  docker start napcat
else
  docker run -d \
    --name napcat \
    --restart=always \
    -p 127.0.0.1:3001:3001 \
    -p 6099:6099 \
    -v napcat-config:/app/napcat/config \
    -v napcat-qq:/app/.config/QQ \
    mlikiowa/napcat-docker:latest
fi

echo "== 3/3 状态 =="
sleep 5
docker ps --filter name=napcat --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
cat <<'EOF'

下一步：
  1. 浏览器打开 http://<服务器公网IP>:6099/webui
     （云厂商安全组要放行 6099，登录完建议关掉）
  2. 用手机 QQ 扫码登录机器人账号
  3. 确认 3001 在监听：ss -lntp | grep 3001
     注意 3001 只绑了 127.0.0.1，不对外暴露，Agent 在本机连它

日志：docker logs -f napcat
EOF
