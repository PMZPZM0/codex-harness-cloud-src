/**
 * 主进程自动重载（10-16 用户令「每次都要老子刷新，要你干什么的」）。
 *
 * 背景：原 `dev` 脚本是 `npm run build:electron && concurrently -k "vite" "... electron ."` ——
 *   · tsc 只编译一次；
 *   · `electron .` 加载编译产物后不会因源码变化重启。
 * ⇒ 改 electron/ 下任何代码都必须手动 Ctrl+C + npm run dev，用户体验极差。
 *
 * 本脚本（零新依赖）：
 *   ① 先完整编译一次（tsc -p electron/tsconfig.json，并跑 gen-rollout-worker）；
 *   ② tsc --watch 持续编译；
 *   ③ 监听 dist-electron 目录变化 ⇒ 杀掉旧 electron、重启（带 VITE_DEV_SERVER_URL）。
 * 用法：`npm run dev:main`（由 dev 脚本的 concurrently 拉起，与 vite 并行）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-electron");
const isWin = process.platform === "win32";

/**
 * ⛔ 别 spawn "npx.cmd" / "electron.cmd"：Windows 上 spawn .cmd 会抛 EINVAL（errno -4071），
 *    除非传 shell:true（那又会引入引号/转义一堆坑）。直接解析本地二进制路径最稳。
 */
