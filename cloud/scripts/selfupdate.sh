#!/usr/bin/env bash
# ── 自助更新（git 协议取文件，不依赖本机是 git 仓库）────────────────────────────
# 用途：非 git 部署的站点（server.js 摊平、web 在另一个目录）也能从面板/命令一键更新。
#
#   sudo bash selfupdate.sh              # 下载 → 备份 → 覆盖 → 语法闸 → 重启
#   sudo bash selfupdate.sh --no-restart # 只覆盖，不重启（服务端自己 exit 交给 systemd）
#   sudo bash selfupdate.sh --dry-run    # 只下载到临时目录，不覆盖
#
# ⛔⛔ 为什么不用镜像 raw 下载：镜像有 CDN 缓存，会**静默返旧版**，
#     结果"更新"把生产覆盖成旧代码（2026-10-18 实测踩到，面板显示的仍是上一版文案）。
#     ⇒ 改用 `git clone --depth=1 --sparse`：git 协议没有 raw 的缓存问题，
#        并且能精确拿到当前 HEAD 的内容。
#
# 默认路径（可用环境变量覆盖）：
#   SERVER_JS=/home/ubuntu/chc-account/server.js
#   WEB_DIR=/var/www/codex-harness-cloud
#   SVC=chc-account
#
# ⛔ 安全：① 全部取到才动文件；② 逐个备份 *.bak-<时间戳>；③ 覆盖后 node --check，不过就不重启。
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
    --no-restart) NO_RESTART=1 ;;
  esac
done

say() { printf '\033[36m[update]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[update] %s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "需要 git（apt-get install -y git）"
command -v node >/dev/null 2>&1 || die "需要 node（用于覆盖后的语法检查）"

SOURCES=(
  "cloud/VERSION"
  "cloud/server-account/server.js"
  "cloud/web/account.html"
  "cloud/web/index.html"
  "cloud/web/app.js"
  "cloud/web/styles.css"
  "cloud/web/admin.html"
  "cloud/web/fnos-guide.html"
)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

say "① 用 git 取最新代码（${REPO}@${BRANCH}）"
git clone --quiet --depth=1 --branch "$BRANCH" --filter=blob:none --sparse "https://github.com/${REPO}.git" "$STAGE/repo" \
  || die "git clone 失败 —— 检查这台机器能否访问 github.com（git 协议 443）"
git -C "$STAGE/repo" sparse-checkout set cloud/server-account cloud/web >/dev/null 2>&1 \
  || die "sparse-checkout 失败"
HEAD_SHA="$(git -C "$STAGE/repo" rev-parse --short HEAD)"
say "   HEAD = ${HEAD_SHA}"

say "② 收集文件"
ok=1
for rel in "${SOURCES[@]}"; do
  src="$STAGE/repo/$rel"
  if [ -s "$src" ]; then
    cp "$src" "$STAGE/$(basename "$rel")"
    printf '  ✓ %s\n' "$rel"
  else
    printf '  ✗ %s（仓库里没有这个文件）\n' "$rel" >&2
    ok=0
  fi
done
[ "$ok" = "1" ] || die "文件不全 —— 已中止，**本机文件一个都没动**"

if [ -n "$DRY_RUN" ]; then
  say "③ --dry-run：停在临时目录，不覆盖"
  trap - EXIT
  exit 0
fi

say "③ 备份并覆盖"
STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$STAGE/server.js" "${SERVER_JS}.new"
[ -f "$SERVER_JS" ] && cp "$SERVER_JS" "${SERVER_JS}.bak-${STAMP}"
mv "${SERVER_JS}.new" "$SERVER_JS"
say "   server.js → $SERVER_JS（备份 ${SERVER_JS}.bak-${STAMP}）"

# 版本号：⛔ 必须一起更新 —— 否则服务重启后版本仍是旧的，面板会一直提示"有新版本"（用户实测）
if [ -f "$STAGE/VERSION" ]; then
  cp "$STAGE/VERSION" "$(dirname "$SERVER_JS")/VERSION"
  say "   VERSION → $(dirname "$SERVER_JS")/VERSION（$(cat "$STAGE/VERSION")）"
fi

for f in account.html index.html app.js styles.css admin.html fnos-guide.html; do
  [ -f "$STAGE/$f" ] || continue
  [ -d "$WEB_DIR" ] || { say "   ⚠ 跳过 $f：$WEB_DIR 不存在"; continue; }
  [ -f "$WEB_DIR/$f" ] && cp "$WEB_DIR/$f" "${WEB_DIR}/$f.bak-${STAMP}"
  cp "$STAGE/$f" "$WEB_DIR/$f"
done
say "   web 资源 → $WEB_DIR（旧文件备份为 *.bak-${STAMP}）"

say "④ 语法检查"
node --check "$SERVER_JS" || die "新 server.js 语法不通过！用 $SERVER_JS.bak-${STAMP} 回滚，别重启"

if [ -n "$NO_RESTART" ]; then
  say "⑤ 跳过重启（--no-restart：由调用方自己重启）"
else
  say "⑤ 重启服务（$SVC）"
  if systemctl list-unit-files 2>/dev/null | grep -q "^${SVC}.service"; then
    systemctl restart "$SVC"
    sleep 2
    systemctl is-active --quiet "$SVC" && say "   ✓ 已重启并运行中" || say "   ⚠ 未起来：journalctl -u $SVC -n 50 --no-pager"
  else
    say "   ⚠ 没找到 $SVC.service —— 请手动重启"
  fi
fi

say "完成（HEAD ${HEAD_SHA}）。回滚：把 *.bak-${STAMP} 覆盖回去再重启"
# 只保留最近 5 份备份，避免目录被 .bak 撑满
ls -1t "${SERVER_JS}".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
for f in "$WEB_DIR"/*.bak-*; do
  [ -e "$f" ] || continue
  d="$(dirname "$f")"; b="$(basename "$f")"; key="${b%%.bak-*}"
  ls -1t "$d/$key".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
done 2>/dev/null || true
