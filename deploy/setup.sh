#!/usr/bin/env bash
# 首程助手 一键部署脚本（Ubuntu 22.04 / 24.04 / 26.04）
#
# 用法（在代码目录里，以 root 运行）：
#   sudo bash deploy/setup.sh                         # 只用 http://公网IP 访问（备案前测试用）
#   sudo bash deploy/setup.sh example.com             # 绑定域名并自动申请 HTTPS 证书
#   sudo bash deploy/setup.sh example.com me@mail.com # 同上，证书到期提醒发到该邮箱
#
# 重复运行是安全的：用于更新代码，不会覆盖已有的 .env。
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR=/opt/shoucheng
APP_USER=shoucheng
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/setup.sh $*"
[[ -f "$SRC_DIR/server.js" ]] || die "找不到 server.js，请在项目目录里运行本脚本"

export DEBIAN_FRONTEND=noninteractive

# ---------- 1. 内存不足 4G 时加 1G swap，防止 npm 安装时内存不够 ----------
if ! swapon --show | grep -q .; then
  log "创建 1G swap"
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------- 2. 系统软件 ----------
log "安装 nginx、certbot、rsync"
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx rsync curl ca-certificates

# ---------- 3. Node.js（需要 >= 20） ----------
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if (( $(node_major) < 20 )); then
  log "安装 Node.js"
  apt-get install -y nodejs npm || true
  if (( $(node_major) < 20 )); then
    log "系统自带 Node.js 版本过低，改用 NodeSource 安装 Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
fi
(( $(node_major) >= 20 )) || die "Node.js 安装失败，需要 20 或更高版本"
command -v npm >/dev/null || apt-get install -y npm
log "Node.js $(node -v)"

# ---------- 4. 应用用户与代码 ----------
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

log "复制代码到 $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude .env --exclude .git \
  "$SRC_DIR"/ "$APP_DIR"/

if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  FIRST_INSTALL=1
fi

log "安装依赖"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY"

chown -R root:"$APP_USER" "$APP_DIR"
chmod -R u=rwX,g=rX,o= "$APP_DIR"
chmod 640 "$APP_DIR/.env"

# ---------- 5. systemd ----------
log "配置 systemd 服务"
install -m 644 "$APP_DIR/deploy/shoucheng.service" /etc/systemd/system/shoucheng.service
systemctl daemon-reload
systemctl enable shoucheng >/dev/null
systemctl restart shoucheng

# ---------- 6. Nginx ----------
log "配置 Nginx"
SERVER_NAME="${DOMAIN:-_}"
sed "s/__SERVER_NAME__/${SERVER_NAME}/" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/shoucheng
ln -sf /etc/nginx/sites-available/shoucheng /etc/nginx/sites-enabled/shoucheng
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx || systemctl restart nginx

# ---------- 7. HTTPS ----------
if [[ -n "$DOMAIN" ]]; then
  if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
    log "证书已存在，重新应用到 Nginx"
    certbot install --nginx -d "$DOMAIN" --cert-name "$DOMAIN" --redirect --non-interactive || true
  else
    log "申请 HTTPS 证书（Let's Encrypt）"
    if [[ -n "$EMAIL" ]]; then
      CERT_MAIL=(-m "$EMAIL")
    else
      CERT_MAIL=(--register-unsafely-without-email)
    fi
    certbot --nginx -d "$DOMAIN" --agree-tos --redirect --non-interactive "${CERT_MAIL[@]}" \
      || echo "⚠️  证书申请失败：请确认域名已解析到本机、安全组已开放 80/443、域名已完成 ICP 备案。之后可重新运行本脚本。"
  fi
fi

# ---------- 8. 检查 ----------
sleep 1
if curl -fsS http://127.0.0.1:3000/api/health >/dev/null; then
  log "服务运行正常"
else
  echo "⚠️  服务未正常启动，查看日志：journalctl -u shoucheng -n 50"
fi

IP=$(curl -fsS --max-time 3 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null \
  || curl -fsS --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null \
  || echo '服务器公网IP')

echo
echo "================ 部署完成 ================"
if [[ -n "$DOMAIN" ]]; then
  echo "访问地址：https://$DOMAIN"
else
  echo "访问地址：http://$IP"
fi
if [[ "${FIRST_INSTALL:-0}" == 1 ]] || ! grep -q '^DASHSCOPE_API_KEY=.\+' "$APP_DIR/.env"; then
  echo
  echo "下一步：填写通义千问 API Key"
  echo "  sudo nano $APP_DIR/.env        # 填写 DASHSCOPE_API_KEY=sk-xxxx"
  echo "  sudo systemctl restart shoucheng"
  echo "（未填写 Key 前，页面显示\"演示模式\"，输出的是固定示例文字）"
fi
echo "=========================================="
