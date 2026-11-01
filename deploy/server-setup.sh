#!/bin/bash
# 宠影孪生-数字孪生体操作平台 —— 服务器一键部署
# 在宝塔面板「终端」中运行（或任意能登录服务器的终端）。
# 静态资源全部经 jsDelivr 从 GitHub 分发，服务器只放一个 6KB 入口页。

set -e
DIR=/www/wwwroot/3d-operation-sys
REPO=YangD5014/Blender-Rigify-Three

mkdir -p $DIR
curl -sL -o $DIR/index.html "https://cdn.jsdelivr.net/gh/$REPO@main/deploy/index.html"
echo "入口页已部署: $DIR/index.html ($(wc -c < $DIR/index.html) 字节)"
echo "下一步：宝塔面板 → 网站 → 对应 2000 端口站点 → 配置文件，在 server 块内加入："
cat <<'NGINX'
location /3d-operation-sys/ {
    alias /www/wwwroot/3d-operation-sys/;
    index index.html;
}
NGINX
echo "然后重载 nginx（bt 命令或 nginx -s reload）"
