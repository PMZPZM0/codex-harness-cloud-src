#!/usr/bin/env bash
# Codex Harness Cloud · 把「真界面资产」（桌面版 dist 构建）发布到云端 /cloud/app/
#
#   bash scripts/deploy-app.sh             # 上传并验证
#   bash scripts/deploy-app.sh --dry-run   # 只构建暂存区，不上传
#
# 这就是"跟随服务器更新"机制的本体：本地桌面助手每 60s 探测 /cloud/app/version.json，
# manifestSha256 与本机一致 ⇒ 用户刷新即从云端加载新界面；不一致/不可达 ⇒ 本地 dist 兜底。
#
# ⛔ 与 deploy-web.sh（登录门外壳）是两条独立发布链，目录互不重叠：
#   /var/www/codex-harness-cloud/       ← deploy-web.sh（登录门，index.html 同名但不同物）
#   /var/www/codex-harness-cloud/app/   ← 本脚本（真界面资产 dist）
#
# 注入「迷路守卫」：/cloud/app/index.html 被**裸开**（没经桌面助手桥）时 window.codex
# 不存在，真界面在 voiceSettings.get 崩错误遮罩（用户看不懂）。守卫在 DOMContentLoaded
# 检测 __chcReady/codex，缺失就整页换成"请从首页进入"。CSP 自带 'unsafe-inline'，能跑。
# ⛔ 守卫只影响裸开者：桥（headless.ts）served 的外壳是本地 shellHtml 注入版，不读这个文件。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CLOUD_DIR="$(cd "$HERE/.." && pwd)"
REPO_DIR="$(cd "$CLOUD_DIR/.." && pwd)"
DIST_DIR="$REPO_DIR/dist"
MANIFEST="$REPO_DIR/electron/ipc-channels.manifest.json"
REMOTE_HOST="${REMOTE_HOST:-tx}"                                # ~/.ssh/config 里的别名
REMOTE_DIR="${REMOTE_DIR:-/var/www/codex-harness-cloud/app}"
PUBLIC_BASE="${PUBLIC_BASE:-https://ppz123.asia/cloud/app}"
DRY_RUN=""
[ "${1:-}" = "--dry-run" ] && DRY_RUN="1"

[ -f "$DIST_DIR/index.html" ] || { echo "[deploy-app] 缺 $DIST_DIR/index.html，先 npm run build:vite" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "[deploy-app] 缺 $MANIFEST" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r "$DIST_DIR"/. "$STAGE/"

# version.json：protocolVersion 必须与 headless.ts 的探测值一致（当前 = 1）
MANIFEST_SHA="$(node -e "const c=require('node:crypto');console.log(c.createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex').slice(0,16))" "$MANIFEST")"
printf '{\n  "version": "1.0.0",\n  "protocolVersion": 1,\n  "manifestSha256": "%s",\n  "builtAt": "%s"\n}\n' \
  "$MANIFEST_SHA" "$(date +%F)" > "$STAGE/version.json"

node - "$STAGE/index.html" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
let html = fs.readFileSync(file, "utf8");
if (html.includes("__CHC_LOST_GUARD__")) { console.log("[deploy-app] 守卫已存在，跳过注入"); process.exit(0); }
const guard = `    <script>window.__CHC_LOST_GUARD__=1;(function(){"use strict";function lost(){if(window.__chcReady||window.codex)return;document.documentElement.innerHTML='<body style="margin:0;font-family:system-ui,sans-serif;background:#f6f6f4;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="max-width:440px;padding:32px;background:#fff;border:1px solid #e2e2de;border-radius:12px;text-align:center"><h2 style="margin:0 0 8px;font-size:16px;color:#2c2c2a">这个地址不能直接打开</h2><p style="margin:0 0 20px;font-size:13px;color:#666;line-height:1.7">这里是 Codex Harness 的界面资产仓库，需要由你电脑上的「桌面助手」加载，或从首页登录进入。</p><a href="/" style="display:inline-block;padding:8px 20px;background:#185fa5;color:#fff;border-radius:8px;text-decoration:none;font-size:13px">返回首页登录</a></div></body>';document.title="请从首页进入"}window.addEventListener("DOMContentLoaded",function(){setTimeout(lost,0)})})();</script>\n`;
if (!/<head[^>]*>/.test(html)) { console.error("[deploy-app] index.html 里找不到 <head>"); process.exit(1); }
html = html.replace(/<head[^>]*>/, (m) => `${m}\n${guard}`);
fs.writeFileSync(file, html);
console.log("[deploy-app] 迷路守卫已注入 index.html");
NODE

echo "[deploy-app] 本地 dist:  $DIST_DIR"
echo "[deploy-app] 暂存区:    $STAGE（manifestSha256=$MANIFEST_SHA）"
echo "[deploy-app] 远端:      ${REMOTE_HOST}:${REMOTE_DIR}"

if [ -n "$DRY_RUN" ]; then
  echo "[deploy-app] --dry-run：到此为止，不上传。暂存区保留检查：$STAGE"
  trap - EXIT
  exit 0
fi

ssh "$REMOTE_HOST" "sudo rm -rf $REMOTE_DIR && sudo mkdir -p $REMOTE_DIR && sudo chown -R \$USER:\$USER $REMOTE_DIR"
# ⛔ Git Bash(Windows) 没有 rsync：tar 管道传输，"清空重建"等效 rsync --delete
tar -C "$STAGE" -cf - . | ssh "$REMOTE_HOST" "tar -xf - -C $REMOTE_DIR"

echo "[deploy-app] 验证（公网真实路径）"
for path in version.json index.html; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "${PUBLIC_BASE}/${path}")
  printf '  %-12s HTTP=%s\n' "$path" "$code"
done
guard_hit=$(curl -sS "${PUBLIC_BASE}/index.html" | grep -c '__CHC_LOST_GUARD__' || true)
echo "  守卫注入:    ${guard_hit:-0} 处（应为 1）"
sha_hit=$(curl -sS "${PUBLIC_BASE}/version.json" | grep -c "$MANIFEST_SHA" || true)
echo "  指纹一致:    ${sha_hit:-0} 处（应为 1，与本机 electron/ipc-channels.manifest.json 同源）"
echo "[deploy-app] 完成。桌面助手 60s 内探到新指纹，用户刷新即新界面。"
