#!/bin/bash
# 宠影孪生-数字孪生体操作平台 —— 服务器一键部署
# 在宝塔面板「终端」中运行（或任意能登录服务器的终端）。
# 静态资源全部经 jsDelivr 从 GitHub 分发，服务器只放一个 6KB 入口页。
# 服务器：124.222.169.94:2000/blender-3d-operator/（SSH 端口 3320）

set -e
DIR=/www/wwwroot/blender-3d-operator
REPO=YangD5014/Blender-Rigify-Three
CONF=/www/server/panel/vhost/nginx/blender-3d-operator.conf

mkdir -p $DIR
curl -sL -o $DIR/index.html "https://cdn.jsdelivr.net/gh/$REPO@main/deploy/index.html"
echo "入口页已部署: $DIR/index.html ($(wc -c < $DIR/index.html) 字节)"

# 写入 nginx 站点配置（2000 端口 + /blender-3d-operator/ 路径）
cat > $CONF <<'NGINX'
# 宠影孪生-数字孪生体操作平台（静态资源经 jsDelivr 从 GitHub 分发）
server {
    listen 2000;
    server_name _;

    location /blender-3d-operator/ {
        alias /www/wwwroot/blender-3d-operator/;
        index index.html;
    }

    location / {
        return 404;
    }
}
NGINX

# 放行防火墙端口
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=2000/tcp >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

nginx -t && nginx -s reload
echo "部署完成: http://124.222.169.94:2000/blender-3d-operator/"
