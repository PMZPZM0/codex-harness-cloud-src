/**
 * Codex Harness Cloud · 界面走查（启动器）
 *
 *   node scripts/shot.mjs                 # 默认：假引擎 + 默认 CDN 配置
 *   node scripts/shot.mjs --cdn http://127.0.0.1:8099/cloud   # 指定资产地址（验更新链路时用）
 *   node scripts/shot.mjs --port 8933 --label prod
 *
 * 做两件事：拉起本地伴生服务（假引擎，确定性脚本）→ 用 Electron 打开它并逐步操作截图。
 * 产物落 cloud/docs/shots/（PNG + 一份 JSON 探针报告）。
 *
 * ⛔ 为什么不用 Playwright/agent-browser：本项目已有"Electron 自渲 + capturePage"的成熟做法
 *   （见 .workbuddy/memory 的截图纪律），不引入新依赖；而且验的是**同一个 Chromium 内核**，
 *   与桌面版用户看到的一致。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = path.resolve(HERE, "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function resolveElectron() {
  const exe = process.platform === "win32" ? "electron.exe" : process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron" : "electron";
  const roots = [
    CLOUD_DIR,
    path.resolve(CLOUD_DIR, "..", ".."),
    "D:/Codex Harness Desktop",
  ];
  for (const root of roots) {
    const candidate = path.join(root, "node_modules", "electron", "dist", exe);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

const PORT = Number(arg("port", 8932));
const LABEL = arg("label", "cloud");
const CDN = arg("cdn", "");
const OUT_DIR = path.join(CLOUD_DIR, "docs", "shots");
const home = path.join(CLOUD_DIR, ".shot-home");
mkdirSync(home, { recursive: true });

const electron = resolveElectron();
if (!electron) {
  console.error("[shot] 找不到 Electron。请在 cloud/ 下 npm install，或保留一份带 node_modules 的桌面版工作副本。");
  process.exit(1);
}

const env = {
  ...process.env,
  HARNESS_CLOUD_HOME: home,
  HARNESS_CLOUD_PORT: String(PORT),
  HARNESS_CLOUD_QUIET: "1",
  MOCK_ENGINE_STEP_MS: "700",   // 放慢一点，截图才抓得到中间态
};
if (CDN) env.HARNESS_CLOUD_CDN = CDN;
// ⛔ 先清掉 token：每次走查都要重新走一遍配对流程（那是我要验的东西之一）
rmSync(path.join(home, "token"), { force: true });

console.log(`[shot] 启动伴生服务（假引擎）:${PORT}`);
const agent = spawn(process.execPath, [path.join(CLOUD_DIR, "local-agent", "server.js"), "--mock"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let agentOut = "";
agent.stdout.on("data", (chunk) => {
  agentOut += String(chunk);
  const match = /配对码：\s*([0-9a-f]{8})/.exec(agentOut);
  if (match && !code) code = match[1];
});
agent.stderr.on("data", (chunk) => process.stderr.write(`[agent] ${chunk}`));

let code = "";
const started = Date.now();
while (!code) {
  if (Date.now() - started > 8000) { console.error("[shot] 伴生服务没打印配对码"); agent.kill(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 80));
}

const url = `http://127.0.0.1:${PORT}/?pair=${code}`;
console.log(`[shot] Electron: ${electron}`);
const electronEnv = { ...process.env, HARNESS_CLOUD_SHOT: "1" };
delete electronEnv.ELECTRON_RUN_AS_NODE;   // ⛔ 不摘掉它，electron.exe 会退化成普通 node
delete electronEnv.NODE_OPTIONS;
// ⛔⛔ 这几个开关必须**写在命令行上**，不能只写在主脚本里：这台机器上 Electron 的 GPU 进程会崩
//   （`GPU process exited unexpectedly: exit_code=-1073741819`），而崩在**主脚本执行之前** ——
//   于是脚本里那三行 `appendSwitch` 根本来不及生效，症状是 exit=127 且脚本一行都没跑。
//   命令行开关在启动更早期就被 Chromium 读走，才拦得住。
// ⛔⛔ 而且它是**偶发**的：同样的命令上一分钟 exit=0、下一分钟 exit=127（实测连跑 5 次全挂，
//   杀干净残留 electron.exe 后再跑又全过）。所以这里做两件事：给每次尝试一个**独立的
//   user-data-dir**（不共享可能已损坏的 GPU/缓存状态）+ 失败自动重试。
const ELECTRON_SWITCHES = ["--in-process-gpu", "--no-sandbox"];
const MAX_ATTEMPTS = 5;

/**
 * 清掉上一次失败留下的 Electron 残骸。
 * ⛔ 为什么需要：走查失败时 Electron 是"脚本都没跑就崩"，父进程收不到任何信号，
 *   会有 electron.exe 挂在后台；连着崩几次后**新的启动会一直失败**（实测：清干净立刻恢复）。
 *   这里按镜像名杀 —— 走查台假定自己是这台机器上唯一的 Electron（打包版进程名是
 *   `Codex Harness Desktop.exe`，不叫 electron.exe，不会被误伤）。
 */
function clearStaleElectron() {
  if (process.platform !== "win32") return;
  try {
    execFileSync("taskkill", ["/F", "/IM", "electron.exe"], { stdio: "ignore", windowsHide: true });
  } catch { /* 本来就没有残留时 taskkill 也会非零退出，属正常 */ }
}

let exitCode = 1;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const userData = path.join(CLOUD_DIR, ".shot-home", `electron-attempt${attempt}`);
  rmSync(path.join(OUT_DIR, `${LABEL}-log.txt`), { force: true });
  const runner = spawn(electron, [
    ...ELECTRON_SWITCHES,
    `--user-data-dir=${userData}`,
    path.join(HERE, "shot.cjs"),
    "--url", url, "--out", OUT_DIR, "--label", LABEL,
  ], {
    env: electronEnv,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  exitCode = await new Promise((resolve) => runner.on("exit", (code2) => resolve(code2 ?? 1)));

  // ⛔ Electron 在 Windows 上不接父进程管道 ⇒ 它的日志全在文件里，这里回读打印，
  //   否则失败时看到的就是"exit=-1、零输出"这种毫无信息量的结果。
  const logFile = path.join(OUT_DIR, `${LABEL}-log.txt`);
  const text = existsSync(logFile) ? readFileSync(logFile, "utf8").trim() : "";
  if (text) process.stdout.write(`${text}\n`);
  // 有日志 = 脚本真的跑起来过（哪怕中途失败，原因也在日志里）⇒ 不再重试
  if (exitCode === 0 || text) break;
  if (attempt < MAX_ATTEMPTS) {
    console.log(`[shot] 第 ${attempt} 次启动在脚本执行前就挂了（exit=${exitCode}），清理残骸后重试…`);
    clearStaleElectron();
    await new Promise((r) => setTimeout(r, 3000));
  }
}

agent.kill();
if (exitCode === 0 && !existsSync(path.join(OUT_DIR, `${LABEL}-report.json`))) {
  console.log("[shot] ⚠️ 退出码为 0 但没有报告文件，视为失败");
  exitCode = 1;
}
console.log(`[shot] 完成（exit=${exitCode}），产物在 ${path.relative(process.cwd(), OUT_DIR)}`);
process.exit(exitCode);
