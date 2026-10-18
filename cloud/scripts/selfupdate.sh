#!/usr/bin/env bash
# ── 自助更新（**清单驱动**，manifest.json 说了算）──────────────────────────────
# 发版只需改 `cloud/manifest.json`（版本号 + 文件列表），本脚本与服务端都读它 —— 不再硬编码文件名。
#
#   sudo bash selfupdate.sh              # 下载 → 备份 → 覆盖 → 语法闸 → 重启
#   sudo bash selfupdate.sh --no-restart # 只覆盖（服务端自己 exit 交给 systemd）
#   sudo bash selfupdate.sh --dry-run    # 只下载并列清单，不覆盖
#
# ⛔⛔ 为什么不用镜像 raw 下载：镜像 CDN 有缓存，会**静默返旧版**，
#     结果"更新"把生产覆盖成旧代码（2026-10-18 实测踩到）。⇒ 用 `git clone --depth=1 --sparse`。
#
# 默认路径（可用环境变量覆盖）：SERVER_JS / WEB_DIR / SVC
set -euo pipefail

REPO="${SRC_REPO:-PMZPZM0/codex-harness-cloud-src}"
BRANCH="${SRC_BRANCH:-main}"
SERVER_JS="${SERVER_JS:-/home/ubuntu/chc-account/server.js}"
WEB_DIR="${WEB_DIR:-/var/www/codex-harness-cloud}"
SVC="${SVC:-chc-account}"
MANIFEST_REL="${MANIFEST_REL:-cloud/manifest.json}"

DRY_RUN=""; NO_RESTART=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --no-restart) NO_RESTART=1 ;;
  esac
done

say() { printf '\033[36m[update]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[update] %s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "需要 git（apt-get install -y git）"
command -v node >/dev/null 2>&1 || die "需要 node（解析 manifest + 语法检查）"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

say "① 用 git 取最新代码（${REPO}@${BRANCH}）"
git clone --quiet --depth=1 --branch "$BRANCH" --filter=blob:none --sparse "https://github.com/${REPO}.git" "$STAGE/repo" \
  || die "git clone 失败 —— 检查这台机器能否访问 github.com（git 协议 443）"
git -C "$STAGE/repo" sparse-checkout set cloud >/dev/null 2>&1 || die "sparse-checkout 失败"
HEAD_SHA="$(git -C "$STAGE/repo" rev-parse --short HEAD)"
say "   HEAD = ${HEAD_SHA}"

MANIFEST="$STAGE/repo/$MANIFEST_REL"
[ -s "$MANIFEST" ] || die "仓里没有 $MANIFEST_REL（发版清单）—— 这是清单驱动的前提"

say "② 解析清单"
ROWS="$(node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const lines = ["__VER__\t\t" + String(m.version || "")];
  for (const f of (m.files || [])) {
    if (!f || !f.src) continue;
    lines.push([f.src, String(f.kind || "server"), String(f.as || "")].join("\t"));
  }
  process.stdout.write(lines.join("\n"));
' "$MANIFEST")" || die "manifest.json 解析失败（JSON 语法错？）"

MF_VERSION="$(printf '%s\n' "$ROWS" | head -1 | cut -f3)"
[ -n "$MF_VERSION" ] || die "清单里没有 version 字段"
say "   目标版本 = ${MF_VERSION}（当前 $(cat "$(dirname "$SERVER_JS")/VERSION" 2>/dev/null || echo '?')）"

say "③ 收集文件（清单里列出的全部）"
ok=1
while IFS=$'\t' read -r src kind as; do
  [ "$src" = "__VER__" ] && continue
  [ -n "$src" ] || continue
  if [ -s "$STAGE/repo/$src" ]; then
    cp "$STAGE/repo/$src" "$STAGE/out_$as"
    printf '  ✓ %-42s → %s\n' "$src" "$as"
  else
    printf '  ✗ %-42s 缺失\n' "$src" >&2
    ok=0
  fi
done <<< "$ROWS"
[ "$ok" = "1" ] || die "清单里有文件缺失 —— 已中止，**本机文件一个都没动**"

if [ -n "$DRY_RUN" ]; then
  say "④ --dry-run：清单与文件都齐全，未覆盖任何文件"
  trap - EXIT
  exit 0
fi

say "④ 备份并覆盖"
STAMP="$(date +%Y%m%d-%H%M%S)"
while IFS=$'\t' read -r src kind as; do
  [ "$src" = "__VER__" ] && continue
  [ -n "$as" ] || continue
  if [ "$kind" = "web" ]; then
    [ -d "$WEB_DIR" ] || { say "   ⚠ 跳过 $as：$WEB_DIR 不存在"; continue; }
    dst="$WEB_DIR/$as"
  else
    dst="$(dirname "$SERVER_JS")/$as"
  fi
  [ -f "$dst" ] && cp "$dst" "${dst}.bak-${STAMP}"
  cp "$STAGE/out_$as" "$dst"
  printf '   %-28s → %s\n' "$as" "$dst"
done <<< "$ROWS"

# ⛔ 版本号以**清单为准**再写一次：清单是发布的单一真相源
printf '%s\n' "$MF_VERSION" > "$(dirname "$SERVER_JS")/VERSION"
say "   VERSION → $(dirname "$SERVER_JS")/VERSION（${MF_VERSION}）"

say "⑤ 语法检查"
node --check "$SERVER_JS" || die "新 server.js 语法不通过！用 *.bak-${STAMP} 回滚，别重启"

if [ -n "$NO_RESTART" ]; then
  say "⑥ 跳过重启（--no-restart：由调用方自己重启）"
else
  say "⑥ 重启服务（$SVC）"
  if systemctl list-unit-files 2>/dev/null | grep -q "^${SVC}.service"; then
    systemctl restart "$SVC"; sleep 2
    systemctl is-active --quiet "$SVC" && say "   ✓ 已重启并运行中" || say "   ⚠ 未起来：journalctl -u $SVC -n 50 --no-pager"
  else
    say "   ⚠ 没找到 $SVC.service —— 请手动重启"
  fi
fi

say "完成：${MF_VERSION}（HEAD ${HEAD_SHA}）。回滚：把 *.bak-${STAMP} 覆盖回去再重启"

# 备份只留最近 5 份/文件
ls -1t "$(dirname "$SERVER_JS")"/*.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
for f in "$WEB_DIR"/*.bak-*; do
  [ -e "$f" ] || continue
  key="${f%%.bak-*}"; ls -1t "${key}".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
done 2>/dev/null || true
