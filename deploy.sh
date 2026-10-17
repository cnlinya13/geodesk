#!/usr/bin/env bash
#
# GEODesk 一键部署脚本 —— 陌生人 1 分钟体验版
#
# 部署的是「合成演示模式」：内存里的假数据，没有数据库、不需要任何模型 Key，
# 公网直接访问是安全的。想跑真实模式请看 README 的本地开发章节。
#
# 最快体验（一条命令，完全非交互）：
#   curl -fsSL https://raw.githubusercontent.com/cnlinya13/geodesk/main/deploy.sh | sudo bash
#
# 讲究一点的（先下载、看一眼再跑，参考 Docker 官方 get.docker.com 的做法）：
#   curl -fsSL https://raw.githubusercontent.com/cnlinya13/geodesk/main/deploy.sh -o deploy.sh
#   less deploy.sh            # 检查脚本内容
#   sudo bash deploy.sh
#
# 指定版本 / 绑定域名：
#   curl -fsSL .../deploy.sh | sudo bash -s v0.3.1
#   curl -fsSL .../deploy.sh | sudo bash -s v0.3.1 demo.example.com
#   # 或用环境变量：
#   curl -fsSL .../deploy.sh | sudo VERSION=v0.3.1 DOMAIN=demo.example.com bash
#
# 环境变量（全部可选）：
#   VERSION       要部署的 tag，缺省自动取 GitHub 最新 Release
#   DOMAIN        绑定的域名；不填则用服务器公网 IP 访问，不配 HTTPS
#   NPM_MIRROR    npm registry，缺省 https://registry.npmmirror.com
#   SKIP_APT      设为 1 跳过 apt/dnf/yum 装包（已装好 curl/git/nginx 时用）
#   SKIP_CERTBOT  设为 1 跳过 certbot（已有证书或只想用 HTTP 时用）
#
# 重复执行 = 更新到指定版本；卸载方法见脚本末尾输出。
#
set -euo pipefail

REPO="cnlinya13/geodesk"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/main"
INSTALL_DIR="/opt/geodesk"
NODE_VERSION="24.20.0"
NPM_MIRROR="${NPM_MIRROR:-https://registry.npmmirror.com}"
FALLBACK_VERSION="v0.3.2"

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}
[ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] && usage

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：curl -fsSL ${RAW_BASE}/deploy.sh | sudo bash" >&2
  exit 1
fi

# 最新 Release 版本号（GitHub API 失败则回退到固定版本）
detect_latest() {
  curl -fsSL --max-time 15 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
    | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/' | head -1
}

# 优先级：位置参数 > 环境变量 > 自动检测/回退（管道模式下只用位置参数和环境变量，不读 stdin）
VERSION="${1:-${VERSION:-$(detect_latest)}}"
VERSION="${VERSION:-$FALLBACK_VERSION}"
DOMAIN="${2:-${DOMAIN:-}}"

echo "GEODesk 一键部署（合成演示模式）"
echo "部署版本：${VERSION}"
if [ -n "$DOMAIN" ]; then
  echo "绑定域名：${DOMAIN}"
else
  echo "绑定域名：无（使用公网 IP 访问）"
fi
echo

echo "=== [1/8] 安装基础软件 ==="
if [ "${SKIP_APT:-0}" = "1" ]; then
  echo "SKIP_APT=1，跳过（请确认 curl / git / nginx 已安装）"
  PKG_MGR=apt
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl git nginx
  PKG_MGR=apt
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q curl git nginx
  PKG_MGR=dnf
elif command -v yum >/dev/null 2>&1; then
  yum install -y -q curl git nginx
  PKG_MGR=yum
else
  echo "不支持的系统：找不到 apt/dnf/yum" >&2
  exit 1
fi

echo "=== [2/8] 安装 Node.js ${NODE_VERSION} ==="
if [ ! -x /opt/node/bin/node ]; then
  curl -fsSL "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    -o /tmp/node.tar.xz
  tar -xf /tmp/node.tar.xz -C /opt
  ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node
  rm -f /tmp/node.tar.xz
fi
export PATH="/opt/node/bin:$PATH"
node --version
npm config set registry "$NPM_MIRROR"

echo "=== [3/8] 拉取代码 ${VERSION} ==="
id -u geodesk >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin geodesk
mkdir -p "$INSTALL_DIR"
chown geodesk:geodesk "$INSTALL_DIR"
# 修复 1：仓库操作统一用 geodesk 身份，避免二次运行时 git 报 dubious ownership
if [ -d "${INSTALL_DIR}/.git" ]; then
  chown -R geodesk:geodesk "$INSTALL_DIR"
  sudo -u geodesk env HOME="/opt/geodesk" git -C "$INSTALL_DIR" fetch --depth 1 origin tag "$VERSION"
  sudo -u geodesk env HOME="/opt/geodesk" git -C "$INSTALL_DIR" checkout -q "$VERSION"
