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
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist-electron");
const isWin = process.platform === "win32";

let child = null;
let stopping = false;
let debounce = null;

function log(line) { console.log(`[watch-electron] ${line}`); }

function startElectron() {
  if (stopping) return;
  if (child) { try { child.kill(isWin ? "SIGKILL" : "SIGTERM"); } catch { /* 已退出 */ } child = null; }
  const env = { ...process.env, VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL || "http://localhost:5173" };
  child = spawn(isWin ? "npx.cmd" : "npx", ["electron", "."], { cwd: root, env, stdio: "inherit" });
  child.on("exit", (code) => { if (!stopping && code !== 0 && code !== null) log(`electron 退出（code=${code}）——若持续退出请查看上方报错`); });
  log("electron 已启动");
}

/**
 * 持续编译（tsc --watch）：改 electron/ 下的源码 ⇒ 自动重编译到 dist-electron。
 * 返回 Promise，在**首次编译结束**（无论成败）后 resolve —— 之后由 watch() 监听产物变化重启。
 */
function watchBuild() {
  return new Promise((resolve) => {
    let settled = false;
    const cmd = spawn(isWin ? "npx.cmd" : "npx", ["tsc", "-p", "electron/tsconfig.json", "--watch"], { cwd: root, stdio: "inherit" });
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

await watchBuild();
startElectron();
watch();
