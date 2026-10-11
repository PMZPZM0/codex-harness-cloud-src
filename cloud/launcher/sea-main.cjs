"use strict";
/**
 * Codex Harness Cloud · 单文件 exe 的入口（Node SEA：Single Executable Application）
 *
 * 为什么需要它：用户要的是**桌面上能双击的东西**，不是"打开终端敲 npm run start"。
 * 这个入口把伴生服务整套（5 个 js + 4 个 web 资源）**内嵌进 exe**，双击即跑，目标机器
 * 不需要装 Node。
 *
 * 做法故意"笨"但稳：
 *   启动时把内嵌资源原样解到 `<HARNESS_CLOUD_HOME>/runtime/`（保持 local-agent/ 与 web/ 的相对布局），
 *   再直接 `require` 那个真实的 server.js。
 * ⛔ 不去手写模块加载器、也不打成一个 bundle —— 那样 `__dirname`、相对 require、web 目录
 *   全都要跟着改写，等于给自己造一套只有 exe 才会走的路径（**只在打包后才生效的 bug 最难查**）。
 *   解包 + 正常 require 之后，exe 里跑的和源码跑的是**同一份代码、同一条路径**。
 *
 * 用法：CodexHarnessCloud.exe [--mock] [--open] [--no-open]
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 内嵌资源的清单：key 就是解包后的相对路径。⛔ 必须与 build-exe.mjs 的 assets 一致。 */
const FILES = [
  "local-agent/auth.js",
  "local-agent/config.js",
  "local-agent/engine.js",
  "local-agent/mock-engine.js",
  "local-agent/server.js",
  "web/index.html",
  "web/app.js",
  "web/styles.css",
  "web/version.json",
];

function homeDir() {
  return process.env.HARNESS_CLOUD_HOME || path.join(os.homedir(), ".codex-harness-cloud");
}

/** 读内嵌资源。`node:sea` 只有 SEA 产物里才有 —— 单独跑这个文件会在这里就说明白。 */
function readAsset(key) {
  let sea;
  try {
    sea = require("node:sea");
  } catch {
    process.stderr.write(
      "[launcher] 这个文件是给打包后的 exe 用的，不能单独运行。\n" +
      "           开发时直接跑：node ../local-agent/server.js\n"
    );
    process.exit(2);
  }
  const asset = sea.getAsset(key, "utf8");
  if (!asset) throw new Error(`内嵌资源缺失：${key}`);
  return asset;
}

function extract(runtimeDir) {
  for (const key of FILES) {
    const target = path.join(runtimeDir, key);
    const text = readAsset(key);
    // 内容一样就不重写：省掉每次启动的写盘，也避免把用户正在看的文件时间戳改掉
    try {
      if (fs.readFileSync(target, "utf8") === text) continue;
    } catch { /* 不存在或不一致 → 写 */ }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, target);   // 原子替换：写一半被杀也只留旧文件
  }
  return runtimeDir;
}

const runtimeDir = extract(path.join(homeDir(), "runtime"));

/**
 * ⛔ 参数：SEA 下 `process.argv` 是 `[exe 路径, ...用户参数]`，而 server.js 读的是
 *   `process.argv.slice(2)`（它按"node 脚本.js"的形态写）。这里把 argv 摆成那个形状，
 *   免得 exe 版本把 `--open` 丢掉 —— 那正是"双击了但浏览器没开"的原因。
 */
const userArgs = process.argv.slice(1).filter((a) => a !== process.execPath && !/\.exe$/i.test(a));
const wantsMock = userArgs.includes("--mock");
// 双击（无参数）默认就打开浏览器：用户要的是"点了就有界面"
const openFlag = userArgs.includes("--open") ? "--open" : (userArgs.includes("--no-open") ? "" : "--open");
const finalArgs = [
  wantsMock ? "--mock" : "",
  openFlag,
].filter(Boolean);
process.argv = [process.execPath, "CodexHarnessCloud", ...finalArgs];

// web 资源就在解包目录里
process.env.HARNESS_CLOUD_WEB_DIR = path.join(runtimeDir, "web");

/**
 * ⛔⛔ SEA 里的 `require` 是**内嵌的那个**：它只认内置模块与内嵌资源，`require("D:\\…\\server.js")`
 *   会直接抛 `ERR_UNKNOWN_BUILTIN_MODULE`（实测踩到）。要加载磁盘上的文件必须自己造一个
 *   正常作用域的 require：`createRequire(该文件的路径)`，它的相对解析也才正确。
 */
const { createRequire } = require("node:module");
const entry = path.join(runtimeDir, "local-agent", "server.js");
createRequire(entry)(entry);