const require_ = createRequire(import.meta.url);
function resolveTscBin() {
  const candidates = [
    (() => { try { return require_.resolve("typescript/bin/tsc"); } catch { return null; } })(),
    path.join(root, "node_modules/typescript/bin/tsc"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}
function resolveElectronBin() {
  try {
    const p = require_("electron");        // electron 包在**非** electron 进程里导出的是可执行文件路径
    if (typeof p === "string" && fs.existsSync(p)) return p;
  } catch { /* 落到下面的兜底路径 */ }
  const win = path.join(root, "node_modules/electron/dist/electron.exe");
  if (isWin && fs.existsSync(win)) return win;
  const unix = path.join(root, "node_modules/.bin/electron");
  return fs.existsSync(unix) ? unix : "electron";
}
const tscBin = resolveTscBin();
const electronBin = resolveElectronBin();

let child = null;
let stopping = false;
let debounce = null;
let devServerUrl = null;

function log(line) { console.log(`[watch-electron] ${line}`); }

/**
 * 探测某个端口上是不是我们的 Vite dev server。
 * ⛔ 不能只判断"端口能连上"：5173 可能被别的服务占着，连上了却不是 vite
 *    ⇒ Electron 会加载到一个空页面（白屏，且看不出原因）。必须校验响应体。
 */
function probePort(port) {
  return new Promise((resolve) => {
    // ⛔ host 必须是 "localhost" 而不是 "127.0.0.1"：Vite 常只监听 IPv6 回环 [::1]:5174，
    //    写死 IPv4 会永远连不上（curl 能访问是因为它解析成了 ::1）。
    const req = http.get({ host: "localhost", port, path: "/", timeout: 800 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
      res.on("end", () => resolve(res.statusCode === 200 && /@vite\/client|__vite|src\/main\.tsx/i.test(body)));
      res.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/**
 * 找到 Vite 实际监听的端口。
 * ⛔ 别写死 5173：端口被占时 Vite 会顺延到 5174/5175…（本仓实测就落在 5174），
 *    写死 ⇒ Electron 去连一个没人听的端口 ⇒ 白屏。这里从基准端口向上扫一段。
 */
async function detectDevServer() {
  const base = Number(process.env.VITE_DEV_PORT || 5173);
  for (let p = base; p < base + 12; p++) {
    if (await probePort(p)) { log(`Vite dev server 在 ${p}`); return `http://localhost:${p}`; }
  }
  // ⛔ 必须返回 null：返回兜底字符串会让 waitForDevServer 的 `if (url)` 第一次就成立 ⇒ 根本没等。
  return null;
}

/** 等 dev server 起来（原先靠外层的 wait-on tcp:5173，端口一变就永久卡住）。 */
async function waitForDevServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const url = await detectDevServer();
    if (url) return url;
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

function startElectron() {
  if (stopping) return;
  if (child) { try { child.kill(isWin ? "SIGKILL" : "SIGTERM"); } catch { /* 已退出 */ } child = null; }
  const env = { ...process.env };
  /* ⛔ 必须删：环境里若带 ELECTRON_RUN_AS_NODE=1，electron.exe 会以**纯 node** 模式启动，
     require("electron") 返回的是可执行文件路径字符串 ⇒ main.js 里 electron.protocol 为 undefined
     ⇒ 启动即崩（TypeError: Cannot read properties of undefined）。 */
  delete env.ELECTRON_RUN_AS_NODE;
  env.VITE_DEV_SERVER_URL = devServerUrl || process.env.VITE_DEV_SERVER_URL || `http://localhost:5173`;
  child = spawn(electronBin, ["."], { cwd: root, env, stdio: "inherit" });
  child.on("exit", (code) => { if (!stopping && code !== 0 && code !== null) log(`electron 退出（code=${code}）——若持续退出请查看上方报错`); });
  log(`electron 已启动（dev server = ${env.VITE_DEV_SERVER_URL}）`);
}

/**
 * 持续编译（tsc --watch）：改 electron/ 下的源码 ⇒ 自动重编译到 dist-electron。
 * 返回 Promise，在**首次编译结束**（无论成败）后 resolve —— 之后由 watch() 监听产物变化重启。
 */
function watchBuild() {
  return new Promise((resolve) => {
    let settled = false;
    /* ⛔ stdio 不能是 "inherit"：那样 cmd.stdout 为 null，就绪信号永远收不到 ⇒ 白等 60 秒兜底。
       用 pipe 自己转发，才能监听到"首次编译结束"。 */
    const cmd = spawn(process.execPath, [tscBin, "-p", "electron/tsconfig.json", "--watch"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    // tsc --watch 不退出；用"首次出现编译相关输出"作为就绪信号，最多等 60s 兜底
    const timer = setTimeout(() => { if (!settled) { settled = true; log("编译监视已启动（超时兜底，直接起 electron）"); resolve(); } }, 60_000);
    cmd.stdout?.on("data", (b) => {
      const s = String(b);
      process.stdout.write(`[tsc] ${s}`);
      if (!settled && /error TS|Found \d+ error|Compilation complete|File change detected|Starting compilation/i.test(s)) {
        // 第一次输出即可认为进入 watch 循环
        settled = true; clearTimeout(timer); log("tsc --watch 已就绪"); resolve();
      }
    });
    cmd.stderr?.on("data", (b) => process.stderr.write(`[tsc:err] ${String(b)}`));
    cmd.on("exit", (code) => { if (!settled) { settled = true; clearTimeout(timer); log(`tsc --watch 退出（code=${code}）`); resolve(); } });
  });
}

function watch() {
  // 目录可能还不存在（首次编译会创建）
  if (!fs.existsSync(dist)) { setTimeout(watch, 500); return; }
  fs.watch(dist, { recursive: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { log("检测到主进程产物变化 → 重启 electron"); startElectron(); }, 600);
  });
  log(`监听 ${path.relative(root, dist)} 变化（自动重启主进程）`);
}

process.on("SIGINT", () => { stopping = true; if (child) { try { child.kill(isWin ? "SIGKILL" : "SIGTERM"); } catch { /* ignore */ } } process.exit(0); });
process.on("SIGTERM", () => process.emit("SIGINT"));

if (!tscBin) { console.error("[watch-electron] 找不到 typescript/bin/tsc —— 请先 npm i"); process.exit(1); }
log(`tsc = ${tscBin}`);
log(`electron = ${electronBin}`);
await watchBuild();
devServerUrl = await waitForDevServer();
if (!devServerUrl) log("未探测到 Vite dev server —— 仍会启动 electron（可能白屏，请先确认 vite 已运行）");
startElectron();
watch();
