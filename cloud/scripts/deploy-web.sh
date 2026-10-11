#!/usr/bin/env bash
# Codex Harness Cloud · 把 Web 客户端资源发布到云端（这就是"更新免重装"的全部动作）
#
#   bash scripts/deploy-web.sh            # 上传资源并验证
#   bash scripts/deploy-web.sh --dry-run  # 只看会传什么
#
# 目标：ch-release:/var/www/codex-harness-cloud/  ← Caddy 的 /cloud/* 路径指向这里
# 效果：用户浏览器刷新即拿到新界面，**本机那份伴生服务不用动、不用重装**。
#
# ⛔ 为什么单独一个远端目录、不塞进 release-site 的 public/：
#   release-site 的部署脚本用的是 `rsync --delete`，两边共用一个目录时，
#   那边一发版就会把这边整个删掉（"界面突然变回旧版/白屏"的来源之一）。
#   独立目录 + 独立 Caddy 路径 ⇒ 两条发布链互不干扰。
#
# ⛔ Caddy 侧需要两件事（见 README 里的片段）：
#   ① handle_path /cloud/* → file_server 指向本目录；
#   ② **必须回 `Access-Control-Allow-Origin`** —— 浏览器把 ES module 一律按 CORS 模式
#      抓取，跨源加载 app.js 缺这个头就会被拦（实测报 "blocked by CORS policy"）。
#      缺了也不是白屏：外壳探测 version.json 失败 ⇒ 自动回落本地副本。
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-ch-release}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/codex-harness-cloud}"
PUBLIC_BASE="${PUBLIC_BASE:-https://ppz123.asia/cloud}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)/web"
DRY_RUN=""
[ "${1:-}" = "--dry-run" ] && DRY_RUN="--dry-run"

echo "[deploy] 本地: $LOCAL_DIR"
echo "[deploy] 远端: ${REMOTE_HOST}:${REMOTE_DIR}"
echo "[deploy] 对外: ${PUBLIC_BASE}/"

if [ ! -f "$LOCAL_DIR/version.json" ]; then
  echo "[deploy] 缺 web/version.json —— 外壳靠它判断云端资产在不在，先补上再发" >&2
  exit 1
fi

ssh "$REMOTE_HOST" "sudo mkdir -p $REMOTE_DIR && sudo chown -R \$USER:\$USER $REMOTE_DIR"

# --delete：让"远端 == 本地 web/"，删掉上一版残留的文件（否则旧 chunk 会一直挂在 CDN 路径下）
# ⛔ 必须排除 app/：真界面资产（deploy-app.sh 发布链）也住在同一远端目录下，
#   不排除的话这边一发版就把整个 /cloud/app/ 删光（桌面助手全部回落本地副本）。
rsync -avz --delete $DRY_RUN \
  --exclude '.DS_Store' \
  --exclude 'app/' \
  "$LOCAL_DIR/" "${REMOTE_HOST}:${REMOTE_DIR}/"

echo "[deploy] 验证（公网，走 Cloudflare/Caddy 的真实路径）"
for path in version.json styles.css app.js index.html; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "${PUBLIC_BASE}/${path}")
  acao=$(curl -sSI "${PUBLIC_BASE}/${path}" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}')
  printf '  %-14s HTTP=%s  CORS=%s\n' "$path" "$code" "${acao:-(缺)}"
done

echo
echo "[deploy] 完成。本机用户刷新浏览器即可看到新界面；伴生服务无需更新。"