else
  # 非 git 目录（如之前中断的残留）则清空重拉
  if [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    rm -rf "${INSTALL_DIR:?}/"
    mkdir -p "$INSTALL_DIR"
    chown geodesk:geodesk "$INSTALL_DIR"
  fi
  sudo -u geodesk env HOME="/opt/geodesk" git clone --depth 1 --branch "$VERSION" \
    "https://github.com/${REPO}.git" "$INSTALL_DIR"
fi

echo "=== [4/8] 安装依赖并构建演示前端 ==="
cd "$INSTALL_DIR"
sudo -u geodesk env PATH="/opt/node/bin:$PATH" HOME="/opt/geodesk" npm ci --no-audit --no-fund
sudo -u geodesk env PATH="/opt/node/bin:$PATH" HOME="/opt/geodesk" npx tsc -b
sudo -u geodesk env PATH="/opt/node/bin:$PATH" HOME="/opt/geodesk" npx vite build --config vite.demo.config.ts
[ -f "$INSTALL_DIR/dist/index.html" ] || { echo "构建失败：dist/index.html 不存在" >&2; exit 1; }
# 修复 2：nginx worker（www-data）需要能读取静态文件；不依赖执行时的 umask
chmod 755 "$INSTALL_DIR"
chmod -R a+rX "$INSTALL_DIR/dist"

echo "=== [5/8] 注册 systemd 服务 ==="
cat > /etc/systemd/system/geodesk-demo-api.service <<'EOF'
[Unit]
Description=GEODesk demo API (synthetic data, no DB)
After=network.target

[Service]
Type=simple
User=geodesk
WorkingDirectory=/opt/geodesk
ExecStart=/opt/geodesk/node_modules/.bin/tsx scripts/demo-server.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now geodesk-demo-api
sleep 3
curl -fsS http://127.0.0.1:8788/api/demo/status >/dev/null \
  && echo "demo API 就绪" \
  || { echo "demo API 启动失败，查看：journalctl -u geodesk-demo-api" >&2; exit 1; }

echo "=== [6/8] 配置 nginx ==="
SERVER_NAME="${DOMAIN:-_}"
cat > /etc/nginx/conf.d/geodesk.conf <<EOF
server {
    listen 80;
    server_name ${SERVER_NAME};

    root ${INSTALL_DIR}/dist;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "=== [7/8] 配置 HTTPS ==="
if [ -z "$DOMAIN" ]; then
  echo "未指定域名，跳过 HTTPS（IP 访问使用 HTTP）"
elif [ "${SKIP_CERTBOT:-0}" = "1" ]; then
  echo "SKIP_CERTBOT=1，跳过 HTTPS 配置"
else
  if [ "$PKG_MGR" = "apt" ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx || true
  else
    $PKG_MGR install -y -q certbot python3-certbot-nginx || true
  fi
  if command -v certbot >/dev/null 2>&1; then
    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect; then
      echo "HTTPS 已启用"
    else
      echo "certbot 未成功（多为 DNS 未生效或 80 端口不可达），稍后手动执行："
      echo "  certbot --nginx -d $DOMAIN"
    fi
  else
    echo "未装上 certbot，稍后手动执行："
    echo "  certbot --nginx -d $DOMAIN"
  fi
fi

echo
echo "=== [8/8] 完成 ==="
if [ -n "$DOMAIN" ]; then
  echo "访问地址：http://$DOMAIN"
else
  PUBLIC_IP="$(curl -fsSL --max-time 10 https://api.ipify.org 2>/dev/null || echo '<本机公网IP>')"
  echo "访问地址：http://${PUBLIC_IP}"
fi
echo "这是合成演示站：内置假数据，无需登录，开箱即用；数据重启后重置。"
echo
echo "常用操作："
echo "  查看服务状态：systemctl status geodesk-demo-api"
echo "  查看服务日志：journalctl -u geodesk-demo-api -f"
echo "  更新到新版本：curl -fsSL ${RAW_BASE}/deploy.sh | sudo bash -s <新版本号>"
echo "  卸载：systemctl disable --now geodesk-demo-api nginx; rm -rf /opt/geodesk /etc/nginx/conf.d/geodesk.conf"
