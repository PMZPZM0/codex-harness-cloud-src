"use strict";
/**
 * Codex Harness Cloud · 单文件 exe 的入口（Node SEA）—— **真助手启动器**（10-11 改版）
 *
 * 历史：这个 exe 最初内嵌的是过渡版伴生服务（local-agent + vanilla 界面）。
 * 10-11 起桌面双击的目标换成**真助手**（Electron 无头主进程 + 桌面版真界面 +
 * 463 通道桥），本入口随之改为**启动器**：定位仓库副本里的 electron，拉起
 * dist-electron/headless.js，再打开浏览器界面。快捷方式/图标/文件名全部不变。
 *
 * 行为：
 *   CodexHarnessCloud.exe                 # 起真助手（已在跑则只开浏览器）→ 开界面
 *   CodexHarnessCloud.exe --add-user 名字  # 给真助手签发个人配对码（转发）
 *
 * ⛔ 首次运行需要 `node launcher/build-exe.mjs` 打出来；直接跑源码请用
 *    `electron dist-electron/headless.js`。
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number(process.env.HARNESS_HEADLESS_PORT || 8917);
const BASE = `http://127.0.0.1:${PORT}`;

/** exe 落在 <repo>/cloud/launcher/dist/ ⇒ 仓库根 = 上溯三级；复制到别处（如桌面）时
 *  回退到已知仓库路径 / HARNESS_ASSISTANT_ROOT。⛔ 正式安装版（electron-builder 产物）
 *  自带主进程，不走本启动器。 */
function locate() {
  const here = path.dirname(process.execPath);            // ...\cloud\launcher\dist
  const candidates = [];
  let dir = here;
  for (let i = 0; i < 4; i++) { dir = path.resolve(dir, ".."); candidates.push(dir); }
  if (process.env.HARNESS_ASSISTANT_ROOT) candidates.unshift(process.env.HARNESS_ASSISTANT_ROOT);
  candidates.push("D:/CodexHarness-Cloud");               // 开发机兜底（用户桌面副本用）
  for (const root of candidates) {
    const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
    const headless = path.join(root, "dist-electron", "headless.js");
    if (fs.existsSync(electronExe) && fs.existsSync(headless)) return { root, electronExe, headless };
  }
  process.stderr.write(
    "[launcher] 找不到助手（node_modules/electron + dist-electron/headless.js）。\n" +
    "           把本 exe 放回仓库副本 cloud/launcher/dist/，或设 HARNESS_ASSISTANT_ROOT 指向仓库根。\n");
  process.exit(1);
}

function openBrowser(url) {
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch { /* 不影响主流程 */ }
}

function healthOk(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/api/health`, { signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/** 启动环境：清掉干扰变量 + userData 指向云副本的助手家目录 + 兜底 key（只在 key 为空时生效）。 */
function childEnv(root) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.CODEX_HARNESS_USER_DATA = env.CODEX_HARNESS_USER_DATA || path.join(root, "cloud", ".headless-home");
  if (!env.HARNESS_CLOUD_API_KEY) env.HARNESS_CLOUD_API_KEY = "harness-local-relay";
  return env;
}

async function main() {
  const argv = process.argv.slice(2);

  /* --add-user：转发给真助手（签发个人配对码，只显示一次） */
  const addUserIndex = argv.indexOf("--add-user");
  if (addUserIndex >= 0) {
    const { electronExe, headless, root } = locate();
    const child = spawn(electronExe, [headless, "--add-user", argv[addUserIndex + 1] || ""], {
      env: childEnv(root), stdio: "inherit", windowsHide: true,
    });
    child.on("exit", (code) => process.exit(code || 0));
    return;
  }

  /* 已在跑（health 认得出自家 product）→ 只开界面，不重复起进程 */
  if (await healthOk(2500)) {
    process.stdout.write(`[launcher] 助手已在运行（${BASE}），直接打开界面。\n`);
    openBrowser(`${BASE}/`);
    return;
  }

  /* 拉起真助手：detached + 独立环境；等 health 就绪后开界面 */
  const { electronExe, headless, root } = locate();
  const child = spawn(electronExe, [headless], { env: childEnv(root), detached: true, stdio: "ignore", windowsHide: true });
  child.unref();

  for (let i = 0; i < 22; i++) {
    await new Promise((r) => setTimeout(r, 700));
    if (await healthOk(1500)) {
      process.stdout.write(`[launcher] 助手已就绪 ${BASE}\n`);
      openBrowser(`${BASE}/`);
      return;
    }
  }
  process.stderr.write("[launcher] 助手 15 秒内未就绪（端口被占或启动报错），请重试或检查日志。\n");
  process.exit(1);
}

main().catch((error) => { process.stderr.write(`[launcher] ${error.message}\n`); process.exit(1); });
