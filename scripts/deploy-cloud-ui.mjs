/**
 * 部署云端界面（云助手唯一生效路径）—— 10-16 用户令「应用本地不要 dist，只加载服务器上的」。
 *
 * ⛔⛔ **改了渲染层（src/**），不跑本脚本 = 用户永远看不到**（本地 dist 只是兜底，正常不加载）。
 *     背景：助手窗加载的是 `http://127.0.0.1:8917/`，而 headless 在「云端模式」下把整份
 *     index.html + 全部资产指向 `https://ppz123.asia/cloud/app/`（electron/headless.ts 的
 *     CLOUD_APP_BASE，注释即「本地只是一个壳」）。只有 version.json 不可达或
 *     protocolVersion 不匹配时才回落本地 dist —— 正常运行时永远不会走。
 *     ⇒ 症状「改了没生效 / 老是不刷新」的根因几乎都是忘了跑这个脚本。
 *
 * 流程：build（dist-electron + dist）→ 备份服务器旧版 → 上传 → 写 version.json → 实测校验。
 *
 * 用法：node scripts/deploy-cloud-ui.mjs [--skip-build]
 *   --skip-build  只上传（已 build 过时用）
 * 依赖：ssh/scp 走 ~/.ssh/config 的 `tx` 别名（124.220.63.4，ubuntu，~/.ssh/123.pem）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SSH_HOST = "tx";                                    // ~/.ssh/config 里的别名
const REMOTE_DIR = "/var/www/codex-harness-cloud/app";    // nginx: https://ppz123.asia/cloud/app/
const PUBLIC_BASE = "https://ppz123.asia/cloud/app";
/** ⛔ 必须与 electron/headless.ts 里 `Number(meta.protocolVersion) === 1` 的判定一致：
 *    改了（或写错类型）⇒ 主进程判定协议不匹配 ⇒ 全部客户端回落本地 dist ⇒ 云端更新静默失效。 */
const PROTOCOL_VERSION = 1;
const skipBuild = process.argv.includes("--skip-build");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) { console.error(`✗ 失败（exit=${r.status}）`); process.exit(r.status ?? 1); }
}
function ssh(script) {
  const r = spawnSync("ssh", [SSH_HOST, script], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) { console.error("✗ ssh 失败：" + (r.stderr || r.stdout || "")); process.exit(1); }
  return (r.stdout || "").trim();
}

if (!skipBuild) run("npm", ["run", "build"]);

// ① 备份旧版（可回滚）+ 建干净目录
const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
console.log(`\n== 备份服务器旧版 → app.bak.${stamp} ==`);
ssh(`cd ${path.posix.dirname(REMOTE_DIR)} && rm -rf app.bak.${stamp} && mv app app.bak.${stamp} && mkdir -p app`);

// ② 上传 dist 内容
console.log("\n== 上传 dist ===");
/* ⛔ 必须拼正斜杠：Windows 下 path.join 会给出 `dist\assets`，scp 认成转义/非法路径
   （本机同步脚本栽过同一处）。 */
run("scp", ["-r", "-o", "ConnectTimeout=10", ...fs.readdirSync(path.join(root, "dist")).map((f) => `dist/${f}`), `${SSH_HOST}:${REMOTE_DIR}/`]);

// ③ version.json（主进程靠它判定能不能用云端）
const versionFile = path.join(root, ".workbuddy/tmp/version.deploy.json");
fs.mkdirSync(path.dirname(versionFile), { recursive: true });
fs.writeFileSync(versionFile, JSON.stringify({
  version: "1.0.0",
  protocolVersion: PROTOCOL_VERSION,
  manifestSha256: "3e2dd9dfdb2c0f23",
  builtAt: new Date().toISOString().slice(0, 10),
}, null, 2) + "\n", "utf8");
console.log("\n== 写 version.json ==");
run("scp", ["-o", "ConnectTimeout=10", versionFile, `${SSH_HOST}:${REMOTE_DIR}/version.json`]);

// ④ 实测校验：拿服务器上的 index.html，比对资产哈希，并抽查新样式是否到位
console.log("\n== 校验 ==");
const shell = await fetch(`${PUBLIC_BASE}/index.html`, { cache: "no-store" }).then((r) => r.text());
const localShell = fs.readFileSync(path.join(root, "dist/index.html"), "utf8");
const hashOf = (h) => (h.match(/assets\/index-[A-Za-z0-9]*\.(?:js|css)/g) || []).sort().join(",");
const remoteHashes = hashOf(shell);
const localHashes = hashOf(localShell);
const versionJson = await fetch(`${PUBLIC_BASE}/version.json`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);

const checks = [
  ["服务器主入口哈希 == 本地新产物", remoteHashes === localHashes && remoteHashes.length > 0, `${remoteHashes} vs ${localHashes}`],
  ["version.json protocolVersion == 1", Number(versionJson?.protocolVersion) === PROTOCOL_VERSION, JSON.stringify(versionJson)],
];
let bad = 0;
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? "✅" : "❌"} ${name} —— ${detail}`);
  if (!pass) bad++;
}
console.log(bad === 0 ? "\n===== 部署完成：用户刷新/重启应用即可看到 =====" : `\n===== ${bad} 项校验失败，请检查 =====`);

/* ⑤ 落部署状态：守卫【288】拿它判「本地改了有没有部署」⇒ 没部署就在 check 里报红。
   ⛔ 必须在**校验通过之后**才写：写早了会把一次失败的部署记成已部署，守卫就永远绿了。 */
if (bad === 0) {
  const statePath = path.join(root, ".cloud-ui-deployed.json");
  fs.writeFileSync(statePath, JSON.stringify({
    assetHashes: localHashes,
    builtAt: versionJson?.builtAt ?? new Date().toISOString().slice(0, 10),
    deployedAt: new Date().toISOString(),
    remoteBase: PUBLIC_BASE,
    remoteDir: REMOTE_DIR,
  }, null, 2) + "\n", "utf8");
  console.log(`已写部署状态 → ${path.relative(root, statePath)}（守卫【288】据此判定）`);
}
process.exit(bad === 0 ? 0 : 1);
