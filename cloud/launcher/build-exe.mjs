/**
 * Codex Harness Cloud · 把本地伴生服务打成**单个 exe**（桌面双击即用）
 *
 *   node launcher/build-exe.mjs
 *
 * 产物：launcher/dist/CodexHarnessCloud.exe（内嵌 5 个 js + 4 个 web 资源，目标机器不需要 Node）
 *
 * 步骤（都是 Node 官方 SEA 流程 + 一个换图标）：
 *   ① 生成 sea-config.json（把资源清单写进去）
 *   ② `node --experimental-sea-config` 产 blob
 *   ③ 复制一份 node.exe 当宿主（SEA 的做法就是把 blob 注进 node 二进制）
 *   ④ `postject` 注入 blob
 *   ⑤ `rcedit` 换图标（postject 只管注入、不管图标，不换就是 Node 的绿三角）
 *
 * ⛔ 依赖解析：postject 与 rcedit 都借桌面版工作副本的 node_modules 用（本目录零依赖）。
 *   找不到就在报错里说清楚该去哪找，不要静默出一个没图标的 exe。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = path.resolve(HERE, "..");
const OUT_DIR = path.join(HERE, "dist");
const BUILD_DIR = path.join(HERE, ".build");
const EXE_NAME = "CodexHarnessCloud.exe";

/** 借桌面版工作副本里的工具（本目录保持零依赖） */
const TOOL_ROOTS = [
  path.resolve(CLOUD_DIR, ".."),
  "D:/Codex Harness Desktop",
];

const ASSETS = {
  "local-agent/auth.js": path.join(CLOUD_DIR, "local-agent", "auth.js"),
  "local-agent/config.js": path.join(CLOUD_DIR, "local-agent", "config.js"),
  "local-agent/engine.js": path.join(CLOUD_DIR, "local-agent", "engine.js"),
  "local-agent/mock-engine.js": path.join(CLOUD_DIR, "local-agent", "mock-engine.js"),
  "local-agent/server.js": path.join(CLOUD_DIR, "local-agent", "server.js"),
  "web/index.html": path.join(CLOUD_DIR, "web", "index.html"),
  "web/app.js": path.join(CLOUD_DIR, "web", "app.js"),
  "web/styles.css": path.join(CLOUD_DIR, "web", "styles.css"),
  "web/version.json": path.join(CLOUD_DIR, "web", "version.json"),
};

function findInRoots(relative) {
  for (const root of TOOL_ROOTS) {
    const candidate = path.join(root, relative);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function run(label, command, args, options = {}) {
  process.stdout.write(`[build] ${label}\n`);
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${label} 失败（exit=${result.status}）\n${(result.stdout || "") + (result.stderr || "")}`);
  }
  return result;
}

// 先把缺的东西一次性说清楚，别跑到一半才炸
const postjectCli = findInRoots("node_modules/postject/dist/cli.js");
const rcedit = findInRoots("node_modules/electron-winstaller/vendor/rcedit.exe");
const icon = findInRoots("build/icon.ico");

if (!postjectCli) {
  console.error("[build] 找不到 postject。请在带 node_modules 的桌面版工作副本里跑本脚本（或在 cloud/ 下 npm i -D postject）。");
  process.exit(1);
}
if (!rcedit || !icon) {
  console.warn("[build] ⚠️ 找不到 rcedit 或 build/icon.ico —— 仍会出 exe，但图标会是 Node 默认的（不好看，但不影响功能）");
}

rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(BUILD_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ① sea-config.json
const seaConfig = {
  main: path.join(HERE, "sea-main.cjs"),
  output: path.join(BUILD_DIR, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
  assets: ASSETS,
};
const seaConfigPath = path.join(BUILD_DIR, "sea-config.json");
writeFileSync(seaConfigPath, `${JSON.stringify(seaConfig, null, 2)}\n`, "utf8");

// ② blob
run("生成 SEA blob", process.execPath, ["--experimental-sea-config", seaConfigPath]);

// ③ 复制 node.exe 当宿主
const hostExe = path.join(OUT_DIR, EXE_NAME);
copyFileSync(process.execPath, hostExe);
process.stdout.write(`[build] 宿主就是自带的 node：${process.execPath}\n`);

// ④ 注入
run("注入 blob（postject）", process.execPath, [
  postjectCli, hostExe, "NODE_SEA_BLOB", path.join(BUILD_DIR, "sea-prep.blob"),
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
]);

// ⑤ 图标
if (rcedit && icon) {
  run("换图标（rcedit）", rcedit, [hostExe, "--set-icon", icon]);
}

const sizeMb = (statSync(hostExe).size / 1024 / 1024).toFixed(0);
process.stdout.write(`\n[build] 完成：${path.relative(process.cwd(), hostExe)}（约 ${sizeMb} MB）\n`);
process.stdout.write(`[build] 双击即跑；也可以先用 --no-open 手动验证：\n`);
process.stdout.write(`        "${hostExe}" --mock --no-open\n`);
