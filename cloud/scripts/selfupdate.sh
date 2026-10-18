#!/usr/bin/env bash
# ── 自助更新（**清单驱动 + sha256 校验**）──────────────────────────────────────
# 发版只需：跑 `node cloud/scripts/gen-manifest.mjs --version x.y.z` 再提交。
#
#   sudo bash selfupdate.sh              # 下载 → 校验 → 备份 → 覆盖 → 语法闸 → 重启
#   sudo bash selfupdate.sh --no-restart # 只覆盖（服务端自己 exit 交给 systemd）
#   sudo bash selfupdate.sh --dry-run    # 只下载校验，不覆盖
#
# ⛔⛔ 两条硬约束（都是踩出来的）：
#   ① **不用 git clone**：这台机器对 github 的 git 协议经常被 reset（实测三源全失败），
#      而 raw 的 HTTPS 是通的 ⇒ 走镜像 raw。
#   ② **必须校验 sha256**：镜像 CDN 会缓存旧版并静默返回，
#      不校验就会"更新"成旧代码（实测踩过）⇒ 不匹配就换下一个镜像，全不匹配才中止。
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

command -v node >/dev/null 2>&1 || die "需要 node（解析清单 + 语法检查）"
command -v sha256sum >/dev/null 2>&1 || die "需要 sha256sum（coreutils）"

# 国内镜像优先，直连兜底
MIRRORS=("https://gh-proxy.com/" "https://ghproxy.net/" "https://ghfast.top/" "https://hub.gitmirror.com/" "")
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

jget() {  # jget <file> <dotted-path>  —— 极简取值，避免依赖 jq
  node -e '
    const fs=require("fs");
    try{
      const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const v=String(process.argv[2]).split(".").reduce((o,k)=>o==null?o:o[k],j);
      process.stdout.write(v==null?"":String(v));
    }catch(e){process.stdout.write("")}
  ' "$1" "$2"
}

say "① 取发版清单（多镜像，缓存旧版会被 sha256 拒绝）"
mf_ok=0
for m in "${MIRRORS[@]}"; do
  if curl -fsSL --max-time 15 -o "$STAGE/mf.json" "${m}${RAW}/${MANIFEST_REL}" 2>/dev/null; then
    v="$(jget "$STAGE/mf.json" version)"
    if [ -n "$v" ]; then
      MF_VERSION="$v"; mf_ok=1
      say "   ✓ ${m:-直连}：version=$v"
      break
    fi
    say "   ⚠ ${m:-直连} 的清单解析不出 version，换源"
  fi
done
[ "$mf_ok" = "1" ] || die "所有镜像都拿不到 $MANIFEST_REL —— 网络或仓里缺清单"

CUR_VERSION="$(cat "$(dirname "$SERVER_JS")/VERSION" 2>/dev/null || echo '?')"
say "   当前 $CUR_VERSION → 目标 $MF_VERSION"

# 解析清单成 TSV：src \t kind \t as \t sha256
ROWS="$(node -e '
  const fs=require("fs");
  const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  for (const f of (m.files||[])) {
    if (!f || !f.src) continue;
    process.stdout.write([f.src, String(f.kind||"server"), String(f.as||""), String(f.sha256||"")].join("\t")+"\n");
  }
' "$STAGE/mf.json")" || die "清单解析失败"

say "② 逐文件下载并校验 sha256"
allok=1
while IFS=$'\t' read -r src kind as want; do
  [ -n "$src" ] || continue
  [ -n "$want" ] || { printf '  ✗ %-40s 清单里没有 sha256（先跑 gen-manifest.mjs）\n' "$src" >&2; allok=0; continue; }
  hit=0
  for m in "${MIRRORS[@]}"; do
    if curl -fsSL --max-time 25 -o "$STAGE/out_$as" "${m}${RAW}/$src" 2>/dev/null; then
      got="$(sha256sum "$STAGE/out_$as" | cut -d' ' -f1)"
      if [ "$got" = "$want" ]; then
        printf '  ✓ %-40s ← %s（sha256 校验通过）\n' "$src" "${m:-直连}"
        hit=1; break
      fi
      printf '  ⚠ %s：%s 返回的可能是缓存旧版（hash 不符），换源\n' "$src" "${m:-直连}"
    fi
  done
  [ "$hit" = "1" ] || { printf '  ✗ %-40s 所有源都拿不到匹配内容\n' "$src" >&2; allok=0; }
done <<< "$ROWS"
[ "$allok" = "1" ] || die "有文件下载/校验失败 —— 已中止，**本机文件一个都没动**"

if [ -n "$DRY_RUN" ]; then
  say "③ --dry-run：全部通过校验，未覆盖任何文件（目标 $MF_VERSION）"
  trap - EXIT
  exit 0
fi

say "③ 备份并覆盖"
STAMP="$(date +%Y%m%d-%H%M%S)"
while IFS=$'\t' read -r src kind as want; do
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

# ⛔ 版本号以**清单为准**再写一次（清单是发布的唯一真相源）
printf '%s\n' "$MF_VERSION" > "$(dirname "$SERVER_JS")/VERSION"
say "   VERSION → $(dirname "$SERVER_JS")/VERSION（$MF_VERSION）"

say "④ 语法检查"
node --check "$SERVER_JS" || die "新 server.js 语法不通过！用 *.bak-${STAMP} 回滚，别重启"

if [ -n "$NO_RESTART" ]; then
  say "⑤ 跳过重启（--no-restart：由调用方自己重启）"
else
  say "⑤ 重启服务（$SVC）"
  if systemctl list-unit-files 2>/dev/null | grep -q "^${SVC}.service"; then
    systemctl restart "$SVC"; sleep 2
    systemctl is-active --quiet "$SVC" && say "   ✓ 已重启并运行中" || say "   ⚠ 未起来：journalctl -u $SVC -n 50 --no-pager"
  else
    say "   ⚠ 没找到 $SVC.service —— 请手动重启"
  fi
fi

say "完成：${CUR_VERSION} → ${MF_VERSION}。回滚：把 *.bak-${STAMP} 覆盖回去再重启"

# 备份只留最近 5 份/文件
ls -1t "$(dirname "$SERVER_JS")"/*.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
for f in "$WEB_DIR"/*.bak-*; do
  [ -e "$f" ] || continue
  key="${f%%.bak-*}"; ls -1t "${key}".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f
done 2>/dev/null || true
