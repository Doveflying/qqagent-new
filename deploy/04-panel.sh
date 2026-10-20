#!/usr/bin/env bash
# 手机访问面板：nginx + HTTPS（自签证书）+ HTTP Basic Auth
#
#   sudo bash 04-panel.sh '你的密码'
#
# 面板本身仍然只监听 127.0.0.1:3081，nginx 在 8443 上做认证与转发。
# 需要云厂商安全组放行 8443/tcp。

set -e

PASS="${1:-}"
PORT=8443
DIR=/opt/qqagent
CERT_DIR=/etc/nginx/certs

[ -n "$PASS" ] || { echo "用法：sudo bash 04-panel.sh '密码'"; exit 1; }

echo "== 1/5 装 nginx =="
command -v nginx >/dev/null 2>&1 || dnf -y install -q nginx
systemctl enable nginx >/dev/null 2>&1 || true

echo "== 2/5 自签证书 =="
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/panel.crt" ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$CERT_DIR/panel.key" -out "$CERT_DIR/panel.crt" \
    -subj "/CN=qqagent-panel" >/dev/null 2>&1
  chmod 600 "$CERT_DIR/panel.key"
fi
echo "   证书：$CERT_DIR/panel.crt（10 年）"

echo "== 3/5 密码 =="
if command -v htpasswd >/dev/null 2>&1; then
  htpasswd -bc /etc/nginx/.htpasswd admin "$PASS" >/dev/null
else
  dnf -y install -q httpd-tools
  htpasswd -bc /etc/nginx/.htpasswd admin "$PASS" >/dev/null
fi
chmod 640 /etc/nginx/.htpasswd
chown root:nginx /etc/nginx/.htpasswd 2>/dev/null || true

echo "== 4/5 nginx 站点 =="
cat >/etc/nginx/conf.d/qqagent-panel.conf <<EOF
server {
    listen $PORT ssl;
    server_name _;

    ssl_certificate     $CERT_DIR/panel.crt;
    ssl_certificate_key $CERT_DIR/panel.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    auth_basic           "QQ Agent";
    auth_basic_user_file /etc/nginx/.htpasswd;

    client_max_body_size 32m;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:3081;
    }
}
EOF

nginx -t
systemctl restart nginx

echo "== 5/5 SELinux / 防火墙 =="
# Rocky 默认 enforcing，不放行的话 nginx 连不到 127.0.0.1:3081
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  setsebool -P httpd_can_network_connect 1 || echo "   [warn] SELinux 放行失败"
  echo "   SELinux httpd_can_network_connect=1"
fi
if systemctl is-active firewalld >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=$PORT/tcp >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  echo "   firewalld 已放行 $PORT/tcp"
else
  echo "   firewalld 未运行，跳过"
fi

echo
echo "=== 自检（无密码应 401，有密码应 200）==="
echo -n "without auth: "
curl -sk -o /dev/null -w '%{http_code}\n' "https://127.0.0.1:$PORT/" || true
echo -n "with auth:    "
curl -sk -u "admin:$PASS" -o /dev/null -w '%{http_code}\n' "https://127.0.0.1:$PORT/" || true

echo
echo "手机浏览器访问：https://$(curl -s --max-time 8 https://ipinfo.io/ip 2>/dev/null || echo '服务器公网IP'):$PORT"
echo "用户名 admin，密码你刚给的那个"
echo
echo "记得在阿里云安全组放行 $PORT/tcp，否则外网连不上。"
