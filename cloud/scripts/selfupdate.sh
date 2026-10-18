#!/usr/bin/env bash
# ── 自助更新（不依赖 git）────────────────────────────────────────────────────
# 用途：面板「立即更新并重启」在**非 git 部署**上会拒绝（它无权覆盖生产文件）。
#       这个脚本把"下载 → 备份 → 覆盖 → 重启"合成一条命令，你自己在服务器上跑。
#
#   sudo bash selfupdate.sh              # 按默认路径更新
#   sudo bash selfupdate.sh --dry-run    # 只下载到临时目录，不覆盖
#
# 默认路径（按需用环境变量覆盖）：
#   SERVER_JS=/home/ubuntu/chc-account/server.js
#   WEB_DIR=/var/www/codex-harness-cloud
#   SVC=chc-account
#
# ⛔ 安全设计：
#   ① **先把所有文件下到临时目录**，任何一个失败就整体中止 —— 绝不出现"覆盖了一半"。
#   ② 覆盖前把每个文件备份成 `<文件>.bak-<时间戳>`，出问题可原样回滚。
#   ③ 只覆盖代码文件（server.js + web 静态资源），**不碰** data.json / config.env。
set -euo pipefail

REPO="${SRC_REPO:-PMZPZM0/codex-harness-cloud-src}"
BRANCH="${SRC_BRANCH:-main}"
SERVER_JS="${SERVER_JS:-/home/ubuntu/chc-account/server.js}"
WEB_DIR="${WEB_DIR:-/var/www/codex-harness-cloud}"
SVC="${SVC:-chc-account}"
DRY_RUN=""
NO_RESTART=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --no-restart) NO_RESTART=1 ;;   # 由调用方（服务端）自己 exit 交给 systemd 拉起
  esac
done

say() { printf '\033[36m[update]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[update] %s\033[0m\n' "$*" >&2; exit 1; }

# 国内镜像优先，直连兜底（与面板 /api/updates 同一套顺序）
MIRRORS=("https://gh-proxy.com/" "https://ghproxy.net/" "https://ghfast.top/" "https://hub.gitmirror.com/" "")

RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

# 清单：源路径（仓内）→ 目标路径（本机）
SOURCES=(
  "cloud/server-account/server.js"
  "cloud/web/account.html"
  "cloud/web/index.html"
  "cloud/web/app.js"
  "cloud/web/styles.css"
  "cloud/web/admin.html"
  "cloud/web/fnos-guide.html"
)

fetch_one() {
  local rel="$1" out="$2" m
  for m in "${MIRRORS[@]}"; do
    if curl -fsSL --max-time 20 -o "$out" "${m}${RAW}/${rel}"; then
      [ -s "$out" ] || continue
      printf '  ✓ %s ← %s\n' "$rel" "${m:-直连}"
      return 0
    fi
  done
  printf '  ✗ %s（所有源都失败）\n' "$rel" >&2
  return 1
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

say "① 下载到临时目录（${REPO}@${BRANCH}）"
ok=1
for rel in "${SOURCES[@]}"; do
  fetch_one "$rel" "$STAGE/$(basename "$rel")" || ok=0
done
[ "$ok" = "1" ] || die "有文件没下全 —— 已中止，**本机文件一个都没动**"

if [ -n "$DRY_RUN" ]; then
  say "② --dry-run：停在临时目录（$STAGE），不覆盖"
  trap - EXIT
  exit 0
fi

say "② 备份并覆盖"
STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$STAGE/server.js" "${SERVER_JS}.new"
cp "${SERVER_JS}" "${SERVER_JS}.bak-${STAMP}" 2>/dev/null || true
mv "${SERVER_JS}.new" "$SERVER_JS"
say "   server.js → $SERVER_JS（备份 ${SERVER_JS}.bak-${STAMP}）"

for f in account.html index.html app.js styles.css admin.html fnos-guide.html; do
  [ -f "$STAGE/$f" ] || continue
  [ -d "$WEB_DIR" ] || { say "   ⚠ 跳过 $f：$WEB_DIR 不存在"; continue; }
  cp "$WEB_DIR/$f" "${WEB_DIR}/$f.bak-${STAMP}" 2>/dev/null || true
  cp "$STAGE/$f" "$WEB_DIR/$f"
done
say "   web 资源 → $WEB_DIR（旧文件已备份为 *.bak-${STAMP}）"

say "③ 语法检查"
if command -v node >/dev/null 2>&1; then
  node --check "$SERVER_JS" || die "新 server.js 语法不通过！用 $SERVER_JS.bak-${STAMP} 回滚，别重启"
else
  say "   ⚠ 没有 node，跳过语法检查"
fi

if [ -n "$NO_RESTART" ]; then
  say "④ 跳过重启（--no-restart：由调用方自己重启）"
else
  say "④ 重启服务（$SVC）"
  if systemctl list-unit-files 2>/dev/null | grep -q "^${SVC}.service"; then
    systemctl restart "$SVC"
    sleep 2
    systemctl is-active --quiet "$SVC" && say "   ✓ 已重启并运行中" || say "   ⚠ 未起来：journalctl -u $SVC -n 50 --no-pager"
  else
    say "   ⚠ 没找到 $SVC.service —— 请手动重启你的服务"
  fi
fi

say "完成。回滚方法：把 *.bak-${STAMP} 覆盖回去再重启"
